import type { IconifyJSON } from '@iconify/types'
import type { ResolvedIconctlConfig } from './config'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { checkpoint, throwIfAborted } from './abort'
import { IconctlError } from './errors'
import { managedOutputFiles, outputTargets } from './export'

interface ArtifactProof {
  path: string
  sha256: string | null
}

export interface OutputProof {
  version: 1
  artifacts: ArtifactProof[]
}

interface ProofOptions {
  signal?: AbortSignal
  stagedPath?: (path: string) => string
}

async function fingerprint(file: string, optional: boolean, signal?: AbortSignal): Promise<string | null> {
  await checkpoint(signal)
  const before = await lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  if (!before) {
    return null
  }
  if (!before.isFile()) {
    throw new IconctlError(`Managed output is not a regular file: ${file}`)
  }
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(file, { signal })) {
      throwIfAborted(signal)
      hash.update(chunk)
    }
  }
  catch (error) {
    throwIfAborted(signal)
    throw error
  }
  const after = await lstat(file, { bigint: true })
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new IconctlError(`Managed output changed while checking completion: ${file}`)
  }
  return hash.digest('hex')
}

async function checkDirectories(config: ResolvedIconctlConfig, cwd: string, files: { path: string, optional?: boolean }[], options: ProofOptions): Promise<void> {
  const checked = new Map<string, boolean>()
  const directories = outputTargets(config, cwd).filter(target => target.directory).map(target => target.path)
  for (const root of directories) {
    checked.set(root, false)
    for (const file of files) {
      const child = relative(root, file.path)
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        continue
      }
      if (!child) {
        throw new IconctlError(`Managed output file conflicts with its directory: ${root}`)
      }
      let parent = dirname(file.path)
      while (parent !== root) {
        checked.set(parent, (checked.get(parent) ?? true) && file.optional === true)
        parent = dirname(parent)
      }
    }
  }
  for (const [directory, optional] of checked) {
    await checkpoint(options.signal)
    const actual = options.stagedPath?.(directory) ?? directory
    const stat = await lstat(actual).catch((error: NodeJS.ErrnoException) => {
      if (optional && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (stat && !stat.isDirectory()) {
      throw new IconctlError(`Managed output directory has the wrong file type: ${directory}`)
    }
  }
}

/** A completion proof describes known output bytes; it grants no filesystem ownership. */
export async function captureOutputProof(
  config: ResolvedIconctlConfig,
  json: IconifyJSON,
  cwd: string,
  options: ProofOptions = {},
): Promise<OutputProof> {
  const files = managedOutputFiles(config, json, cwd)
  await checkDirectories(config, cwd, files, options)
  const artifacts: ArtifactProof[] = []
  for (const file of files) {
    artifacts.push({
      path: file.path,
      sha256: await fingerprint(options.stagedPath?.(file.path) ?? file.path, file.optional === true, options.signal),
    })
  }
  return { version: 1, artifacts }
}

export async function matchesOutputProof(
  proof: unknown,
  config: ResolvedIconctlConfig,
  json: IconifyJSON,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await checkpoint(signal)
  try {
    if (!proof || typeof proof !== 'object' || !('version' in proof) || proof.version !== 1
      || !('artifacts' in proof) || !Array.isArray(proof.artifacts)) {
      return false
    }
    const artifacts = proof.artifacts
    const files = managedOutputFiles(config, json, cwd)
    if (files.length !== artifacts.length || !artifacts.every((item: unknown, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !('path' in item) || item.path !== files[index]!.path
        || !('sha256' in item)) {
        return false
      }
      return (typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))
        || (item.sha256 === null && files[index]!.optional === true)
    })) {
      return false
    }
    const current = await captureOutputProof(config, json, cwd, { ...(signal ? { signal } : {}) })
    return current.artifacts.every((item, index) => item.sha256 === artifacts[index].sha256)
  }
  catch {
    throwIfAborted(signal)
    return false
  }
}

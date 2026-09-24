import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  MAX_ARTIFACT_BYTES,
  MAX_UPLOAD_BYTES,
  safePath,
} from '@iconctl/console-contracts'
import { unzipSync } from 'fflate'

export function sha256(data: Uint8Array | string) {
  return createHash('sha256').update(data).digest('hex')
}
export function integrity(data: Uint8Array) {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`
}
export function resolveInside(root: string, name: string) {
  safePath.parse(name)
  const result = resolve(root, name)
  if (!result.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error('Path escapes its root')
  }
  return result
}
export async function validateDirectory(root: string, name: string) {
  const directory = resolveInside(root, name)
  const canonical = await realpath(directory)
  if (!canonical.startsWith(`${await realpath(root)}${sep}`)) {
    throw new Error('Source directory escapes repository')
  }
  let count = 0
  let bytes = 0
  async function walk(path: string) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed in SVG sources')
    }
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) {
        await walk(resolve(path, entry))
      }
      return
    }
    bytes += stat.size
    if (++count > 5000 || bytes > MAX_ARTIFACT_BYTES) {
      throw new Error('SVG directory exceeds size limits')
    }
  }
  await walk(directory)
  return canonical
}
export async function extractSvgArchive(
  bytes: Uint8Array,
  destination: string,
) {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('ZIP upload is too large')
  }
  let total = 0
  let count = 0
  const names = new Set<string>()
  const files = unzipSync(bytes, {
    filter(file) {
      if (file.name.endsWith('/')) {
        safePath.parse(file.name.slice(0, -1))
        return false
      }
      safePath.parse(file.name)
      if (!file.name.toLowerCase().endsWith('.svg') || names.has(file.name)) {
        throw new Error('ZIP may contain only unique SVG files')
      }
      names.add(file.name)
      total += file.originalSize
      if (
        ++count > 5000
        || total > MAX_ARTIFACT_BYTES
        || file.originalSize > 1024 * 1024
      ) {
        throw new Error('Expanded ZIP exceeds size limits')
      }
      return true
    },
  })
  if (!count) {
    throw new Error('No SVG files found')
  }
  for (const [name, content] of Object.entries(files)) {
    const target = resolveInside(destination, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}
export async function collectFiles(
  root: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  let total = 0
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Artifact contains a symbolic link')
      }
      if (entry.isDirectory()) {
        await walk(full)
      }
      else {
        const content = await readFile(full)
        total += content.byteLength
        if (total > MAX_ARTIFACT_BYTES * 0.6) {
          throw new Error('Artifact bundle exceeds size limit')
        }
        files[safePath.parse(relative(root, full).split(sep).join('/'))]
          = content.toString('base64')
      }
    }
  }
  await walk(root)
  return files
}

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  MAX_ARTIFACT_BYTES,
  MAX_UPLOAD_BYTES,
  safePath,
  validateIconifyUpload,
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

export class RepositorySourceError extends Error {
  override name = 'RepositorySourceError'
}

export class UploadStreamError extends Error {
  override name = 'UploadStreamError'
}

/** Freeze a bounded repository file before any advanced configuration executes. */
export async function materializeIconifySource(root: string, name: string, destination: string) {
  try {
    const canonicalRoot = await realpath(root)
    const canonical = await realpath(resolveInside(root, name))
    if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new RepositorySourceError('Iconify JSON source escapes repository')
    }
    // A safe lexical path may still point into Git metadata through a symlink.
    safePath.parse(relative(canonicalRoot, canonical).split(sep).join('/'))
    const stat = await lstat(canonical)
    if (!stat.isFile()) {
      throw new RepositorySourceError('Iconify JSON source must be a regular file')
    }
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      if (!opened.isFile()) {
        throw new RepositorySourceError('Iconify JSON source must be a regular file')
      }
      if (opened.size > MAX_ARTIFACT_BYTES) {
        throw new RepositorySourceError('Iconify JSON source exceeds the 25 MiB size limit')
      }
      const chunks: Buffer[] = []
      let size = 0
      // Read at most one byte beyond the limit, even if a file grows after stat.
      for await (const chunk of file.createReadStream({ autoClose: false, end: MAX_ARTIFACT_BYTES })) {
        size += chunk.length
        if (size > MAX_ARTIFACT_BYTES) {
          throw new RepositorySourceError('Iconify JSON source exceeds the 25 MiB size limit')
        }
        chunks.push(chunk)
      }
      await writeFile(destination, Buffer.concat(chunks, size), { flag: 'wx' })
    }
    finally {
      await file.close()
    }
    return destination
  }
  catch (error) {
    if (error instanceof RepositorySourceError) {
      throw error
    }
    throw new RepositorySourceError('Cannot read repository Iconify JSON source', { cause: error })
  }
}

/** Validate raw upload bytes before creating a runner-owned input file. */
export async function materializeIconifyUpload(response: Response, destination: string) {
  const invalid = (message: string) => new RepositorySourceError(message)
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => undefined)
    throw invalid('Iconify JSON upload has an unexpected content type; upload the file again')
  }
  if (Number(response.headers.get('content-length')) > MAX_UPLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw invalid('Iconify JSON upload exceeds the 10 MiB size limit')
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        // Do not retain or copy an oversized chunk, regardless of Content-Length.
        if (value.byteLength > MAX_UPLOAD_BYTES - size) {
          await reader.cancel().catch(() => undefined)
          throw invalid('Iconify JSON upload exceeds the 10 MiB size limit')
        }
        size += value.byteLength
        chunks.push(value)
      }
    }
    catch (error) {
      if (error instanceof RepositorySourceError) {
        throw error
      }
      throw new UploadStreamError('Iconify upload stream interrupted', { cause: error })
    }
    finally {
      reader.releaseLock()
    }
  }
  const bytes = Buffer.concat(chunks, size)
  if (sha256(bytes) !== response.headers.get('X-Content-SHA256')) {
    throw new Error('Upload digest mismatch')
  }
  try {
    validateIconifyUpload(bytes)
  }
  catch (error) {
    throw invalid((error as Error).message)
  }
  const file = await open(destination, 'wx')
  try {
    await file.writeFile(bytes)
    await file.close()
  }
  catch (error) {
    await file.close().catch(() => undefined)
    try {
      await rm(destination, { force: true })
    }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Iconify upload write and cleanup failed')
    }
    throw error
  }
  return destination
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
        const name = safePath.parse(relative(root, full).split(sep).join('/'))
        // The core SVG exporter keeps this ownership record for local cleanup.
        // It is not part of the immutable snapshot or the published icon package.
        if (name === 'svg/.iconctl-manifest.json') {
          continue
        }
        const content = await readFile(full)
        total += content.byteLength
        if (total > MAX_ARTIFACT_BYTES * 0.6) {
          throw new Error('Artifact bundle exceeds size limit')
        }
        files[name] = content.toString('base64')
      }
    }
  }
  await walk(root)
  return files
}

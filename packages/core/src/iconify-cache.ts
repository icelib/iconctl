import type { BigIntStats } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { throwIfAborted } from './abort'
import { IconctlError } from './errors'
import { createIconifyJsonResolver } from './iconify-json'
import { ICONIFY_BODY_MAX_BYTES, ICONIFY_CACHE_MAX_BYTES } from './iconify-limits'
import { decodeUtf8 } from './json-input'

export type IconifyCacheEntryStatus = 'valid' | 'invalid' | 'missing'

export interface IconifyCacheEntry {
  file: string
  status: IconifyCacheEntryStatus
  bytes: number
  bodyBytes?: number
  url?: string
  keyMatches?: boolean
  etag?: string
  lastModified?: string
  error?: string
}

export interface IconifyCacheReport {
  directory: string
  entries: IconifyCacheEntry[]
  valid: number
  invalid: number
  missing: number
}

export interface InspectIconifyCacheOptions {
  cwd?: string
  cacheDir?: string
  /** Inspect the exact cache key for this URL, including a missing entry. */
  url?: string
}

export interface RemoteIconifyCache {
  url: string
  body: string
  etag?: string
  lastModified?: string
}

export function remoteCacheFile(cacheDir: string, url: string): string {
  return join(cacheDir, 'iconify-v1', `${createHash('sha256').update(url).digest('hex')}.json`)
}

function validateUrl(value: unknown): string {
  try {
    if (typeof value !== 'string' || !value) {
      throw new Error('missing URL')
    }
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
      throw new Error('unsupported URL')
    }
    return value
  }
  catch {
    throw new IconctlError('Cache URL must be HTTPS and contain no credentials')
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function readCacheMetadata(file: string, entry: IconifyCacheEntry, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal)
  const info = await lstat(file, { bigint: true })
  throwIfAborted(signal)
  if (!info.isFile()) {
    throw new IconctlError('Cache entry must be a regular file')
  }
  entry.bytes = Number(info.size)
  if (info.size > BigInt(ICONIFY_CACHE_MAX_BYTES)) {
    throw new IconctlError(`Cache metadata exceeds the ${ICONIFY_CACHE_MAX_BYTES}-byte limit`)
  }
  // No-follow rejects a swapped symlink; non-blocking prevents a swapped FIFO
  // from hanging open before the descriptor's regular-file check can run.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    throwIfAborted(signal)
    const opened = await handle.stat({ bigint: true })
    throwIfAborted(signal)
    if (!opened.isFile()) {
      throw new IconctlError('Cache entry must be a regular file')
    }
    if (!sameFile(info, opened)) {
      throw new IconctlError('Cache entry changed while it was being read')
    }
    const initialBytes = Number(info.size)
    // One allocation also bounds memory for repeated short reads. The extra
    // byte detects growth without reading a concurrently expanding file.
    const input = Buffer.allocUnsafe(initialBytes + 1)
    let bytes = 0
    while (true) {
      throwIfAborted(signal)
      const result = await handle.read(input, bytes, Math.min(64 * 1024, input.byteLength - bytes), null)
      throwIfAborted(signal)
      if (result.bytesRead === 0) {
        break
      }
      bytes += result.bytesRead
      entry.bytes = bytes
      if (bytes > ICONIFY_CACHE_MAX_BYTES) {
        throw new IconctlError(`Cache metadata exceeds the ${ICONIFY_CACHE_MAX_BYTES}-byte limit`)
      }
      if (bytes > initialBytes) {
        throw new IconctlError('Cache entry changed while it was being read')
      }
    }
    const completed = await handle.stat({ bigint: true })
    throwIfAborted(signal)
    const current = await lstat(file, { bigint: true })
    throwIfAborted(signal)
    if (!sameFile(info, completed) || !sameFile(info, current) || BigInt(bytes) !== info.size) {
      throw new IconctlError('Cache entry changed while it was being read')
    }
    return input.subarray(0, bytes)
  }
  finally {
    await handle.close()
  }
}

/** One bounded parser defines cache usability for both sync and diagnostics. */
export async function readIconifyCacheEntry(file: string, expectedUrl?: string, signal?: AbortSignal): Promise<{ entry: IconifyCacheEntry, value?: RemoteIconifyCache }> {
  const entry: IconifyCacheEntry = { file, status: 'invalid', bytes: 0 }
  try {
    const input = await readCacheMetadata(file, entry, signal)
    throwIfAborted(signal)
    let text: string
    try {
      text = decodeUtf8(input)
    }
    catch {
      throw new IconctlError('Invalid UTF-8 cache metadata')
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    }
    catch {
      throw new IconctlError('Cache metadata is not valid JSON')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IconctlError('Cache metadata must be an object')
    }
    const metadata = value as Record<string, unknown>
    const url = validateUrl(metadata['url'])
    entry.url = url
    if (expectedUrl !== undefined && url !== expectedUrl) {
      throw new IconctlError('Cache URL does not match the requested URL')
    }
    entry.keyMatches = basename(file) === basename(remoteCacheFile('', url))
    if (!entry.keyMatches) {
      throw new IconctlError('Cache filename does not match its URL key')
    }
    if (typeof metadata['body'] !== 'string') {
      throw new IconctlError('Cache metadata is missing a body')
    }
    const body = metadata['body']
    entry.bodyBytes = Buffer.byteLength(body)
    if (entry.bodyBytes > ICONIFY_BODY_MAX_BYTES) {
      throw new IconctlError(`Cached Iconify JSON exceeds the ${ICONIFY_BODY_MAX_BYTES}-byte limit`)
    }
    try {
      createIconifyJsonResolver(JSON.parse(body.replace(/^\uFEFF/, '')))
    }
    catch {
      throw new IconctlError('Cached Iconify JSON is invalid')
    }
    const validators: Pick<RemoteIconifyCache, 'etag' | 'lastModified'> = {}
    for (const key of ['etag', 'lastModified'] as const) {
      const value = metadata[key]
      if (typeof value === 'string' && value) {
        try {
          const headers = new Headers()
          headers.set(key === 'etag' ? 'If-None-Match' : 'If-Modified-Since', value)
        }
        catch {
          throw new IconctlError(`Cache ${key} is not a valid HTTP header value`)
        }
        validators[key] = value
      }
    }
    Object.assign(entry, validators, { status: 'valid' })
    return { entry, value: { url, body, ...validators } }
  }
  catch (error) {
    throwIfAborted(signal)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      entry.status = 'missing'
      entry.error = 'Cache entry is missing'
    }
    else {
      entry.error = error instanceof Error ? error.message : 'Cannot read cache entry'
    }
    return { entry }
  }
}

/** Inspect transport caches without fetching, writing or returning icon bodies. */
export async function inspectIconifyCache(options: InspectIconifyCacheOptions = {}): Promise<IconifyCacheReport> {
  const cacheDir = resolve(options.cwd ?? process.cwd(), options.cacheDir ?? '.iconctl-cache')
  const directory = join(cacheDir, 'iconify-v1')
  const entries: IconifyCacheEntry[] = []
  if (options.url !== undefined) {
    const url = validateUrl(options.url)
    entries.push((await readIconifyCacheEntry(remoteCacheFile(cacheDir, url), url)).entry)
  }
  else {
    let children: string[]
    try {
      children = await readdir(directory)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      children = []
    }
    for (const name of children.sort()) {
      if (extname(name).toLowerCase() === '.json') {
        entries.push((await readIconifyCacheEntry(join(directory, name))).entry)
      }
    }
  }
  return {
    directory,
    entries,
    valid: entries.filter(entry => entry.status === 'valid').length,
    invalid: entries.filter(entry => entry.status === 'invalid').length,
    missing: entries.filter(entry => entry.status === 'missing').length,
  }
}

import type { LoadedSource, ResolvedIconifySourceConfig } from './types'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { checkpoint, settleWithAbort, throwIfAborted } from '../abort'
import { IconctlError } from '../errors'
import { createIconifyJsonResolver } from '../iconify-json'
import { decodeUtf8 } from '../json-input'
import { shouldSkipName } from '../naming'

interface RemoteIconifyCache {
  url: string
  body: string
  etag?: string
  lastModified?: string
}

function remoteCacheFile(cacheDir: string, url: string): string {
  const key = createHash('sha256').update(url).digest('hex')
  return join(cacheDir, 'iconify-v1', `${key}.json`)
}

async function readRemoteCache(file: string, url: string): Promise<RemoteIconifyCache | undefined> {
  try {
    const value = JSON.parse(decodeUtf8(await readFile(file))) as Partial<RemoteIconifyCache>
    if (value.url !== url || typeof value.body !== 'string') {
      return undefined
    }
    // A conditional 304 is only useful when the cached body can still be
    // consumed. Validate the collection before sending validators so an
    // interrupted or hand-edited cache cannot silently poison a sync.
    const parsed = JSON.parse(value.body.replace(/^\uFEFF/, ''))
    createIconifyJsonResolver(parsed)
    return {
      url,
      body: value.body,
      ...(typeof value.etag === 'string' && value.etag ? { etag: value.etag } : {}),
      ...(typeof value.lastModified === 'string' && value.lastModified ? { lastModified: value.lastModified } : {}),
    }
  }
  catch {
    return undefined
  }
}

async function writeRemoteCache(file: string, value: RemoteIconifyCache, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    throwIfAborted(signal)
    await rename(temporary, file)
  }
  catch (error) {
    // Cache persistence is an optimization. A read-only cache must not make a
    // successfully fetched collection unusable, while cancellation remains
    // observable to the caller.
    throwIfAborted(signal)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return
    }
  }
  finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function loadRemoteBody(source: ResolvedIconifySourceConfig, options: { cwd: string, cacheDir: string, signal?: AbortSignal }): Promise<string> {
  const url = source.url!
  const file = remoteCacheFile(resolve(options.cwd, options.cacheDir), url)
  const cached = await readRemoteCache(file, url)
  const headers = new Headers()
  if (cached?.etag) {
    headers.set('If-None-Match', cached.etag)
  }
  if (cached?.lastModified) {
    headers.set('If-Modified-Since', cached.lastModified)
  }

  throwIfAborted(options.signal)
  let response: Response
  try {
    response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: requestSignal(options.signal),
    })
  }
  catch (error) {
    throwIfAborted(options.signal)
    throw new IconctlError(`Could not fetch remote Iconify JSON from ${url}. The request failed or timed out.`, { cause: error })
  }
  throwIfAborted(options.signal)

  if (response.status === 304) {
    await response.body?.cancel()
    if (!cached) {
      throw new IconctlError(`Remote Iconify JSON at ${url} returned 304, but no valid cached body is available.`)
    }
    return cached.body
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new IconctlError(`Remote Iconify JSON request failed (HTTP ${response.status}) for ${url}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }

  let body: string
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    throwIfAborted(options.signal)
    body = decodeUtf8(bytes)
  }
  catch (error) {
    throwIfAborted(options.signal)
    if (error instanceof IconctlError) {
      throw error
    }
    throw new IconctlError(`Cannot decode remote Iconify JSON from ${url}`, { cause: error })
  }
  const text = body.replace(/^\uFEFF/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
    createIconifyJsonResolver(parsed)
  }
  catch (error) {
    throw new IconctlError(`Cannot parse remote Iconify JSON from ${url}`, { cause: error })
  }
  await writeRemoteCache(file, { url, body, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}), ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}) }, options.signal)
  return body
}

export async function loadIconifySource(
  source: ResolvedIconifySourceConfig,
  options: { cwd: string, prefix: string, skipPrefix: string[], cacheDir?: string, signal?: AbortSignal },
): Promise<LoadedSource> {
  const file = source.file ? resolve(options.cwd, source.file) : undefined
  let body: string
  if (source.url) {
    body = await loadRemoteBody(source, { cwd: options.cwd, cacheDir: options.cacheDir ?? '.iconctl-cache', ...(options.signal ? { signal: options.signal } : {}) })
  }
  else {
    const bytes = await settleWithAbort(() => readFile(file!, { ...(options.signal ? { signal: options.signal } : {}) }), options.signal)
    try {
      body = decodeUtf8(bytes)
    }
    catch (error) {
      throwIfAborted(options.signal)
      throw new IconctlError(`Cannot parse Iconify JSON: ${file}`, { cause: error })
    }
  }
  let value: unknown
  try {
    value = JSON.parse(body.replace(/^\uFEFF/, ''))
  }
  catch {
    throw new IconctlError(`Cannot parse Iconify JSON: ${source.url ?? file}`)
  }
  const resolver = createIconifyJsonResolver(value)
  const names = source.include === undefined ? resolver.names : [...source.include].sort()
  const iconSet = blankIconSet(options.prefix)
  const issues: NonNullable<LoadedSource['issues']> = []
  for (const original of names) {
    await checkpoint(options.signal)
    if (shouldSkipName(original, options.skipPrefix)) {
      continue
    }
    const name = `${source.namePrefix}${original}`
    const result = resolver.resolve(original)
    if ('issue' in result) {
      issues.push({ name, message: result.issue.message, stage: 'import' })
      continue
    }
    try {
      const { body, left, top, width, height } = result.icon
      const svg = new SVG(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${body}</svg>`)
      cleanupSVG(svg)
      if (!iconSet.fromSVG(name, svg)) {
        throw new Error('Invalid icon name or SVG')
      }
    }
    catch {
      issues.push({ name, stage: 'import', message: 'Cannot import the Iconify SVG body. Check its markup and dimensions.' })
    }
  }
  await checkpoint(options.signal)
  return { type: 'iconify', iconSet, notModified: false, issues }
}

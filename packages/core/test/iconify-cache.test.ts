import type * as fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlAbortError, inspectIconifyCache, resolveConfig, sync } from '../src'
import { readIconifyCacheEntry, remoteCacheFile } from '../src/iconify-cache'
import { ICONIFY_BODY_MAX_BYTES, ICONIFY_CACHE_MAX_BYTES } from '../src/iconify-limits'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})
// Exercise exact byte boundaries without allocating several production-size
// collections in parallel with the rest of the suite.
vi.mock('../src/iconify-limits', () => ({
  ICONIFY_BODY_MAX_BYTES: 1024,
  ICONIFY_CACHE_MAX_BYTES: 2 * 1024 + 64 * 1024,
}))
const actual = await vi.importActual<typeof fs>('node:fs/promises')

beforeEach(() => {
  vi.mocked(open).mockReset().mockImplementation(actual.open)
})
afterEach(() => {
  vi.mocked(open).mockReset().mockImplementation(actual.open)
})

const body = JSON.stringify({ prefix: 'vendor', icons: { home: { body: '<path/>' } } })

describe('remote Iconify cache diagnostics', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'iconctl-cache-diagnostics-'))
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('Cache diagnostics must not fetch')
    }))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it('reports a missing cache without creating it or contacting the network', async () => {
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache' })
    expect(report).toEqual({
      directory: join(cwd, '.cache', 'iconify-v1'),
      entries: [],
      valid: 0,
      invalid: 0,
      missing: 0,
    })
  })

  it('validates bodies and preserves safe validator metadata', async () => {
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    const url = 'https://cdn.example.test/vendor.json'
    const file = `${createHash('sha256').update(url).digest('hex')}.json`
    await writeFile(join(directory, file), JSON.stringify({
      url,
      body,
      etag: '"v1"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    }))
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache' })
    expect(report.valid).toBe(1)
    expect(report.invalid).toBe(0)
    expect(report.entries[0]).toMatchObject({
      status: 'valid',
      url,
      etag: '"v1"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      bodyBytes: Buffer.byteLength(body),
    })
    expect(report.entries[0]).not.toHaveProperty('body')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports malformed metadata, body and UTF-8 independently', async () => {
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'metadata.json'), '{')
    const invalidBodyUrl = 'https://cdn.example.test/body.json'
    await writeFile(join(directory, `${createHash('sha256').update(invalidBodyUrl).digest('hex')}.json`), JSON.stringify({ url: invalidBodyUrl, body: '{"prefix":"vendor","icons":[]}' }))
    const malformed = Buffer.from(JSON.stringify({ url: 'https://cdn.example.test/utf8.json', body }))
    malformed[malformed.length - 2] = 0xFF
    await writeFile(join(directory, 'utf8.json'), malformed)
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache' })
    expect(report.valid).toBe(0)
    expect(report.invalid).toBe(3)
    expect(report.entries.map(entry => entry.error).sort()).toEqual([
      'Cached Iconify JSON is invalid',
      'Cache metadata is not valid JSON',
      'Invalid UTF-8 cache metadata',
    ].sort())
  })

  it('rejects non-HTTPS cache URLs and ignores unrelated files', async () => {
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    const url = 'http://cdn.example.test/icons.json'
    await writeFile(join(directory, `${createHash('sha256').update(url).digest('hex')}.json`), JSON.stringify({ url, body }))
    await writeFile(join(directory, 'readme.txt'), 'not a cache entry')
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache' })
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ status: 'invalid', error: 'Cache URL must be HTTPS and contain no credentials' })
  })

  it('rejects a valid body stored under a filename the loader will not use', async () => {
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'wrong-key.json'), JSON.stringify({ url: 'https://cdn.example.test/icons.json', body }))
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache' })
    expect(report.entries[0]).toMatchObject({ status: 'invalid', keyMatches: false, error: 'Cache filename does not match its URL key' })
  })

  it('locates a requested missing entry without creating any directories', async () => {
    const url = 'https://cdn.example.test/icons.json'
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache', url })
    expect(report).toMatchObject({ valid: 0, invalid: 0, missing: 1, entries: [{ status: 'missing' }] })
    expect(report.entries[0]!.file).toBe(join(cwd, '.cache', 'iconify-v1', `${createHash('sha256').update(url).digest('hex')}.json`))
    expect(await readdir(cwd)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['directory', 'symlink'])('reports a %s entry instead of silently ignoring it', async (kind) => {
    const url = 'https://cdn.example.test/icons.json'
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${createHash('sha256').update(url).digest('hex')}.json`)
    if (kind === 'directory') {
      await mkdir(file)
    }
    else {
      const target = join(cwd, 'outside.json')
      await writeFile(target, JSON.stringify({ url, body }))
      await symlink(target, file)
    }
    for (const options of [{ cwd, cacheDir: '.cache' }, { cwd, cacheDir: '.cache', url }]) {
      expect(await inspectIconifyCache(options)).toMatchObject({ invalid: 1, entries: [{ status: 'invalid', error: 'Cache entry must be a regular file' }] })
    }
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', url }], cacheDir: '.cache' })
    await expect(sync({ cwd, config, offline: true, dryRun: true })).rejects.toThrow('offline mode')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['etag', 'lastModified'])('reports an invalid %s and repairs it with an unconditional online fetch', async (validator) => {
    const url = 'https://cdn.example.test/icons.json'
    const directory = join(cwd, '.cache', 'iconify-v1')
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${createHash('sha256').update(url).digest('hex')}.json`)
    const bytes = JSON.stringify({ url, body, [validator]: 'invalid\r\nheader' })
    await writeFile(file, bytes)
    const report = await inspectIconifyCache({ cwd, cacheDir: '.cache', url })
    expect(report).toMatchObject({ invalid: 1, entries: [{ status: 'invalid', error: `Cache ${validator} is not a valid HTTP header value` }] })
    expect(await readFile(file, 'utf8')).toBe(bytes)
    const requests: Headers[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers))
      return new Response(body, { headers: { ETag: '"repaired"' } })
    }))
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', url }], cacheDir: '.cache' })
    await sync({ cwd, config, dryRun: true })
    expect(requests).toHaveLength(1)
    expect([...requests[0]!.keys()]).toEqual([])
    expect(await inspectIconifyCache({ cwd, cacheDir: '.cache', url })).toMatchObject({ valid: 1, invalid: 0 })
  })
})

describe('bounded cache snapshots', () => {
  let cwd: string
  let file: string
  const url = 'https://cdn.example.test/bounded.json'
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'iconctl-bounded-cache-'))
    file = remoteCacheFile(cwd, url)
    await mkdir(join(cwd, 'iconify-v1'))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it.each([0, 1])('measures the cached body in UTF-8 bytes at the limit plus %s', async (extra) => {
    const base = JSON.stringify({ prefix: 'vendor', icons: { home: { body: '<path/>' } }, title: '图标' })
    const padded = base + ' '.repeat(ICONIFY_BODY_MAX_BYTES - Buffer.byteLength(base) + extra)
    await writeFile(file, JSON.stringify({ url, body: padded }))
    const report = await inspectIconifyCache({ cacheDir: cwd, url })
    expect(report.entries[0]).toMatchObject({
      status: extra === 0 ? 'valid' : 'invalid',
      bodyBytes: ICONIFY_BODY_MAX_BYTES + extra,
      ...(extra ? { error: `Cached Iconify JSON exceeds the ${ICONIFY_BODY_MAX_BYTES}-byte limit` } : {}),
    })
  })

  it.each([0, 1])('bounds metadata independently at the limit plus %s', async (extra) => {
    const metadata = JSON.stringify({ url, body })
    await writeFile(file, metadata + ' '.repeat(ICONIFY_CACHE_MAX_BYTES - Buffer.byteLength(metadata) + extra))
    const report = await readIconifyCacheEntry(file, url)
    expect(report.entry).toMatchObject({
      status: extra === 0 ? 'valid' : 'invalid',
      bytes: ICONIFY_CACHE_MAX_BYTES + extra,
      ...(extra ? { error: `Cache metadata exceeds the ${ICONIFY_CACHE_MAX_BYTES}-byte limit` } : {}),
    })
    // An oversized stat rejects before a descriptor is opened or memory is
    // allocated for the contents.
    expect(open).toHaveBeenCalledTimes(extra === 0 ? 1 : 0)
  })

  it('bounds actual bytes when metadata grows beyond its initial stat', async () => {
    const metadata = JSON.stringify({ url, body })
    await writeFile(file, metadata)
    let bytesRead = 0
    let close: ReturnType<typeof vi.fn<() => Promise<void>>> | undefined
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle)
      let grew = false
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs)
        bytesRead += result.bytesRead
        if (!grew) {
          grew = true
          await appendFile(file, ' '.repeat(ICONIFY_CACHE_MAX_BYTES))
        }
        return result
      })
      close = vi.fn(handle.close.bind(handle))
      handle.close = close
      return handle
    })
    expect((await readIconifyCacheEntry(file, url)).entry).toMatchObject({
      status: 'invalid',
      bytes: Buffer.byteLength(metadata) + 1,
      error: 'Cache entry changed while it was being read',
    })
    expect(bytesRead).toBe(Buffer.byteLength(metadata) + 1)
    expect(close).toHaveBeenCalledOnce()
  })

  it.each(['replace', 'symlink'])('rejects a %s between path inspection and opening', async (change) => {
    await writeFile(file, JSON.stringify({ url, body }))
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const previous = `${file}.previous`
      await rename(file, previous)
      if (change === 'symlink') {
        await symlink(previous, file)
      }
      else {
        await writeFile(file, JSON.stringify({ url, body }))
      }
      return actual.open(...args)
    })
    expect((await readIconifyCacheEntry(file, url)).entry.status).toBe('invalid')
  })

  it.each(['grow', 'replace'])('rejects a cache that undergoes %s during reading', async (change) => {
    await writeFile(file, JSON.stringify({ url, body }))
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      const read = handle.read.bind(handle)
      let changed = false
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs)
        if (!changed) {
          changed = true
          if (change === 'grow') {
            await appendFile(file, ' ')
          }
          else {
            await rename(file, `${file}.previous`)
            await writeFile(file, JSON.stringify({ url, body }))
          }
        }
        return result
      })
      return handle
    })
    expect((await readIconifyCacheEntry(file, url)).entry).toMatchObject({
      status: 'invalid',
      error: 'Cache entry changed while it was being read',
    })
  })

  it('propagates cancellation before reading instead of reporting an invalid cache', async () => {
    await expect(readIconifyCacheEntry(file, url, AbortSignal.abort('stop'))).rejects.toBeInstanceOf(IconctlAbortError)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['open', 'read'])('closes the descriptor when cancellation arrives during %s', async (stage) => {
    await writeFile(file, JSON.stringify({ url, body }))
    const controller = new AbortController()
    let close: ReturnType<typeof vi.fn<() => Promise<void>>> | undefined
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      close = vi.fn(handle.close.bind(handle))
      handle.close = close
      if (stage === 'open') {
        controller.abort('stop')
      }
      else {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs)
          controller.abort('stop')
          return result
        })
      }
      return handle
    })
    await expect(readIconifyCacheEntry(file, url, controller.signal)).rejects.toMatchObject({ name: 'AbortError', cause: 'stop' })
    expect(close).toHaveBeenCalledOnce()
  })

  it.each(['body', 'metadata'])('rejects an oversized cache %s offline and repairs it online without validators', async (kind) => {
    const metadata = JSON.stringify({ url, body: kind === 'body' ? `${body}${' '.repeat(ICONIFY_BODY_MAX_BYTES)}` : body, etag: '"old"' })
    const contents = kind === 'metadata' ? `${metadata}${' '.repeat(ICONIFY_CACHE_MAX_BYTES)}` : metadata
    await writeFile(file, contents)
    const requests: Headers[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers))
      return new Response(body, { headers: { ETag: '"new"' } })
    }))
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', url }], cacheDir: cwd })
    await expect(sync({ cwd, config, offline: true, dryRun: true })).rejects.toThrow(/offline mode.*exceeds/)
    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(contents)
    await sync({ cwd, config, dryRun: true })
    expect(requests).toHaveLength(1)
    expect([...requests[0]!.keys()]).toEqual([])
    expect(await inspectIconifyCache({ cacheDir: cwd, url })).toMatchObject({ valid: 1, invalid: 0 })
  })

  it.each([false, true])('skips writing excessive metadata while preserving any old cache: %s', async (existing) => {
    const metadata = JSON.stringify({ url, body, etag: '"old"' })
    if (existing) {
      await writeFile(file, metadata)
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { ETag: 'x'.repeat(ICONIFY_CACHE_MAX_BYTES) } })))
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', url }], cacheDir: cwd })
    expect((await sync({ cwd, config, dryRun: true })).processed).toBe(1)
    if (existing) {
      expect(await readFile(file, 'utf8')).toBe(metadata)
    }
    else {
      expect(await readdir(join(cwd, 'iconify-v1'))).toEqual([])
    }
  })
})

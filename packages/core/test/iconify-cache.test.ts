import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectIconifyCache, resolveConfig, sync } from '../src'

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

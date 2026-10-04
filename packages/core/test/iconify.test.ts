import type { IconctlConfig } from '../src'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers'
import { IconSet } from '@iconify/tools'
import { IconctlAbortError, IconctlSyncError, resolveConfig, sync } from '../src'
import { loadIconifySource } from '../src/sources/iconify'

let cwd: string
const body = '<path d="M0 0h4v8H0z" fill="#123456"/>'
const vendor = { prefix: 'vendor', icons: { home: { body } } }
function configuration(extra: Partial<IconctlConfig> = {}) {
  return resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'iconify', file: 'vendor.json' }],
    output: { json: 'out.json', svg: 'svg', changelog: 'changes.md' },
    ...extra,
  })
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-iconify-'))
  await writeFile(join(cwd, 'vendor.json'), JSON.stringify(vendor))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

it('accepts a UTF-8 BOM in a vendor collection file', async () => {
  await writeFile(join(cwd, 'vendor.json'), `\uFEFF${JSON.stringify(vendor)}`)
  const result = await sync({ cwd, config: configuration(), dryRun: true })
  expect(Object.keys(result.json.icons)).toEqual(['home'])
})

it('loads a remote Iconify collection and reuses a valid body on 304', async () => {
  const url = 'https://cdn.example.test/vendor.json'
  const requests: Request[] = []
  const responses = [
    new Response(`\uFEFF${JSON.stringify(vendor)}`, { status: 200, headers: [['etag', '"v1"'], ['last-modified', 'Mon, 01 Jan 2024 00:00:00 GMT']] }),
    new Response(null, { status: 304 }),
  ]
  vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
    requests.push(new Request(url, init))
    return responses.shift()!
  }))
  const config = configuration({
    cacheDir: '.cache',
    sources: [{ type: 'iconify', url }],
  })
  const first = await sync({ cwd, config, dryRun: true })
  expect(first.json.icons).toHaveProperty('home')
  const second = await sync({ cwd, config, dryRun: true })
  expect(second.json.icons).toHaveProperty('home')
  expect(requests).toHaveLength(2)
  expect(requests[1]!.headers.get('If-None-Match')).toBe('"v1"')
  expect(requests[1]!.headers.get('If-Modified-Since')).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
  expect((await readdir(join(cwd, '.cache', 'iconify-v1'))).length).toBe(1)
})

it('fetches changed remote collections and ignores malformed cache metadata', async () => {
  const url = 'https://cdn.example.test/vendor.json'
  const first = JSON.stringify(vendor)
  const changed = JSON.stringify({ prefix: 'vendor', icons: { account: { body } } })
  const requests: Request[] = []
  const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    requests.push(new Request(url, init))
    return requests.length === 1
      ? new Response(first, { status: 200, headers: { ETag: '"v1"' } })
      : new Response(changed, { status: 200, headers: { ETag: '"v2"' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  const config = configuration({ cacheDir: 'remote-cache', sources: [{ type: 'iconify', url }] })
  expect(Object.keys((await sync({ cwd, config, dryRun: true })).json.icons)).toEqual(['home'])
  expect(Object.keys((await sync({ cwd, config, dryRun: true })).json.icons)).toEqual(['account'])
  expect(requests[1]!.headers.get('If-None-Match')).toBe('"v1"')

  // A corrupt cache is ignored, so the next request is unconditional and can
  // repair it instead of accepting an invalid 304 body.
  const files = await readdir(join(cwd, 'remote-cache', 'iconify-v1'))
  await writeFile(join(cwd, 'remote-cache', 'iconify-v1', files[0]!), '{not-json')
  await sync({ cwd, config, dryRun: true })
  expect(requests[2]!.headers.get('If-None-Match')).toBeNull()
})

it('rejects a 304 response when the cached body is unavailable', async () => {
  const url = 'https://cdn.example.test/vendor.json'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })))
  await expect(sync({ cwd, config: configuration({ sources: [{ type: 'iconify', url }] }), dryRun: true })).rejects.toThrow('304')
})

it('rejects malformed remote JSON without writing a cache entry', async () => {
  const url = 'https://cdn.example.test/malformed.json'
  vi.stubGlobal('fetch', vi.fn(async () => new Response('\uFEFF{"prefix":"vendor","icons":[]}', { status: 200 })))
  const config = configuration({ cacheDir: 'malformed-cache', sources: [{ type: 'iconify', url }] })
  await expect(sync({ cwd, config, dryRun: true })).rejects.toThrow('Cannot parse remote Iconify JSON')
  await expect(readdir(join(cwd, 'malformed-cache'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancels a remote Iconify request', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
    return new Response(JSON.stringify(vendor))
  }))
  const pending = sync({ cwd, config: configuration({ sources: [{ type: 'iconify', url: 'https://cdn.example.test/vendor.json' }] }), signal: controller.signal, dryRun: true })
  setImmediate(() => controller.abort())
  await expect(pending).rejects.toBeInstanceOf(IconctlAbortError)
})

it('rejects malformed UTF-8 before resolving an Iconify source', async () => {
  const bytes = Buffer.from('{"prefix":"vendor","icons":{"bad":{"body":"<path/>"}}}')
  bytes[bytes.indexOf('bad') + 2] = 255
  await writeFile(join(cwd, 'vendor.json'), bytes)
  await expect(sync({ cwd, config: configuration(), continueOnError: true })).rejects.toThrow(`Cannot parse Iconify JSON: ${join(cwd, 'vendor.json')}`)
})

it('mixes prefixed aliases and SVG sources through the normal processing pipeline', async () => {
  await mkdir(join(cwd, 'raw'))
  await writeFile(join(cwd, 'raw', 'local.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`)
  await writeFile(join(cwd, 'vendor.json'), JSON.stringify({
    ...vendor,
    width: 24,
    aliases: { rotated: { parent: 'home', rotate: 1 }, reflected: { parent: 'rotated', hFlip: true } },
  }))
  const result = await sync({ cwd, config: configuration({ sources: [
    { type: 'directory', dir: 'raw' },
    { type: 'iconify', file: 'vendor.json', include: ['reflected'], namePrefix: 'vendor-' },
  ] }) })
  expect(result.prefix).toBe('brand')
  expect(result.complete).toBe(true)
  expect(Object.keys(result.json.icons)).toEqual(['local', 'vendor-reflected'])
  expect(new IconSet(result.json).toSVG('vendor-reflected')!.viewBox).toEqual({ left: 0, top: 0, width: 16, height: 24 })
  expect(result.json.icons['vendor-reflected']!.body).toContain('currentColor')
  expect(result.sources.map(source => source.type)).toEqual(['directory', 'iconify'])
  expect(await readFile(join(cwd, 'svg', 'vendor-reflected.svg'), 'utf8')).toContain('<svg')
})

it('uses exact include names, ignores unselected failures, and treats [] as an empty selection', async () => {
  await writeFile(join(cwd, 'vendor.json'), JSON.stringify({ ...vendor, icons: { ...vendor.icons, broken: null } }))
  const selected = await sync({ cwd, config: configuration({ sources: [{ type: 'iconify', file: 'vendor.json', include: ['home', 'home'] }] }), dryRun: true })
  expect(selected.complete).toBe(true)
  expect(Object.keys(selected.json.icons)).toEqual(['home'])
  const empty = await sync({ cwd, config: configuration({ sources: [{ type: 'iconify', file: 'vendor.json', include: [] }] }), dryRun: true })
  expect(empty.complete).toBe(true)
  expect(empty.json.icons).toEqual({})
  await expect(readFile(join(cwd, 'out.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves outputs on selected entry failures and reports safe partial results only when requested', async () => {
  const previous = { prefix: 'brand', icons: { previous: { body } } }
  await writeFile(join(cwd, 'out.json'), JSON.stringify(previous))
  await writeFile(join(cwd, 'changes.md'), 'keep history\n')
  await writeFile(join(cwd, 'vendor.json'), JSON.stringify({ ...vendor, icons: { ...vendor.icons, broken: { body: 4 } }, aliases: { circular: { parent: 'circular' } } }))
  const config = configuration({ sources: [{ type: 'iconify', file: 'vendor.json', include: ['home', 'broken', 'circular', 'absent'], namePrefix: 'v-' }] })
  await expect(sync({ cwd, config })).rejects.toBeInstanceOf(IconctlSyncError)
  expect(JSON.parse(await readFile(join(cwd, 'out.json'), 'utf8'))).toEqual(previous)
  const partial = await sync({ cwd, config, continueOnError: true })
  expect(partial.complete).toBe(false)
  expect(partial.diff).toMatchObject({ removed: [], deletionsReliable: false })
  expect(partial.failed).toEqual(['v-absent', 'v-broken', 'v-circular'])
  expect(partial.issues).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'v-circular', stage: 'import', sourceType: 'iconify', sourceIndex: 0 })]))
  expect(Object.keys(partial.json.icons)).toEqual(['v-home'])
  expect(await readFile(join(cwd, 'changes.md'), 'utf8')).toBe('keep history\n')
})

it.each(['not json', '{"prefix":"vendor","icons":[]}', '{"prefix":"vendor","icons":{},"width":0}'])('treats unreadable collection structure as fatal even with continue: %s', async (contents) => {
  await writeFile(join(cwd, 'vendor.json'), contents)
  await expect(sync({ cwd, config: configuration(), continueOnError: true })).rejects.toThrow()
  await expect(readFile(join(cwd, 'out.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('treats a missing source file as fatal even with continue', async () => {
  await rm(join(cwd, 'vendor.json'))
  await expect(sync({ cwd, config: configuration(), continueOnError: true })).rejects.toThrow()
})

it('applies project size validation and preserves source colors when requested', async () => {
  await expect(sync({ cwd, config: configuration({ validate: { width: 24 } }), dryRun: true })).rejects.toBeInstanceOf(IconctlSyncError)
  const result = await sync({ cwd, config: configuration({ color: false }), dryRun: true })
  expect(result.json.icons['home']!.body).toContain('#123456')
  expect(new IconSet(result.json).toSVG('home')!.viewBox.width).toBe(16)
})

it('cancels local reads and yields while importing selected icons', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(sync({ cwd, config: configuration(), signal: controller.signal })).rejects.toBeInstanceOf(IconctlAbortError)
  await writeFile(join(cwd, 'vendor.json'), JSON.stringify({ prefix: 'vendor', icons: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`icon-${index}`, { body }])) }))
  const importing = new AbortController()
  const pending = loadIconifySource({ type: 'iconify', file: 'vendor.json', namePrefix: '' }, { cwd, prefix: 'brand', skipPrefix: [], signal: importing.signal })
  setImmediate(() => importing.abort())
  await expect(pending).rejects.toBeInstanceOf(IconctlAbortError)
  await expect(readFile(join(cwd, 'out.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

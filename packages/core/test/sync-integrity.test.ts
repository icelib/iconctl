import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankIconSet, SVG } from '@iconify/tools'
import { IconctlSyncError, resolveConfig, sync } from '../src'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h12v24H0z"/></svg>'
let cwd: string
let version: number
let failure: 'none' | 'missing' | 'empty' | 'download' | 'timeout' | 'parse' | 'all' | 'document'
let downloads: string[]
const output = { json: 'icons.json', svg: 'svg', types: 'types.ts', preview: 'preview.html', changelog: 'CHANGELOG.md', jsonPackage: 'pkg' }
function config() {
  return resolveConfig({ prefix: 'fixture', sources: [{ type: 'figma', file: 'fixture12345678', token: 'fake-pat' }], output })
}
function document() {
  return {
    editorType: 'figma',
    version: String(version),
    lastModified: `version-${version}`,
    document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Icons', type: 'CANVAS', children: ['good', 'bad'].map((name, i) => ({
      id: `1:${i}`,
      name,
      type: 'COMPONENT',
      children: [],
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
    })) }] },
  }
}
const savedFiles = ['icons.json', 'svg/old.svg', 'types.ts', 'preview.html', 'CHANGELOG.md', 'pkg/KEEP.md']
async function seed() {
  await mkdir(join(cwd, 'svg'), { recursive: true })
  await mkdir(join(cwd, 'pkg'), { recursive: true })
  for (const file of savedFiles) {
    await writeFile(join(cwd, file), file === 'icons.json'
      ? JSON.stringify({ prefix: 'fixture', width: 24, height: 24, icons: { good: { body: '<path d="M0 0h12v24H0z"/>' }, bad: { body: '<path/>' } } })
      : `old-${file}`)
  }
}
async function snapshot() {
  return await Promise.all(savedFiles.map(file => readFile(join(cwd, file), 'utf8')))
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-integrity-'))
  version = 1
  failure = 'none'
  downloads = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      return failure === 'document' ? new Response('', { status: 503 }) : Response.json(document())
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({ images: {
        '1:0': `https://fixture.invalid/good-${version}.svg`,
        ...(failure === 'missing' ? {} : { '1:1': `https://fixture.invalid/bad-${version}.svg` }),
      } })
    }
    downloads.push(url.pathname)
    if (failure === 'all' || url.pathname.startsWith('/bad')) {
      if (failure === 'download' || failure === 'all') {
        return new Response('', {
          status: 503,
        })
      }
      if (failure === 'parse') {
        return new Response('not svg')
      }
      if (failure === 'empty') {
        return new Response('')
      }
      if (failure === 'timeout') {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }
    }
    return new Response(svg)
  }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

it.each([
  ['missing', 'export-url'],
  ['empty', 'import'],
  ['download', 'download'],
  ['parse', 'import'],
  ['timeout', 'download'],
] as const)('rejects %s without changing any previous output', async (mode, stage) => {
  await seed()
  const before = await snapshot()
  failure = mode
  if (mode === 'timeout') {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10))
  }
  const error = await sync({ cwd, config: config() }).catch(error => error)
  expect(error).toBeInstanceOf(IconctlSyncError)
  expect(error.issues).toEqual([expect.objectContaining({ name: 'bad', nodeId: '1:1', fileKey: 'fixture12345678', sourceIndex: 0, sourceType: 'figma', stage })])
  expect(await snapshot()).toEqual(before)
})

it.each(['missing', 'parse', 'download'] as const)('reports partial %s and retries the failed item on the next sync', async (mode) => {
  await seed()
  failure = mode
  const result = await sync({ cwd, config: config(), continueOnError: true })
  expect(result).toMatchObject({ complete: false, failed: ['bad'], diff: { removed: [], deletionsReliable: false } })
  expect(result.issues).toHaveLength(1)
  expect(Object.keys(result.json.icons)).toEqual(['good'])
  expect(await readFile(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe('old-CHANGELOG.md')
  expect(result.files).not.toContain(join(cwd, 'CHANGELOG.md'))
  await expect(readFile(join(cwd, '.iconctl-cache/meta.json'))).rejects.toThrow()
  failure = 'none'
  const next = await sync({ cwd, config: config() })
  expect(next.complete).toBe(true)
  expect(Object.keys(next.json.icons).sort()).toEqual(['bad', 'good'])
  expect(downloads.filter(path => path.includes('bad')).length).toBeGreaterThanOrEqual(1)
  expect((await sync({ cwd, config: config() })).notModified).toBe(true)
})

it('invalidates an earlier complete marker after a partial commit', async () => {
  await sync({ cwd, config: config() })
  version = 2
  failure = 'download'
  expect((await sync({ cwd, config: config(), continueOnError: true })).complete).toBe(false)
  failure = 'none'
  const next = await sync({ cwd, config: config() })
  expect(next.notModified).toBe(false)
  expect(next.json.icons['bad']).toBeDefined()
})

it.each(['all', 'document'] as const)('does not export %s failures even in partial mode', async (mode) => {
  await seed()
  const before = await snapshot()
  failure = mode
  await expect(sync({ cwd, config: config(), continueOnError: true })).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})

it('keeps dry runs read-only while reporting incompleteness', async () => {
  await seed()
  const before = await snapshot()
  failure = 'download'
  const result = await sync({ cwd, config: config(), continueOnError: true, dryRun: true })
  expect(result).toMatchObject({ complete: false, files: [], diff: { removed: [], deletionsReliable: false } })
  expect(await snapshot()).toEqual(before)
})

it('gates processing failures as well as loading failures', async () => {
  await seed()
  const before = await snapshot()
  const createSet = () => {
    const set = blankIconSet('fixture')
    set.fromSVG('good', new SVG(svg))
    set.fromSVG('bad', new SVG(svg))
    const toSVG = set.toSVG.bind(set)
    vi.spyOn(set, 'toSVG').mockImplementation(name => name === 'bad' ? null : toSVG(name))
    return set
  }
  await expect(sync({ cwd, config: config(), iconSet: createSet() })).rejects.toMatchObject({ issues: [{ name: 'bad', stage: 'process' }] })
  expect(await snapshot()).toEqual(before)
  expect(await sync({ cwd, config: config(), iconSet: createSet(), continueOnError: true })).toMatchObject({
    complete: false,
    failed: ['bad'],
    issues: [{ name: 'bad', stage: 'process' }],
    diff: { removed: [], deletionsReliable: false },
  })
})

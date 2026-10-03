import type { SyncIssue } from '../src/errors'
import type { FigmaSourceConfig } from '../src/sources/types'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlSyncError, resolveConfig, sync } from '../src'

const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const normalizedCollision = [
  { id: '1:1', name: 'Arrow Left' },
  { id: '1:2', name: 'arrow_left' },
  { id: '1:3', name: 'Check' },
]
interface FixtureIcon { id: string, name: string, page?: string }
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-figma-collisions-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

function config(source: Partial<FigmaSourceConfig> = {}) {
  return resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: fileKey, token: 'fixture', ...source }],
    output: { json: 'icons.json', types: 'types.ts', changelog: 'CHANGELOG.md' },
  })
}

function mockFigma(icons: FixtureIcon[]) {
  const imageBatches: string[][] = []
  const downloads: string[] = []
  const fileScopes: (string[] | undefined)[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.hostname === 'cdn.example.com') {
      downloads.push(decodeURIComponent(url.pathname.slice(1)))
      return new Response(svg)
    }
    if (url.pathname.includes('/files/')) {
      const ids = url.searchParams.get('ids')?.split(',')
      fileScopes.push(ids)
      const selected = ids ? icons.filter(icon => ids.includes(icon.id)) : icons
      const pages = [...new Set(selected.map(icon => icon.page ?? 'Icons'))]
      return Response.json({
        editorType: 'figma',
        version: 'v1',
        lastModified: '2026-10-04T00:00:00Z',
        document: { id: '0:0', type: 'DOCUMENT', children: pages.map((name, index) => ({
          id: `0:${index + 1}`,
          name,
          type: 'CANVAS',
          children: selected.filter(icon => (icon.page ?? 'Icons') === name).map(icon => ({
            id: icon.id,
            name: icon.name,
            type: 'COMPONENT',
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        })) },
      })
    }
    if (url.pathname.includes('/images/')) {
      const ids = url.searchParams.get('ids')!.split(',')
      imageBatches.push(ids)
      return Response.json({ images: Object.fromEntries(ids.map(id => [id, `https://cdn.example.com/${encodeURIComponent(id)}`])) })
    }
    throw new Error(`Unexpected request: ${url.href}`)
  }))
  return { imageBatches, downloads, fileScopes }
}

function expectedIssues(name = 'arrow-left', ids = ['1:1', '1:2'], sourceIndex = 0) {
  return ids.map(nodeId => ({
    name,
    nodeId,
    fileKey,
    sourceType: 'figma',
    sourceIndex,
    stage: 'import',
    message: expect.any(String),
  }))
}

async function seedOutputs() {
  const files = {
    'icons.json': JSON.stringify({ prefix: 'brand', icons: { previous: { body: '<path d="M0 0h24v24H0z"/>', width: 24, height: 24 } } }),
    'types.ts': 'export type Previous = "previous"\n',
    'CHANGELOG.md': '# Previous changes\n',
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cwd, name), content)
  }
  return files
}

async function expectOutputs(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    expect(await readFile(join(cwd, name), 'utf8')).toBe(content)
  }
}

it('rejects normalized same-source names with every node coordinate and preserves previous outputs', async () => {
  const requests = mockFigma(normalizedCollision)
  const previous = await seedOutputs()
  const error = await sync({ cwd, config: config() }).catch(error => error as unknown)
  expect(error).toBeInstanceOf(IconctlSyncError)
  expect((error as IconctlSyncError).issues).toEqual(expectedIssues())
  await expectOutputs(previous)
  await expect(readFile(join(cwd, '.iconctl-cache/meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(requests.imageBatches).toEqual([['1:3']])
  expect(requests.downloads).toEqual(['1:3'])
})

it('excludes the entire conflict group when continuing and commits only independent icons', async () => {
  const requests = mockFigma(normalizedCollision)
  const previous = await seedOutputs()
  const result = await sync({ cwd, config: config(), continueOnError: true })
  expect(result).toMatchObject({ complete: false, notModified: false, failed: ['arrow-left'], processed: 1, diff: { removed: [], deletionsReliable: false } })
  expect(result.issues).toEqual(expectedIssues())
  expect(Object.keys(result.json.icons)).toEqual(['check'])
  expect(Object.keys(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons)).toEqual(['check'])
  expect(await readFile(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(previous['CHANGELOG.md'])
  expect(result.files).not.toContain(join(cwd, 'CHANGELOG.md'))
  await expect(readFile(join(cwd, '.iconctl-cache/meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(requests.imageBatches).toEqual([['1:3']])
  expect(requests.downloads).toEqual(['1:3'])
})

it('keeps conflict provenance at the actual configured source index', async () => {
  mockFigma(normalizedCollision)
  await mkdir(join(cwd, 'empty'))
  const resolved = config()
  resolved.sources.unshift({ type: 'directory', dir: 'empty' })
  const result = await sync({ cwd, config: resolved, continueOnError: true, dryRun: true })
  expect(result.issues).toEqual(expectedIssues('arrow-left', ['1:1', '1:2'], 1))
  expect(Object.keys(result.json.icons)).toEqual(['check'])
})

it('rejects an all-conflicting source even when continuing without exporting or rendering it', async () => {
  const requests = mockFigma(normalizedCollision.slice(0, 2))
  const previous = await seedOutputs()
  const error = await sync({ cwd, config: config(), continueOnError: true }).catch(error => error as unknown)
  expect(error).toBeInstanceOf(IconctlSyncError)
  expect((error as IconctlSyncError).issues).toEqual(expectedIssues())
  await expectOutputs(previous)
  await expect(readFile(join(cwd, '.iconctl-cache/meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(requests.imageBatches).toEqual([])
  expect(requests.downloads).toEqual([])
})

it.each(['string', 'object', 'mixed'] as const)('detects collisions in actual %s hook keywords', async (kind) => {
  const requests = mockFigma([
    { id: '1:1', name: 'First' },
    { id: '1:2', name: 'Second' },
    { id: '1:3', name: 'Check' },
  ])
  const result = await sync({
    cwd,
    config: config({ iconNameForNode: (node) => {
      const keyword = node.id === '1:3' ? 'check' : 'custom-shared'
      return kind === 'string' || (kind === 'mixed' && node.id === '1:1')
        ? keyword
        : { keyword, id: 'hook-cannot-replace-node-id', name: 'hook-cannot-replace-name' }
    } }),
    continueOnError: true,
    dryRun: true,
  })
  expect(result.issues).toEqual(expectedIssues('custom-shared'))
  expect(result.failed).toEqual(['custom-shared'])
  expect(Object.keys(result.json.icons)).toEqual(['check'])
  expect(requests.imageBatches).toEqual([['1:3']])
  expect(requests.downloads).toEqual(['1:3'])
})

it('uses distinct hook keywords even when the default node names would collide', async () => {
  const requests = mockFigma(normalizedCollision.slice(0, 2))
  const result = await sync({
    cwd,
    config: config({ iconNameForNode: node => node.id === '1:1' ? 'custom-first' : { keyword: 'custom-second' } }),
    dryRun: true,
  })
  expect(result.complete).toBe(true)
  expect(result.issues).toEqual([])
  expect(Object.keys(result.json.icons).sort()).toEqual(['custom-first', 'custom-second'])
  expect(requests.imageBatches).toEqual([['1:1', '1:2']])
})

it('does not normalize custom hook keywords a second time', async () => {
  const requests = mockFigma(normalizedCollision.slice(0, 2))
  const resolved = config({ iconNameForNode: node => node.id === '1:1' ? node.name : { keyword: node.name } })
  resolved.validate.name = /^[a-z _-]+$/i
  const result = await sync({ cwd, config: resolved, dryRun: true })
  expect(result.complete).toBe(true)
  expect(result.issues).toEqual([])
  expect(Object.keys(result.json.icons).sort()).toEqual(['Arrow Left', 'arrow_left'])
  expect(requests.imageBatches).toEqual([['1:1', '1:2']])
})

it.each(['pages', 'ids', 'hook'] as const)('detects names only within the selected %s scope', async (scope) => {
  const requests = mockFigma(normalizedCollision.map(icon => ({ ...icon, page: scope === 'pages' && icon.id === '1:2' ? 'Excluded' : 'Icons' })))
  const source: Partial<FigmaSourceConfig> = scope === 'pages'
    ? { pages: ['Icons'] }
    : scope === 'ids'
      ? { ids: ['1:1', '1:3'] }
      : { iconNameForNode: node => node.id === '1:2' ? null : node.id === '1:1' ? 'arrow-left' : 'check' }
  const result = await sync({ cwd, config: config(source), dryRun: true })
  expect(result.complete).toBe(true)
  expect(result.issues).toEqual([])
  expect(Object.keys(result.json.icons).sort()).toEqual(['arrow-left', 'check'])
  expect(requests.imageBatches).toEqual([['1:1', '1:3']])
  expect(requests.downloads.sort()).toEqual(['1:1', '1:3'])
  if (scope === 'ids') {
    expect(requests.fileScopes).toEqual([['1:1', '1:3']])
  }
})

it('keeps partial outputs and complete diagnostics stable when Figma traversal order changes', async () => {
  const icons = [
    ...normalizedCollision,
    { id: '1:4', name: 'arrow-left' },
    { id: '2:1', name: 'User Add' },
    { id: '2:2', name: 'user_add' },
  ]
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T00:00:00Z'))
  try {
    let previous: { json: unknown, issues: SyncIssue[], failed: string[] } | undefined
    for (const [index, order] of [icons, [...icons].reverse()].entries()) {
      const directory = join(cwd, String(index))
      await mkdir(directory)
      const requests = mockFigma(order)
      const result = await sync({ cwd: directory, config: config(), continueOnError: true, dryRun: true })
      expect(result.complete).toBe(false)
      expect(result.issues).toEqual([
        ...expectedIssues('arrow-left', ['1:1', '1:2', '1:4']),
        ...expectedIssues('user-add', ['2:1', '2:2']),
      ])
      expect(result.failed).toEqual(['arrow-left', 'user-add'])
      expect(Object.keys(result.json.icons)).toEqual(['check'])
      expect(requests.imageBatches).toEqual([['1:3']])
      expect(requests.downloads).toEqual(['1:3'])
      const current = { json: result.json, issues: result.issues, failed: result.failed }
      if (previous) {
        expect(current).toEqual(previous)
      }
      previous = current
    }
  }
  finally {
    now.mockRestore()
  }
})

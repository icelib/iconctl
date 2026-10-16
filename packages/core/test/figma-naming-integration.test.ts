import type { IconctlConfig } from '../src/config'
import type { FigmaNamingManifest } from '../src/figma-naming-plan'
import type { SourceConfig } from '../src/sources/types'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlSyncError, preflightFigmaNaming, resolveConfig, sync } from '../src'

const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
const otherFileKey = 'ZyXwVuTsRqPoNmLkJiHgFe'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const duplicateIcons = [
  { id: '34:1698', name: 'bell' },
  { id: '34:1779', name: 'more' },
  { id: '34:1970', name: 'data-board' },
  { id: '34:2231', name: 'eleme' },
  { id: '34:2238', name: 'eleme' },
  { id: '5398:44', name: 'bell' },
  { id: '5398:45', name: 'data-board' },
  { id: '78:1939', name: 'more' },
]
const expectedNames = ['bell', 'bell-5398-44', 'data-board', 'data-board-5398-45', 'eleme', 'eleme-34-2238', 'more', 'more-78-1939']
interface FixtureIcon { id: string, name: string, type?: string }
interface FixtureFile { icons: FixtureIcon[], version: string, lastModified: string }
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-figma-naming-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

function config(overrides: Partial<IconctlConfig> = {}) {
  return resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: fileKey, token: 'fixture', naming: { duplicates: 'suffix-node-id' } }],
    output: { json: 'icons.json' },
    ...overrides,
  })
}

function mockFigma(icons: FixtureIcon[] = duplicateIcons) {
  const files: Record<string, FixtureFile> = {
    [fileKey]: { icons: [...icons], version: 'v1', lastModified: '2026-10-16T00:00:00Z' },
  }
  const requests: URL[] = []
  const failedDownloads = new Set<string>()
  let documentBarrier: { entered: () => void, released: Promise<void> } | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    requests.push(url)
    if (url.hostname === 'cdn.example.com') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
      return new Response(failedDownloads.has(id) ? 'unavailable' : svg, { status: failedDownloads.has(id) ? 503 : 200 })
    }
    const key = url.pathname.split('/').at(-1)!
    const file = files[key]
    if (!file) {
      throw new Error(`Unexpected Figma file: ${url.href}`)
    }
    if (url.pathname.includes('/files/')) {
      const barrier = documentBarrier
      documentBarrier = undefined
      if (barrier) {
        barrier.entered()
        await barrier.released
      }
      const ids = url.searchParams.get('ids')?.split(',')
      const selected = ids ? file.icons.filter(icon => ids.includes(icon.id)) : file.icons
      return Response.json({
        editorType: 'figma',
        version: file.version,
        lastModified: file.lastModified,
        document: { id: '0:0', type: 'DOCUMENT', children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: selected.map(icon => ({
            type: 'COMPONENT',
            ...icon,
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        }] },
      })
    }
    if (url.pathname.includes('/images/')) {
      const ids = url.searchParams.get('ids')!.split(',')
      return Response.json({ images: Object.fromEntries(ids.map(id => [id, `https://cdn.example.com/${key}/${file.version}/${encodeURIComponent(id)}`])) })
    }
    throw new Error(`Unexpected request: ${url.href}`)
  }))
  return {
    files,
    requests,
    failedDownloads,
    pauseNextDocument() {
      let release!: () => void
      let entered!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const pending = new Promise<void>((resolve) => {
        entered = resolve
      })
      documentBarrier = { entered, released }
      return { entered: pending, release }
    },
    revise(next: FixtureIcon[]) {
      const previous = files[fileKey]!
      files[fileKey] = { icons: next, version: `${previous.version}-next`, lastModified: `${previous.lastModified}-next` }
    },
  }
}

function assigned(result: { naming?: { mappings: { nodeId: string, name?: string }[] }[] }) {
  return Object.fromEntries(result.naming![0]!.mappings.map(mapping => [mapping.nodeId, mapping.name]))
}

async function manifest(): Promise<FigmaNamingManifest> {
  return JSON.parse(await readFile(join(cwd, '.iconctl-names.json'), 'utf8'))
}

async function expectMissing(file: string) {
  await expect(readFile(join(cwd, file))).rejects.toMatchObject({ code: 'ENOENT' })
}

it('imports all eight reported nodes with compatible bare names and successful warning diagnostics', async () => {
  mockFigma()
  const result = await sync({ cwd, config: config() })
  expect(Object.keys(result.json.icons).sort()).toEqual(expectedNames)
  expect(result.complete).toBe(true)
  expect(result.failed).toEqual([])
  expect(result.issues).toHaveLength(8)
  expect(result.issues.every(issue => issue.severity === 'warning' && issue.code === 'FIGMA_NAME_DISAMBIGUATED')).toBe(true)
  expect(result.files).toContain(join(cwd, '.iconctl-names.json'))
  expect(Object.values((await manifest()).sources)[0]!.activeNodeIds.sort()).toEqual(duplicateIcons.map(icon => icon.id).sort())
})

it('keeps node ownership through reordering, earlier IDs, renames, deletion and restoration', async () => {
  const fixture = mockFigma()
  const first = await sync({ cwd, config: config() })
  const original = assigned(first)
  fixture.revise([...duplicateIcons].reverse())
  expect(assigned(await sync({ cwd, config: config() }))).toEqual(original)

  const earlier = { id: '1:1', name: 'bell' }
  fixture.revise([earlier, ...duplicateIcons.map(icon => icon.id === '34:1698' ? { ...icon, name: 'Notification' } : icon)])
  const changed = await sync({ cwd, config: config() })
  expect(assigned(changed)).toMatchObject({ ...original, '1:1': 'bell-1-1' })
  expect(changed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: '34:1698', name: 'bell', code: 'FIGMA_NAME_PRESERVED' })]))

  fixture.revise([earlier, ...duplicateIcons.filter(icon => icon.id !== '34:1698')])
  const deleted = await sync({ cwd, config: config() })
  expect(assigned(deleted)['1:1']).toBe('bell-1-1')
  expect(assigned(deleted)['5398:44']).toBe('bell-5398-44')
  expect(deleted.json.icons).not.toHaveProperty('bell')
  expect(Object.values((await manifest()).sources)[0]!.entries['34:1698']!.name).toBe('bell')

  fixture.revise([earlier, ...duplicateIcons])
  expect(assigned(await sync({ cwd, config: config() }))).toMatchObject({ ...original, '1:1': 'bell-1-1' })
})

it('preflights without images or artifacts and produces the same mappings as a first dry-run', async () => {
  const fixture = mockFigma()
  const preview = await preflightFigmaNaming({ cwd, config: config() })
  expect(preview.complete).toBe(true)
  expect(preview.files).toEqual([])
  expect(fixture.requests.every(url => url.hostname === 'api.figma.com' && url.pathname.includes('/files/'))).toBe(true)
  await expectMissing('.iconctl-names.json')
  await expectMissing('icons.json')
  await expectMissing('.iconctl-cache/meta.json')
  const dry = await sync({ cwd, config: config(), dryRun: true })
  expect(dry.naming).toEqual(preview.naming)
  expect(dry.files).toEqual([])
  expect(preview.publicNames).toEqual({ added: expectedNames, removed: [], deletionsReliable: true })
  await expectMissing('.iconctl-names.json')
  await expectMissing('icons.json')
  await expectMissing('.iconctl-cache/meta.json')
})

it('runs naming transforms after default filtering and allows explicitly skipping a valid node', async () => {
  mockFigma([
    { id: '1:1', name: '' },
    { id: '1:2', name: '_hidden' },
    { id: '1:3', name: '.draft' },
    { id: '1:4', name: 'Instance', type: 'INSTANCE' },
    { id: '1:5', name: 'Bell' },
    { id: '1:6', name: 'More' },
  ])
  const transform = vi.fn((name: string, node: { id: string }) => node.id === '1:6' ? null : `Brand_${name}`)
  const result = await sync({ cwd, config: config({
    sources: [{ type: 'figma', file: fileKey, token: 'fixture', naming: { transform } }],
  }), dryRun: true })
  expect(transform.mock.calls.map(([name, node]) => [name, node.id])).toEqual([['bell', '1:5'], ['more', '1:6']])
  expect(Object.keys(result.json.icons)).toEqual(['brand-bell'])
})

it.each([false, true])('preserves an existing manifest when SVG downloads fail (continueOnError=%s)', async (continueOnError) => {
  const fixture = mockFigma()
  await sync({ cwd, config: config() })
  const saved = await readFile(join(cwd, '.iconctl-names.json'), 'utf8')
  fixture.revise([...duplicateIcons, { id: '90:1', name: 'broken' }, { id: '90:2', name: 'valid' }])
  fixture.failedDownloads.add('90:1')
  if (continueOnError) {
    const partial = await sync({ cwd, config: config(), continueOnError })
    expect(partial.complete).toBe(false)
    expect(partial.failed).toContain('broken')
    expect(partial.json.icons).toHaveProperty('valid')
    expect(partial.files).not.toContain(join(cwd, '.iconctl-names.json'))
  }
  else {
    await expect(sync({ cwd, config: config() })).rejects.toBeInstanceOf(IconctlSyncError)
  }
  expect(await readFile(join(cwd, '.iconctl-names.json'), 'utf8')).toBe(saved)
})

it('does not create a manifest for a first partial import', async () => {
  const fixture = mockFigma([{ id: '90:1', name: 'broken' }, { id: '90:2', name: 'valid' }])
  fixture.failedDownloads.add('90:1')
  const partial = await sync({ cwd, config: config(), continueOnError: true })
  expect(partial.complete).toBe(false)
  expect(partial.json.icons).toHaveProperty('valid')
  await expectMissing('.iconctl-names.json')
})

it('invalidates not-modified results after a reviewed manifest edit and adopts the edited assignment', async () => {
  mockFigma()
  const resolved = config()
  await sync({ cwd, config: resolved })
  expect((await sync({ cwd, config: resolved })).notModified).toBe(true)
  const edited = await manifest()
  Object.values(edited.sources)[0]!.entries['34:1698']!.name = 'notification'
  await writeFile(join(cwd, '.iconctl-names.json'), JSON.stringify(edited))
  const result = await sync({ cwd, config: resolved })
  expect(result.notModified).toBe(false)
  expect(assigned(result)['34:1698']).toBe('notification')
  expect(result.json.icons).toHaveProperty('notification')
  expect(result.json.icons).not.toHaveProperty('bell')
  expect(Object.values((await manifest()).sources)[0]!.entries['34:1698']!.name).toBe('notification')
})

it('isolates ownership by file and namespace while retaining original source indexes', async () => {
  const fixture = mockFigma([{ id: '1:1', name: 'Bell' }, { id: '1:2', name: 'bell' }])
  fixture.files[otherFileKey] = { ...fixture.files[fileKey]!, icons: [{ id: '1:1', name: 'Bell' }, { id: '1:2', name: 'bell' }] }
  await mkdir(join(cwd, 'empty'))
  const sources: SourceConfig[] = [{ type: 'directory', dir: 'empty' }, ...[
    { file: fileKey, namespace: 'outline', prefix: 'outline' },
    { file: fileKey, namespace: 'filled', prefix: 'filled' },
    { file: otherFileKey, namespace: 'outline', prefix: 'other' },
  ].map(({ file, namespace, prefix }) => ({
    type: 'figma' as const,
    file,
    token: 'fixture',
    naming: { duplicates: 'suffix-node-id' as const, namespace, transform: (name: string) => `${prefix}-${name}` },
  }))]
  const result = await sync({ cwd, config: config({ sources }) })
  expect(result.naming!.map(plan => ({ sourceIndex: plan.sourceIndex, fileKey: plan.fileKey, namespace: plan.namespace }))).toEqual([
    { sourceIndex: 1, fileKey, namespace: 'outline' },
    { sourceIndex: 2, fileKey, namespace: 'filled' },
    { sourceIndex: 3, fileKey: otherFileKey, namespace: 'outline' },
  ])
  expect(result.issues.map(issue => issue.sourceIndex)).toEqual([1, 1, 2, 2, 3, 3])
  const saved = await manifest()
  expect(Object.keys(saved.sources)).toHaveLength(3)
  expect(saved.sources[JSON.stringify([fileKey, 'outline'])]!.entries['1:1']!.name).toBe('outline-bell')
  expect(saved.sources[JSON.stringify([fileKey, 'filled'])]!.entries['1:1']!.name).toBe('filled-bell')
  expect(saved.sources[JSON.stringify([otherFileKey, 'outline'])]!.entries['1:1']!.name).toBe('other-bell')
})

it('rejects repeated file/namespace identities instead of overwriting ownership', async () => {
  mockFigma()
  const source: SourceConfig = { type: 'figma', file: fileKey, token: 'fixture', naming: { duplicates: 'suffix-node-id' } }
  await expect(sync({ cwd, config: config({ sources: [source, source] }) })).rejects.toMatchObject({ code: 'FIGMA_NAMING_SOURCE_CONFLICT' })
  await expectMissing('.iconctl-names.json')
  await expectMissing('icons.json')
})

it.each([false, true])('rejects manifest/output path collisions (dryRun=%s)', async (dryRun) => {
  mockFigma()
  await expect(sync({ cwd, config: config({ output: { json: '.iconctl-names.json' } }), dryRun })).rejects.toThrow(/(?:overlap|same|conflict|duplicate)/i)
  await expectMissing('.iconctl-names.json')
})

it.each([
  { namingManifest: 'svg/bell.svg', output: { json: 'icons.json', svg: 'svg' } },
  { namingManifest: 'svg/.iconctl-manifest.json', output: { json: 'icons.json', svg: 'svg' } },
  { namingManifest: 'pkg/icons.json', output: { json: 'icons.json', jsonPackage: 'pkg' } },
  { namingManifest: 'pkg/package.json', output: { json: 'icons.json', jsonPackage: 'pkg' } },
].flatMap(options => [false, true].map(dryRun => ({ ...options, dryRun }))))('preserves artifacts when a manifest conflicts with a generated file: $namingManifest (dryRun=$dryRun)', async ({ namingManifest, output, dryRun }) => {
  mockFigma()
  await mkdir(join(cwd, 'svg'))
  await mkdir(join(cwd, 'pkg'))
  const originals: Record<string, string> = {
    'icons.json': JSON.stringify({ prefix: 'brand', icons: { previous: { body: '<path/>' } } }),
    'svg/bell.svg': svg,
    'svg/.iconctl-manifest.json': '{"files":["bell.svg"]}\n',
    'svg/preserved.svg': svg,
    'pkg/icons.json': '{"prefix":"brand","icons":{}}\n',
    'pkg/package.json': '{"name":"@acme/icons","version":"1.0.0"}\n',
    'pkg/preserved.txt': 'User-owned package contents\n',
    [namingManifest]: '{"version":1,"sources":{}}\n',
  }
  for (const [file, content] of Object.entries(originals)) {
    await writeFile(join(cwd, file), content)
  }
  await expect(sync({ cwd, config: config({ namingManifest, output }), dryRun })).rejects.toThrow('Conflicting output targets')
  for (const [file, content] of Object.entries(originals)) {
    expect(await readFile(join(cwd, file), 'utf8'), file).toBe(content)
  }
  await expectMissing('.iconctl-cache/meta.json')
})

it('rejects overlapping writers before another API request, permits readers and releases the manifest lock', async () => {
  const fixture = mockFigma()
  const barrier = fixture.pauseNextDocument()
  const resolved = config()
  const first = sync({ cwd, config: resolved })
  try {
    await barrier.entered
    expect(fixture.requests).toHaveLength(1)
    await expect(sync({ cwd, config: resolved })).rejects.toMatchObject({ code: 'FIGMA_NAMING_LOCKED', retryable: true })
    expect(fixture.requests).toHaveLength(1)
    expect((await preflightFigmaNaming({ cwd, config: resolved })).complete).toBe(true)
    expect((await sync({ cwd, config: resolved, dryRun: true })).complete).toBe(true)
    await expectMissing('.iconctl-names.json')
    await expectMissing('icons.json')
  }
  finally {
    barrier.release()
    expect((await first).complete).toBe(true)
  }
  expect((await sync({ cwd, config: resolved })).notModified).toBe(true)
})

it.each([
  '{broken json',
  JSON.stringify({ version: 1, sources: { [JSON.stringify([fileKey, ''])]: {
    fileKey,
    namespace: '',
    activeNodeIds: ['1:1', '1:2'],
    entries: {
      '1:1': { name: 'bell', baseName: 'bell' },
      '1:2': { name: 'bell', baseName: 'bell' },
    },
  } } }),
])('preserves an invalid manifest and refuses to reset ownership: %s', async (content) => {
  const fixture = mockFigma()
  await writeFile(join(cwd, '.iconctl-names.json'), content)
  await expect(sync({ cwd, config: config() })).rejects.toMatchObject({ code: 'FIGMA_NAMING_MANIFEST_INVALID' })
  expect(fixture.requests).toEqual([])
  expect(await readFile(join(cwd, '.iconctl-names.json'), 'utf8')).toBe(content)
  await expectMissing('icons.json')
})

it('reimports an old completed cache entry that has no naming plan', async () => {
  const fixture = mockFigma()
  const resolved = config()
  await sync({ cwd, config: resolved })
  const metaFile = join(cwd, '.iconctl-cache/meta.json')
  const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { naming?: unknown }
  delete meta.naming
  await writeFile(metaFile, JSON.stringify(meta))
  fixture.requests.length = 0
  const result = await sync({ cwd, config: resolved })
  expect(result.notModified).toBe(false)
  expect(result.naming![0]!.mappings).toHaveLength(8)
  expect(fixture.requests.some(url => url.pathname.includes('/files/') && url.searchParams.get('depth') === '3')).toBe(true)
  expect((await sync({ cwd, config: resolved })).notModified).toBe(true)
})

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlAbortError, resolveConfig, sync } from '../src'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), readFile: vi.fn(actual.readFile) }
})

interface OutputProof {
  version: number
  artifacts: { path: string, sha256: string | null }[]
}
interface CacheMarker {
  validationVersion: number
  configDigest: string
  outputDigest: string
  lastModified: string
  version: string
  outputProof: OutputProof
}

const config = resolveConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv', token: 'fixture' }],
  output: {
    json: 'icons.json',
    svg: 'svg',
    sprite: 'sprite.svg',
    types: 'types.ts',
    preview: 'preview.html',
    changelog: 'CHANGELOG.md',
    jsonPackage: { dir: 'pkg', clean: false },
  },
})
const packageFiles = ['icons.json', 'info.json', 'metadata.json', 'chars.json', 'index.js', 'index.mjs', 'index.d.ts', 'package.json']
const managedFiles = ['icons.json', 'svg/.iconctl-manifest.json', 'svg/home.svg', 'sprite.svg', 'types.ts', 'preview.html', 'CHANGELOG.md', ...packageFiles.map(file => `pkg/${file}`)]
const preservedFiles = ['svg/manual.svg', 'svg/README.md', 'pkg/README.md', 'pkg/custom.json']
const directTargets = new Set(['icons.json', 'sprite.svg', 'types.ts', 'preview.html', 'CHANGELOG.md'])
let root: string
let cwd: string
let depths: string[]

const digest = (contents: string) => createHash('sha256').update(contents).digest('hex')
const metaPath = () => join(cwd, config.cacheDir, 'meta.json')
const readMarker = async () => JSON.parse(await readFile(metaPath(), 'utf8')) as CacheMarker
const snapshot = async (files: string[]) => Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(cwd, file), 'utf8')])))
const publish = async () => expect(await sync({ cwd, config })).toMatchObject({ complete: true, notModified: false, processed: 1, issues: [] })

async function expectRegeneratedArtifact(file: string, previous: string) {
  const contents = await readFile(join(cwd, file), 'utf8')
  if (file === 'icons.json' || file === 'pkg/icons.json') {
    // A fresh IconSet can advance this timestamp even when icon data is unchanged.
    const { lastModified: _previousModified, ...before } = JSON.parse(previous)
    const { lastModified: _currentModified, ...after } = JSON.parse(contents)
    expect(after).toEqual(before)
  }
  else {
    expect(contents).toBe(previous)
  }
  const entry = (await readMarker()).outputProof.artifacts.find(artifact => artifact.path === join(cwd, file))
  expect(entry).toEqual({ path: join(cwd, file), sha256: digest(contents) })
}

async function expectRefreshThenReuse() {
  await publish()
  expect(depths).toEqual(['3', '3'])
  expect(await sync({ cwd, config })).toMatchObject({ complete: true, notModified: true, processed: 0, files: [] })
  expect(depths).toEqual(['3', '3', '1'])
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-artifact-cache-')))
  cwd = join(root, 'project')
  await mkdir(cwd)
  depths = []
  vi.mocked(createReadStream).mockClear()
  vi.mocked(lstat).mockClear()
  vi.mocked(readFile).mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      depths.push(url.searchParams.get('depth')!)
      return Response.json({
        editorType: 'figma',
        version: 'v1',
        lastModified: 'unchanged-revision',
        document: { id: '0:0', type: 'DOCUMENT', children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: [{ id: '1:1', name: 'home', type: 'COMPONENT', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } }],
        }] },
      })
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({ images: { '1:1': 'https://cdn.example.com/home.svg' } })
    }
    if (url.href === 'https://cdn.example.com/home.svg') {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
    }
    throw new Error(`Unexpected fixture request: ${url}`)
  }))
})

afterEach(async () => {
  vi.mocked(createReadStream).mockRestore()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it('certifies the final managed file bytes alongside the existing completion digests', async () => {
  await publish()
  const contents = await snapshot(managedFiles)
  const marker = await readMarker()
  expect(marker).toMatchObject({ validationVersion: 1, version: 'v1', lastModified: 'unchanged-revision' })
  expect(marker.configDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(marker.outputDigest).toBe(digest(JSON.stringify(JSON.parse(contents['icons.json']!))))
  expect(marker.outputProof).toEqual({
    version: 4,
    artifacts: managedFiles.toSorted().map(file => ({ path: join(cwd, file), sha256: digest(contents[file]!) })),
  })
  const before = await readFile(metaPath(), 'utf8')
  expect((await sync({ cwd, config })).notModified).toBe(true)
  expect(depths).toEqual(['3', '1'])
  expect(await snapshot(managedFiles)).toEqual(contents)
  expect(await readFile(metaPath(), 'utf8')).toBe(before)
})

it.each(managedFiles.flatMap(path => (['edit', 'delete'] as const).map(change => ({ path, change }))))('revalidates $path after $change before reusing its next completion', async ({ path, change }) => {
  await publish()
  const before = await readFile(join(cwd, path), 'utf8')
  if (change === 'edit') {
    // Valid trailing whitespace leaves parsed JSON and manifest data unchanged.
    await appendFile(join(cwd, path), ' \n')
  }
  else {
    await rm(join(cwd, path))
  }
  await expectRefreshThenReuse()
  if (path === 'CHANGELOG.md') {
    // A complete refresh with no icon diff preserves history, including absence.
    const entry = (await readMarker()).outputProof.artifacts.find(artifact => artifact.path === join(cwd, path))
    if (change === 'delete') {
      await expect(readFile(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(entry?.sha256).toBeNull()
    }
    else {
      expect(await readFile(join(cwd, path), 'utf8')).toBe(`${before} \n`)
      expect(entry?.sha256).toBe(digest(`${before} \n`))
    }
  }
  else {
    await expectRegeneratedArtifact(path, before)
  }
})

it('ignores preserved SVG and package siblings while retaining their edits on refresh', async () => {
  await publish()
  for (const file of preservedFiles) {
    await writeFile(join(cwd, file), `User maintained: ${file}\n`)
  }
  const before = await snapshot(preservedFiles)
  const marker = await readFile(metaPath(), 'utf8')
  expect((await sync({ cwd, config })).notModified).toBe(true)
  expect(depths).toEqual(['3', '1'])
  expect(await readFile(metaPath(), 'utf8')).toBe(marker)
  await appendFile(join(cwd, 'types.ts'), '// force refresh\n')
  await publish()
  expect(depths).toEqual(['3', '1', '3'])
  expect(await snapshot(preservedFiles)).toEqual(before)
  expect((await sync({ cwd, config })).notModified).toBe(true)
  expect(depths).toEqual(['3', '1', '3', '1'])
})

it('certifies shared package JSON and a legitimately absent nested changelog from final staged outputs', async () => {
  const nested = { ...config, output: {
    ...config.output,
    json: 'pkg/icons.json',
    svg: 'pkg/svg',
    sprite: 'pkg/sprite.svg',
    types: 'pkg/types.ts',
    preview: 'pkg/preview.html',
    changelog: 'pkg/history/CHANGELOG.md',
  } }
  expect((await sync({ cwd, config: nested })).complete).toBe(true)
  await rm(join(cwd, 'pkg/history'), { recursive: true })
  expect(await sync({ cwd, config: nested })).toMatchObject({ complete: true, notModified: false, diff: { added: [], removed: [], changed: [] } })
  const { outputProof } = await readMarker()
  expect(outputProof.artifacts.filter(entry => entry.path === join(cwd, 'pkg/icons.json'))).toHaveLength(1)
  expect(outputProof.artifacts.find(entry => entry.path === join(cwd, nested.output.changelog))).toEqual({ path: join(cwd, nested.output.changelog), sha256: null })
  for (const entry of outputProof.artifacts) {
    expect(entry.path.startsWith(`${cwd}/pkg/`)).toBe(true)
    if (entry.sha256 !== null) {
      expect(entry.sha256).toBe(digest(await readFile(entry.path, 'utf8')))
    }
  }
  // Even its optional parent directory may be absent on the next proof check.
  await rm(join(cwd, 'pkg/history'), { recursive: true, force: true })
  expect((await sync({ cwd, config: nested })).notModified).toBe(true)
  expect(depths).toEqual(['3', '3', '1'])
})

it.each(['icons.json', 'types.ts', 'svg/home.svg', 'svg/.iconctl-manifest.json', 'pkg/index.js'])('revalidates and rejects a directory replacing managed file %s', async (path) => {
  await publish()
  const otherFiles = managedFiles.filter(file => file !== path)
  const before = await snapshot(otherFiles)
  const marker = await readFile(metaPath(), 'utf8')
  await rm(join(cwd, path))
  await mkdir(join(cwd, path))
  await expect(sync({ cwd, config })).rejects.toThrow()
  expect(depths).toEqual(['3', '3'])
  expect((await lstat(join(cwd, path))).isDirectory()).toBe(true)
  expect(await snapshot(otherFiles)).toEqual(before)
  expect(await readFile(metaPath(), 'utf8')).toBe(marker)
})

it.each(managedFiles)('does not reuse identical bytes through a managed leaf symlink: %s', async (path) => {
  await publish()
  const before = await readFile(join(cwd, path), 'utf8')
  const outside = join(root, 'outside')
  await writeFile(outside, before)
  await rm(join(cwd, path))
  await symlink(outside, join(cwd, path))
  if (directTargets.has(path)) {
    await expect(sync({ cwd, config })).rejects.toThrow('wrong file type')
    expect((await lstat(join(cwd, path))).isSymbolicLink()).toBe(true)
    expect(depths).toEqual(['3', '3'])
  }
  else {
    await expectRefreshThenReuse()
    expect((await lstat(join(cwd, path))).isFile()).toBe(true)
    await expectRegeneratedArtifact(path, before)
  }
  expect(await readFile(outside, 'utf8')).toBe(before)
})

const malformedProofs: [string, (proof: OutputProof) => unknown][] = [
  ['absent', () => undefined],
  ['null', () => null],
  ['old version', proof => ({ ...proof, version: 0 })],
  ['legacy type semantics', proof => ({ ...proof, version: 1 })],
  ['previous preview semantics', proof => ({ ...proof, version: 2 })],
  ['previous declaration semantics', proof => ({ ...proof, version: 3 })],
  ['missing artifacts', () => ({ version: 4 })],
  ['non-array artifacts', () => ({ version: 4, artifacts: {} })],
  ['empty roster', proof => ({ ...proof, artifacts: [] })],
  ['missing artifact', proof => ({ ...proof, artifacts: proof.artifacts.slice(1) })],
  ['duplicate artifact', proof => ({ ...proof, artifacts: [...proof.artifacts, proof.artifacts[0]] })],
  ['invalid digest', proof => ({ ...proof, artifacts: proof.artifacts.map((entry, index) => index ? entry : { ...entry, sha256: 'invalid' }) })],
  ['non-string digest', proof => ({ ...proof, artifacts: proof.artifacts.map((entry, index) => index ? entry : { ...entry, sha256: 1 }) })],
  ['false absence', proof => ({ ...proof, artifacts: proof.artifacts.map((entry, index) => index ? entry : { ...entry, sha256: null }) })],
]

it('regenerates a certified legacy type artifact after an output-semantics upgrade without enabling sprites', async () => {
  const { sprite: _sprite, ...output } = config.output
  const legacy = { ...config, prefix: 'brand\'s', output }
  await sync({ cwd, config: legacy })
  const oldTypes = 'export const ICONIFY_PREFIX = \'brand\'s\' as const\nexport type IconName = \'home\'\n'
  await writeFile(join(cwd, 'types.ts'), oldTypes)
  const marker = await readMarker()
  marker.outputProof.version = 1
  marker.outputProof.artifacts.find(entry => entry.path === join(cwd, 'types.ts'))!.sha256 = digest(oldTypes)
  await writeFile(metaPath(), JSON.stringify(marker))
  expect((await sync({ cwd, config: legacy })).notModified).toBe(false)
  expect(depths).toEqual(['3', '3'])
  expect(await readFile(join(cwd, 'types.ts'), 'utf8')).toContain('brand\\\'s')
  expect((await readMarker()).outputProof.version).toBe(4)
  expect((await sync({ cwd, config: legacy })).notModified).toBe(true)
  expect(depths).toEqual(['3', '3', '1'])
})

it('regenerates a certified static preview from the previous output version, then reuses the new proof', async () => {
  await publish()
  const oldPreview = '<!doctype html><title>brand icons</title><figure>brand:home</figure>\n'
  await writeFile(join(cwd, 'preview.html'), oldPreview)
  const marker = await readMarker()
  marker.outputProof.version = 2
  marker.outputProof.artifacts.find(entry => entry.path === join(cwd, 'preview.html'))!.sha256 = digest(oldPreview)
  await writeFile(metaPath(), JSON.stringify(marker))
  await expectRefreshThenReuse()
  const preview = await readFile(join(cwd, 'preview.html'), 'utf8')
  expect(preview).toContain('Search icons')
  expect(preview).toContain('Copy Iconify name')
  expect(preview).toContain('Copy CSS class')
  const refreshed = await readMarker()
  expect(refreshed).toMatchObject({ validationVersion: 1, outputProof: { version: 4 } })
  expect(refreshed.outputProof.artifacts.find(entry => entry.path === join(cwd, 'preview.html'))).toEqual({ path: join(cwd, 'preview.html'), sha256: digest(preview) })
})

it('replaces a certified v3 declaration before reusing unchanged remote metadata', async () => {
  const declarations = { ...config, output: { ...config.output, types: 'icons.d.ts' } }
  await sync({ cwd, config: declarations })
  const oldTypes = 'export const ICONIFY_PREFIX = \'brand\' as const\nexport type IconName = \'home\'\n'
  const typesPath = join(cwd, declarations.output.types)
  await writeFile(typesPath, oldTypes)
  const marker = await readMarker()
  marker.outputProof.version = 3
  marker.outputProof.artifacts.find(entry => entry.path === typesPath)!.sha256 = digest(oldTypes)
  await writeFile(metaPath(), JSON.stringify(marker))

  expect(await sync({ cwd, config: declarations })).toMatchObject({ complete: true, notModified: false })
  expect(depths).toEqual(['3', '3'])
  const current = await readFile(typesPath, 'utf8')
  expect(current).toBe('export const ICONIFY_PREFIX = \'brand\'\nexport type IconName = \'home\'\n')
  const refreshed = await readMarker()
  expect(refreshed.outputProof.version).toBe(4)
  expect(refreshed.outputProof.artifacts.find(entry => entry.path === typesPath)).toEqual({ path: typesPath, sha256: digest(current) })
  expect(await sync({ cwd, config: declarations })).toMatchObject({ complete: true, notModified: true, files: [] })
  expect(depths).toEqual(['3', '3', '1'])
  expect(await readFile(typesPath, 'utf8')).toBe(current)
})

it.each(malformedProofs)('refreshes an otherwise valid completion with %s output proof', async (_, mutate) => {
  await publish()
  const marker = await readMarker()
  await writeFile(metaPath(), JSON.stringify({ ...marker, outputProof: mutate(marker.outputProof) }))
  await expectRefreshThenReuse()
  const currentJson = JSON.parse(await readFile(join(cwd, config.output.json), 'utf8'))
  expect(await readMarker()).toMatchObject({ configDigest: marker.configDigest, outputDigest: digest(JSON.stringify(currentJson)), outputProof: { version: 4 } })
})

it.each(['absolute', 'relative'] as const)('rejects an unconfigured %s marker path without reading it', async (kind) => {
  await publish()
  const outside = join(root, 'outside')
  const contents = 'Unrelated bytes must not be read or changed.\n'
  await writeFile(outside, contents)
  const marker = await readMarker()
  const path = kind === 'absolute' ? outside : '../outside'
  const artifacts = marker.outputProof.artifacts.map((entry, index) => index ? entry : { path, sha256: digest(contents) })
  await writeFile(metaPath(), JSON.stringify({ ...marker, outputProof: { version: 4, artifacts } }))
  vi.mocked(createReadStream).mockClear()
  vi.mocked(lstat).mockClear()
  vi.mocked(readFile).mockClear()
  await expectRefreshThenReuse()
  const accessed = [...vi.mocked(readFile).mock.calls, ...vi.mocked(lstat).mock.calls, ...vi.mocked(createReadStream).mock.calls]
  expect(accessed.some(([file]) => [path, outside].includes(String(file)))).toBe(false)
  expect(await readFile(outside, 'utf8')).toBe(contents)
})

it.each(['existing', 'staged'] as const)('cancels during %s artifact hashing without publishing outputs or a completion', async (phase) => {
  await publish()
  if (phase === 'staged') {
    await appendFile(join(cwd, 'types.ts'), '// requires revalidation\n')
  }
  const before = await snapshot(managedFiles)
  const marker = await readFile(metaPath(), 'utf8')
  const controller = new AbortController()
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream
  let closed: Promise<void> | undefined
  vi.mocked(createReadStream).mockImplementation((file, options) => {
    const stream = original(file, options)
    const target = phase === 'existing' ? String(file) === join(cwd, 'types.ts') : String(file).includes('.iconctl-stage-')
    if (target) {
      closed = new Promise(resolve => stream.once('close', resolve))
      stream.once('open', () => controller.abort('stop fingerprint'))
    }
    return stream
  })
  await expect(sync({ cwd, config, signal: controller.signal })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(controller.signal.aborted).toBe(true)
  expect(closed).toBeDefined()
  await closed
  expect(depths).toEqual(phase === 'existing' ? ['3'] : ['3', '3'])
  expect(await snapshot(managedFiles)).toEqual(before)
  expect(await readFile(metaPath(), 'utf8')).toBe(marker)
  expect((await readdir(cwd, { recursive: true })).some(file => file.includes('.iconctl-stage-'))).toBe(false)
})

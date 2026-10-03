import type { SourceConfig } from '../src/sources/types'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconSet, runSVGO } from '@iconify/tools'
import { IconctlSyncError, resolveConfig, sync } from '../src'

vi.mock('@iconify/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iconify/tools')>()
  return { ...actual, runSVGO: vi.fn(actual.runSVGO) }
})

const firstFile = 'AbCdEfGhIjKlMnOpQrStUv'
const secondFile = 'ZbCdEfGhIjKlMnOpQrStUv'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
interface FixtureIcon { id: string, name: string, svg?: string }
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-provenance-'))
})
afterEach(async () => {
  vi.mocked(runSVGO).mockRestore()
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

function figma(file = firstFile): SourceConfig {
  return { type: 'figma', file, token: 'fixture', pages: ['Icons'] }
}

function mockFigma(files: Record<string, FixtureIcon[]>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.hostname === 'cdn.example.com') {
      const [file, id] = url.pathname.slice(1).split('/')
      return new Response(files[file!]!.find(icon => icon.id === id)!.svg ?? svg)
    }
    const file = url.pathname.split('/').pop()!
    const icons = files[file]!
    if (url.pathname.includes('/files/')) {
      return Response.json({
        editorType: 'figma',
        version: '1',
        lastModified: '1',
        document: { id: '0:0', type: 'DOCUMENT', children: [{
          id: '0:1',
          name: 'Icons',
          type: 'CANVAS',
          children: icons.map(({ id, name }) => ({
            id,
            name,
            type: 'COMPONENT',
            children: [],
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
          })),
        }] },
      })
    }
    return Response.json({ images: Object.fromEntries(icons.map(icon => [icon.id, `https://cdn.example.com/${file}/${icon.id}`])) })
  }))
}

it.each(['default', 'continue', 'dry-run'] as const)('retains custom Figma names and coordinates for all validation rules (%s)', async (mode) => {
  mockFigma({ [firstFile]: [{ id: '3:7', name: 'Raw Component' }] })
  const config = resolveConfig({
    prefix: 'brand',
    sources: [{ ...figma(), type: 'figma', file: firstFile, iconNameForNode: node => node.type === 'COMPONENT' ? { keyword: 'custom-name' } : null }],
    validate: { name: /^allowed$/, width: 16, height: 16 },
    output: { json: 'icons.json' },
  })
  const task = sync({ cwd, config, continueOnError: mode !== 'default', dryRun: mode === 'dry-run' })
  let issues
  if (mode === 'default') {
    const error = await task.catch(error => error as unknown)
    expect(error).toBeInstanceOf(IconctlSyncError)
    issues = (error as IconctlSyncError).issues
  }
  else {
    const result = await task
    expect(result.complete).toBe(false)
    expect(result.diff.deletionsReliable).toBe(false)
    issues = result.issues
  }
  expect(issues).toHaveLength(3)
  for (const issue of issues) {
    expect(issue).toMatchObject({ name: 'custom-name', stage: 'validation', sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '3:7' })
  }
  if (mode === 'continue') {
    expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons['custom-name']).toBeDefined()
  }
  else {
    await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(readFile(join(cwd, config.cacheDir, 'meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['directory', 'iconify'] as const)('replaces Figma coordinates when a later %s source wins', async (type) => {
  mockFigma({ [firstFile]: [{ id: '1:1', name: 'shared' }] })
  await mkdir(join(cwd, 'empty'))
  await mkdir(join(cwd, 'local'))
  await writeFile(join(cwd, 'local/shared.svg'), svg)
  await writeFile(join(cwd, 'local.json'), JSON.stringify({ prefix: 'local', icons: { shared: { body: '<path d="M0 0h24v24H0z"/>', width: 24, height: 24 } } }))
  const local: SourceConfig = type === 'directory' ? { type, dir: 'local' } : { type, file: 'local.json' }
  const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'empty' }, figma(), local], validate: { width: 16 } })
  const result = await sync({ cwd, config, continueOnError: true, dryRun: true })
  expect(result.fileKey).toBe(firstFile)
  expect(result.issues).toEqual([{ name: 'shared', stage: 'validation', message: expect.any(String), sourceType: type, sourceIndex: 2 }])
})

it('uses the final Figma source and node for same-name replacements', async () => {
  mockFigma({ [firstFile]: [{ id: '1:1', name: 'shared' }], [secondFile]: [{ id: '8:9', name: 'shared' }] })
  const config = resolveConfig({ prefix: 'brand', sources: [figma(), figma(secondFile)], validate: { height: 16 } })
  const result = await sync({ cwd, config, continueOnError: true, dryRun: true })
  expect(result.issues).toEqual([{ name: 'shared', stage: 'validation', message: expect.any(String), sourceType: 'figma', sourceIndex: 1, fileKey: secondFile, nodeId: '8:9' }])
})

it('keeps the successful source when a later same-name import fails, without relabelling its import issue', async () => {
  mockFigma({ [firstFile]: [{ id: '1:1', name: 'shared' }] })
  await mkdir(join(cwd, 'local'))
  await writeFile(join(cwd, 'local/shared.svg'), 'invalid SVG')
  const config = resolveConfig({ prefix: 'brand', sources: [figma(), { type: 'directory', dir: 'local' }], validate: { width: 16 } })
  const result = await sync({ cwd, config, continueOnError: true, dryRun: true })
  expect(result.issues).toEqual([
    { name: 'shared', stage: 'import', message: expect.any(String), sourceType: 'directory', sourceIndex: 1 },
    { name: 'shared', stage: 'validation', message: expect.any(String), sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '1:1' },
  ])
})

it.each(['both-valid', 'first-invalid', 'last-invalid'] as const)('excludes every same-source duplicate regardless of SVG validity (%s)', async (order) => {
  mockFigma({ [firstFile]: [
    { id: '1:1', name: 'First', ...(order === 'first-invalid' ? { svg: 'invalid SVG' } : {}) },
    { id: '1:2', name: 'Second', ...(order === 'last-invalid' ? { svg: 'invalid SVG' } : {}) },
    { id: '1:3', name: 'Independent' },
  ] })
  const config = resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: firstFile, token: 'fixture', iconNameForNode: node => node.type === 'COMPONENT' ? node.id === '1:3' ? 'independent' : 'same-name' : null }],
    validate: { width: 16 },
  })
  const result = await sync({ cwd, config, continueOnError: true, dryRun: true })
  expect(Object.keys(result.json.icons)).toEqual(['independent'])
  expect(result.issues.filter(issue => issue.stage === 'validation')).toEqual([
    { name: 'independent', stage: 'validation', message: expect.any(String), sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '1:3' },
  ])
  expect(result.issues.filter(issue => issue.stage === 'import')).toEqual([
    { name: 'same-name', stage: 'import', message: expect.stringContaining('Duplicate'), sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '1:1' },
    { name: 'same-name', stage: 'import', message: expect.stringContaining('Duplicate'), sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '1:2' },
  ])
})

it('retains the source after processing removes a failed icon', async () => {
  mockFigma({ [firstFile]: [{ id: '4:5', name: 'broken' }] })
  vi.mocked(runSVGO).mockImplementationOnce(() => {
    throw new Error('optimizer failed')
  })
  const result = await sync({ cwd, config: resolveConfig({ prefix: 'brand', sources: [figma()] }), continueOnError: true, dryRun: true })
  expect(result.json.icons).toEqual({})
  expect(result.failed).toEqual(['broken'])
  expect(result.issues).toEqual([{ name: 'broken', stage: 'process', message: expect.stringContaining('optimizing SVG'), sourceType: 'figma', sourceIndex: 0, fileKey: firstFile, nodeId: '4:5' }])
})

it('does not infer configured sources for a caller-supplied icon set', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const iconSet = new IconSet({ prefix: 'brand', width: 24, height: 24, icons: {
    valid: { body: '<path d="M0 0h24v24H0z"/>' },
    broken: { body: '<script>throw new Error("not executed")</script>' },
  } })
  const result = await sync({ cwd, config: resolveConfig({ prefix: 'brand', sources: [figma()], validate: { width: 16 } }), iconSet, continueOnError: true, dryRun: true })
  expect(request).not.toHaveBeenCalled()
  expect(result.issues).toEqual([
    { name: 'broken', stage: 'process', message: expect.any(String) },
    { name: 'valid', stage: 'validation', message: expect.any(String) },
  ])
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconSet } from '@iconify/tools'
import { resolveConfig, sync } from '../src'
import { loadFigmaSource } from '../src/sources/figma'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const source = { type: 'figma' as const, file: 'AbCdEfGhIjKlMnOpQrStUv', token: 'test', pages: ['Icons'], depth: 3 }
const config = resolveConfig({ prefix: 'brand', sources: [source], output: { json: 'icons.json' } })
type Failure = 'missing-url' | 'download' | 'invalid-svg' | undefined
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-sync-failures-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

function mockFigma(failure?: Failure) {
  const state: { failure: Failure, revision: number, userDownloads: number, imageRequests: number, failedRevision?: number } = { failure, revision: 1, userDownloads: 0, imageRequests: 0 }
  const component = (id: string, name: string) => ({ id, name, type: 'COMPONENT', absoluteBoundingBox: { width: 24, height: 24, x: 0, y: 0 }, children: [] })
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      return Response.json({
        editorType: 'figma',
        version: `v${state.revision}`,
        lastModified: `2026-10-0${state.revision}T00:00:00Z`,
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Icons', type: 'CANVAS', children: [component('1:1', 'home'), component('1:2', 'user')] }] },
      })
    }
    const revision = Number(url.searchParams.get('version')?.slice(1) ?? url.pathname.match(/\/v(\d+)\//)?.[1] ?? state.revision)
    const failure = state.failedRevision === undefined || state.failedRevision === revision ? state.failure : undefined
    if (url.pathname.includes('/images/')) {
      state.imageRequests++
      return Response.json({ images: {
        '1:1': `https://cdn.example.com/v${revision}/home.svg`,
        '1:2': failure === 'missing-url' ? null : `https://cdn.example.com/v${revision}/user.svg`,
      } })
    }
    if (url.pathname.endsWith('/user.svg')) {
      state.userDownloads++
      if (failure === 'download') {
        return new Response('temporary failure', { status: 503 })
      }
      if (failure === 'invalid-svg') {
        return new Response('<html>temporary failure</html>')
      }
    }
    return new Response(svg)
  })
  return state
}

it.each(['missing-url', 'download', 'invalid-svg'] as const)('reports Figma %s failures and recovers on the next sync', async (failure) => {
  const state = mockFigma(failure)
  const loaded = await loadFigmaSource(source, { cwd: directory, prefix: 'brand', cacheDir: config.cacheDir, skipPrefix: ['_', '.'] })
  expect(loaded.iconSet?.list()).toEqual(['home'])
  expect(loaded.failures).toEqual([{ name: 'user', message: expect.any(String) }])
  await expect(sync({ cwd: directory, config })).rejects.toThrow(/user/)
  await expect(readFile(join(directory, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(directory, config.cacheDir, 'meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  state.failure = undefined
  const recovered = await sync({ cwd: directory, config })
  expect(Object.keys(recovered.json.icons)).toEqual(['home', 'user'])
  expect(recovered.failed).toEqual([])
  expect(recovered.issues).toEqual([])
  expect(recovered.notModified).toBe(false)
  expect((await sync({ cwd: directory, config })).notModified).toBe(true)
})

it.each([false, true])('fetches a repaired Figma revision after failure (continue: %s)', async (continueOnError) => {
  const state = mockFigma('missing-url')
  state.failedRevision = 1
  const first = sync({ cwd: directory, config, continueOnError })
  if (continueOnError) {
    expect((await first).failed).toEqual(['user'])
  }
  else {
    await expect(first).rejects.toThrow(/user/)
  }
  await expect(readFile(join(directory, config.cacheDir, 'meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Version 1 remains permanently broken, even after the remote file is fixed.
  state.revision = 2
  const recovered = await sync({ cwd: directory, config })
  expect(recovered.fileVersion).toBe('v2')
  expect(recovered.notModified).toBe(false)
  expect(Object.keys(recovered.json.icons)).toEqual(['home', 'user'])
  expect(recovered.failed).toEqual([])
  expect(recovered.issues).toEqual([])
})

it('keeps previous outputs and completed metadata after a default failure', async () => {
  const state = mockFigma()
  await sync({ cwd: directory, config })
  const before = await readFile(join(directory, 'icons.json'), 'utf8')
  const beforeMeta = await readFile(join(directory, config.cacheDir, 'meta.json'), 'utf8')
  state.revision++
  state.failure = 'download'
  await expect(sync({ cwd: directory, config })).rejects.toThrow(/user/)
  expect(await readFile(join(directory, 'icons.json'), 'utf8')).toBe(before)
  expect(await readFile(join(directory, config.cacheDir, 'meta.json'), 'utf8')).toBe(beforeMeta)
})

it('reports a continued failure, invalidates completed metadata and retries it', async () => {
  const state = mockFigma()
  await sync({ cwd: directory, config })
  state.revision++
  state.failure = 'download'
  const partial = await sync({ cwd: directory, config, continueOnError: true })
  expect(Object.keys(partial.json.icons)).toEqual(['home'])
  expect(partial.failed).toEqual(['user'])
  expect(partial.issues).toEqual([{ name: 'user', message: expect.stringContaining('download') }])
  await expect(readFile(join(directory, config.cacheDir, 'meta.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const downloads = state.userDownloads
  state.failure = undefined
  const recovered = await sync({ cwd: directory, config })
  expect(recovered.notModified).toBe(false)
  expect(recovered.diff.added).toEqual(['user'])
  expect(state.userDownloads).toBe(downloads + 1)
})

it('blocks processing failures by default and reports them when continuing', async () => {
  const createIcons = () => new IconSet({ prefix: 'brand', width: 24, height: 24, icons: {
    good: { body: '<path d="M0 0h24v24H0z"/>' },
    bad: { body: '<script>throw new Error("not executed")</script>' },
  } })
  await expect(sync({ cwd: directory, config, iconSet: createIcons() })).rejects.toThrow(/bad/)
  await expect(readFile(join(directory, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const partial = await sync({ cwd: directory, config, iconSet: createIcons(), continueOnError: true })
  expect(partial.failed).toEqual(['bad'])
  expect(partial.issues).toEqual([{ name: 'bad', message: expect.stringContaining('cleaning SVG') }])
  expect(Object.keys(partial.json.icons)).toEqual(['good'])
})

it('still rejects authentication failures with continue enabled', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
  await expect(sync({ cwd: directory, config, continueOnError: true })).rejects.toThrow(/HTTP 401/)
  await expect(readFile(join(directory, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

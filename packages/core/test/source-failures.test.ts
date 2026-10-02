import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlAbortError, importLocalSvgDirectory } from '../src'
import { loadDirectorySource } from '../src/sources/directory'
import { loadIconfontSource } from '../src/sources/iconfont'
import { loadJsdesignSource } from '../src/sources/jsdesign'
import { loadMastergoSource } from '../src/sources/mastergo'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-source-failures-'))
})
afterEach(async () => {
  vi.mocked(readFile).mockRestore()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it('normalizes cancellation during an SVG file read to IconctlAbortError', async () => {
  await writeFile(join(directory, 'good.svg'), svg)
  const controller = new AbortController()
  vi.mocked(readFile).mockImplementationOnce(async (_path, options) => {
    expect(options).toMatchObject({ signal: controller.signal })
    controller.abort('cancelled while reading')
    throw new DOMException('The operation was aborted', 'AbortError')
  })
  const task = loadDirectorySource({ type: 'directory', dir: directory }, { cwd: directory, prefix: 'brand', signal: controller.signal })
  await expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  await expect(task).rejects.toMatchObject({ code: 'ABORT_ERR', cause: 'cancelled while reading' })
})

it.each(['directory', 'jsdesign', 'iconfont'] as const)('reports malformed local SVGs from %s without losing valid icons', async (type) => {
  await writeFile(join(directory, 'good.svg'), svg)
  await writeFile(join(directory, 'bad.svg'), 'not an SVG')
  await writeFile(join(directory, '_draft.svg'), 'draft content is intentionally ignored')
  const options = { cwd: directory, prefix: 'brand' }
  const loaded = type === 'directory'
    ? await loadDirectorySource({ type, dir: directory }, options)
    : type === 'jsdesign'
      ? await loadJsdesignSource({ type, dir: directory }, options)
      : await loadIconfontSource({ type, dir: directory, stripPrefix: '' }, options)
  expect(loaded.iconSet?.list()).toEqual(['good'])
  expect(loaded.failures).toEqual([{ name: 'bad', message: expect.stringContaining('Cannot import') }])
})

it('keeps the public directory import helper strict', async () => {
  await writeFile(join(directory, 'bad.svg'), 'not an SVG')
  await expect(importLocalSvgDirectory(directory, 'brand')).rejects.toThrow(/bad: Cannot import/)
})

it('reports malformed MasterGo entries separately from an unreadable source', async () => {
  const source = { type: 'mastergo' as const, fileId: '123', layerId: '1:2', token: 'test', baseUrl: 'https://mastergo.com' }
  vi.stubGlobal('fetch', async () => Response.json({
    svgs: [
      { name: 'good', svg },
      { name: 'missing' },
      { name: 'invalid', svg: 'not an SVG' },
      { svg },
      { name: '!!!', svg },
    ],
    hasMore: false,
  }))
  const loaded = await loadMastergoSource(source, { prefix: 'brand' })
  expect(loaded.iconSet?.list()).toEqual(['good'])
  expect(loaded.failures?.map(item => item.name)).toEqual(['missing', 'invalid', 'item-4', '!!!'])
  vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
  await expect(loadMastergoSource(source, { prefix: 'brand' })).rejects.toThrow(/403/)
})

it('reports empty, unnamed and invalid iconfont symbols', async () => {
  vi.stubGlobal('fetch', async () => new Response([
    '<symbol id="icon-good" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>',
    '<symbol id="icon-empty"></symbol>',
    '<symbol><path d="M0 0h24v24H0z"/></symbol>',
    '<symbol id="icon-bad" viewBox="invalid"><path/></symbol>',
    '<symbol id="icon-" viewBox="0 0 24 24"><path/></symbol>',
  ].join('')))
  const loaded = await loadIconfontSource({ type: 'iconfont', url: 'https://example.com/icons.js', stripPrefix: 'icon-' }, { cwd: directory, prefix: 'brand' })
  expect(loaded.iconSet?.list()).toEqual(['good'])
  expect(loaded.failures?.map(item => item.name).sort()).toEqual(['bad', 'empty', 'icon-', 'symbol-3'])
})

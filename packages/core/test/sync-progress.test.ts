import type { SyncProgressEvent } from '../src'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { blankIconSet, SVG } from '@iconify/tools'
import { IconctlAbortError, IconctlSyncError, resolveConfig, serializeIconctlError, sync } from '../src'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h12v24H0z"/></svg>'
let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-progress-'))
  await mkdir(join(cwd, 'raw'))
  await writeFile(join(cwd, 'raw/home.svg'), svg)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})
function localConfig() {
  return resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json' } })
}
function figmaConfig() {
  return resolveConfig({ prefix: 'fixture', sources: [{ type: 'figma', file: 'fixture12345678', token: 'figd_private' }], output: { json: 'icons.json' } })
}
function figma(fail = false) {
  const request = vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.includes('/files/')) {
      return Response.json({ editorType: 'figma', version: '1', lastModified: '1', document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Icons', type: 'CANVAS', children: ['good', 'bad'].map((name, i) => ({ id: `1:${i}`, name, type: 'COMPONENT', children: [], absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } })) }] } })
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({ images: { '1:0': 'https://fixture.invalid/good.svg?signature=private', '1:1': 'https://fixture.invalid/bad.svg?signature=private' } })
    }
    return fail && url.pathname.includes('bad') ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : new Response(svg)
  })
  vi.stubGlobal('fetch', request)
  return request
}
function stages(events: SyncProgressEvent[]) {
  return [...new Set(events.map(event => event.stage))]
}

it('reports real directory stages and counts with frozen timestamped snapshots', async () => {
  const events: SyncProgressEvent[] = []
  const result = await sync({ cwd, config: localConfig(), onProgress: event => void events.push(event) })
  expect(result.complete).toBe(true)
  expect(stages(events)).toEqual(['prepare', 'source', 'process', 'validate', 'export', 'complete'])
  expect(events.filter(event => event.stage === 'process').map(event => [event.completed, event.total])).toEqual([[0, 1], [1, 1]])
  expect(events.filter(event => event.stage === 'validate').at(-1)).toMatchObject({ completed: 1, total: 1, name: 'home' })
  expect(events.at(-1)).toMatchObject({ stage: 'complete', complete: true, notModified: false, dryRun: false })
  expect(events.every(event => Object.isFrozen(event) && Number.isFinite(Date.parse(event.timestamp)))).toBe(true)
  expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons.home).toBeDefined()
})

it('counts each source and only processed icons, excluding aliases', async () => {
  const config = localConfig()
  config.sources.push({ ...config.sources[0]! })
  const events: SyncProgressEvent[] = []
  await sync({ cwd, config, dryRun: true, onProgress: event => void events.push(event) })
  expect(events.filter(event => event.stage === 'source' && event.sourceIndex !== undefined).map(event => [event.sourceIndex, event.completed, event.total])).toEqual([[0, 0, 2], [0, 1, 2], [1, 1, 2], [1, 2, 2]])
  const iconSet = blankIconSet('fixture')
  iconSet.fromSVG('home', new SVG(svg))
  iconSet.setAlias('alias', 'home')
  events.length = 0
  await sync({ cwd, config, iconSet, dryRun: true, onProgress: event => void events.push(event) })
  expect(events.filter(event => event.stage === 'process').map(event => [event.completed, event.total])).toEqual([[0, 1], [1, 1]])
  expect(events.filter(event => event.stage === 'validate').at(-1)).toMatchObject({ completed: 1, total: 1 })
})

it('reports Figma phase counts/context without credentials or signed URLs, including an unchanged run', async () => {
  figma()
  const events: SyncProgressEvent[] = []
  await sync({ cwd, config: figmaConfig(), onProgress: event => void events.push(event) })
  expect(stages(events)).toEqual(['prepare', 'source', 'document', 'export-url', 'download', 'import', 'process', 'validate', 'export', 'complete'])
  for (const stage of ['export-url', 'download', 'import']) {
    expect(events.filter(event => event.stage === stage).map(event => [event.completed, event.total])).toEqual([[0, 2], [1, 2], [2, 2]])
    expect(events.find(event => event.stage === stage && event.nodeId)).toMatchObject({ sourceIndex: 0, sourceType: 'figma', fileKey: 'fixture12345678', name: expect.any(String), nodeId: expect.any(String) })
  }
  expect(JSON.stringify(events)).not.toMatch(/figd_private|signature|https:/)
  expect(events.find(event => event.stage === 'process' && event.name === 'good')).toMatchObject({ sourceType: 'figma', sourceIndex: 0, fileKey: 'fixture12345678', nodeId: '1:0' })
  expect(events.find(event => event.stage === 'validate' && event.name === 'good')).toMatchObject({ sourceType: 'figma', sourceIndex: 0, fileKey: 'fixture12345678', nodeId: '1:0' })
  events.length = 0
  const unchanged = await sync({ cwd, config: figmaConfig(), onProgress: event => void events.push(event) })
  expect(unchanged.notModified).toBe(true)
  expect(stages(events)).toEqual(['prepare', 'source', 'document', 'complete'])
  expect(events.at(-1)).toMatchObject({ complete: true, notModified: true })
})

it.each([false, true])('reports partial attempts and a truthful final result with continueOnError=%s', async (continueOnError) => {
  figma(true)
  const events: SyncProgressEvent[] = []
  const task = sync({ cwd, config: figmaConfig(), continueOnError, onProgress: event => void events.push(event) })
  if (continueOnError) {
    const result = await task
    expect(result.complete).toBe(false)
    expect(events.at(-1)).toMatchObject({ stage: 'complete', complete: false })
    expect(result.issues[0]).toMatchObject({ httpStatus: 429, retryAfterMs: 2000, retryable: true, operation: 'figma-svg' })
  }
  else {
    const error = await task.catch(error => error)
    expect(error).toBeInstanceOf(IconctlSyncError)
    expect(serializeIconctlError(error).issues?.[0]).toMatchObject({ httpStatus: 429, retryAfterMs: 2000 })
    expect(events.some(event => event.stage === 'complete')).toBe(false)
    await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(events.filter(event => event.stage === 'download').at(-1)).toMatchObject({ completed: 2, total: 2 })
})

it('reports dry-run success without writing output and stops promptly when an observer cancels', async () => {
  const events: SyncProgressEvent[] = []
  await sync({ cwd, config: localConfig(), dryRun: true, onProgress: event => void events.push(event) })
  expect(events.at(-1)).toMatchObject({ stage: 'complete', dryRun: true })
  await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const controller = new AbortController()
  events.length = 0
  await expect(sync({ cwd, config: localConfig(), signal: controller.signal, onProgress(event) {
    events.push(event)
    if (event.stage === 'process') {
      controller.abort()
    }
  } })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(events.some(event => event.stage === 'complete')).toBe(false)
  await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['throw', 'reject', 'pending'] as const)('isolates %s observers without delaying or misreporting committed output', async (behavior) => {
  const events: string[] = []
  const result = await sync({ cwd, config: localConfig(), onProgress(event) {
    events.push(event.stage)
    if (behavior === 'throw') {
      throw new Error('observer failed')
    }
    return behavior === 'reject' ? Promise.reject(new Error('observer failed')) : new Promise<void>(() => {})
  } })
  await setImmediate()
  expect(result.complete).toBe(true)
  expect(events.at(-1)).toBe('complete')
  expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons.home).toBeDefined()
})

it('propagates Figma timeout options and source coordinates without sending a successful final event', async () => {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const events: SyncProgressEvent[] = []
  const error = await sync({ cwd, config: figmaConfig(), requestTimeoutMs: 10, onProgress: event => void events.push(event) }).catch(error => error)
  expect(error).toMatchObject({ code: 'REQUEST_TIMEOUT', operation: 'figma-api', sourceType: 'figma', sourceIndex: 0, retryable: true })
  expect(events.some(event => event.stage === 'complete')).toBe(false)
})

it('preserves a frozen custom provider error when source metadata cannot be added', async () => {
  const error = Object.freeze(new IconctlSyncError([]))
  await expect(sync({ cwd, config: figmaConfig(), figmaAuthProvider: () => Promise.reject(error) })).rejects.toBe(error)
})

it.each(['validate', 'document', 'import'] as const)('prioritizes cancellation from the final %s callback over the stage failure', async (stage) => {
  const controller = new AbortController()
  const events: SyncProgressEvent[] = []
  let config = localConfig()
  if (stage === 'validate') {
    config.validate.width = 1
  }
  else {
    config = figmaConfig()
    const request = figma()
    const implementation = request.getMockImplementation()!
    request.mockImplementation(async (input) => {
      const url = new URL(input)
      if (stage === 'document' && url.pathname.includes('/files/')) {
        return Response.json({ editorType: 'figma', version: '1', lastModified: '1', document: { id: '0:0', type: 'DOCUMENT', children: [] } })
      }
      return url.hostname === 'fixture.invalid' ? new Response('invalid SVG') : await implementation(input)
    })
  }
  await expect(sync({ cwd, config, signal: controller.signal, onProgress(event) {
    events.push(event)
    if (event.stage === stage && event.completed === event.total) {
      controller.abort()
    }
  } })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(events.some(event => event.stage === 'complete')).toBe(false)
  await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { blankIconSet, SVG } from '@iconify/tools'
import { IconctlAbortError, resolveConfig, sync } from '../src'
import { resolveFigmaAuth } from '../src/figma/auth'
import { readFigmaCredentials, writeFigmaCredentials } from '../src/figma/credentials'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h12v24H0z"/></svg>'
let cwd: string
function config() {
  return resolveConfig({ prefix: 'fixture', sources: [{ type: 'figma', file: 'fixture12345678', token: 'fake-pat' }], output: { json: 'icons.json', svg: 'svg' } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function document() {
  return { editorType: 'figma', version: '1', lastModified: '1', document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Icons', type: 'CANVAS', children: Array.from({ length: 8 }, (_, i) => ({
    id: `1:${i}`,
    name: `icon-${i}`,
    type: 'COMPONENT',
    children: [],
    absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
  })) }] } }
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-abort-'))
  await writeFile(join(cwd, 'icons.json'), 'previous-output')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

it('rejects a pre-aborted signal without requests, authentication or output writes', async () => {
  const request = vi.fn()
  const provider = vi.fn()
  vi.stubGlobal('fetch', request)
  const reason = new Error('user cancelled')
  const signal = AbortSignal.abort(reason)
  await expect(sync({ cwd, config: config(), signal, figmaAuthProvider: provider })).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason })
  expect(request).not.toHaveBeenCalled()
  expect(provider).not.toHaveBeenCalled()
  expect(await readdir(cwd)).toEqual(['icons.json'])
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe('previous-output')
})

it.each(['document', 'body', 'downloads'] as const)('actually aborts %s and drains in-flight work before rejecting', async (phase) => {
  const controller = new AbortController()
  const started = deferred<void>()
  let active = 0
  let calls = 0
  let aborted = 0
  const blocked = async (signal: AbortSignal): Promise<Response> => {
    active++
    calls++
    if (calls === (phase === 'downloads' ? 4 : 1)) {
      started.resolve()
    }
    try {
      return await new Promise<Response>((_resolve, reject) => {
        const stop = async () => {
          aborted++
          await setImmediate()
          reject(signal.reason)
        }
        signal.addEventListener('abort', () => {
          void stop()
        }, { once: true })
      })
    }
    finally {
      active--
    }
  }
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit) => {
    const url = new URL(input)
    expect(init.signal).toBeDefined()
    if (url.pathname.includes('/files/')) {
      if (phase === 'document') {
        return await blocked(init.signal!)
      }
      if (phase === 'body') {
        const stream = new ReadableStream({ start(stream) {
          active++
          calls++
          init.signal!.addEventListener('abort', () => {
            aborted++
            active--
            stream.error(init.signal!.reason)
          }, { once: true })
          started.resolve()
        } })
        return new Response(stream)
      }
      return Response.json(document())
    }
    if (url.pathname.includes('/images/')) {
      return Response.json({ images: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`1:${i}`, `https://fixture.invalid/${i}.svg`])) })
    }
    return await blocked(init.signal!)
  })
  const task = sync({ cwd, config: config(), signal: controller.signal, continueOnError: true })
  const rejected = expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  await started.promise
  controller.abort('stop')
  await rejected
  expect(active).toBe(0)
  expect(aborted).toBe(phase === 'downloads' ? 4 : 1)
  const settledCalls = calls
  await setImmediate()
  expect(calls).toBe(settledCalls)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe('previous-output')
})

it('yields between CPU processing steps so a scheduled abort stops the next icon', async () => {
  const iconSet = blankIconSet('fixture')
  for (let i = 0; i < 10; i++) {
    iconSet.fromSVG(`icon-${i}`, new SVG(svg))
  }
  const controller = new AbortController()
  const toSVG = iconSet.toSVG.bind(iconSet)
  let processed = 0
  vi.spyOn(iconSet, 'toSVG').mockImplementation((...args) => {
    processed++
    if (processed === 1) {
      globalThis.setImmediate(() => controller.abort())
    }
    return toSVG(...args)
  })
  await expect(sync({ cwd, config: config(), iconSet, signal: controller.signal })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(processed).toBe(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe('previous-output')
  expect(await readdir(cwd)).toEqual(['icons.json'])
})

it.each(['iconfont', 'mastergo'] as const)('passes cancellation to %s requests', async (type) => {
  const controller = new AbortController()
  const started = deferred<void>()
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    started.resolve()
  }))
  const source = type === 'iconfont' ? { type, url: 'https://fixture.invalid/icons.js' } : { type, fileId: '1', layerId: '2', token: 'fake' }
  const task = sync({ cwd, config: resolveConfig({ prefix: 'fixture', sources: [source] }), signal: controller.signal })
  const rejected = expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  await started.promise
  controller.abort()
  await rejected
})

it('waits for a custom authentication provider to settle on cancellation', async () => {
  const controller = new AbortController()
  const started = deferred<void>()
  const auth = deferred<never>()
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  let settled = false
  const task = sync({ cwd, config: config(), signal: controller.signal, figmaAuthProvider: async () => {
    started.resolve()
    return await auth.promise
  } }).finally(() => {
    settled = true
  })
  const rejected = expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  await started.promise
  controller.abort()
  await setImmediate()
  expect(settled).toBe(false)
  auth.resolve(undefined as never)
  await rejected
  expect(request).not.toHaveBeenCalled()
})

it('lets shared OAuth rotation persist safely before rejecting the cancelled sync', async () => {
  const credentials = join(cwd, 'credentials.json')
  await writeFigmaCredentials(credentials, { clientId: 'fake', clientSecret: 'fake', accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 })
  const env = { ICONCTL_FIGMA_CREDENTIALS_FILE: credentials }
  const started = deferred<void>()
  const refreshed = deferred<Response>()
  const request = vi.fn(async () => {
    started.resolve()
    return await refreshed.promise
  })
  vi.stubGlobal('fetch', request)
  const controller = new AbortController()
  const cfg = config()
  cfg.sources = [{ type: 'figma', file: 'fixture12345678', depth: 3 }]
  let settled = false
  const task = sync({ cwd, config: cfg, env, signal: controller.signal }).finally(() => {
    settled = true
  })
  const rejected = expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  await started.promise
  const other = (await resolveFigmaAuth(undefined, env)).token()
  controller.abort()
  await setImmediate()
  expect(settled).toBe(false)
  refreshed.resolve(Response.json({ access_token: 'new', refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 }))
  await rejected
  expect(await other).toBe('new')
  expect((await readFigmaCredentials(credentials))?.refreshToken).toBe('new-refresh')
  expect(request).toHaveBeenCalledTimes(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe('previous-output')
})

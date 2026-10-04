import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers'
import { gzipSync } from 'node:zlib'
import { IconctlAbortError, resolveConfig, sync } from '../src'
import { loadIconifySource } from '../src/sources/iconify'

const maximumBytes = 25 * 1024 * 1024
const url = 'https://cdn.example.test/transport.json'
const vendor = { prefix: 'vendor', icons: { home: { body: '<path d="M0 0h4v8H0z"/>' } } }
let cwd: string

function load(options: { signal?: AbortSignal } = {}) {
  return loadIconifySource(
    { type: 'iconify', url, namePrefix: '' },
    { cwd, prefix: 'brand', skipPrefix: [], cacheDir: '.cache', ...(options.signal ? { signal: options.signal } : {}) },
  )
}

function paddedBody(bytes: number, multibyte = false): Buffer {
  const json = Buffer.from(JSON.stringify({ ...vendor, ...(multibyte ? { note: 'é' } : {}) }))
  return Buffer.concat([json, Buffer.alloc(bytes - json.length, 0x20)])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function responseStream(chunks: Uint8Array[], options: { status?: number, headers?: HeadersInit, cancel?: () => void | Promise<void> } = {}) {
  let index = 0
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[index++]
    if (chunk) {
      controller.enqueue(chunk)
    }
    else {
      controller.close()
    }
  })
  const cancel = vi.fn(options.cancel ?? (() => {}))
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  const response = new Response(stream, { status: options.status ?? 200, ...(options.headers ? { headers: options.headers } : {}) })
  return { response, pull, cancel }
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-transport-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(cwd, { recursive: true, force: true })
})

it('accepts exactly 25 MiB across chunks even when Content-Length overstates the body', async () => {
  const bytes = paddedBody(maximumBytes)
  const { response } = responseStream([bytes.subarray(0, 79), bytes.subarray(79, maximumBytes - 1), bytes.subarray(maximumBytes - 1)], {
    headers: { 'content-length': String(maximumBytes * 2) },
  })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const result = await load()
  expect(result.iconSet!.list()).toEqual(['home'])
  expect(response.body!.locked).toBe(false)
})

it.each(['single', 'multiple'] as const)('rejects a %s-chunk oversized body without trusting Content-Length or awaiting hung cleanup', async (shape) => {
  const bytes = paddedBody(maximumBytes + 1)
  const chunks = shape === 'single'
    ? [bytes]
    : [bytes.subarray(0, maximumBytes), bytes.subarray(maximumBytes), Buffer.from('must not be read')]
  const { response, cancel, pull } = responseStream(chunks, {
    ...(shape === 'single' ? { headers: { 'content-length': '1' } } : {}),
    cancel: () => new Promise<void>(() => {}),
  })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await expect(load()).rejects.toThrow(/25 MiB|size limit|too large|exceed/i)
  expect(pull).toHaveBeenCalledTimes(shape === 'single' ? 1 : 2)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
  await expect(readdir(join(cwd, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('counts UTF-8 bytes rather than JavaScript characters toward the response limit', async () => {
  const bytes = paddedBody(maximumBytes + 1, true)
  expect(bytes.toString('utf8')).toHaveLength(maximumBytes)
  vi.stubGlobal('fetch', vi.fn(async () => responseStream([bytes]).response))
  await expect(load()).rejects.toThrow(/25 MiB|size limit|too large|exceed/i)
})

it('limits the decompressed body of a real gzip HTTP response', async () => {
  const nativeFetch = globalThis.fetch
  const compressed = gzipSync(paddedBody(maximumBytes + 1))
  expect(compressed.byteLength).toBeLessThan(maximumBytes)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.byteLength })
    response.end(compressed)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing test HTTP listener address')
    }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(input).toBe(url)
      return nativeFetch(`http://127.0.0.1:${address.port}/icons.json`, init)
    }))
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'iconify', url }] })
    await expect(sync({ cwd, config, dryRun: true })).rejects.toThrow(/25 MiB|size limit|too large|exceed/i)
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it.each(['resolve', 'reject', 'hang'] as const)('stops an HTTP error body after 4 KiB when cancellation will %s', async (cleanup) => {
  const { response, pull, cancel } = responseStream([Buffer.from('é'.repeat(2048)), Buffer.from('UNREAD_SECRET')], {
    status: 503,
    cancel: () => cleanup === 'hang' ? new Promise<void>(() => {}) : cleanup === 'reject' ? Promise.reject(new Error('cleanup failed')) : undefined,
  })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await expect(load()).rejects.toThrow(`Remote Iconify JSON request failed (HTTP 503) for ${url}: ${'é'.repeat(300)}`)
  expect(pull).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it('takes only the bounded prefix from a single oversized HTTP error chunk', async () => {
  const { response, pull, cancel } = responseStream([Buffer.from(`${'a'.repeat(4096)}UNREAD_SECRET`)], { status: 429 })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const error = await load().catch(error => error as Error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(`Remote Iconify JSON request failed (HTTP 429) for ${url}: ${'a'.repeat(300)}`)
  expect(pull).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it.each([200, 503])('preserves user cancellation during an HTTP %i body even when reads and cleanup hang', async (status) => {
  const controller = new AbortController()
  const started = deferred<void>()
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() {
      started.resolve()
      return new Promise<void>(() => {})
    },
    cancel,
  }, { highWaterMark: 0 }), { status })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const pending = load({ signal: controller.signal })
  const reason = new Error('the caller stopped the sync')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason })
  await started.promise
  controller.abort(reason)
  await rejected
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it.each([200, 503])('applies the same 30-second timeout to the HTTP %i response body', async (status) => {
  const timeout = new AbortController()
  const timeoutFactory = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  const started = deferred<void>()
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() {
      started.resolve()
      return new Promise<void>(() => {})
    },
    cancel,
  }, { highWaterMark: 0 }), { status })
  let requestSignal: AbortSignal | null | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal
    return response
  }))
  const pending = load({ signal: new AbortController().signal })
  const rejected = expect(pending).rejects.toThrow(/request failed or timed out/i)
  await started.promise
  expect(timeoutFactory).toHaveBeenCalledExactlyOnceWith(30_000)
  timeout.abort(new DOMException('deadline elapsed', 'TimeoutError'))
  await rejected
  expect(requestSignal?.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it.each([200, 503])('reports a broken HTTP %i body as a request failure', async (status) => {
  const failure = new Error('socket closed halfway through the response')
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure)
    },
  }, { highWaterMark: 0 }), { status })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const pending = load()
  await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/request failed or timed out/i), cause: failure })
  if (status === 503) {
    await expect(pending).rejects.toThrow('HTTP 503')
  }
  expect(response.body!.locked).toBe(false)
})

it('allows scheduled cancellation while draining many buffered response chunks', async () => {
  const controller = new AbortController()
  const bytes = paddedBody(256 * 1024)
  let offset = 0
  const cancel = vi.fn()
  const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset === 0) {
      setImmediate(() => controller.abort('stop draining'))
    }
    if (offset >= bytes.byteLength) {
      stream.close()
    }
    else {
      stream.enqueue(bytes.subarray(offset, offset + 1024))
      offset += 1024
    }
  })
  const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }))
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await expect(load({ signal: controller.signal })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(offset).toBeLessThan(bytes.byteLength)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it('distinguishes malformed UTF-8 from a failed request', async () => {
  const { response } = responseStream([Buffer.from('{"prefix":"vendor","icons":{},"note":"'), Uint8Array.of(0xC3), Buffer.from('"}')])
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await expect(load()).rejects.toThrow('Cannot decode remote Iconify JSON')
  expect(response.body!.locked).toBe(false)
})

it('accepts a multibyte UTF-8 sequence split across response chunks', async () => {
  const { response } = responseStream([Buffer.from('{"prefix":"vendor","icons":{},"note":"'), Uint8Array.of(0xC3), Uint8Array.of(0xA9), Buffer.from('"}')])
  vi.stubGlobal('fetch', vi.fn(async () => response))
  expect((await load()).iconSet!.list()).toEqual([])
  expect(response.body!.locked).toBe(false)
})

it.each([false, true])('does not await 304 cleanup when a cached collection exists: %s', async (cached) => {
  if (cached) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(vendor)))
    await load()
  }
  // Native Response disallows a 304 body, while custom fetch adapters may
  // provide one. It must still be discarded without blocking cache reuse.
  const { response, pull, cancel } = responseStream([Buffer.from('unused')], { cancel: () => new Promise<void>(() => {}) })
  Object.defineProperty(response, 'status', { value: 304 })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  if (cached) {
    expect((await load()).iconSet!.list()).toEqual(['home'])
  }
  else {
    await expect(load()).rejects.toThrow('304')
  }
  expect(pull).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body!.locked).toBe(false)
})

it('keeps prior outputs and cache after an oversized refresh instead of falling back to stale content', async () => {
  const config = resolveConfig({ prefix: 'brand', cacheDir: '.cache', sources: [{ type: 'iconify', url }], output: { json: 'icons.json', svg: 'svg', changelog: 'changes.md' } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(vendor), { headers: { etag: '"previous"' } })))
  await sync({ cwd, config })
  const cacheFile = join(cwd, '.cache', 'iconify-v1', (await readdir(join(cwd, '.cache', 'iconify-v1')))[0]!)
  const paths = [join(cwd, 'icons.json'), join(cwd, 'svg', 'home.svg'), join(cwd, 'changes.md'), cacheFile]
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"previous"')
    return responseStream([paddedBody(maximumBytes + 1)]).response
  })
  vi.stubGlobal('fetch', request)
  await expect(sync({ cwd, config, continueOnError: true })).rejects.toThrow(/25 MiB|size limit|too large|exceed/i)
  expect(request).toHaveBeenCalledTimes(1)
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before)
})

it('does not issue a request for a pre-cancelled source', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(load({ signal: AbortSignal.abort('cancelled') })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(request).not.toHaveBeenCalled()
})

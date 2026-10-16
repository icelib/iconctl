import type { IconctlError } from '../src/errors'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeIconctlError } from '../src/errors'
import { resolveFigmaAuth } from '../src/figma/auth'
import { FigmaClient } from '../src/figma/client'
import { readFigmaCredentials, writeFigmaCredentials } from '../src/figma/credentials'
import { refreshFigmaCredentials, requestFigmaToken } from '../src/figma/oauth'
import { resolveRequestOptions, waitForRequest, withRequestDeadline } from '../src/request-options'

const clientCredentials = { clientId: 'synthetic-client', clientSecret: 'private-client-secret' }
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-request-'))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function tokenResponse() {
  return Response.json({ access_token: 'refreshed-access', token_type: 'bearer', expires_in: 3600 })
}
function blockedFetch() {
  const started = deferred<AbortSignal>()
  vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = options.signal!
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started.resolve(signal)
  })))
  return started.promise
}

it('preserves default deadlines and validates both timeout fields', () => {
  expect(resolveRequestOptions()).toEqual({ requestTimeoutMs: 30_000, oauthTimeoutMs: 15_000 })
  for (const name of ['requestTimeoutMs', 'oauthTimeoutMs']) {
    for (const value of [null, '50', true, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveRequestOptions({ [name]: value })).toThrow('finite positive integer')
    }
  }
})

it('classifies an OAuth header deadline and aborts its actual transport', async () => {
  vi.useFakeTimers()
  const started = blockedFetch()
  const result = requestFigmaToken(clientCredentials, new URLSearchParams(), true, undefined, { oauthTimeoutMs: 50 }).catch(error => error)
  const signal = await started
  await vi.advanceTimersByTimeAsync(49)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true, operation: 'figma-oauth-refresh' })
  expect(signal.aborted).toBe(true)
})

it('bounds the entire OAuth response read and cancels a stalled response body', async () => {
  vi.useFakeTimers()
  const cancelled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }))))
  const result = requestFigmaToken(clientCredentials, new URLSearchParams(), true, undefined, { oauthTimeoutMs: 50 }).catch(error => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'REQUEST_TIMEOUT' })
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it('preserves explicit cancellation separately from deadlines, including the refresh convenience API', async () => {
  const started = blockedFetch()
  const controller = new AbortController()
  const reason = new Error('user cancellation')
  const result = refreshFigmaCredentials({ ...clientCredentials, refreshToken: 'refresh-private' }, { signal: controller.signal }).catch(error => error)
  const signal = await started
  controller.abort(reason)
  expect(await result).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason })
  expect(signal.aborted).toBe(true)
})

it.each([401, 403, 429])('retains structured HTTP %i metadata without exposing response bodies or retrying', async (status) => {
  const request = vi.fn(async () => new Response('provider echoed private-client-secret', { status, headers: { 'Retry-After': '2' } }))
  vi.stubGlobal('fetch', request)
  const client = new FigmaClient(await resolveFigmaAuth('pat', {}), directory)
  const error = await client.json('files/file', new URLSearchParams()).catch(error => error) as IconctlError
  expect(error).toMatchObject({ code: 'FIGMA_HTTP_ERROR', httpStatus: status, retryable: status === 429, operation: 'figma-api' })
  expect(error.message).toContain(`HTTP ${status}`)
  expect(error.message).not.toContain('private-client-secret')
  expect(error.retryAfterMs).toBe(status === 429 ? 2000 : undefined)
  expect(request).toHaveBeenCalledTimes(1)
})

it('reads Retry-After HTTP dates on OAuth and cancels rejected private bodies', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'))
  const cancelled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), {
    status: 429,
    headers: { 'Retry-After': 'Fri, 16 Oct 2026 00:00:03 GMT' },
  })))
  const error = await requestFigmaToken(clientCredentials, new URLSearchParams(), true).catch(error => error)
  expect(error).toMatchObject({ code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 3000, operation: 'figma-oauth-refresh' })
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it('keeps the transport cause for a network failure and keeps malformed private bodies out of errors', async () => {
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw cause
  }))
  const network = await requestFigmaToken(clientCredentials, new URLSearchParams(), true).catch(error => error)
  expect(network).toMatchObject({ code: 'NETWORK_ERROR', retryable: true, cause: { message: 'socket closed', code: 'ECONNRESET' } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-client-secret malformed JSON')))
  const invalid = await requestFigmaToken(clientCredentials, new URLSearchParams(), true).catch(error => error)
  expect(invalid).toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(invalid.message).not.toContain('private-client-secret')
  expect(invalid.cause).toBeUndefined()
})

it.each(['json', 'svg'] as const)('applies requestTimeoutMs through the full %s body read', async (kind) => {
  vi.useFakeTimers()
  const started = deferred<void>()
  const cancelled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => {
    started.resolve()
    return new Response(new ReadableStream({ cancel: cancelled }))
  }))
  const client = new FigmaClient(await resolveFigmaAuth('pat', {}), directory, undefined, { requestTimeoutMs: 50 })
  const result = (kind === 'json' ? client.json('files/file', new URLSearchParams()) : client.svg('https://fixture.invalid/icon.svg')).catch(error => error)
  await started.promise
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'REQUEST_TIMEOUT', operation: kind === 'json' ? 'figma-api' : 'figma-svg' })
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it('cancels one OAuth waiter promptly while its sibling shares the successful refresh', async () => {
  const started = deferred<AbortSignal>()
  const refreshed = deferred<Response>()
  const fetcher = vi.fn((_url, options: RequestInit) => {
    started.resolve(options.signal!)
    return refreshed.promise
  })
  vi.stubGlobal('fetch', fetcher)
  const env = { FIGMA_CLIENT_ID: randomUUID(), FIGMA_CLIENT_SECRET: 'secret', FIGMA_REFRESH_TOKEN: 'refresh' }
  const controller = new AbortController()
  const first = await resolveFigmaAuth(undefined, env, { signal: controller.signal })
  const sibling = await resolveFigmaAuth(undefined, env)
  const cancelled = first.token().catch(error => error)
  const success = sibling.token()
  const signal = await started.promise
  controller.abort('cancel this waiter')
  expect(await cancelled).toMatchObject({ code: 'ABORT_ERR' })
  expect(signal.aborted).toBe(false)
  refreshed.resolve(tokenResponse())
  expect(await success).toBe('refreshed-access')
  expect(await sibling.token()).toBe('refreshed-access')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('shares rotating credentials across different waiter policies and keeps the latest refresh token', async () => {
  vi.useFakeTimers()
  const response = deferred<Response>()
  const refreshTokens: string[] = []
  const request = vi.fn((_url, options: RequestInit) => {
    refreshTokens.push(String(options.body))
    return refreshTokens.length === 1 ? response.promise : Promise.resolve(tokenResponse())
  })
  vi.stubGlobal('fetch', request)
  const env = { FIGMA_CLIENT_ID: randomUUID(), FIGMA_CLIENT_SECRET: 'secret', FIGMA_REFRESH_TOKEN: 'initial-refresh' }
  const short = await resolveFigmaAuth(undefined, env, { oauthTimeoutMs: 50 })
  const long = await resolveFigmaAuth(undefined, env, { oauthTimeoutMs: 100 })
  expect(short.cacheIdentity).toBe(long.cacheIdentity)
  const first = short.token().catch(error => error)
  const second = long.token()
  await vi.advanceTimersByTimeAsync(50)
  expect(await first).toMatchObject({ code: 'REQUEST_TIMEOUT' })
  expect(request).toHaveBeenCalledTimes(1)
  response.resolve(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600 }))
  expect(await second).toBe('rotated-access')
  expect(await short.token()).toBe('rotated-access')
  expect(await long.token('rotated-access')).toBe('refreshed-access')
  expect(refreshTokens).toEqual(['refresh_token=initial-refresh', 'refresh_token=rotated-refresh'])
})

it('shares local refreshes across waiter policies and persists rotation for later auth instances', async () => {
  const file = join(directory, 'credentials.json')
  await writeFigmaCredentials(file, { ...clientCredentials, accessToken: 'expired-access', refreshToken: 'initial-refresh', expiresAt: 1 })
  vi.useFakeTimers()
  const started = deferred<void>()
  const response = deferred<Response>()
  const refreshTokens: string[] = []
  vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
    refreshTokens.push(String(options.body))
    started.resolve()
    return refreshTokens.length === 1 ? response.promise : Promise.resolve(tokenResponse())
  }))
  const env = { ICONCTL_FIGMA_CREDENTIALS_FILE: file }
  const short = await resolveFigmaAuth(undefined, env, { oauthTimeoutMs: 50 })
  const long = await resolveFigmaAuth(undefined, env, { oauthTimeoutMs: 100 })
  const first = short.token().catch(error => error)
  const second = long.token()
  await started.promise
  await vi.advanceTimersByTimeAsync(50)
  expect(await first).toMatchObject({ code: 'REQUEST_TIMEOUT' })
  expect(refreshTokens).toHaveLength(1)
  response.resolve(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600 }))
  expect(await second).toBe('rotated-access')
  expect((await readFigmaCredentials(file))?.refreshToken).toBe('rotated-refresh')
  const next = await resolveFigmaAuth(undefined, env, { oauthTimeoutMs: 200 })
  expect(await next.token('rotated-access')).toBe('refreshed-access')
  expect(refreshTokens).toEqual(['refresh_token=initial-refresh', 'refresh_token=rotated-refresh'])
})

it('handles a synchronous abort and throw in a waiter without losing cancellation', async () => {
  const controller = new AbortController()
  const result = waitForRequest(() => {
    controller.abort('cancel this waiter')
    throw new Error('synchronous provider failure')
  }, controller.signal)
  await expect(result).rejects.toMatchObject({ code: 'ABORT_ERR', cause: 'cancel this waiter' })
})

it('keeps the deadline bounded when a transport ignores abort and observes its late completion', async () => {
  vi.useFakeTimers()
  const pending = deferred<string>()
  const result = withRequestDeadline({ timeoutMs: 50, operation: 'figma-api', label: 'Figma API' }, () => pending.promise).catch(error => error)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ code: 'REQUEST_TIMEOUT' })
  pending.resolve('late response')
  await Promise.resolve()
})

it('redacts a rotated OAuth refresh token from a network cause before it leaves the request boundary', async () => {
  const env = { FIGMA_CLIENT_ID: randomUUID(), FIGMA_CLIENT_SECRET: 'original-secret', FIGMA_REFRESH_TOKEN: 'original-refresh' }
  const rotated = 'newly-rotated-private-refresh'
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: 'rotated-access', refresh_token: rotated, token_type: 'bearer', expires_in: 3600 }))
    .mockRejectedValueOnce(Object.assign(new Error(rotated), { code: 'ECONNRESET' }))
  vi.stubGlobal('fetch', fetcher)
  const auth = await resolveFigmaAuth(undefined, env)
  expect(await auth.token()).toBe('rotated-access')
  const error = await auth.token('rotated-access').catch(error => error)
  const diagnostics = serializeIconctlError(error, { secrets: [env.FIGMA_CLIENT_SECRET, env.FIGMA_REFRESH_TOKEN] })
  expect(diagnostics).toMatchObject({ code: 'NETWORK_ERROR', cause: { code: 'ECONNRESET' } })
  expect(JSON.stringify(diagnostics)).not.toContain(rotated)
})

it('labels invalid SVG download URLs as structured protocol errors without issuing requests', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const client = new FigmaClient(await resolveFigmaAuth('pat', {}), directory)
  await expect(client.svg('http://fixture.invalid/icon.svg')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-svg' })
  expect(request).not.toHaveBeenCalled()
})

it('keeps active API credentials and signed SVG URLs private in underlying network causes', async () => {
  const token = 'new-private-oauth-access'
  const url = 'https://fixture.invalid/opaque-private-download-path.svg'
  const request = vi.fn()
    .mockRejectedValueOnce(new Error(token))
    .mockRejectedValueOnce(new Error(url))
  vi.stubGlobal('fetch', request)
  const client = new FigmaClient({ kind: 'oauth', cacheIdentity: 'injected', token: async () => token }, directory)
  const apiError = await client.json('files/file', new URLSearchParams()).catch(error => error)
  const svgError = await client.svg(url).catch(error => error)
  for (const [error, secret] of [[apiError, token], [svgError, url]] as const) {
    const report = serializeIconctlError(error)
    expect(report.code).toBe('NETWORK_ERROR')
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report.cause?.message).toContain('[redacted]')
  }
})

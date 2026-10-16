import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlAbortError } from '../src/errors'
import { resolveFigmaAuth } from '../src/figma/auth'
import { writeFigmaCredentials } from '../src/figma/credentials'
import { inspectFigmaAuth } from '../src/figma/inspect-auth'

const directories: string[] = []
const local = {
  clientId: 'inspect-local-client',
  clientSecret: 'inspect-local-secret',
  accessToken: 'inspect-local-access',
  refreshToken: 'inspect-local-refresh',
  expiresAt: Date.now() + 3600_000,
}
const environmentOAuth = {
  FIGMA_CLIENT_ID: 'inspect-environment-client',
  FIGMA_CLIENT_SECRET: 'inspect-environment-secret',
  FIGMA_REFRESH_TOKEN: 'inspect-environment-refresh',
}

async function setup(credentials?: typeof local) {
  const dir = await mkdtemp(join(tmpdir(), 'iconctl-inspect-'))
  directories.push(dir)
  const file = join(dir, 'figma.json')
  if (credentials) {
    await writeFigmaCredentials(file, credentials)
  }
  return { dir, file, env: { ICONCTL_FIGMA_CREDENTIALS_FILE: file } }
}

function tokenResponse(accessToken = 'inspect-refreshed-access') {
  return Response.json({ access_token: accessToken, refresh_token: 'inspect-rotated-refresh', token_type: 'bearer', expires_in: 3600 })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('read-only Figma authentication inspection', () => {
  it('collects all sources offline without refreshing or changing files', async () => {
    const { dir, file, env } = await setup(local)
    const before = await readFile(file, 'utf8')
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ token: 'inspect-config-pat', env: { ...env, FIGMA_TOKEN: 'inspect-environment-pat', ...environmentOAuth } })
    expect(result).toEqual({
      source: 'config-token',
      sources: [
        { source: 'config-token', configured: true, selected: true, validity: 'unknown', expiresAt: null },
        { source: 'environment-token', configured: true, selected: false, validity: 'unknown', expiresAt: null },
        { source: 'environment-oauth', configured: true, selected: false, validity: 'unknown', expiresAt: null },
        { source: 'local-oauth', configured: true, selected: false, validity: 'unknown', expiresAt: local.expiresAt },
      ],
    })
    expect(request).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['figma.json'])
    const serialized = JSON.stringify(result)
    for (const secret of [file, 'inspect-config-pat', 'inspect-environment-pat', ...Object.values(environmentOAuth), ...Object.values(local).filter(value => typeof value === 'string')]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it.each([
    { token: 'config-pat', extra: { FIGMA_TOKEN: 'env-pat', ...environmentOAuth }, selected: 'config-token' },
    { token: undefined, extra: { FIGMA_TOKEN: 'env-pat', ...environmentOAuth }, selected: 'environment-token' },
    { token: undefined, extra: environmentOAuth, selected: 'environment-oauth' },
    { token: '  ', extra: {}, selected: 'local-oauth' },
  ])('preserves authentication priority: $selected', async ({ token, extra, selected }) => {
    const { env } = await setup(local)
    const result = await inspectFigmaAuth({ ...(token !== undefined ? { token } : {}), env: { ...env, ...extra } })
    expect(result.source).toBe(selected)
    expect(result.sources.filter(source => source.selected).map(source => source.source)).toEqual([selected])
  })

  it('reports missing credentials without creating a directory or contacting Figma', async () => {
    const { dir, env } = await setup()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ env, verify: true })
    expect(result.source).toBe('none')
    expect(result.sources.every(source => !source.configured && !source.selected && source.validity === 'unknown')).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
  })

  it('reports incomplete environment OAuth without hiding local diagnostics or changing priority', async () => {
    const { env } = await setup(local)
    const result = await inspectFigmaAuth({ env: { ...env, FIGMA_CLIENT_ID: environmentOAuth.FIGMA_CLIENT_ID }, verify: true })
    expect(result.source).toBe('environment-oauth')
    expect(result.sources[2]).toMatchObject({ configured: true, selected: true, validity: 'invalid', error: { code: 'INCOMPLETE_FIGMA_OAUTH' } })
    expect(result.sources[3]).toMatchObject({ configured: true, selected: false, expiresAt: local.expiresAt })
    const withPat = await inspectFigmaAuth({ token: 'config-pat', env: { ...env, FIGMA_CLIENT_ID: environmentOAuth.FIGMA_CLIENT_ID } })
    expect(withPat.source).toBe('config-token')
    expect(withPat.sources[2]).toMatchObject({ selected: false, validity: 'invalid' })
  })

  it('exposes a malformed local file even when a higher-priority PAT is selected', async () => {
    const { file, env } = await setup()
    await writeFile(file, `malformed ${local.clientSecret} ${file}`)
    const result = await inspectFigmaAuth({ token: 'config-pat', env })
    expect(result.source).toBe('config-token')
    expect(result.sources[3]).toMatchObject({ configured: true, selected: false, validity: 'invalid', error: { message: expect.stringContaining('Invalid Figma credentials file') } })
    expect(JSON.stringify(result)).not.toContain(file)
    expect(JSON.stringify(result)).not.toContain(local.clientSecret)
    expect(await readFile(file, 'utf8')).toBe(`malformed ${local.clientSecret} ${file}`)
  })

  it('reports expired local OAuth without refreshing during explicit verification', async () => {
    const { dir, file, env } = await setup({ ...local, expiresAt: 1 })
    const before = await readFile(file, 'utf8')
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ env, verify: true })
    expect(result.source).toBe('local-oauth')
    expect(result.sources[3]).toMatchObject({ validity: 'expired', expiresAt: 1, error: { code: 'FIGMA_CREDENTIALS_EXPIRED' } })
    expect(request).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['figma.json'])
  })

  it('verifies a healthy local token without refreshing it or creating a cache', async () => {
    const { dir, file, env } = await setup(local)
    const before = await readFile(file, 'utf8')
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.figma.com/v1/me')
      expect(init.method).toBe('GET')
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${local.accessToken}`)
      return Response.json({ id: 'user' })
    })
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ env, verify: true })
    expect(result.sources[3]?.validity).toBe('valid')
    expect(request).toHaveBeenCalledTimes(1)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['figma.json'])
  })

  it('checks only the selected PAT and uses a minimal file access request', async () => {
    const { env } = await setup(local)
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.figma.com/v1/files/aBcDeFgHiJ123?depth=1')
      expect(new Headers(init.headers).get('X-Figma-Token')).toBe('config-pat')
      expect(new Headers(init.headers).has('Authorization')).toBe(false)
      return Response.json({ document: {} })
    })
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ token: 'config-pat', env: { ...env, FIGMA_TOKEN: 'env-pat', ...environmentOAuth }, verify: true, file: 'https://www.figma.com/design/aBcDeFgHiJ123/Icons?node-id=1-2' })
    expect(result.sources.map(source => source.validity)).toEqual(['valid', 'unknown', 'unknown', 'unknown'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([403, 429])('reports file HTTP %i without misclassifying or leaking provider response bodies', async (status) => {
    const { file, env } = await setup()
    const request = vi.fn(async () => Response.json({ error: `config-pat ${file}` }, { status, headers: { 'Retry-After': '7' } }))
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ token: 'config-pat', env, verify: true, file: 'aBcDeFgHiJ123' })
    expect(result.sources[0]).toMatchObject({ validity: 'unknown', error: { code: 'FIGMA_HTTP_ERROR', httpStatus: status, retryable: status === 429 } })
    if (status === 429) {
      expect(result.sources[0]?.error?.retryAfterMs).toBe(7000)
    }
    expect(JSON.stringify(result)).not.toContain('config-pat')
    expect(JSON.stringify(result)).not.toContain(file)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('marks an HTTP 401 credential rejection as invalid', async () => {
    const { env } = await setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const result = await inspectFigmaAuth({ token: 'config-pat', env, verify: true })
    expect(result.sources[0]).toMatchObject({ validity: 'invalid', error: { httpStatus: 401 } })
  })

  it('retains environment OAuth rotation for standard sync without modifying the local file', async () => {
    const { dir, file, env } = await setup(local)
    const supplied = { ...env, ...environmentOAuth, FIGMA_CLIENT_ID: 'isolated-inspection-client' }
    const before = await readFile(file, 'utf8')
    let refreshes = 0
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth/refresh')) {
        refreshes++
        expect(String(init.body)).toBe(`refresh_token=${refreshes === 1 ? environmentOAuth.FIGMA_REFRESH_TOKEN : 'inspect-rotated-refresh'}`)
        return tokenResponse(refreshes === 1 ? 'inspection-access' : 'sync-access')
      }
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer inspection-access')
      return Response.json({ id: 'user' })
    })
    vi.stubGlobal('fetch', request)
    const standardAuth = await resolveFigmaAuth(undefined, supplied)
    const result = await inspectFigmaAuth({ env: supplied, verify: true })
    expect(result.sources[2]).toMatchObject({ validity: 'valid', expiresAt: null })
    expect(await standardAuth.token()).toBe('inspection-access')
    expect(refreshes).toBe(1)
    expect(await standardAuth.token('inspection-access')).toBe('sync-access')
    expect(await (await resolveFigmaAuth(undefined, supplied)).token()).toBe('sync-access')
    expect(refreshes).toBe(2)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['figma.json'])
    expect(JSON.stringify(result)).not.toContain('inspection-access')
    expect(JSON.stringify(result)).not.toContain('inspect-rotated-refresh')
  })

  it('reports invalid environment refresh credentials without exposing secrets', async () => {
    const { env } = await setup()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: environmentOAuth.FIGMA_CLIENT_SECRET }, { status: 400 })))
    const result = await inspectFigmaAuth({ env: { ...env, ...environmentOAuth }, verify: true })
    expect(result.sources[2]).toMatchObject({ validity: 'invalid', error: { httpStatus: 400 } })
    expect(JSON.stringify(result)).not.toContain(environmentOAuth.FIGMA_CLIENT_SECRET)
  })

  it('redacts a rotated shared refresh token from a later transport failure', async () => {
    const { file, env } = await setup()
    const supplied = { ...env, ...environmentOAuth, FIGMA_CLIENT_ID: 'rotated-diagnostic-client' }
    const rotatedRefresh = 'rotated-private-refresh-not-in-environment'
    let refreshes = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/refresh')) {
        if (++refreshes > 1) {
          throw new Error(`${rotatedRefresh} ${file}`)
        }
        return Response.json({ access_token: 'short-lived-access', refresh_token: rotatedRefresh, token_type: 'bearer', expires_in: 1 })
      }
      return Response.json({ id: 'user' })
    }))
    expect((await inspectFigmaAuth({ env: supplied, verify: true })).sources[2]?.validity).toBe('valid')
    const result = await inspectFigmaAuth({ env: supplied, verify: true })
    expect(result.sources[2]).toMatchObject({ validity: 'unknown', error: { code: 'NETWORK_ERROR', retryable: true } })
    expect(JSON.stringify(result)).not.toContain(rotatedRefresh)
    expect(JSON.stringify(result)).not.toContain(file)
    expect(refreshes).toBe(2)
  })

  it.each(['network', 'body', 'file'])('redacts %s failures', async (failure) => {
    const { file, env } = await setup()
    const request = vi.fn(async () => {
      if (failure === 'network') {
        throw new Error(`config-pat ${file}`)
      }
      return new Response(`config-pat ${file}`)
    })
    vi.stubGlobal('fetch', request)
    const result = await inspectFigmaAuth({ token: 'config-pat', env, verify: true, ...(failure === 'file' ? { file: `invalid-config-pat-${file}` } : {}) })
    expect(result.sources[0]?.error).toBeDefined()
    expect(JSON.stringify(result)).not.toContain('config-pat')
    expect(JSON.stringify(result)).not.toContain(file)
    expect(request).toHaveBeenCalledTimes(failure === 'file' ? 0 : 1)
  })

  it('rejects an already aborted inspection without retaining its reason', async () => {
    const { file, env } = await setup()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const signal = AbortSignal.abort(`config-pat ${file}`)
    const error = await inspectFigmaAuth({ token: 'config-pat', env, signal }).catch(error => error as Error)
    expect(error).toBeInstanceOf(IconctlAbortError)
    expect((error as Error).cause).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels verification even if the transport ignores the signal', async () => {
    const { file, env } = await setup()
    const controller = new AbortController()
    const request = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', request)
    const pending = inspectFigmaAuth({ token: 'config-pat', env, verify: true, signal: controller.signal })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    controller.abort(`config-pat ${file}`)
    const error = await pending.catch(error => error as Error)
    expect(error).toBeInstanceOf(IconctlAbortError)
    expect((error as Error).cause).toBeUndefined()
  })

  it.each(['api', 'oauth'])('honors the configured %s verification deadline', async (stage) => {
    const { env } = await setup()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const result = await inspectFigmaAuth({
      ...(stage === 'api' ? { token: 'config-pat' } : {}),
      env: { ...env, ...(stage === 'oauth' ? environmentOAuth : {}) },
      verify: true,
      requestTimeoutMs: 10,
      oauthTimeoutMs: 10,
    })
    expect(result.sources.find(source => source.selected)).toMatchObject({ validity: 'unknown', error: { code: 'REQUEST_TIMEOUT', retryable: true } })
  })
})

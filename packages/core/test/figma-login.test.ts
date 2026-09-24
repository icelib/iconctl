import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFigmaCredentials } from '../src/figma/credentials'
import { loginFigma } from '../src/figma/login'

const networkFetch = globalThis.fetch
let directory: string
let env: NodeJS.Dict<string>
let redirectUri: string

async function listen() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iconctl-login-'))
  env = { FIGMA_CLIENT_ID: 'test-client', FIGMA_CLIENT_SECRET: 'test-secret', ICONCTL_FIGMA_CREDENTIALS_FILE: join(directory, 'figma.json') }
  const { server, port } = await listen()
  await new Promise<void>(resolve => server.close(() => resolve()))
  redirectUri = `http://127.0.0.1:${port}/callback`
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('Figma browser login', () => {
  it('checks state, exchanges the code with PKCE, persists credentials and releases the port', async () => {
    let authorization: URL
    const exchanges = vi.fn(async (_url, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body))
      expect(body.get('code')).toBe('authorization-code')
      expect(body.get('redirect_uri')).toBe(redirectUri)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
      return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600 })
    })
    vi.stubGlobal('fetch', exchanges)
    const login = loginFigma({
      env,
      redirectUri,
      async onAuthorize(url) {
        authorization = new URL(url)
        expect(authorization.origin).toBe('https://www.figma.com')
        expect(authorization.searchParams.get('scope')).toBe('file_content:read')
        const invalid = await networkFetch(`${redirectUri}?code=wrong&state=wrong`)
        expect(invalid.status).toBe(400)
        expect(exchanges).not.toHaveBeenCalled()
        const response = await networkFetch(`${redirectUri}?code=authorization-code&state=${authorization.searchParams.get('state')}`)
        expect(response.status).toBe(200)
        expect(await response.text()).not.toContain('refresh')
      },
    })
    await login
    expect((await readFigmaCredentials(env['ICONCTL_FIGMA_CREDENTIALS_FILE']!))?.refreshToken).toBe('refresh')
    expect(exchanges).toHaveBeenCalledTimes(1)
    await expect(networkFetch(redirectUri)).rejects.toThrow()
  })

  it('times out and closes the callback listener', async () => {
    await expect(loginFigma({ env, redirectUri, timeoutMs: 40, onAuthorize() {} })).rejects.toThrow('timed out')
    await expect(networkFetch(redirectUri)).rejects.toThrow()
    expect(await readFigmaCredentials(env['ICONCTL_FIGMA_CREDENTIALS_FILE']!)).toBeUndefined()
  })

  it('aborts and closes the callback listener', async () => {
    const controller = new AbortController()
    await expect(loginFigma({ env, redirectUri, signal: controller.signal, onAuthorize: () => controller.abort() })).rejects.toThrow('cancelled')
    await expect(networkFetch(redirectUri)).rejects.toThrow()
  })

  it('rejects an occupied port without waiting for the login timeout', async () => {
    const { server, port } = await listen()
    try {
      await expect(loginFigma({ env, redirectUri: `http://127.0.0.1:${port}/callback`, onAuthorize() {} })).rejects.toThrow('port')
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('does not save credentials if cancelled during the code exchange', async () => {
    const controller = new AbortController()
    let completed: Promise<Response> | undefined
    const finished = Promise.withResolvers<void>()
    vi.stubGlobal('fetch', async () => {
      controller.abort()
      finished.resolve()
      return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600 })
    })
    await expect(loginFigma({
      env,
      redirectUri,
      signal: controller.signal,
      onAuthorize(url) {
        completed = networkFetch(`${redirectUri}?code=code&state=${new URL(url).searchParams.get('state')}`).catch(() => new Response())
      },
    })).rejects.toThrow('cancelled')
    await finished.promise
    await completed
    expect(await readFigmaCredentials(env['ICONCTL_FIGMA_CREDENTIALS_FILE']!)).toBeUndefined()
  })

  it.each(['https://example.com/callback', 'http://0.0.0.0:3000/callback', 'http://127.0.0.1:0/callback'])('rejects non-loopback or unstable callback %s', async (redirectUri) => {
    await expect(loginFigma({ env, redirectUri, onAuthorize() {} })).rejects.toThrow('loopback')
  })
})

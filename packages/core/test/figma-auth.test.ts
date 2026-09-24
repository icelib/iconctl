import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getFigmaAuthStatus, logoutFigma, resolveFigmaAuth } from '../src/figma/auth'
import { FigmaClient } from '../src/figma/client'
import { readFigmaCredentials, writeFigmaCredentials } from '../src/figma/credentials'

const original = { clientId: 'client', clientSecret: 'secret-do-not-log', accessToken: 'old-private-token', refreshToken: 'refresh-do-not-log', expiresAt: 1 }
const directories: string[] = []
async function setup(expiresAt = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'iconctl-auth-'))
  directories.push(dir)
  const file = join(dir, 'figma.json')
  await writeFigmaCredentials(file, { ...original, expiresAt })
  return { dir, file, env: { ICONCTL_FIGMA_CREDENTIALS_FILE: file } }
}
function tokenResponse(accessToken = 'new-private-token') {
  return Response.json({ access_token: accessToken, token_type: 'bearer', expires_in: 3600 })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Figma credentials and refresh', () => {
  it('recovers an expired lock left by a terminated process', async () => {
    const { file, env } = await setup()
    await mkdir(`${file}.lock`)
    const stale = new Date(Date.now() - 60_000)
    await utimes(`${file}.lock`, stale, stale)
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()))
    expect(await (await resolveFigmaAuth(undefined, env)).token()).toBe('new-private-token')
    await expect(stat(`${file}.lock`)).rejects.toThrow()
  })

  it('keeps the old file if ownership is lost before the atomic replacement', async () => {
    const { file, dir } = await setup()
    const before = await readFile(file, 'utf8')
    await expect(writeFigmaCredentials(file, { ...original, accessToken: 'must-not-save' }, () => {
      throw new Error('lost lock')
    })).rejects.toThrow('Cannot save')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(dir)).toEqual(['figma.json'])
  })

  it('persists a rotated refresh token and uses it for the next refresh', async () => {
    const { file, env } = await setup()
    const request = vi.fn(async () => Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600 }))
    vi.stubGlobal('fetch', request)
    const auth = await resolveFigmaAuth(undefined, env)
    await auth.token()
    expect((await readFigmaCredentials(file))?.refreshToken).toBe('rotated-refresh')
    const second = vi.fn(async (_url, init: RequestInit) => {
      expect(String(init.body)).toBe('refresh_token=rotated-refresh')
      return tokenResponse('second-access')
    })
    vi.stubGlobal('fetch', second)
    expect(await auth.token('rotated-access')).toBe('second-access')
  })

  it('refreshes expired credentials once across concurrent consumers and saves privately', async () => {
    const { file, env, dir } = await setup()
    const request = vi.fn(async (_url, init: RequestInit) => {
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('Authorization')).toBe(`Basic ${Buffer.from('client:secret-do-not-log').toString('base64')}`)
      expect(String(init.body)).toBe('refresh_token=refresh-do-not-log')
      return tokenResponse()
    })
    vi.stubGlobal('fetch', request)
    const consumers = await Promise.all(Array.from({ length: 8 }, () => resolveFigmaAuth(undefined, env)))
    expect(await Promise.all(consumers.map(auth => auth.token()))).toEqual(Array.from({ length: 8 }).fill('new-private-token'))
    expect(request).toHaveBeenCalledTimes(1)
    const saved = await readFigmaCredentials(file)
    expect(saved?.refreshToken).toBe(original.refreshToken)
    expect(saved?.expiresAt).toBeGreaterThan(Date.now())
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    expect(await readdir(dir)).toEqual(['figma.json'])
  })

  it('waits for another process and rereads the credentials it refreshed', async () => {
    const { file, env } = await setup()
    const auth = await resolveFigmaAuth(undefined, env)
    const lockModule = createRequire(import.meta.url).resolve('proper-lockfile')
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import lockfile from ${JSON.stringify(lockModule)};
      import { writeFile } from 'node:fs/promises';
      const file = process.argv[1];
      const release = await lockfile.lock(file, { realpath: false });
      process.stdout.write('locked');
      process.stdin.once('data', async () => {
        await writeFile(file, JSON.stringify(${JSON.stringify({ version: 1, ...original, accessToken: 'from-other-process', expiresAt: Date.now() + 3600_000 })}));
        await release();
        process.exit(0);
      });
    `, file], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      const request = vi.fn()
      vi.stubGlobal('fetch', request)
      const waiting = auth.token()
      const exited = once(child, 'exit')
      child.stdin.write('release')
      expect(await waiting).toBe('from-other-process')
      expect(request).not.toHaveBeenCalled()
      await exited
    }
    finally {
      child.kill()
    }
  })

  it('refreshes shortly before expiry, but reuses a healthy token', async () => {
    const { env } = await setup(Date.now() + 301_000)
    const request = vi.fn(async () => tokenResponse())
    vi.stubGlobal('fetch', request)
    const auth = await resolveFigmaAuth(undefined, env)
    expect(await auth.token()).toBe(original.accessToken)
    expect(request).not.toHaveBeenCalled()
    const { env: expiring } = await setup(Date.now() + 299_000)
    expect(await (await resolveFigmaAuth(undefined, expiring)).token()).toBe('new-private-token')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    () => Response.json({ error: original.clientSecret }, { status: 400 }),
    () => Response.json({ access_token: 'invalid', expires_in: -1, token_type: 'bearer' }),
    () => new Response('not json'),
    () => Response.json(null),
    () => { throw new Error(original.refreshToken) },
  ])('preserves credentials and redacts failures', async (response) => {
    const { file, env } = await setup()
    const before = await readFile(file, 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const auth = await resolveFigmaAuth(undefined, env)
    const error = await auth.token().catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(original.clientSecret)
    expect(String(error)).not.toContain(original.refreshToken)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(join(file, '..'))).toEqual(['figma.json'])
  })

  it('uses explicit PAT before environment credentials and rejects partial OAuth', async () => {
    expect(await (await resolveFigmaAuth('configured', { FIGMA_TOKEN: 'env' })).token()).toBe('configured')
    expect(await (await resolveFigmaAuth(undefined, { FIGMA_TOKEN: 'env', FIGMA_CLIENT_ID: 'partial' })).token()).toBe('env')
    const { env } = await setup()
    await expect(resolveFigmaAuth(undefined, { ...env, FIGMA_CLIENT_ID: 'partial' })).rejects.toThrow('together')
  })

  it('reuses environment OAuth across sources without reading or writing local credentials', async () => {
    const { file, env } = await setup()
    await writeFile(file, 'invalid local file')
    const supplied = { ...env, FIGMA_CLIENT_ID: file, FIGMA_CLIENT_SECRET: 'ci-secret', FIGMA_REFRESH_TOKEN: 'ci-refresh' }
    const request = vi.fn(async () => tokenResponse('ci-access'))
    vi.stubGlobal('fetch', request)
    const first = await resolveFigmaAuth(undefined, supplied)
    const second = await resolveFigmaAuth(undefined, supplied)
    expect(await Promise.all([first.token(), second.token()])).toEqual(['ci-access', 'ci-access'])
    expect(request).toHaveBeenCalledTimes(1)
    expect(await readFile(file, 'utf8')).toBe('invalid local file')
    expect(JSON.stringify(await getFigmaAuthStatus(supplied))).not.toContain('ci-secret')
  })

  it('reports expiry without refreshing, and logout removes only local credentials', async () => {
    const { file, env } = await setup()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(await getFigmaAuthStatus(env)).toEqual({ source: 'local-oauth', expiresAt: 1, expired: true })
    await logoutFigma(env)
    expect(await readFigmaCredentials(file)).toBeUndefined()
    expect((await getFigmaAuthStatus(env)).source).toBe('none')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Figma request authentication', () => {
  it.each([401, 403])('refreshes an invalid token response (%i) and retries once', async (status) => {
    const { env, dir } = await setup(Date.now() + 3600_000)
    const headers: string[] = []
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/oauth/refresh')) {
        return tokenResponse()
      }
      headers.push(new Headers(init.headers).get('Authorization')!)
      return headers.length === 1 ? Response.json({ err: 'Invalid token' }, { status }) : Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', request)
    const client = new FigmaClient(await resolveFigmaAuth(undefined, env), dir)
    expect(await client.json('files/file', new URLSearchParams())).toEqual({ ok: true })
    expect(headers).toEqual([`Bearer ${original.accessToken}`, 'Bearer new-private-token'])
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('stops after one retry when the replacement token also fails', async () => {
    const { env, dir } = await setup(Date.now() + 3600_000)
    const request = vi.fn(async (url: string) => url.endsWith('/oauth/refresh') ? tokenResponse() : new Response('', { status: 401 }))
    vi.stubGlobal('fetch', request)
    const client = new FigmaClient(await resolveFigmaAuth(undefined, env), dir)
    await expect(client.json('files/file', new URLSearchParams())).rejects.toThrow('HTTP 401')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([403, 429, 500])('does not refresh ordinary HTTP %i errors', async (status) => {
    const { env, dir } = await setup(Date.now() + 3600_000)
    const request = vi.fn(async () => Response.json({ err: 'Permission denied' }, { status }))
    vi.stubGlobal('fetch', request)
    const client = new FigmaClient(await resolveFigmaAuth(undefined, env), dir)
    await expect(client.json('files/file', new URLSearchParams())).rejects.toThrow(`HTTP ${status}`)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('sends PAT headers only to the API and no credentials to SVG CDN URLs', async () => {
    const { dir } = await setup()
    const request = vi.fn(async (url: string | URL, init: RequestInit) => {
      if (String(url).includes('api.figma.com')) {
        expect(new Headers(init.headers).get('X-Figma-Token')).toBe('pat-secret')
        expect(new Headers(init.headers).has('Authorization')).toBe(false)
        return Response.json({ ok: true })
      }
      expect(init.headers).toBeUndefined()
      return new Response('<svg/>')
    })
    vi.stubGlobal('fetch', request)
    const client = new FigmaClient(await resolveFigmaAuth('pat-secret', {}), dir)
    await client.json('files/file', new URLSearchParams())
    await client.svg('https://cdn.example.com/icon.svg')
    const cached = await Promise.all((await readdir(join(dir, 'figma-v1'))).map(file => readFile(join(dir, 'figma-v1', file), 'utf8')))
    expect(cached.join('')).not.toContain('pat-secret')
    expect(cached.join('')).not.toContain('Authorization')
  })
})

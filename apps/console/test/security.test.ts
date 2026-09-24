import type { AccountState } from '../worker/state'
import { OWNER_ID } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decrypt,
  digest,
  encrypt,
  limitedBody,
  verifyWebhook,
} from '../worker/security'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
async function rejects(action: (instance: AccountState) => Promise<unknown>) {
  return runInDurableObject(account(), async (instance) => {
    try {
      await action(instance)
      return false
    }
    catch {
      return true
    }
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

describe('private routes and sessions', () => {
  it('rejects anonymous APIs, assets, snapshots and downloads', async () => {
    for (const path of [
      '/api/state',
      '/api/backup',
      '/api/snapshots/whatever',
      '/api/releases/a/package.tgz',
    ]) {
      const response = await exports.default.fetch(
        `https://iconctl.icebreaker.top${path}`,
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    for (const path of [
      '/app',
      '/app/',
      '/app/assets/private.js',
      '/app/index.html',
      '/%61pp/assets/private.js',
      '/app%2fassets/private.js',
      '/%2561pp/index.html',
    ]) {
      const response = await exports.default.fetch(
        `https://iconctl.icebreaker.top${path}`,
        { redirect: 'manual' },
      )
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/login')
    }
  })
  it('allows only the numeric owner and revokes sessions', async () => {
    expect(await rejects(instance => instance.newSession('1'))).toBe(true)
    const created = await account().newSession(OWNER_ID)
    const cookie = `__Host-iconctl-session=${created.token}`
    const response = await exports.default.fetch(
      'https://iconctl.icebreaker.top/api/session',
      { headers: { Cookie: cookie } },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      owner: 'sonofmagic',
      csrf: created.csrf,
    })
    await account().logout(await digest(created.token))
    expect(
      (
        await exports.default.fetch(
          'https://iconctl.icebreaker.top/api/state',
          { headers: { Cookie: cookie } },
        )
      ).status,
    ).toBe(401)
  })
  it('requires both same-origin and CSRF for writes', async () => {
    const session = await account().newSession(OWNER_ID)
    for (const headers of [
      { 'Origin': 'https://evil.example', 'X-CSRF-Token': session.csrf },
      { Origin: env.APP_ORIGIN },
      { 'X-CSRF-Token': session.csrf },
    ] as Record<string, string>[]) {
      const response = await exports.default.fetch(
        `${env.APP_ORIGIN}/api/logout`,
        {
          method: 'POST',
          headers: {
            Cookie: `__Host-iconctl-session=${session.token}`,
            ...headers,
          },
        },
      )
      expect(response.status).toBe(403)
    }
    expect(
      (
        await exports.default.fetch(`${env.APP_ORIGIN}/api/logout`, {
          method: 'POST',
          headers: {
            'Cookie': `__Host-iconctl-session=${session.token}`,
            'Origin': env.APP_ORIGIN,
            'X-CSRF-Token': session.csrf,
          },
        })
      ).status,
    ).toBe(200)
  })
  it('consumes OAuth state once and binds it to the browser and provider', async () => {
    const state = 'random-state'
    await account().saveOAuth(state, {
      provider: 'github',
      verifier: 'verifier',
      browser: 'browser',
      expiresAt: Date.now() + 60_000,
    })
    expect(
      await rejects(instance =>
        instance.consumeOAuth(state, 'attacker', 'github'),
      ),
    ).toBe(true)
    expect(
      await rejects(instance =>
        instance.consumeOAuth(state, 'browser', 'figma'),
      ),
    ).toBe(true)
    expect(
      (await account().consumeOAuth(state, 'browser', 'github')).verifier,
    ).toBe('verifier')
    expect(
      await rejects(instance =>
        instance.consumeOAuth(state, 'browser', 'github'),
      ),
    ).toBe(true)
    await account().saveOAuth('expired', {
      provider: 'github',
      verifier: 'verifier',
      browser: 'browser',
      expiresAt: 1,
    })
    expect(
      await rejects(instance =>
        instance.consumeOAuth('expired', 'browser', 'github'),
      ),
    ).toBe(true)
  })
})
describe('encrypted credential broker', () => {
  it('authenticates ciphertext and its connection context', async () => {
    const encrypted = await encrypt(
      env.CREDENTIAL_ENCRYPTION_KEY,
      'connection-a',
      { accessToken: 'secret' },
    )
    expect(encrypted).not.toContain('secret')
    expect(
      await decrypt(env.CREDENTIAL_ENCRYPTION_KEY, 'connection-a', encrypted),
    ).toEqual({ accessToken: 'secret' })
    await expect(
      decrypt(env.CREDENTIAL_ENCRYPTION_KEY, 'connection-b', encrypted),
    ).rejects.toThrow()
  })
  it('merges concurrent refreshes, retains omitted refresh tokens, and omits secrets from status', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        Response.json({
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_in: 60,
          token_type: 'bearer',
        }),
      )
    const id = await account().connectFigma('code', 'verifier')
    fetch.mockImplementation(async () =>
      Response.json({
        access_token: 'fresh-access',
        expires_in: 3600,
        token_type: 'bearer',
      }),
    )
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => account().credential(id)),
    )
    expect(tokens.every(token => token.accessToken === 'fresh-access')).toBe(
      true,
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(tokens[0]?.refreshToken).toBe('old-refresh')
    expect(JSON.stringify(await account().state())).not.toMatch(
      /old-refresh|fresh-access|figma-secret|encrypted/,
    )
    expect((await account().credential(id, 'old-access')).accessToken).toBe(
      'fresh-access',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('preserves old encrypted credentials and requires reconnect after an ambiguous refresh failure', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        Response.json({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 1,
          token_type: 'bearer',
        }),
      )
    const id = await account().connectFigma('code', 'verifier')
    const read = () =>
      runInDurableObject(
        account(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ value: string }>(
              'SELECT value FROM records WHERE key=?',
              `connection:${id}`,
            )
            .one()
            .value,
      )
    const before = JSON.parse(await read())
    fetch.mockImplementation(
      async () => new Response('secret-provider-response', { status: 401 }),
    )
    expect(await rejects(instance => instance.credential(id))).toBe(true)
    const after = JSON.parse(await read())
    expect(after.encrypted).toBe(before.encrypted)
    expect(after.reconnect).toBe(true)
    expect(await rejects(instance => instance.credential(id))).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await account().state())).not.toContain(
      'secret-provider-response',
    )
  })
  it('does not restore a connection disconnected during refresh', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () =>
        Response.json({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 1,
          token_type: 'bearer',
        }),
      )
    const id = await account().connectFigma('code', 'verifier')
    const rejected = await runInDurableObject(account(), async (instance) => {
      fetch.mockImplementation(async () => {
        instance.disconnect(id)
        return Response.json({
          access_token: 'fresh',
          expires_in: 3600,
          token_type: 'bearer',
        })
      })
      try {
        await instance.credential(id)
        return false
      }
      catch {
        return true
      }
    })
    expect(rejected).toBe(true)
    expect((await account().state()).connections).toEqual([])
  })
})
it('rejects oversized streamed uploads and invalid webhooks', async () => {
  await expect(
    limitedBody(
      new Request('https://example.com', { method: 'POST', body: 'too long' }),
      3,
    ),
  ).rejects.toThrow()
  expect(await verifyWebhook('secret', new ArrayBuffer(0), 'sha256=bad')).toBe(
    false,
  )
})

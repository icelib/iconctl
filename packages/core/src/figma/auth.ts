import type { FigmaAuthOptions, RequestOptions } from '../request-options'
import type { FigmaCredentials } from './oauth'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import process from 'node:process'
import { IconctlError } from '../errors'
import { resolveRequestOptions, waitForRequest, withRequestDeadline } from '../request-options'
import { figmaCredentialsPath, readFigmaCredentials, withFigmaCredentialsLock, writeFigmaCredentials } from './credentials'
import { refreshFigmaCredentials } from './oauth'

const refreshAhead = 5 * 60 * 1000

export interface FigmaAuth {
  kind: 'pat' | 'oauth'
  cacheIdentity: string
  token: (rejectedToken?: string) => Promise<string>
}

function identity(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function environmentCredentials(env: NodeJS.Dict<string>) {
  const clientId = env['FIGMA_CLIENT_ID']?.trim()
  const clientSecret = env['FIGMA_CLIENT_SECRET']?.trim()
  const refreshToken = env['FIGMA_REFRESH_TOKEN']?.trim()
  if (!clientId && !clientSecret && !refreshToken) {
    return undefined
  }
  if (!clientId || !clientSecret || !refreshToken) {
    throw new IconctlError('Set FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET and FIGMA_REFRESH_TOKEN together for environment OAuth authentication. For local login, unset these variables after authorization.')
  }
  return { clientId, clientSecret, refreshToken }
}

interface OAuthSession extends FigmaAuth {
  token: (rejectedToken?: string, options?: RequestOptions) => Promise<string>
}

function oauthAuth(initial: FigmaCredentials | undefined, key: string, update: (rejectedToken: string | undefined, options: Required<RequestOptions>) => Promise<FigmaCredentials>): OAuthSession {
  let credentials = initial
  return {
    kind: 'oauth',
    cacheIdentity: identity(key),
    async token(rejectedToken, options) {
      if (!credentials || credentials.expiresAt <= Date.now() + refreshAhead || rejectedToken === credentials.accessToken) {
        credentials = await update(rejectedToken, resolveRequestOptions(options))
      }
      return credentials.accessToken
    },
  }
}

interface RefreshFlight {
  promise: Promise<FigmaCredentials>
  extend: (timeoutMs: number) => void
}

// Share rotation state by identity, irrespective of caller deadline policy.
const environmentSessions = new Map<string, OAuthSession>()
const refreshFlights = new Map<string, RefreshFlight>()

function sharedRefresh(key: string, timeoutMs: number, update: (signal: AbortSignal) => Promise<FigmaCredentials>): Promise<FigmaCredentials> {
  const existing = refreshFlights.get(key)
  if (existing) {
    existing.extend(timeoutMs)
    return existing.promise
  }
  const controller = new AbortController()
  let deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout>
  const schedule = () => {
    clearTimeout(timer!)
    timer = setTimeout(() => {
      if (Date.now() < deadline) {
        schedule()
      }
      else {
        controller.abort(new IconctlError('Figma OAuth shared refresh timed out. Check your connection and retry.', {
          code: 'REQUEST_TIMEOUT',
          retryable: true,
          sourceType: 'figma',
          operation: 'figma-oauth-refresh',
        }))
      }
    }, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647))
  }
  schedule()
  const promise = Promise.resolve().then(() => update(controller.signal)).catch((error) => {
    if (controller.signal.aborted && controller.signal.reason instanceof IconctlError) {
      throw controller.signal.reason
    }
    throw error
  }).finally(() => {
    clearTimeout(timer!)
    refreshFlights.delete(key)
  })
  refreshFlights.set(key, {
    promise,
    extend(timeout) {
      // A shorter/cancelled waiter never shortens work owned by its siblings.
      deadline = Math.max(deadline, Date.now() + timeout)
      schedule()
    },
  })
  return promise
}

// Shared work owns the adaptive deadline above. Each waiter separately enforces
// its policy; disable the nested fixed deadline so a later sibling can extend it.
function sharedCredentials(credentials: Parameters<typeof refreshFigmaCredentials>[0], signal: AbortSignal) {
  return refreshFigmaCredentials(credentials, { signal, oauthTimeoutMs: Number.MAX_SAFE_INTEGER })
}

export async function resolveFigmaAuth(configToken?: string, env: NodeJS.Dict<string> = process.env, options: FigmaAuthOptions = {}): Promise<FigmaAuth> {
  const resolved = resolveRequestOptions(options)
  const owned = (auth: OAuthSession): FigmaAuth => ({
    ...auth,
    // A consumer cancels only its wait. A refresh shared by sibling consumers
    // owns its OAuth deadline and is allowed to persist rotated credentials.
    token: rejectedToken => auth.kind === 'pat'
      ? waitForRequest(() => auth.token(rejectedToken), options.signal)
      : withRequestDeadline({ signal: options.signal, timeoutMs: resolved.oauthTimeoutMs, operation: 'figma-oauth-refresh', label: 'Figma OAuth' }, () => auth.token(rejectedToken, resolved)),
  })
  await waitForRequest(async () => {}, options.signal)
  const pat = configToken?.trim() || env['FIGMA_TOKEN']?.trim()
  if (pat) {
    return owned({ kind: 'pat', cacheIdentity: identity(pat), token: async () => pat })
  }
  const supplied = environmentCredentials(env)
  if (supplied) {
    const key = identity(JSON.stringify(supplied))
    let session = environmentSessions.get(key)
    if (!session) {
      let current = supplied
      session = oauthAuth(undefined, key, (_rejectedToken, policy) => sharedRefresh(`environment:${key}`, policy.oauthTimeoutMs, async (signal) => {
        const updated = await sharedCredentials(current, signal)
        current = updated
        return updated
      }))
      environmentSessions.set(key, session)
    }
    return owned(session)
  }
  const file = figmaCredentialsPath(env)
  const credentials = await waitForRequest(() => readFigmaCredentials(file), options.signal)
  if (!credentials) {
    throw new IconctlError('Missing Figma credentials. Run `iconctl auth figma login`, supply OAuth environment credentials, or set FIGMA_TOKEN for a personal access token.')
  }
  return owned(oauthAuth(credentials, `${credentials.clientId}:${credentials.refreshToken}`, (rejectedToken, policy) =>
    sharedRefresh(`file:${file}`, policy.oauthTimeoutMs, signal =>
      withFigmaCredentialsLock(file, async (assertOwned) => {
        const latest = await readFigmaCredentials(file)
        if (!latest) {
          throw new IconctlError('Figma credentials were removed. Run `iconctl auth figma login` again.')
        }
        if (latest.expiresAt > Date.now() + refreshAhead && latest.accessToken !== rejectedToken) {
          return latest
        }
        const updated = await sharedCredentials(latest, signal)
        await writeFigmaCredentials(file, updated, assertOwned)
        return updated
      }))))
}

export async function getFigmaAuthStatus(env: NodeJS.Dict<string> = process.env) {
  if (env['FIGMA_TOKEN']?.trim()) {
    return { source: 'personal-token', expiresAt: null, expired: null }
  }
  if (environmentCredentials(env)) {
    return { source: 'environment-oauth', expiresAt: null, expired: null }
  }
  const credentials = await readFigmaCredentials(figmaCredentialsPath(env))
  return {
    source: credentials ? 'local-oauth' : 'none',
    expiresAt: credentials?.expiresAt ?? null,
    expired: credentials ? credentials.expiresAt <= Date.now() : null,
  }
}

export async function logoutFigma(env: NodeJS.Dict<string> = process.env): Promise<void> {
  const file = figmaCredentialsPath(env)
  await withFigmaCredentialsLock(file, () => rm(file, { force: true }))
}

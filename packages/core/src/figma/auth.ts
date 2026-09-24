import type { FigmaCredentials } from './oauth'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import process from 'node:process'
import { IconctlError } from '../errors'
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

function oauthAuth(initial: FigmaCredentials | undefined, key: string, update: (rejectedToken?: string) => Promise<FigmaCredentials>): FigmaAuth {
  let credentials = initial
  let pending: Promise<FigmaCredentials> | undefined
  return {
    kind: 'oauth',
    cacheIdentity: identity(key),
    async token(rejectedToken) {
      // One in-flight refresh per identity. A failed request with an older
      // token can immediately use the replacement obtained by another request.
      if (!pending && (!credentials || credentials.expiresAt <= Date.now() + refreshAhead || rejectedToken === credentials.accessToken)) {
        pending = update(rejectedToken).then((result) => {
          credentials = result
          return result
        }).finally(() => { pending = undefined })
      }
      if (pending) {
        await pending
      }
      return credentials!.accessToken
    },
  }
}

// Share refresh state across sources and concurrent sync() calls, without
// retaining secrets in map keys or exposing them through errors.
const environmentSessions = new Map<string, FigmaAuth>()
const fileRefreshes = new Map<string, Promise<FigmaCredentials>>()

export async function resolveFigmaAuth(configToken?: string, env: NodeJS.Dict<string> = process.env): Promise<FigmaAuth> {
  const pat = configToken?.trim() || env['FIGMA_TOKEN']?.trim()
  if (pat) {
    return { kind: 'pat', cacheIdentity: identity(pat), token: async () => pat }
  }
  const supplied = environmentCredentials(env)
  if (supplied) {
    const key = identity(JSON.stringify(supplied))
    let session = environmentSessions.get(key)
    if (!session) {
      let current = supplied
      session = oauthAuth(undefined, key, async () => {
        const updated = await refreshFigmaCredentials(current)
        current = updated
        return updated
      })
      environmentSessions.set(key, session)
    }
    return session
  }
  const file = figmaCredentialsPath(env)
  const credentials = await readFigmaCredentials(file)
  if (!credentials) {
    throw new IconctlError('Missing Figma credentials. Run `iconctl auth figma login`, supply OAuth environment credentials, or set FIGMA_TOKEN for a personal access token.')
  }
  return oauthAuth(credentials, `${credentials.clientId}:${credentials.refreshToken}`, async (rejectedToken) => {
    let pending = fileRefreshes.get(file)
    if (!pending) {
      pending = withFigmaCredentialsLock(file, async (assertOwned) => {
        const latest = await readFigmaCredentials(file)
        if (!latest) {
          throw new IconctlError('Figma credentials were removed. Run `iconctl auth figma login` again.')
        }
        if (latest.expiresAt > Date.now() + refreshAhead && latest.accessToken !== rejectedToken) {
          return latest
        }
        const updated = await refreshFigmaCredentials(latest)
        await writeFigmaCredentials(file, updated, assertOwned)
        return updated
      }).finally(() => { fileRefreshes.delete(file) })
      fileRefreshes.set(file, pending)
    }
    return pending
  })
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

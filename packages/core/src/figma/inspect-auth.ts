import type { SerializedIconctlError } from '../errors'
import type { FigmaAuthOptions } from '../request-options'
import type { FigmaCredentials } from './oauth'
import process from 'node:process'
import { IconctlAbortError, IconctlError, serializeIconctlError } from '../errors'
import { parseFigmaFileKey } from '../file-key'
import { cancelResponse, figmaHttpError, readResponseText, resolveRequestOptions, withRequestDeadline } from '../request-options'
import { resolveFigmaAuth } from './auth'
import { figmaCredentialsPath, readFigmaCredentials } from './credentials'

export type FigmaAuthSource = 'config-token' | 'environment-token' | 'environment-oauth' | 'local-oauth'

export interface FigmaAuthSourceInspection {
  source: FigmaAuthSource
  configured: boolean
  selected: boolean
  validity: 'unknown' | 'valid' | 'invalid' | 'expired'
  expiresAt: number | null
  error?: SerializedIconctlError
}

export interface FigmaAuthInspection {
  /** The source normal authentication would select, including invalid configuration. */
  source: FigmaAuthSource | 'none'
  sources: FigmaAuthSourceInspection[]
}

export interface InspectFigmaAuthOptions extends FigmaAuthOptions {
  env?: NodeJS.Dict<string>
  token?: string
  /** Check only the selected source. The default performs no network requests. */
  verify?: boolean
  /** Check access to this file instead of requesting the current user's profile. */
  file?: string
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    // Abort reasons are caller-controlled and may contain credentials or paths.
    throw new IconctlAbortError()
  }
}

async function verifyToken(token: string, kind: 'pat' | 'oauth', options: InspectFigmaAuthOptions): Promise<void> {
  const requestOptions = resolveRequestOptions(options)
  let path = 'me'
  if (options.file !== undefined) {
    try {
      path = `files/${encodeURIComponent(parseFigmaFileKey(options.file))}?depth=1`
    }
    catch {
      // The parser includes its input in some errors; URLs may contain secrets.
      throw new IconctlError('Invalid Figma file or URL. Supply a file key or a Figma design URL.', {
        code: 'INVALID_FIGMA_FILE',
        sourceType: 'figma',
        operation: 'figma-auth-inspect',
      })
    }
  }
  await withRequestDeadline({
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: requestOptions.requestTimeoutMs,
    operation: 'figma-auth-inspect',
    label: 'Figma authentication check',
  }, async (signal) => {
    const response = await fetch(`https://api.figma.com/v1/${path}`, {
      method: 'GET',
      headers: kind === 'oauth' ? { Authorization: `Bearer ${token}` } : { 'X-Figma-Token': token },
      redirect: 'error',
      signal,
    })
    if (!response.ok) {
      cancelResponse(response)
      const hint = response.status === 401
        ? 'Check your credentials; for OAuth, run `iconctl auth figma login` again or update CI secrets.'
        : response.status === 403
          ? options.file === undefined ? 'Check the token scopes and account access.' : 'Check file access and the file_content:read scope.'
          : response.status === 429 ? 'Rate limit reached. Retry later.' : 'Retry later or check the file key and account access.'
      throw figmaHttpError(response, 'Figma authentication check', 'figma-auth-inspect', hint)
    }
    const text = await readResponseText(response, signal)
    try {
      const data: unknown = JSON.parse(text)
      if (!data || typeof data !== 'object' || Array.isArray(data) || ('err' in data && data.err)) {
        throw new Error('invalid')
      }
    }
    catch {
      // Provider bodies and JSON parser errors must never enter diagnostics.
      throw new IconctlError('Invalid Figma authentication check response.', {
        code: 'INVALID_RESPONSE',
        sourceType: 'figma',
        operation: 'figma-auth-inspect',
      })
    }
    finally {
      if (signal.aborted) {
        cancelResponse(response)
      }
    }
  })
}

/**
 * By default, inspect every source with local reads only: no network, refreshes,
 * session changes, or writes. Explicit verification may refresh environment OAuth
 * in its shared in-memory session, retaining rotated tokens for subsequent syncs.
 * Local OAuth is never refreshed, including when expired. Neither mode writes
 * credentials or response cache files.
 */
export async function inspectFigmaAuth(options: InspectFigmaAuthOptions = {}): Promise<FigmaAuthInspection> {
  checkCancellation(options.signal)
  resolveRequestOptions(options)
  const env = options.env ?? process.env
  const configToken = options.token?.trim()
  const environmentToken = env['FIGMA_TOKEN']?.trim()
  const clientId = env['FIGMA_CLIENT_ID']?.trim()
  const clientSecret = env['FIGMA_CLIENT_SECRET']?.trim()
  const refreshToken = env['FIGMA_REFRESH_TOKEN']?.trim()
  const secrets = [configToken, environmentToken, clientId, clientSecret, refreshToken].filter((value): value is string => Boolean(value))
  const source = (name: FigmaAuthSource, configured: boolean): FigmaAuthSourceInspection => ({
    source: name,
    configured,
    selected: false,
    validity: 'unknown',
    expiresAt: null,
  })
  const config = source('config-token', Boolean(configToken))
  const environmentPat = source('environment-token', Boolean(environmentToken))
  const environmentOAuth = source('environment-oauth', Boolean(clientId || clientSecret || refreshToken))
  const localOAuth = source('local-oauth', false)
  const sources = [config, environmentPat, environmentOAuth, localOAuth]
  const setError = (entry: FigmaAuthSourceInspection, error: unknown) => {
    entry.error = serializeIconctlError(error, { secrets })
  }

  if (environmentOAuth.configured && (!clientId || !clientSecret || !refreshToken)) {
    environmentOAuth.validity = 'invalid'
    setError(environmentOAuth, new IconctlError('Set FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET and FIGMA_REFRESH_TOKEN together for environment OAuth authentication. For local login, unset these variables after authorization.', {
      code: 'INCOMPLETE_FIGMA_OAUTH',
      sourceType: 'figma',
      operation: 'figma-auth-inspect',
    }))
  }

  let localCredentials: FigmaCredentials | undefined
  try {
    const file = figmaCredentialsPath(env)
    secrets.push(file)
    localCredentials = await readFigmaCredentials(file)
    if (localCredentials) {
      secrets.push(localCredentials.clientId, localCredentials.clientSecret, localCredentials.accessToken, localCredentials.refreshToken)
      localOAuth.configured = true
      localOAuth.expiresAt = localCredentials.expiresAt
      if (localCredentials.expiresAt <= Date.now()) {
        localOAuth.validity = 'expired'
        setError(localOAuth, new IconctlError('Local Figma credentials have expired. Run `iconctl auth figma login` again or use normal sync to refresh them.', {
          code: 'FIGMA_CREDENTIALS_EXPIRED',
          sourceType: 'figma',
          operation: 'figma-auth-inspect',
        }))
      }
    }
  }
  catch (error) {
    localOAuth.configured = true
    localOAuth.validity = 'invalid'
    setError(localOAuth, error)
  }
  checkCancellation(options.signal)

  const selected = sources.find(entry => entry.configured)
  if (selected) {
    selected.selected = true
  }
  const result: FigmaAuthInspection = { source: selected?.source ?? 'none', sources }
  if (!options.verify || !selected || selected.validity === 'invalid' || selected.validity === 'expired') {
    return result
  }

  let refreshingEnvironmentOAuth = false
  try {
    let token: string
    let kind: 'pat' | 'oauth' = 'pat'
    if (selected === config) {
      token = configToken!
    }
    else if (selected === environmentPat) {
      token = environmentToken!
    }
    else if (selected === environmentOAuth) {
      // Keep rotated refresh credentials in the same identity session as sync.
      refreshingEnvironmentOAuth = true
      const auth = await resolveFigmaAuth(undefined, env, options)
      token = await auth.token()
      refreshingEnvironmentOAuth = false
      secrets.push(token)
      kind = 'oauth'
    }
    else {
      token = localCredentials!.accessToken
      kind = 'oauth'
    }
    checkCancellation(options.signal)
    await verifyToken(token, kind, options)
    checkCancellation(options.signal)
    selected.validity = 'valid'
  }
  catch (error) {
    checkCancellation(options.signal)
    if (error instanceof IconctlAbortError) {
      throw new IconctlAbortError()
    }
    setError(selected, error)
    if (selected.error?.httpStatus === 401
      || (refreshingEnvironmentOAuth && selected.error?.httpStatus !== undefined && [400, 403].includes(selected.error.httpStatus))) {
      selected.validity = 'invalid'
    }
  }
  return result
}

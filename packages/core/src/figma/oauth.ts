import type { FigmaAuthOptions, RequestOptions } from '../request-options'
import { IconctlError } from '../errors'
import { cancelResponse, figmaHttpError, readResponseText, resolveRequestOptions, withRequestDeadline } from '../request-options'

export interface FigmaOAuthClient {
  clientId: string
  clientSecret: string
}

export interface FigmaCredentials extends FigmaOAuthClient {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export async function requestFigmaToken(
  client: FigmaOAuthClient,
  parameters: URLSearchParams,
  refresh = false,
  signal?: AbortSignal,
  options: RequestOptions = {},
): Promise<{ accessToken: string, refreshToken?: string, expiresAt: number }> {
  const resolved = resolveRequestOptions(options)
  const operation = refresh ? 'figma-oauth-refresh' : 'figma-oauth-token'
  const secrets = [client.clientSecret, ...['refresh_token', 'code', 'access_token'].flatMap(key => parameters.get(key) || [])]
  const data = await withRequestDeadline<Record<string, unknown>>({ signal, timeoutMs: resolved.oauthTimeoutMs, operation, label: 'Figma OAuth', secrets }, async (requestSignal) => {
    const response = await fetch(`https://api.figma.com/v1/oauth/${refresh ? 'refresh' : 'token'}`, {
      method: 'POST',
      redirect: 'manual',
      signal: requestSignal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${client.clientId}:${client.clientSecret}`)))}`,
      },
      body: parameters,
    })
    if (!response.ok) {
      // Never include OAuth response bodies: providers can echo credentials.
      cancelResponse(response)
      throw figmaHttpError(response, 'Figma OAuth', operation, response.status === 400 || response.status === 401 || response.status === 403
        ? 'Check the OAuth app credentials and run `iconctl auth figma login` again; update CI secrets if applicable.'
        : 'Try again later.')
    }
    const text = await readResponseText(response, requestSignal)
    try {
      return JSON.parse(text) as Record<string, unknown>
    }
    catch {
      // JSON parser errors may echo private response text.
      throw new IconctlError('Invalid Figma OAuth response.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation })
    }
  })
  if (!data || typeof data['access_token'] !== 'string' || !data['access_token'].trim()
    || typeof data['expires_in'] !== 'number' || !Number.isFinite(data['expires_in']) || data['expires_in'] <= 0
    || typeof data['token_type'] !== 'string' || data['token_type'].toLowerCase() !== 'bearer'
    || (!refresh && (typeof data['refresh_token'] !== 'string' || !data['refresh_token'].trim()))
    || (data['refresh_token'] !== undefined && (typeof data['refresh_token'] !== 'string' || !data['refresh_token'].trim()))) {
    throw new IconctlError('Invalid Figma OAuth response.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation })
  }
  const expiresAt = Date.now() + data['expires_in'] * 1000
  if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15) {
    throw new IconctlError('Invalid Figma OAuth expiry.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation })
  }
  return {
    accessToken: data['access_token'],
    expiresAt,
    ...(typeof data['refresh_token'] === 'string' ? { refreshToken: data['refresh_token'] } : {}),
  }
}

export async function refreshFigmaCredentials(credentials: FigmaOAuthClient & { refreshToken: string }, options: FigmaAuthOptions = {}): Promise<FigmaCredentials> {
  const result = await requestFigmaToken(credentials, new URLSearchParams({ refresh_token: credentials.refreshToken }), true, options.signal, options)
  return { ...credentials, ...result, refreshToken: result.refreshToken ?? credentials.refreshToken }
}

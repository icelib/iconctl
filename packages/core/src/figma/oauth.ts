import { Buffer } from 'node:buffer'
import { IconctlError } from '../errors'

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
): Promise<{ accessToken: string, refreshToken?: string, expiresAt: number }> {
  let response: Response
  try {
    response = await fetch(`https://api.figma.com/v1/oauth/${refresh ? 'refresh' : 'token'}`, {
      method: 'POST',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
      },
      body: parameters,
    })
  }
  catch {
    throw new IconctlError('Figma OAuth request failed or timed out. Check your connection and retry.')
  }
  if (!response.ok) {
    // Never include OAuth response bodies: providers can echo credentials.
    throw new IconctlError(`Figma OAuth failed (HTTP ${response.status}). ${response.status === 400 || response.status === 401 || response.status === 403 ? 'Check the OAuth app credentials and run `iconctl auth figma login` again; update CI secrets if applicable.' : 'Try again later.'}`)
  }
  let data: Record<string, unknown>
  try {
    data = await response.json() as Record<string, unknown>
  }
  catch {
    throw new IconctlError('Invalid Figma OAuth response.')
  }
  if (!data || typeof data['access_token'] !== 'string' || !data['access_token'].trim()
    || typeof data['expires_in'] !== 'number' || !Number.isFinite(data['expires_in']) || data['expires_in'] <= 0
    || typeof data['token_type'] !== 'string' || data['token_type'].toLowerCase() !== 'bearer'
    || (!refresh && (typeof data['refresh_token'] !== 'string' || !data['refresh_token'].trim()))
    || (data['refresh_token'] !== undefined && (typeof data['refresh_token'] !== 'string' || !data['refresh_token'].trim()))) {
    throw new IconctlError('Invalid Figma OAuth response.')
  }
  const expiresAt = Date.now() + data['expires_in'] * 1000
  if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15) {
    throw new IconctlError('Invalid Figma OAuth expiry.')
  }
  return {
    accessToken: data['access_token'],
    expiresAt,
    ...(typeof data['refresh_token'] === 'string' ? { refreshToken: data['refresh_token'] } : {}),
  }
}

export async function refreshFigmaCredentials(credentials: FigmaOAuthClient & { refreshToken: string }): Promise<FigmaCredentials> {
  const result = await requestFigmaToken(credentials, new URLSearchParams({ refresh_token: credentials.refreshToken }), true)
  return { ...credentials, ...result, refreshToken: result.refreshToken ?? credentials.refreshToken }
}

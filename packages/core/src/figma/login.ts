import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { IconctlError } from '../errors'
import { figmaCredentialsPath, withFigmaCredentialsLock, writeFigmaCredentials } from './credentials'
import { requestFigmaToken } from './oauth'

export interface FigmaLoginOptions {
  env?: NodeJS.Dict<string>
  redirectUri?: string
  onAuthorize: (url: string) => void | Promise<void>
  signal?: AbortSignal
  timeoutMs?: number
}

export async function loginFigma(options: FigmaLoginOptions): Promise<void> {
  const env = options.env ?? process.env
  const clientId = env['FIGMA_CLIENT_ID']?.trim()
  const clientSecret = env['FIGMA_CLIENT_SECRET']?.trim()
  if (!clientId || !clientSecret) {
    throw new IconctlError('Login requires FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET from your Figma OAuth app.')
  }
  const file = figmaCredentialsPath(env)
  let redirect: URL
  try {
    redirect = new URL(options.redirectUri ?? 'http://127.0.0.1:53682/callback')
  }
  catch {
    throw new IconctlError('Invalid Figma OAuth redirect URI.')
  }
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)
    || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.port === '0') {
    throw new IconctlError('Figma OAuth redirect URI must be an HTTP loopback URL with a fixed port and no query or fragment.')
  }
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL('https://www.figma.com/oauth')
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.href,
    scope: 'file_content:read',
    state,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString()

  await new Promise<void>((resolve, reject) => {
    let finished = false
    let exchanging = false
    let exchange: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout>
    let server: Server
    let abort: () => void
    const controller = new AbortController()
    function finish(error?: Error) {
      if (finished) {
        return
      }
      finished = true
      controller.abort()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      server.closeAllConnections()
      server.close(() => {
        void Promise.resolve(exchange).then(() => error ? reject(error) : resolve(), reject)
      })
    }
    abort = () => finish(new IconctlError('Figma login cancelled.'))
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Referrer-Policy', 'no-referrer')
      let url: URL
      try {
        url = new URL(request.url ?? '/', redirect.origin)
      }
      catch {
        response.writeHead(400).end('Invalid request')
        return
      }
      if (request.method !== 'GET' || url.pathname !== redirect.pathname) {
        response.writeHead(404).end('Not found')
        return
      }
      const receivedState = Buffer.from(url.searchParams.get('state') ?? '')
      const expectedState = Buffer.from(state)
      if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState)) {
        response.writeHead(400).end('Invalid OAuth state. Use the authorization link from your terminal.')
        return
      }
      if (exchanging) {
        response.writeHead(409).end('Authorization is already being processed.')
        return
      }
      const code = url.searchParams.get('code')
      if (url.searchParams.has('error') || !code) {
        response.once('finish', () => finish(new IconctlError('Figma authorization was denied or did not return a code.')))
        response.writeHead(400).end('Authorization was not completed. Return to your terminal.')
        return
      }
      exchanging = true
      exchange = (async () => {
        try {
          const tokens = await requestFigmaToken({ clientId, clientSecret }, new URLSearchParams({
            redirect_uri: redirect.href,
            code,
            grant_type: 'authorization_code',
            code_verifier: verifier,
          }), false, controller.signal)
          if (finished) {
            return
          }
          await withFigmaCredentialsLock(file, async (assertOwned) => {
            if (finished) {
              throw new IconctlError('Figma login cancelled or timed out.')
            }
            await writeFigmaCredentials(file, { clientId, clientSecret, ...tokens, refreshToken: tokens.refreshToken! }, () => {
              assertOwned()
              controller.signal.throwIfAborted()
            })
          })
          response.once('finish', () => finish())
          response.end('Figma authorization saved. You can close this window and return to your terminal.')
        }
        catch (error) {
          response.once('finish', () => finish(error instanceof IconctlError ? error : new IconctlError('Figma login failed. Please retry.')))
          response.writeHead(500).end('Figma login failed. Return to your terminal for instructions.')
          if (response.destroyed) {
            finish(error instanceof IconctlError ? error : new IconctlError('Figma login failed. Please retry.'))
          }
        }
      })()
    })
    timer = setTimeout(() => finish(new IconctlError('Figma login timed out. Run `iconctl auth figma login` again.')), options.timeoutMs ?? 300_000)
    server.on('error', () => finish(new IconctlError('Cannot listen for Figma login. Check that the callback port is available.')))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    server.listen(Number(redirect.port || 80), redirect.hostname === '[::1]' ? '::1' : redirect.hostname, () => {
      if (finished) {
        server.close()
        return
      }
      Promise.resolve().then(() => options.onAuthorize(authorize.href)).catch(() => finish(new IconctlError('Could not start Figma authorization. Try `--no-open`.')))
    })
  })
}

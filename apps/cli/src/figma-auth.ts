import { spawn } from 'node:child_process'
import process from 'node:process'
import { getFigmaAuthStatus, IconctlError, loginFigma, logoutFigma } from '@iconctl/core'

export interface FigmaAuthOptions {
  redirectUri?: string
  open?: boolean
  json?: boolean
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('browser')))
  })
}

export async function runFigmaAuth(provider: string, action: string, options: FigmaAuthOptions): Promise<void> {
  if (provider !== 'figma') {
    throw new IconctlError('Supported auth provider: figma.')
  }
  if (action === 'login') {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try {
      await loginFigma({
        ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
        signal: controller.signal,
        async onAuthorize(url) {
          process.stderr.write(`Authorize iconctl in your browser:\n${url}\n`)
          if (options.open !== false) {
            await openBrowser(url).catch(() => {
              process.stderr.write('Could not open a browser. Open the URL above manually.\n')
            })
          }
        },
      })
    }
    finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
    const message = 'Figma authorization saved. Unset FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET and FIGMA_REFRESH_TOKEN to use local credentials.'
    process.stdout.write(options.json ? `${JSON.stringify({ success: true, action: 'login' })}\n` : `${message}\n`)
    return
  }
  if (action === 'status') {
    const status = await getFigmaAuthStatus()
    process.stdout.write(options.json ? `${JSON.stringify(status)}\n` : `Figma authentication: ${status.source}\nAccess token expiry: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : 'unknown'}${status.expired ? ' (expired; will refresh on use)' : ''}\n`)
    return
  }
  if (action === 'logout') {
    await logoutFigma()
    process.stdout.write(options.json ? `${JSON.stringify({ success: true, action: 'logout' })}\n` : 'Local Figma credentials removed. Remote authorization and environment credentials are unchanged.\n')
    return
  }
  throw new IconctlError('Use `iconctl auth figma login`, `status`, or `logout`.')
}

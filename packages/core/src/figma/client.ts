import type { FigmaAuth } from './auth'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IconctlError } from '../errors'

async function invalidToken(response: Response): Promise<boolean> {
  if (response.status === 401) {
    return true
  }
  if (response.status !== 403) {
    return false
  }
  try {
    const data = await response.clone().json() as { err?: string, message?: string }
    return /^(?:invalid token|token (?:is )?(?:expired|invalid)|access token (?:is )?(?:expired|invalid))\.?$/i.test(data.err ?? data.message ?? '')
  }
  catch {
    return false
  }
}

export class FigmaClient {
  constructor(private readonly auth: FigmaAuth, private readonly cacheDir: string) {}

  private async cached(url: string, ttl: number, load: () => Promise<string>, fresh: boolean): Promise<string> {
    const directory = join(this.cacheDir, 'figma-v1')
    const key = createHash('sha256').update(`${this.auth.cacheIdentity}:${url}`).digest('hex')
    const file = join(directory, `${key}.json`)
    if (!fresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as { expires: number, content: string }
        if (cached.expires > Date.now() && typeof cached.content === 'string') {
          return cached.content
        }
      }
      catch {}
    }
    const content = await load()
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, JSON.stringify({ expires: Date.now() + ttl, content }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    }
    catch {
      // A read-only cache must not prevent an otherwise successful import.
    }
    finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    return content
  }

  async json<T>(path: string, parameters: URLSearchParams, fresh = false): Promise<T> {
    const url = `https://api.figma.com/v1/${path}?${parameters}`
    const content = await this.cached(url, 86_400_000, async () => {
      let token = await this.auth.token()
      const request = async () => {
        try {
          return await fetch(url, {
            headers: this.auth.kind === 'oauth' ? { Authorization: `Bearer ${token}` } : { 'X-Figma-Token': token },
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          })
        }
        catch {
          throw new IconctlError('Figma API request failed or timed out. Check your connection and retry.')
        }
      }
      let response = await request()
      if (this.auth.kind === 'oauth' && await invalidToken(response)) {
        token = await this.auth.token(token)
        response = await request()
      }
      if (!response.ok) {
        const hint = response.status === 401 || await invalidToken(response)
          ? 'Check your credentials; for OAuth, run `iconctl auth figma login` again or update CI secrets.'
          : response.status === 403 ? 'Check file access and the file_content:read scope.' : response.status === 429 ? 'Rate limit reached. Retry later.' : 'Retry later or check the file key.'
        throw new IconctlError(`Figma API failed (HTTP ${response.status}). ${hint}`)
      }
      try {
        const text = await response.text()
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || ('err' in parsed && parsed.err)) {
          throw new Error('invalid')
        }
        return text
      }
      catch {
        throw new IconctlError('Invalid Figma API response.')
      }
    }, fresh)
    try {
      return JSON.parse(content) as T
    }
    catch {
      throw new IconctlError('Invalid Figma API cache. Remove the Figma cache and retry.')
    }
  }

  async svg(url: string): Promise<string> {
    let target: URL
    try {
      target = new URL(url)
      if (target.protocol !== 'https:' || target.username || target.password) {
        throw new Error('invalid')
      }
    }
    catch {
      throw new IconctlError('Invalid Figma SVG download URL.')
    }
    return this.cached(target.href, 30 * 86_400_000, async () => {
      try {
        // Signed CDN URLs authenticate themselves; never forward API headers.
        const response = await fetch(target, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) {
          throw new Error('download')
        }
        return await response.text()
      }
      catch {
        throw new IconctlError('Could not download a Figma SVG.')
      }
    }, false)
  }
}

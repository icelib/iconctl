import type { RequestOptions } from '../request-options'
import type { FigmaAuth } from './auth'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupSVG, SVG } from '@iconify/tools'
import { throwIfAborted } from '../abort'
import { IconctlError } from '../errors'
import { cancelResponse, figmaHttpError, readResponseText, resolveRequestOptions, waitForRequest, withRequestDeadline } from '../request-options'

function validSvg(content: string): boolean {
  try {
    cleanupSVG(new SVG(content))
    return true
  }
  catch {
    return false
  }
}

function invalidToken(response: Response, text: string): boolean {
  if (response.status === 401) {
    return true
  }
  if (response.status !== 403) {
    return false
  }
  try {
    const data = JSON.parse(text) as { err?: string, message?: string }
    return /^(?:invalid token|token (?:is )?(?:expired|invalid)|access token (?:is )?(?:expired|invalid))\.?$/i.test(data.err ?? data.message ?? '')
  }
  catch {
    return false
  }
}

export class FigmaClient {
  private readonly options: Required<RequestOptions>

  constructor(private readonly auth: FigmaAuth, private readonly cacheDir: string, private readonly signal?: AbortSignal, options: RequestOptions = {}) {
    this.options = resolveRequestOptions(options)
  }

  private cacheFile(url: string): string {
    const key = createHash('sha256').update(`${this.auth.cacheIdentity}:${url}`).digest('hex')
    return join(this.cacheDir, 'figma-v1', `${key}.json`)
  }

  async invalidate(url: string): Promise<void> {
    await rm(this.cacheFile(url), { force: true }).catch(() => {})
  }

  async invalidateImages(path: string, parameters: URLSearchParams): Promise<void> {
    await this.invalidate(`https://api.figma.com/v1/${path}?${parameters}`)
  }

  private async cached(url: string, ttl: number, load: () => Promise<string>, fresh: boolean, canCache: (content: string) => boolean = () => true): Promise<string> {
    const directory = join(this.cacheDir, 'figma-v1')
    throwIfAborted(this.signal)
    const file = this.cacheFile(url)
    if (!fresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as { expires: number, content: string }
        if (cached.expires > Date.now() && typeof cached.content === 'string' && canCache(cached.content)) {
          throwIfAborted(this.signal)
          return cached.content
        }
      }
      catch {}
    }
    throwIfAborted(this.signal)
    const content = await load()
    throwIfAborted(this.signal)
    if (!canCache(content)) {
      return content
    }
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
    throwIfAborted(this.signal)
    return content
  }

  async json<T>(path: string, parameters: URLSearchParams, fresh = false, canCache?: (value: T) => boolean): Promise<T> {
    const url = `https://api.figma.com/v1/${path}?${parameters}`
    const content = await this.cached(url, 86_400_000, async () => {
      throwIfAborted(this.signal)
      let token = await waitForRequest(() => this.auth.token(), this.signal)
      const request = () => withRequestDeadline<{ response: Response, text: string }>({
        signal: this.signal,
        timeoutMs: this.options.requestTimeoutMs,
        operation: 'figma-api',
        label: 'Figma API',
        secrets: [token],
      }, async (signal) => {
        const response = await fetch(url, {
          headers: this.auth.kind === 'oauth' ? { Authorization: `Bearer ${token}` } : { 'X-Figma-Token': token },
          redirect: 'error',
          signal,
        })
        if (!response.ok && response.status !== 403) {
          cancelResponse(response)
          return { response, text: '' }
        }
        try {
          return { response, text: await readResponseText(response, signal) }
        }
        finally {
          if (signal.aborted) {
            cancelResponse(response)
          }
        }
      })
      let result = await request()
      if (this.auth.kind === 'oauth' && invalidToken(result.response, result.text)) {
        token = await waitForRequest(() => this.auth.token(token), this.signal)
        result = await request()
      }
      const { response, text } = result
      if (!response.ok) {
        const hint = response.status === 401 || invalidToken(response, text)
          ? 'Check your credentials; for OAuth, run `iconctl auth figma login` again or update CI secrets.'
          : response.status === 403 ? 'Check file access and the file_content:read scope.' : response.status === 429 ? 'Rate limit reached. Retry later.' : 'Retry later or check the file key.'
        throw figmaHttpError(response, 'Figma API', 'figma-api', hint)
      }
      try {
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || ('err' in parsed && parsed.err)) {
          throw new Error('invalid')
        }
        return text
      }
      catch {
        // Parser errors can include provider response bodies; keep them private.
        throw new IconctlError('Invalid Figma API response.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-api' })
      }
    }, fresh, canCache
      ? (text) => {
          try {
            return canCache(JSON.parse(text) as T)
          }
          catch {
            return false
          }
        }
      : undefined)
    try {
      return JSON.parse(content) as T
    }
    catch {
      throw new IconctlError('Invalid Figma API cache. Remove the Figma cache and retry.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-api' })
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
      throw new IconctlError('Invalid Figma SVG download URL.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-svg' })
    }
    return this.cached(target.href, 30 * 86_400_000, () => withRequestDeadline({
      signal: this.signal,
      timeoutMs: this.options.requestTimeoutMs,
      operation: 'figma-svg',
      label: 'Figma SVG download',
      secrets: [target.href],
    }, async (signal) => {
      // Signed CDN URLs authenticate themselves; never forward API headers.
      const response = await fetch(target, { signal })
      if (!response.ok) {
        cancelResponse(response)
        throw figmaHttpError(response, 'Figma SVG download', 'figma-svg', 'Retry later or check file access.')
      }
      try {
        return await readResponseText(response, signal)
      }
      finally {
        if (signal.aborted) {
          cancelResponse(response)
        }
      }
    }), false, validSvg)
  }
}

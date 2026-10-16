import { setImmediate } from 'node:timers/promises'
import { IconctlAbortError, IconctlError, serializeIconctlError } from './errors'

export interface RequestOptions {
  /** Figma API and SVG headers plus complete body read; defaults to 30,000 ms. */
  requestTimeoutMs?: number
  /** OAuth token/refresh deadline, or a shared-refresh waiter deadline; defaults to 15,000 ms. */
  oauthTimeoutMs?: number
}

export interface FigmaAuthOptions extends RequestOptions {
  /** Resolve-auth cancellation stops only this waiter; direct refresh owns its request. */
  signal?: AbortSignal | undefined
}

export function resolveRequestOptions(options: RequestOptions = {}): Required<RequestOptions> {
  const resolved = { requestTimeoutMs: options.requestTimeoutMs === undefined ? 30_000 : options.requestTimeoutMs, oauthTimeoutMs: options.oauthTimeoutMs === undefined ? 15_000 : options.oauthTimeoutMs }
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new IconctlError(`${key} must be a finite positive integer.`, { code: 'INVALID_REQUEST_OPTIONS' })
    }
  }
  return resolved
}

/** Cancellation belongs to this waiter; shared refresh work keeps its own deadline. */
export async function waitForRequest<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new IconctlAbortError(signal.reason)
  }
  if (!signal) {
    return action()
  }
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new IconctlAbortError(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const running = Promise.resolve().then(() => {
      if (signal.aborted) {
        throw new IconctlAbortError(signal.reason)
      }
      return action()
    })
    return await Promise.race([running, cancelled])
  }
  finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Bound response headers and body reads with one owned transport signal. */
export async function withRequestDeadline<T>(options: {
  signal?: AbortSignal | undefined
  timeoutMs: number
  operation: string
  label: string
  secrets?: readonly string[]
}, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const deadline = Date.now() + options.timeoutMs
  let timer: ReturnType<typeof setTimeout>
  let timedOut = false
  const schedule = () => {
    timer = setTimeout(() => {
      if (Date.now() < deadline) {
        schedule()
      }
      else {
        timedOut = true
        controller.abort()
      }
    }, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647))
  }
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) {
    cancel()
  }
  schedule()
  let running: Promise<T> | undefined
  try {
    if (controller.signal.aborted) {
      throw new IconctlAbortError(options.signal?.reason)
    }
    running = action(controller.signal)
    const result = await waitForRequest(() => running!, controller.signal)
    if (controller.signal.aborted) {
      throw new IconctlAbortError(options.signal?.reason)
    }
    return result
  }
  catch (cause) {
    if (controller.signal.aborted && running) {
      // Let transport abort handlers drain before reporting cancellation. A
      // transport ignoring abort must not keep this deadline waiting forever.
      await Promise.race([running.catch(() => {}), setImmediate()])
    }
    if (options.signal?.aborted) {
      throw new IconctlAbortError(options.signal.reason)
    }
    if (timedOut) {
      throw new IconctlError(`${options.label} request timed out after ${options.timeoutMs} ms. Check your connection and retry.`, {
        code: 'REQUEST_TIMEOUT',
        retryable: true,
        sourceType: 'figma',
        operation: options.operation,
        cause,
      })
    }
    if (cause instanceof IconctlError) {
      throw cause
    }
    throw new IconctlError(`${options.label} request failed. Check your connection and retry.`, {
      code: 'NETWORK_ERROR',
      retryable: true,
      sourceType: 'figma',
      operation: options.operation,
      cause: options.secrets ? serializeIconctlError(cause, { secrets: options.secrets }) : cause,
    })
  }
  finally {
    clearTimeout(timer!)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export function cancelResponse(response: Response): void {
  // Cancellation may wait for another tee reader; do not delay error delivery.
  void response.body?.cancel().catch(() => {})
}

export async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const { done, value } = await waitForRequest(() => reader.read(), signal)
      if (done) {
        return text + decoder.decode()
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  finally {
    signal.removeEventListener('abort', cancel)
    if (signal.aborted) {
      cancel()
    }
    reader.releaseLock()
  }
}

export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) {
    return undefined
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const duration = Number(value) * 1000
    return Number.isFinite(duration) ? duration : undefined
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export function figmaHttpError(response: Response, label: string, operation: string, hint: string): IconctlError {
  const retryAfter = response.status === 429 ? retryAfterMs(response) : undefined
  return new IconctlError(`${label} failed (HTTP ${response.status}). ${hint}`, {
    code: 'FIGMA_HTTP_ERROR',
    httpStatus: response.status,
    retryable: response.status === 429 || response.status >= 500,
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    sourceType: 'figma',
    operation,
  })
}

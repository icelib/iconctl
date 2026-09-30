import { setImmediate } from 'node:timers/promises'
import { IconctlAbortError } from './errors'

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IconctlAbortError(signal.reason)
  }
}

/** Give timers and request handlers a chance to deliver cancellation. */
export async function checkpoint(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (signal) {
    await setImmediate()
    throwIfAborted(signal)
  }
}

/** Wait for non-interruptible work (notably shared credential refresh) to settle. */
export async function settleWithAbort<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  try {
    const result = await action()
    throwIfAborted(signal)
    return result
  }
  catch (error) {
    throwIfAborted(signal)
    throw error
  }
}

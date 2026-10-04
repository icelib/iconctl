import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers/promises'
import { IconctlError } from './errors'

/** A broken stream's cancellation must not keep sync/watch shutdown waiting. */
export function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Read actual decompressed bytes, bounding retained memory even for tiny chunks. */
export async function readResponseBytes(response: Response, signal: AbortSignal, limit: number, truncate = false): Promise<Uint8Array> {
  signal.throwIfAborted()
  if (!response.body) {
    return new Uint8Array()
  }
  const reader = response.body.getReader()
  let output = Buffer.allocUnsafe(Math.min(64 * 1024, limit))
  let length = 0
  let chunks = 0
  let finished = false
  try {
    while (true) {
      const { value, done } = await readChunk(reader, signal)
      signal.throwIfAborted()
      if (done) {
        finished = true
        return output.subarray(0, length)
      }
      if (!truncate && value.byteLength > limit - length) {
        throw new IconctlError('Remote Iconify JSON exceeds the 25 MiB response limit')
      }
      const accepted = Math.min(value.byteLength, limit - length)
      if (length + accepted > output.byteLength) {
        const expanded = Buffer.allocUnsafe(Math.min(limit, Math.max(output.byteLength * 2, length + accepted)))
        output.copy(expanded, 0, 0, length)
        output = expanded
      }
      output.set(value.subarray(0, accepted), length)
      length += accepted
      if (truncate && length === limit) {
        return output.subarray(0, length)
      }
      // Buffered streams must also allow timers and caller cancellation to run.
      if (++chunks % 64 === 0) {
        await setImmediate()
        signal.throwIfAborted()
      }
    }
  }
  finally {
    if (!finished) {
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

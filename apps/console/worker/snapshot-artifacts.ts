import type { Snapshot, SnapshotContent } from '@iconctl/console-contracts'
import { digest, fail } from './security'

type SnapshotObject = Pick<R2ObjectBody, 'size' | 'body' | 'text'>
interface SnapshotBucket {
  get: (key: string) => Promise<SnapshotObject | null>
}

async function boundedText(object: SnapshotObject, maximum: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    void object.body.cancel(signal.reason).catch(() => {})
    signal.throwIfAborted()
  }
  if (object.size > maximum) {
    await object.body.cancel()
    fail(413, 'Snapshot exceeds the SVG archive document limit')
  }
  const bytes = new Uint8Array(object.size)
  const reader = object.body.getReader()
  // Cancel settles any pending read immediately, even when the source's
  // cancellation promise is delayed. Do not make abort wait on that promise.
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let length = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) {
        break
      }
      if (length + value.byteLength > bytes.byteLength) {
        await reader.cancel()
        fail(413, 'Snapshot exceeds the SVG archive document limit')
      }
      bytes.set(value, length)
      length += value.byteLength
    }
    return new TextDecoder().decode(bytes.subarray(0, length))
  }
  finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

/** Metadata owns the R2 key; export-only bounds do not change ordinary reads. */
export async function readSnapshotArtifact(bucket: SnapshotBucket, snapshot: Snapshot, maximum?: number, signal?: AbortSignal): Promise<SnapshotContent> {
  signal?.throwIfAborted()
  const object = await bucket.get(`snapshots/${snapshot.id}/${snapshot.digest}`)
  if (!object) {
    fail(404, 'Snapshot object is missing')
  }
  const text = maximum === undefined ? await object.text() : await boundedText(object, maximum, signal)
  signal?.throwIfAborted()
  const actualDigest = await digest(text)
  signal?.throwIfAborted()
  if (actualDigest !== snapshot.digest) {
    fail(409, 'Snapshot digest mismatch')
  }
  // Preserve the existing stored-document contract. Each artifact consumer
  // validates its own output representation after checking the document digest.
  return JSON.parse(text) as SnapshotContent
}

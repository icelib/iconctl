import type { Snapshot } from '@iconctl/console-contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { readSnapshotArtifact } from '../worker/snapshot-artifacts'

const snapshot: Snapshot = { id: 'snapshot', projectId: 'project', jobId: 'job', createdAt: 1, digest: '0'.repeat(64), iconCount: 1, issues: 0, attempt: 1 }
const object = (body: ReadableStream<Uint8Array>) => ({ body, size: 1024, text: async () => '' })
afterEach(() => vi.restoreAllMocks())

it('does not fetch an export that was already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const get = vi.fn(async () => null)
  await expect(readSnapshotArtifact({ get }, snapshot, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(get).not.toHaveBeenCalled()
})

it('cancels an R2 body returned after the export was cancelled without reading it', async () => {
  const controller = new AbortController()
  const pull = vi.fn()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  const get = async () => {
    controller.abort()
    return object(body)
  }
  await expect(readSnapshotArtifact({ get }, snapshot, 1024, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(pull).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledExactlyOnceWith(controller.signal.reason)
  expect(body.locked).toBe(false)
})

it.each(['pending', 'rejected'] as const)('stops a delayed R2 read and releases its lock with a %s cancellation promise', async (cancellation) => {
  const controller = new AbortController()
  let started!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  const pull = vi.fn(() => {
    started()
    return new Promise<void>(() => {})
  })
  const cancel = vi.fn(() => cancellation === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('Source cancelled')))
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  const hashing = vi.spyOn(crypto.subtle, 'digest')
  const download = readSnapshotArtifact({ get: async () => object(body) }, snapshot, 1024, controller.signal)
  const rejected = expect(download).rejects.toMatchObject({ name: 'AbortError' })
  await reading
  expect(body.locked).toBe(true)
  controller.abort()
  await rejected
  expect(cancel).toHaveBeenCalledExactlyOnceWith(controller.signal.reason)
  expect(pull).toHaveBeenCalledTimes(1)
  expect(hashing).not.toHaveBeenCalled()
  expect(body.locked).toBe(false)
  const reader = body.getReader()
  expect(await reader.read()).toEqual({ done: true, value: undefined })
  reader.releaseLock()
})

it('skips parsing when cancellation arrives while the digest is pending', async () => {
  const controller = new AbortController()
  let started!: () => void
  const hashing = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (value: ArrayBuffer) => void
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => {
    started()
    return new Promise<ArrayBuffer>((resolve) => {
      finish = resolve
    })
  })
  const body = new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(new TextEncoder().encode('invalid JSON'))
    stream.close()
  } })
  const download = readSnapshotArtifact({ get: async () => object(body) }, snapshot, 1024, controller.signal)
  const rejected = expect(download).rejects.toMatchObject({ name: 'AbortError' })
  await hashing
  controller.abort()
  finish(new ArrayBuffer(32))
  await rejected
  expect(body.locked).toBe(false)
})

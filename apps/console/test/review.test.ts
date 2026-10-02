import type { Job, ReleasePreview, SnapshotPreview } from '@iconctl/console-contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/api-response'
import { createReleaseReview } from '../src/features/review/release-review'
import { createSnapshotReview } from '../src/features/review/snapshot-review'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const snapshot = (id: string) => ({ snapshot: { id }, diff: { added: [id], changed: [], removed: [] } }) as unknown as SnapshotPreview
const confirmation = (id: string) => ({ id, release: { version: id } }) as ReleasePreview
const context = { projectId: 'A', snapshotId: 'A1', bump: 'patch' as const }
const job = { id: 'published-job', projectId: 'A' } as Job

describe('snapshot review ownership', () => {
  it('aborts the old request and rejects its later success after a newer pair commits', async () => {
    const first = deferred<SnapshotPreview>()
    const second = deferred<SnapshotPreview>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const review = createSnapshotReview(load)
    const a = review.open('A1')
    const signal = load.mock.calls[0]![2] as AbortSignal
    const b = review.open('A2', 'release')
    expect(signal.aborted).toBe(true)
    second.resolve(snapshot('A2'))
    await b
    first.resolve(snapshot('A1'))
    await a
    expect(review.state.value).toEqual({ committed: { id: 'A2', compareTo: 'release', preview: snapshot('A2') }, error: '' })
  })

  it('keeps the complete committed pair during a comparison load and its failure', async () => {
    const pending = deferred<SnapshotPreview>()
    const load = vi.fn().mockResolvedValueOnce(snapshot('A1')).mockReturnValueOnce(pending.promise)
    const review = createSnapshotReview(load)
    await review.open('A1')
    const previous = review.state.value.committed
    const work = review.open('A1', 'release')
    expect(review.state.value.committed).toBe(previous)
    expect(review.state.value.pending).toEqual({ id: 'A1', compareTo: 'release' })
    pending.reject(new ApiError('comparison unavailable', 502))
    await work
    expect(review.state.value).toEqual({ committed: previous, error: 'comparison unavailable' })
  })

  it.each([false, true])('invalidates pending responses on navigation (clear project: %s)', async (clear) => {
    const pending = deferred<SnapshotPreview>()
    const review = createSnapshotReview(vi.fn().mockResolvedValueOnce(snapshot('A1')).mockReturnValueOnce(pending.promise))
    await review.open('A1')
    const work = review.open('A2')
    review.invalidate(clear)
    pending.reject(new Error('stale failure'))
    await work
    expect(review.state.value.error).toBe('')
    expect(review.state.value.pending).toBeUndefined()
    expect(review.state.value.committed?.id).toBe(clear ? undefined : 'A1')
  })
})

describe('publication recovery', () => {
  function setup() {
    const preview = vi.fn().mockResolvedValue(confirmation('1.0.1'))
    const publish = vi.fn().mockResolvedValue(job)
    const published = vi.fn().mockResolvedValue(undefined)
    return { review: createReleaseReview({ preview, publish, published }), preview, publish, published }
  }

  it.each([404, 409, 410])('requires a new preview and another explicit click after HTTP %s', async (status) => {
    const { review, preview, publish, published } = setup()
    await review.open(context)
    publish.mockRejectedValueOnce(new ApiError('confirmation unavailable', status))
    await review.publish()
    const firstKey = publish.mock.calls[0]![2]
    expect(review.state.value.confirmation?.release.version).toBe('1.0.1')
    expect(review.state.value.needsPreview).toBe(true)
    await review.publish()
    expect(publish).toHaveBeenCalledTimes(1)
    preview.mockResolvedValueOnce(confirmation('1.1.0'))
    await review.preview()
    expect(review.state.value.confirmation?.release.version).toBe('1.1.0')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(published).not.toHaveBeenCalled()
    await review.publish()
    expect(publish.mock.calls[1]![2]).not.toBe(firstKey)
    expect(published).toHaveBeenCalledWith(job, true)
  })

  it.each([new TypeError('Network failed'), new ApiError('Gateway unavailable', 502)])('retries an ambiguous response with the same confirmation and key: %s', async (cause) => {
    const { review, publish, published } = setup()
    await review.open(context)
    publish.mockRejectedValueOnce(cause)
    await review.publish()
    expect(review.state.value.needsPreview).toBe(false)
    expect(review.state.value.error).toBe(cause.message)
    await review.publish()
    expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0])
    expect(published).toHaveBeenCalledOnce()
  })

  it('keeps the old confirmation visible when refreshing an incompatible snapshot fails', async () => {
    const { review, preview, publish } = setup()
    await review.open(context)
    publish.mockRejectedValueOnce(new ApiError('stale revision', 409))
    await review.publish()
    const pending = deferred<ReleasePreview>()
    preview.mockReturnValueOnce(pending.promise)
    const work = review.preview()
    expect(review.state.value.confirmation?.release.version).toBe('1.0.1')
    pending.reject(new ApiError('Snapshot project revision changed', 409))
    await work
    expect(review.state.value.confirmation?.release.version).toBe('1.0.1')
    expect(review.state.value.needsPreview).toBe(true)
    await review.publish()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('does not reopen a closed or replaced dialog when its preview settles', async () => {
    const { review, preview } = setup()
    const old = deferred<ReleasePreview>()
    preview.mockReturnValueOnce(old.promise)
    const pending = review.open(context)
    const signal = preview.mock.calls[0]![1] as AbortSignal
    review.close()
    expect(signal.aborted).toBe(true)
    await review.open({ ...context, projectId: 'B', snapshotId: 'B1' })
    old.resolve(confirmation('stale'))
    await pending
    expect(review.state.value.context?.projectId).toBe('B')
    expect(review.state.value.confirmation?.id).toBe('1.0.1')
  })

  it('records a late successful job without claiming the current dialog', async () => {
    const { review, publish, published } = setup()
    await review.open(context)
    const old = deferred<Job>()
    publish.mockReturnValueOnce(old.promise)
    const work = review.publish()
    review.close()
    await review.open({ ...context, projectId: 'B', snapshotId: 'B1' })
    old.resolve(job)
    await work
    expect(published).toHaveBeenCalledWith(job, false)
    expect(review.state.value.open).toBe(true)
    expect(review.state.value.context?.projectId).toBe('B')
  })

  it('ignores late publication failures after closing and does not update an unmounted view', async () => {
    const { review, publish, published } = setup()
    await review.open(context)
    const old = deferred<Job>()
    publish.mockReturnValueOnce(old.promise)
    const work = review.publish()
    review.close()
    old.reject(new ApiError('stale failure', 409))
    await work
    expect(review.state.value.error).toBe('')
    expect(review.state.value.open).toBe(false)
    await review.open(context)
    const late = deferred<Job>()
    publish.mockReturnValueOnce(late.promise)
    const disposed = review.publish()
    review.dispose()
    late.resolve(job)
    await disposed
    expect(published).not.toHaveBeenCalled()
  })
})

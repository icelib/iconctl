import type { SnapshotPreview } from '@iconctl/console-contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, readApiResponse } from '../src/api-response'
import { createSnapshotReview } from '../src/features/review/snapshot-review'

describe('API response errors', () => {
  it.each([404, 409, 502])('retains HTTP %s when an error response is not JSON', async (status) => {
    await expect(readApiResponse(new Response('<html>unavailable</html>', { status })))
      .rejects
      .toMatchObject({ name: 'ApiError', status, message: `请求失败（${status}）` })
  })

  it('retains structured messages and identifies a non-JSON authentication failure', async () => {
    await expect(readApiResponse(Response.json({ error: 'New preview required' }, { status: 409 })))
      .rejects
      .toEqual(new ApiError('New preview required', 409))
    await expect(readApiResponse(new Response('Unauthorized', { status: 401 })))
      .rejects
      .toMatchObject({ status: 401, message: '请重新登录' })
  })

  it('ignores JSON that settles after its response arrived and the read was superseded', async () => {
    let finishJSON!: (value: unknown) => void
    const delayed = new Promise((resolve) => {
      finishJSON = resolve
    })
    const first = Response.json({})
    const json = vi.spyOn(first, 'json').mockReturnValue(delayed)
    const responses = [first, Response.json({ snapshot: { id: 'B' } })]
    const review = createSnapshotReview(() => readApiResponse<SnapshotPreview>(responses.shift()!))
    const old = review.open('A')
    await vi.waitFor(() => expect(json).toHaveBeenCalled())
    await review.open('B')
    finishJSON({ snapshot: { id: 'A' } })
    await old
    expect(review.state.value.committed?.preview.snapshot.id).toBe('B')
  })
})

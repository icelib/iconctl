import type { Job } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { upsertSubmittedJob } from '../src/features/history/submitted-job'

it('records a returned job without rolling back a newer polled status or attempt', () => {
  const submitted = { id: 'publish', attempt: 1, status: 'queued', createdAt: 1, updatedAt: 1 } as Job
  expect(upsertSubmittedJob([], submitted)).toEqual([submitted])
  const running = { ...submitted, status: 'running' as const, updatedAt: 2 }
  expect(upsertSubmittedJob([running], submitted)).toEqual([running])
  const retried = { ...submitted, attempt: 2 }
  expect(upsertSubmittedJob([running], retried)).toEqual([retried])
  expect(upsertSubmittedJob([retried], running)).toEqual([retried])
})

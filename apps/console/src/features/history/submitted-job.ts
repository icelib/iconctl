import type { Job } from '@iconctl/console-contracts'

/** A late mutation response must not roll back progress already seen by polling. */
export function upsertSubmittedJob(jobs: Job[], submitted: Job): Job[] {
  const existing = jobs.find(job => job.id === submitted.id)
  const newer = existing && ((existing.attempt ?? 1) > (submitted.attempt ?? 1)
    || ((existing.attempt ?? 1) === (submitted.attempt ?? 1) && existing.updatedAt > submitted.updatedAt))
  const job = newer ? existing : submitted
  return [job, ...jobs.filter(item => item.id !== submitted.id)]
    .sort((left, right) => right.createdAt - left.createdAt)
}

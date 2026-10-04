import type { Job, Snapshot } from '@iconctl/console-contracts'

export interface SnapshotOriginTarget {
  snapshotId: string
  jobId: string
  projectId: string
  attempt: number
}
interface RecordedRun {
  id: string
  attempt?: string
  href: string
}
export type SnapshotOrigin = {
  available: false
  snapshotId: string
  jobId: string
} | {
  available: true
  target: SnapshotOriginTarget
  operation: Job['operation']
  projectName: string
  repository: string
  revision?: number
  sourceCommit: string
  sourceHref?: string
  runs: RecordedRun[]
}

function repositoryUrl(repository: string): string | undefined {
  const match = /^([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([\w.-]{1,100})$/i.exec(repository)
  if (!match || match[2] === '.' || match[2] === '..') {
    return undefined
  }
  return `https://github.com/${match[1]}/${match[2]}`
}
export function recordedRunUrl(repository: string, runId: string | undefined, runAttempt?: string): string | undefined {
  const base = repositoryUrl(repository)
  if (!base || !runId || !/^[1-9]\d*$/.test(runId) || (runAttempt !== undefined && !/^[1-9]\d*$/.test(runAttempt))) {
    return undefined
  }
  return `${base}/actions/runs/${runId}${runAttempt === undefined ? '' : `/attempts/${runAttempt}`}`
}

/** A snapshot identifies its generating job; the job's current result does not. */
export function snapshotOrigin(snapshot: Snapshot, jobs: readonly Job[]): SnapshotOrigin {
  const unavailable: SnapshotOrigin = { available: false, snapshotId: snapshot.id, jobId: snapshot.jobId }
  const matches = jobs.filter(job => job.id === snapshot.jobId)
  const job = matches.length === 1 ? matches[0] : undefined
  const attempt = snapshot.attempt === undefined ? 1 : snapshot.attempt
  if (!job || job.projectId !== snapshot.projectId || job.project?.id !== snapshot.projectId || !Number.isSafeInteger(attempt) || attempt < 1) {
    return unavailable
  }
  const runs = new Map<string, RecordedRun>()
  for (const event of job.events ?? []) {
    if (event.attempt !== attempt) {
      continue
    }
    const href = recordedRunUrl(job.project.repository, event.runId, event.runAttempt)
    if (href) {
      runs.set(href, { id: event.runId!, ...(event.runAttempt === undefined ? {} : { attempt: event.runAttempt }), href })
    }
  }
  const repository = repositoryUrl(job.project.repository)
  const sourceHref = repository && /^[a-f\d]{40}$/i.test(job.sourceCommit)
    ? `${repository}/commit/${job.sourceCommit}`
    : undefined
  return {
    available: true,
    target: { snapshotId: snapshot.id, jobId: job.id, projectId: job.projectId, attempt },
    operation: job.operation,
    projectName: job.project.name,
    repository: job.project.repository,
    ...(Number.isSafeInteger(job.project.revision) && job.project.revision > 0 ? { revision: job.project.revision } : {}),
    sourceCommit: job.sourceCommit,
    ...(sourceHref ? { sourceHref } : {}),
    runs: [...runs.values()],
  }
}

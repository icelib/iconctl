import type { Job, JobEvent, Snapshot } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { recordedRunUrl, snapshotOrigin } from '../src/features/history/snapshot-origin'

const sha = 'a'.repeat(40)
const snapshot: Snapshot = { id: 'old-snapshot', jobId: 'source-job', projectId: 'project-A', attempt: 1, createdAt: 20, digest: 'a'.repeat(64), iconCount: 1, issues: 1 }
function event(attempt: number | undefined, runId: string, runAttempt?: string): JobEvent {
  return { at: 10, stage: 'validating', status: 'running', ...(attempt === undefined ? {} : { attempt }), runId, ...(runAttempt === undefined ? {} : { runAttempt }) }
}
function job(overrides: Partial<Job> = {}): Job {
  return {
    id: snapshot.jobId,
    projectId: snapshot.projectId,
    project: { id: snapshot.projectId, name: 'Original project', repository: 'owner/icons', revision: 3 },
    operation: 'sync',
    attempt: 2,
    status: 'succeeded',
    stage: 'complete',
    runId: '202',
    runAttempt: '9',
    sourceCommit: sha,
    workflowCommit: 'b'.repeat(40),
    executorCommit: 'c'.repeat(40),
    snapshotId: 'new-snapshot',
    events: [event(1, '101', '1'), event(2, '202', '9')],
    ...overrides,
  } as Job
}

it.each(['sync', 'check', 'preview', 'dry-run'] as const)('traces a %s snapshot to its frozen configuration and historical attempt', (operation) => {
  expect(snapshotOrigin(snapshot, [job({ operation })])).toEqual({
    available: true,
    target: { snapshotId: snapshot.id, jobId: snapshot.jobId, projectId: snapshot.projectId, attempt: 1 },
    operation,
    projectName: 'Original project',
    repository: 'owner/icons',
    revision: 3,
    sourceCommit: sha,
    sourceHref: `https://github.com/owner/icons/commit/${sha}`,
    runs: [{ id: '101', attempt: '1', href: 'https://github.com/owner/icons/actions/runs/101/attempts/1' }],
  })
})

it('uses the generating job identity even when a publish job currently points to the same snapshot', () => {
  const publisher = job({ id: 'publish-job', operation: 'publish', snapshotId: snapshot.id, sourceCommit: 'd'.repeat(40), events: [event(1, '999')] })
  const origin = snapshotOrigin(snapshot, [publisher, job()])
  expect(origin).toMatchObject({ available: true, operation: 'sync', sourceCommit: sha, target: { jobId: 'source-job' } })
  expect(JSON.stringify(origin)).not.toContain('999')
})

it('defaults only absent snapshot attempts to one and never assigns unnumbered legacy events', () => {
  const { attempt: _attempt, ...legacy } = snapshot
  const origin = snapshotOrigin(legacy, [job({ events: [event(undefined, '999'), event(1, '101')] })])
  expect(origin).toMatchObject({ available: true, target: { attempt: 1 }, runs: [{ id: '101' }] })
  expect(JSON.stringify(origin)).not.toContain('999')
})

it('does not invent a historical run from the current job when events are missing or have been truncated', () => {
  for (const events of [undefined, [], [event(2, '202')], [event(undefined, '101')]]) {
    expect(snapshotOrigin(snapshot, [job({ events })])).toMatchObject({ available: true, target: { attempt: 1 }, runs: [] })
  }
})

it('deduplicates recorded run identities while retaining distinct run attempts and runs', () => {
  const origin = snapshotOrigin(snapshot, [job({ events: [
    event(1, '101', '1'),
    event(1, '101', '1'),
    event(1, '101', '2'),
    event(1, '102'),
    event(2, '202'),
  ] })])
  expect(origin).toMatchObject({ available: true, runs: [
    { id: '101', attempt: '1' },
    { id: '101', attempt: '2' },
    { id: '102', href: 'https://github.com/owner/icons/actions/runs/102' },
  ] })
})

it('rejects missing, duplicate or cross-project job associations instead of falling back to the current result pointer', () => {
  const original = job()
  for (const jobs of [
    [],
    [job({ id: 'wrong-job', snapshotId: snapshot.id })],
    [job({ projectId: 'project-B' })],
    [job({ project: { ...original.project, id: 'project-B' } })],
    [job({ project: undefined as unknown as Job['project'] })],
    [original, original],
  ]) {
    expect(snapshotOrigin(snapshot, jobs)).toEqual({ available: false, snapshotId: snapshot.id, jobId: snapshot.jobId })
  }
  expect(snapshotOrigin(snapshot, [original]).available).toBe(true)
})

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null])('does not infer a valid attempt from corrupt value %s', (attempt) => {
  expect(snapshotOrigin({ ...snapshot, attempt: attempt as number }, [job()]).available).toBe(false)
})

it('keeps invalid commit/revision values as unlinked or unrecorded rather than inventing metadata', () => {
  const original = job()
  const origin = snapshotOrigin(snapshot, [job({ sourceCommit: 'javascript:alert(1)', project: { ...original.project, revision: 0 } })])
  expect(origin).toMatchObject({ available: true, sourceCommit: 'javascript:alert(1)' })
  expect(origin).not.toHaveProperty('sourceHref')
  expect(origin).not.toHaveProperty('revision')
})

it.each(['owner/..', 'owner/.', '../icons', 'owner/icons/extra', 'https://evil.example/a', 'owner/icons?ref=main', 'owner/icons#main', 'owner\\icons', '//evil.example'])('never turns repository %s into a GitHub link', (repository) => {
  const original = job()
  const origin = snapshotOrigin(snapshot, [job({ project: { ...original.project, repository } })])
  expect(origin).toMatchObject({ available: true, repository, runs: [] })
  expect(origin).not.toHaveProperty('sourceHref')
})

it.each(['0', '-1', '1.5', '1/path', ' 123 ', 'javascript:1'])('rejects run identity %s without falling back to another attempt', (value) => {
  expect(recordedRunUrl('owner/icons', value, '1')).toBeUndefined()
  expect(recordedRunUrl('owner/icons', '101', value)).toBeUndefined()
})

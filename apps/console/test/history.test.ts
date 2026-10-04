import type { ConsoleState, Job, Project, SnapshotContent, SnapshotPreview } from '@iconctl/console-contracts'
import type { RunnerIdentity } from '../worker/github'
import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const sha = 'a'.repeat(40)
const firstRun: RunnerIdentity = {
  runId: '101',
  runAttempt: '1',
  repositoryId: '123',
  workflowRef: 'fixture/icons/.github/workflows/iconctl-console.yml@refs/heads/main',
  sha,
  ref: 'refs/heads/main',
}
const secondRun: RunnerIdentity = { ...firstRun, runId: '202', runAttempt: '2' }
const detailedIssue = {
  name: 'arrow-left',
  message: 'Expected width 24; received 16',
  stage: 'validate',
  sourceType: 'figma',
  sourceIndex: 0,
  fileKey: 'AbCdEf123456',
  nodeId: '12:34',
}
const legacyIssue = { name: 'legacy-icon', message: 'Legacy validation message' }
function content(issues: SnapshotContent['issues'] = []): SnapshotContent {
  return {
    json: { prefix: 'brand', width: 24, height: 24, icons: { 'arrow-left': { body: '<path d="M2 12h20"/>' } } },
    files: {},
    issues,
    failed: [],
    sources: [{ type: 'figma', notModified: false, fileKey: 'AbCdEf123456' }],
  }
}
async function seed(key: string, value: unknown) {
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
  })
}
async function queuedJob(): Promise<Job> {
  const project: Project = {
    ...projectInput.parse({
      name: 'attempt-history',
      prefix: 'brand',
      packageName: '@test/attempt-history',
      repository: 'fixture/icons',
      sources: [{ type: 'figma', file: 'AbCdEf123456', connection: crypto.randomUUID() }],
    }),
    id: crypto.randomUUID(),
    revision: 1,
    repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
    createdAt: Date.now(),
  }
  const job: Job = {
    id: crypto.randomUUID(),
    projectId: project.id,
    project,
    operation: 'sync',
    status: 'queued',
    stage: 'queued',
    sourceCommit: sha,
    workflowCommit: sha,
    executorCommit: sha,
    workflowDigest: 'a'.repeat(64),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dispatchAttempts: 1,
    attempt: 1,
    events: [{ at: 1, stage: 'queued', status: 'queued' }],
  }
  await seed(`project:${project.id}`, project)
  await seed(`job:${job.id}`, job)
  return job
}
function mockGithub() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/app/installations/456/access_tokens') {
      return Response.json({ token: 'fixture-installation-token' })
    }
    if (url.pathname === '/repos/fixture/icons/git/ref/heads/main') {
      return Response.json({ object: { sha } })
    }
    throw new Error(`Unexpected external request: ${url.pathname}`)
  })
}
async function ownerHeaders() {
  const session = await account().newSession(OWNER_ID)
  return { Cookie: `__Host-iconctl-session=${session.token}` }
}
async function failure(
  action: (instance: import('../worker/state').AccountState) => unknown,
) {
  return runInDurableObject(account(), async (instance) => {
    try {
      await action(instance)
      return ''
    }
    catch (error) {
      return (error as Error).message
    }
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('retains failed diagnostics and each run identity after a successful retry through state and snapshot routes', async () => {
  const job = await queuedJob()
  await account().claim(job.id, firstRun, 'sync')
  await account().progress(job.id, firstRun, 'validating')
  const failedContent = content([detailedIssue, legacyIssue])
  const failed = await account().saveSnapshot(job.id, firstRun, failedContent)
  expect(failed).toMatchObject({ attempt: 1, issues: 2 })
  mockGithub()
  await account().retry(job.id)
  await account().claim(job.id, secondRun, 'sync')
  await account().progress(job.id, secondRun, 'validating')
  const succeeded = await account().saveSnapshot(job.id, secondRun, content())
  expect(succeeded).toMatchObject({ attempt: 2, issues: 0 })
  expect(succeeded.id).not.toBe(failed.id)

  const headers = await ownerHeaders()
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/state`, { headers })
  expect(response.status).toBe(200)
  const state = await response.json<ConsoleState>()
  const current = state.jobs.find(item => item.id === job.id)!
  expect(current).toMatchObject({ status: 'succeeded', attempt: 2, snapshotId: succeeded.id })
  expect(state.snapshots.filter(item => item.jobId === job.id).map(item => item.id).sort()).toEqual([failed.id, succeeded.id].sort())
  expect(current.events?.[0]).toEqual(job.events![0])
  expect(current.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ attempt: 1, runId: '101', runAttempt: '1', stage: 'validating' }),
    expect.objectContaining({ attempt: 1, runId: '101', runAttempt: '1', status: 'failed', error: 'validation' }),
    expect.objectContaining({ attempt: 2, stage: 'queued', status: 'queued' }),
    expect.objectContaining({ attempt: 2, runId: '202', runAttempt: '2', status: 'succeeded' }),
  ]))
  const queued = current.events?.find(event => event.attempt === 2 && event.stage === 'queued')
  expect(queued).not.toHaveProperty('runId')
  expect(queued).not.toHaveProperty('runAttempt')

  for (const [snapshot, issues] of [[failed, failedContent.issues], [succeeded, []]] as const) {
    const previewResponse = await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${snapshot.id}`, { headers })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json<SnapshotPreview>()
    expect(preview.content.issues).toEqual(issues)
    const stored = await env.ARTIFACTS.get(`snapshots/${snapshot.id}/${snapshot.digest}`)
    expect((await stored!.json<SnapshotContent>()).issues).toEqual(issues)
  }
})

it('pages attempt history with an opaque project-bound cursor without changing state', async () => {
  const job = await queuedJob()
  const firstSnapshot = {
    id: crypto.randomUUID(),
    jobId: job.id,
    projectId: job.projectId,
    createdAt: 20,
    digest: 'a'.repeat(64),
    iconCount: 1,
    issues: 1,
  }
  const legacySnapshot = {
    id: crypto.randomUUID(),
    jobId: job.id,
    projectId: job.projectId,
    createdAt: 10,
    digest: 'b'.repeat(64),
    iconCount: 1,
    issues: 0,
  }
  await seed(`snapshot:${firstSnapshot.id}`, { ...firstSnapshot, attempt: 2 })
  await seed(`snapshot:${legacySnapshot.id}`, legacySnapshot)
  await seed(`snapshot:${crypto.randomUUID()}`, {
    ...legacySnapshot,
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
  })
  await seed(`job:${job.id}`, {
    ...job,
    attempt: 3,
    events: [
      ...(job.events ?? []),
      { at: 2, stage: 'failed', status: 'failed', attempt: 1, error: 'old' },
      { at: 3, stage: 'complete', status: 'succeeded', attempt: 2 },
    ],
  })
  const before = await account().state()
  const first = await account().attemptHistory(job.id, { limit: 1 })
  expect(first.attempts.map(item => item.attempt)).toEqual([3])
  expect(first.hasMore).toBe(true)
  expect(first.legacyEvents).toEqual(job.events)
  expect(first.nextCursor).toBeTruthy()
  const second = await account().attemptHistory(job.id, {
    limit: 1,
    cursor: first.nextCursor,
  })
  expect(second.attempts.map(item => item.attempt)).toEqual([2])
  expect(second.attempts[0]?.snapshots[0]?.id).toBe(firstSnapshot.id)
  const filtered = await account().attemptHistory(job.id, { attempt: 1, limit: 5 })
  expect(filtered.attempts).toEqual([
    expect.objectContaining({ attempt: 1, snapshots: [legacySnapshot] }),
  ])
  expect(await failure(instance => instance.attemptHistory(job.id, { cursor: 'invalid' }))).toContain('History cursor is invalid')
  expect(await account().state()).toEqual(before)

  const headers = await ownerHeaders()
  const response = await exports.default.fetch(
    `${env.APP_ORIGIN}/api/jobs/${job.id}/history?limit=1`,
    { headers },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ...first,
    nextCursor: expect.any(String),
  })
})

it('records an attempt-only change without assigning an attempt to legacy events', async () => {
  const job = await queuedJob()
  await runInDurableObject(account(), (instance) => {
    // Exercise the persistence boundary directly: a new attempt is noteworthy
    // even if the runner reports exactly the same stage and status.
    instance['put'](`job:${job.id}`, { ...job, attempt: 2 })
  })
  const current = await account().getJob(job.id)
  expect(current.events).toHaveLength(2)
  expect(current.events?.[0]).toEqual({ at: 1, stage: 'queued', status: 'queued' })
  expect(current.events?.[1]).toMatchObject({ attempt: 2, stage: 'queued', status: 'queued' })
})

it('keeps the newest 500 events with attempt provenance and ignores unchanged progress', async () => {
  const job = await queuedJob()
  const oldEvents = Array.from({ length: 500 }, (_, index) => ({ at: index, stage: 'fetching', status: 'running' as const, attempt: 1, runId: firstRun.runId, runAttempt: firstRun.runAttempt }))
  await seed(`job:${job.id}`, { ...job, status: 'running', stage: 'fetching', runId: firstRun.runId, runAttempt: firstRun.runAttempt, events: oldEvents })
  await account().progress(job.id, firstRun, 'validating')
  const once = await account().getJob(job.id)
  expect(once.events).toHaveLength(500)
  expect(once.events?.[0]).toEqual(oldEvents[1])
  expect(once.events?.[499]).toMatchObject({ stage: 'validating', attempt: 1, runId: '101', runAttempt: '1' })
  await account().progress(job.id, firstRun, 'validating')
  expect((await account().getJob(job.id)).events).toEqual(once.events)
})

it('records a newly claimed run even when status and stage remain unchanged', async () => {
  const job = await queuedJob()
  const prior = { at: 1, stage: 'validating', status: 'running', attempt: 1 }
  await seed(`job:${job.id}`, { ...job, status: 'running', stage: 'validating', events: [prior] })
  await account().claim(job.id, firstRun, 'sync')
  const current = await account().getJob(job.id)
  expect(current.events).toHaveLength(2)
  expect(current.events?.[0]).toEqual(prior)
  expect(current.events?.[1]).toMatchObject({ stage: 'validating', status: 'running', attempt: 1, runId: '101', runAttempt: '1' })
})

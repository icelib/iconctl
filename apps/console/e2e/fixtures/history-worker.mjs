import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { AccountState } from '../../worker/state.ts'

const sha = 'a'.repeat(40)
const firstRun = {
  runId: '101',
  runAttempt: '1',
  repositoryId: '123',
  workflowRef: 'fixture/icons/.github/workflows/iconctl-console.yml@refs/heads/main',
  sha,
  ref: 'refs/heads/main',
}
function snapshotContent(issues = []) {
  return {
    json: { prefix: 'brand', width: 24, height: 24, icons: { 'arrow-left': { body: '<path d="m10 4-8 8 8 8v-6h12v-4H10z"/>' } } },
    files: {},
    issues,
    failed: [],
    sources: [{ type: 'figma', notModified: false, fileKey: 'AbCdEf123456' }],
  }
}

// Test-only bootstrap and trusted-runner callbacks. The browser uses the real
// owner retry/state/snapshot routes; production never imports this entrypoint.
export class FixtureAccountState extends AccountState {
  async seedHistory() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const put = (key, value) => this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value),
    )
    const now = Date.now()
    const project = {
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
      createdAt: now,
    }
    const job = {
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
      createdAt: now,
      updatedAt: now,
      dispatchAttempts: 1,
      attempt: 1,
      events: [{ at: now - 1000, stage: 'queued', status: 'queued' }],
    }
    put(`project:${project.id}`, project)
    put(`job:${job.id}`, job)
    this.claim(job.id, firstRun, 'sync')
    this.progress(job.id, firstRun, 'validating')
    const snapshot = await this.saveSnapshot(job.id, firstRun, snapshotContent([
      {
        name: 'arrow-left',
        message: 'Expected width 24; received 16',
        stage: 'validate',
        sourceType: 'figma',
        sourceIndex: 0,
        fileKey: 'AbCdEf123456',
        nodeId: '12:34',
      },
      { name: 'legacy-icon', message: 'Legacy validation message' },
    ]))
    // Older snapshots did not store attempt. They must still be offered as the
    // first attempt without assigning old stage events to an invented attempt.
    const { attempt: _attempt, ...failedSnapshot } = snapshot
    put(`snapshot:${snapshot.id}`, failedSnapshot)
    return { project, job: this.getJob(job.id), failedSnapshot, session: await this.newSession(OWNER_ID) }
  }

  async completeHistoryRetry(jobId) {
    const job = this.getJob(jobId)
    if (job.attempt !== 2 || job.status !== 'queued') {
      throw new Error('The browser must retry the failed job before runner completion')
    }
    const identity = { ...firstRun, runId: '202', runAttempt: '2' }
    this.claim(job.id, identity, 'sync')
    this.progress(job.id, identity, 'validating')
    const snapshot = await this.saveSnapshot(job.id, identity, snapshotContent())
    return { job: this.getJob(job.id), snapshot }
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
    if (request.method === 'POST' && path === '/__fixtures/history') {
      return Response.json(await account().seedHistory())
    }
    if (request.method === 'POST' && path === '/__fixtures/history/complete-retry') {
      const { jobId } = await request.json()
      return Response.json(await account().completeHistoryRetry(jobId))
    }
    return app.fetch(request, env, ctx)
  },
}

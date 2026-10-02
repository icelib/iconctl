import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { AccountState } from '../../worker/state.ts'

const sha = 'a'.repeat(40)
const identity = {
  runId: '303',
  runAttempt: '1',
  repositoryId: '123',
  workflowRef: 'fixture/icons/.github/workflows/iconctl-console.yml@refs/heads/main',
  sha,
  ref: 'refs/heads/main',
}

// Only the project and trusted runner identity are seeded here. Snapshot data
// must come from the real core sync performed by the browser test's fixture.
export class FixtureAccountState extends AccountState {
  async seedProvenance() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const put = (key, value) => this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value),
    )
    const now = Date.now()
    const project = {
      ...projectInput.parse({
        name: 'winning-source-diagnostics',
        prefix: 'brand',
        packageName: '@test/winning-source-diagnostics',
        repository: 'fixture/icons',
        sources: [
          { type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv', connection: crypto.randomUUID() },
          { type: 'figma', file: 'ZbCdEfGhIjKlMnOpQrStUv', connection: crypto.randomUUID() },
        ],
        validate: { height: 16, name: '^allowed$' },
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
    }
    put(`project:${project.id}`, project)
    put(`job:${job.id}`, job)
    this.claim(job.id, identity, 'sync')
    this.progress(job.id, identity, 'validating')
    return { project, job: this.getJob(job.id), session: await this.newSession(OWNER_ID) }
  }

  async uploadProvenance(jobId, content) {
    const snapshot = await this.saveSnapshot(jobId, identity, content)
    return { snapshot, job: this.getJob(jobId) }
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
    if (request.method === 'POST' && path === '/__fixtures/provenance') {
      return Response.json(await account().seedProvenance())
    }
    if (request.method === 'POST' && path === '/__fixtures/provenance/snapshot') {
      const { jobId, content } = await request.json()
      return Response.json(await account().uploadProvenance(jobId, content))
    }
    return app.fetch(request, env, ctx)
  },
}

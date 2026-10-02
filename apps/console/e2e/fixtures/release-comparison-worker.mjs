import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { digest } from '../../worker/security.ts'
import { AccountState } from '../../worker/state.ts'

// This entrypoint is bundled only by the browser integration fixture. Production
// continues to export AccountState and app directly from worker/index.ts.
export class FixtureAccountState extends AccountState {
  async seedReleaseComparison() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const put = (key, value) => this.ctx.storage.sql.exec(
      'INSERT INTO records(key,value) VALUES (?,?)',
      key,
      JSON.stringify(value),
    )
    const now = Date.now()
    const project = {
      ...projectInput.parse({
        name: 'release-comparison',
        prefix: 'brand',
        packageName: '@test/release-comparison',
        repository: 'fixture/icons',
        sources: [{ type: 'directory', dir: 'raw' }],
      }),
      id: crypto.randomUUID(),
      revision: 1,
      repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
      createdAt: now - 5000,
    }
    const kept = { body: '<circle cx="12" cy="12" r="8"/>' }
    const removed = { body: '<path d="M4 4h16v16H4z"/>' }
    const snapshots = []
    for (const [index, icons] of [
      { kept, removed },
      { kept },
      { kept },
    ].entries()) {
      const content = {
        json: { prefix: project.prefix, width: 24, height: 24, icons },
        files: {},
        issues: [],
        failed: [],
        sources: [{ type: 'directory', notModified: index === 2 }],
      }
      const document = JSON.stringify(content)
      const snapshot = {
        id: crypto.randomUUID(),
        projectId: project.id,
        jobId: crypto.randomUUID(),
        attempt: 1,
        createdAt: now - (3 - index) * 1000,
        digest: await digest(document),
        iconCount: Object.keys(icons).length,
        issues: 0,
        ...(index ? { baselineId: snapshots[index - 1].id } : {}),
      }
      await this.env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, document)
      put(`snapshot:${snapshot.id}`, snapshot)
      put(`job:${snapshot.jobId}`, {
        id: snapshot.jobId,
        projectId: project.id,
        project,
        operation: 'sync',
        status: 'succeeded',
        stage: 'complete',
        snapshotId: snapshot.id,
        sourceCommit: 'a'.repeat(40),
        workflowCommit: 'a'.repeat(40),
        executorCommit: 'a'.repeat(40),
        workflowDigest: 'a'.repeat(64),
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt,
        dispatchAttempts: 1,
        attempt: 1,
      })
      snapshots.push(snapshot)
    }
    const release = {
      id: crypto.randomUUID(),
      projectId: project.id,
      jobId: crypto.randomUUID(),
      snapshotId: snapshots[0].id,
      version: '1.0.0',
      packageName: project.packageName,
      integrity: 'sha512-fixture',
      commit: 'b'.repeat(40),
      createdAt: now - 2500,
      url: 'https://github.com/fixture/icons/releases/tag/1.0.0',
    }
    project.snapshotId = snapshots[2].id
    project.releaseId = release.id
    put(`release:${release.id}`, release)
    put(`project:${project.id}`, project)
    return { project, snapshots, release, session: await this.newSession(OWNER_ID) }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/__fixtures/release-comparison') {
      const fixture = await env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID)).seedReleaseComparison()
      return Response.json(fixture)
    }
    return app.fetch(request, env, ctx)
  },
}

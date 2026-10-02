import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { digest } from '../../worker/security.ts'
import { AccountState } from '../../worker/state.ts'

const kept = { body: '<circle cx="12" cy="12" r="8"/>' }
const added = { body: '<path d="M4 12h16M12 4v16"/>' }

// Tests mutate only stored preconditions; preview, confirmation, job creation,
// idempotency, session and CSRF all run through the production Worker.
export class FixtureAccountState extends AccountState {
  record(key, value) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
  }

  readRecord(key) {
    const row = this.ctx.storage.sql.exec('SELECT value FROM records WHERE key = ?', key).one()
    return JSON.parse(row.value)
  }

  async seedSnapshot(project, icons, baselineId, createdAt = Date.now()) {
    const content = {
      json: { prefix: project.prefix, width: 24, height: 24, icons },
      files: {},
      issues: [],
      failed: [],
      sources: [{ type: 'directory', notModified: false }],
    }
    const document = JSON.stringify(content)
    const snapshot = {
      id: crypto.randomUUID(),
      projectId: project.id,
      jobId: crypto.randomUUID(),
      attempt: 1,
      createdAt,
      digest: await digest(document),
      iconCount: Object.keys(icons).length,
      issues: 0,
      ...(baselineId ? { baselineId } : {}),
    }
    await this.env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, document)
    this.record(`snapshot:${snapshot.id}`, snapshot)
    this.record(`job:${snapshot.jobId}`, {
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
      createdAt,
      updatedAt: createdAt,
      dispatchAttempts: 1,
      attempt: 1,
    })
    return snapshot
  }

  async seedReviewRecovery() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const now = Date.now()
    const makeProject = name => ({
      ...projectInput.parse({ name, prefix: 'brand', packageName: `@test/${name}`, repository: 'fixture/icons', sources: [{ type: 'directory', dir: 'raw' }] }),
      id: crypto.randomUUID(),
      revision: 1,
      repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
      createdAt: now - 5000,
    })
    const project = makeProject('review-recovery')
    const otherProject = makeProject('other-project')
    const baseline = await this.seedSnapshot(project, { kept, removed: { body: '<path d="M4 4h16v16H4z"/>' } }, undefined, now - 3000)
    const review = await this.seedSnapshot(project, { kept, added }, baseline.id, now - 2000)
    const alternate = await this.seedSnapshot(project, { kept, replacement: added }, review.id, now - 1000)
    const otherSnapshot = await this.seedSnapshot(otherProject, { other: kept }, undefined, now - 500)
    const release = {
      id: crypto.randomUUID(),
      projectId: project.id,
      jobId: baseline.jobId,
      snapshotId: baseline.id,
      version: '1.0.0',
      packageName: project.packageName,
      integrity: 'sha512-fixture',
      commit: 'b'.repeat(40),
      createdAt: now - 2500,
      url: 'https://github.com/fixture/icons/releases/tag/1.0.0',
    }
    project.snapshotId = alternate.id
    project.releaseId = release.id
    otherProject.snapshotId = otherSnapshot.id
    this.record(`release:${release.id}`, release)
    this.record(`project:${project.id}`, project)
    this.record(`project:${otherProject.id}`, otherProject)
    return { project, otherProject, snapshots: [baseline, review, alternate], otherSnapshot, release, session: await this.newSession(OWNER_ID), appOrigin: this.env.APP_ORIGIN }
  }

  async changeReviewPrecondition(input) {
    if (input.action === 'expire') {
      const confirmation = this.readRecord(`confirmation:${input.confirmationId}`)
      this.record(`confirmation:${input.confirmationId}`, { ...confirmation, expiresAt: Date.now() - 1 })
      return {}
    }
    if (input.action === 'remove') {
      this.ctx.storage.sql.exec('DELETE FROM records WHERE key = ?', `confirmation:${input.confirmationId}`)
      return {}
    }
    const project = this.readRecord(`project:${input.projectId}`)
    if (input.action === 'baseline') {
      const previous = this.readRecord(`release:${project.releaseId}`)
      const release = { ...previous, id: crypto.randomUUID(), version: '1.1.0', snapshotId: input.snapshotId, createdAt: Date.now() }
      this.record(`release:${release.id}`, release)
      this.record(`project:${project.id}`, { ...project, releaseId: release.id })
      return { release }
    }
    if (input.action === 'revision') {
      this.record(`project:${project.id}`, { ...project, revision: project.revision + 1 })
      return {}
    }
    if (input.action === 'snapshot') {
      const snapshot = await this.seedSnapshot(project, { kept, added }, project.snapshotId)
      this.record(`project:${project.id}`, { ...project, snapshotId: snapshot.id })
      return { snapshot }
    }
    throw new Error(`Unknown fixture action: ${input.action}`)
  }

  // Dispatch is outside this fixture's scope; never contact a real workflow.
  async alarm() {}
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.startsWith('/__fixtures/review-recovery')) {
      const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
      return Response.json(path === '/__fixtures/review-recovery'
        ? await account.seedReviewRecovery()
        : await account.changeReviewPrecondition(await request.json()))
    }
    return app.fetch(request, env, ctx)
  },
}

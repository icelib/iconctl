import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { digest } from '../../worker/security.ts'
import { AccountState } from '../../worker/state.ts'

// Seed immutable stored artifacts directly to exercise legacy/extension data.
// This is not evidence that normal upload validation accepts hostile metadata.
export class FixtureAccountState extends AccountState {
  async seedComparisonReport() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const put = (key, value) => this.ctx.storage.sql.exec('INSERT INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
    const now = Date.now()
    const project = {
      ...projectInput.parse({ name: 'comparison-report', prefix: 'brand', packageName: '@test/comparison-report', repository: 'fixture/icons', sources: [{ type: 'directory', dir: 'raw' }] }),
      id: crypto.randomUUID(), revision: 1,
      repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' }, createdAt: now - 10000,
    }
    const otherProject = { ...project, id: crypto.randomUUID(), name: 'first-release' }
    const hostile = '</script><img data-injected="report" src="https://invalid.example/leak"> & "设计"'
    const circle = '<circle cx="8" cy="8" r="6"/>'
    const hostileSvg = `<g onload="parent.__svgExecuted=true"><title>设计 😀 &amp; review</title><script>parent.__svgExecuted=true;fetch('https://invalid.example/script')</script><foreignObject width="16" height="16"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://invalid.example/foreign" onerror="parent.__svgExecuted=true"/></div></foreignObject><image href="https://invalid.example/image" width="1" height="1"/>${circle}</g>`
    const baselineIcons = { unchanged: { body: circle, width: 24, height: 24 }, metadata: { body: circle, width: 24, height: 24, custom: 'before' }, resized: { body: circle, width: 20, height: 10 }, removed: { body: '<path d="M1 1h8v8z"/>' } }
    const currentIcons = { unchanged: { body: circle, width: 24, height: 24 }, metadata: { body: circle, width: 24, height: 24, custom: 'after' }, resized: { body: circle, width: 40 }, added: { body: circle }, [hostile]: { body: hostileSvg, width: 48, height: 24 } }
    const issue = { name: hostile, message: `${hostile} ${'long-text'.repeat(30)}`, stage: 'constructor', sourceType: 'figma', sourceIndex: 0, fileKey: 'file<&', nodeId: 'node:1', private: 'report-private-issue' }
    const content = (json, diagnostics = false) => ({ json, files: { 'secret.txt': 'report-private-file' }, issues: diagnostics ? [issue] : [], failed: diagnostics ? ['missing-output'] : [], sources: [{ type: 'figma', token: 'report-private-source' }], config: { token: 'report-private-config' } })
    let sequence = 0
    const add = async (owner, data, baseline, legacy = false) => {
      const document = JSON.stringify(data)
      const snapshot = { id: crypto.randomUUID(), projectId: owner.id, jobId: crypto.randomUUID(), ...(legacy ? {} : { attempt: 2 }), createdAt: now - 9000 + sequence++ * 1000, digest: await digest(document), iconCount: Object.keys(data.json.icons).length, issues: data.issues.length + data.failed.length, ...(baseline ? { baselineId: baseline.id } : {}) }
      await this.env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, document)
      put(`snapshot:${snapshot.id}`, snapshot)
      put(`job:${snapshot.jobId}`, { id: snapshot.jobId, projectId: owner.id, project: owner, operation: 'sync', status: 'succeeded', stage: 'complete', snapshotId: snapshot.id, sourceCommit: 'a'.repeat(40), workflowCommit: 'a'.repeat(40), executorCommit: 'a'.repeat(40), workflowDigest: 'a'.repeat(64), createdAt: snapshot.createdAt, updatedAt: snapshot.createdAt, dispatchAttempts: 1, attempt: snapshot.attempt ?? 1 })
      return snapshot
    }
    const baseline = await add(project, content({ prefix: 'released-品牌', width: 24, height: 24, icons: baselineIcons }), undefined, true)
    const previous = await add(project, content({ prefix: 'brand', width: 32, height: 16, icons: currentIcons }), baseline)
    const current = await add(project, content({ prefix: `current<&"`, width: 32, height: 16, icons: currentIcons }, true), previous)
    const prefixOnly = await add(project, content({ prefix: 'new-prefix', width: 32, height: 16, icons: currentIcons }), current)
    const empty = await add(project, content({ prefix: 'empty', icons: {} }), current)
    const first = await add(otherProject, content({ prefix: 'first', icons: { default: { body: circle }, override: { body: circle, width: 18 } } }), undefined, true)
    const release = { id: crypto.randomUUID(), projectId: project.id, jobId: crypto.randomUUID(), snapshotId: baseline.id, version: '1.2.3', packageName: project.packageName, integrity: 'sha512-fixture', commit: 'b'.repeat(40), createdAt: now - 8500, url: 'https://github.com/fixture/icons/releases/tag/1.2.3' }
    project.snapshotId = current.id
    project.releaseId = release.id
    otherProject.snapshotId = first.id
    put(`release:${release.id}`, release)
    put(`project:${project.id}`, project)
    put(`project:${otherProject.id}`, otherProject)
    return { project, otherProject, baseline, previous, current, prefixOnly, empty, first, release, hostile, hostileSvg, session: await this.newSession(OWNER_ID) }
  }
}
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/__fixtures/comparison-report') {
      return Response.json(await env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID)).seedComparisonReport())
    }
    return app.fetch(request, env, ctx)
  },
}

import { OWNER_ID } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { digest } from '../../worker/security.ts'
import { FixtureAccountState as ProvenanceState } from './provenance-worker.mjs'

// Normal core data uses inherited claim/saveSnapshot. Direct R2 data below is
// explicitly legacy/extension data, not evidence of accepted upload validation.
export class FixtureAccountState extends ProvenanceState {
  async seedDiagnostics() {
    const fixture = await this.seedProvenance()
    const hostile = `</textarea><img data-injected="diagnostics"> "设计😀"\n${'长名称'.repeat(50)}`
    const issues = [
      { name: 'shared', message: 'Legacy validation', stage: 'validate', sourceType: 'figma', sourceIndex: 1, fileKey: 'ZbCdEfGhIjKlMnOpQrStUv', nodeId: '8:9' },
      { name: 'shared', message: 'Current validation', stage: 'validation', sourceType: 'figma', sourceIndex: 1, fileKey: 'ZbCdEfGhIjKlMnOpQrStUv', nodeId: '8:9' },
      { name: 'shared', message: 'Download failed', stage: 'download', sourceType: 'figma', sourceIndex: 0 },
      { name: hostile, message: hostile, stage: 'all', sourceType: 'all', sourceIndex: 0, secret: 'private-diagnostic' },
      { name: 'literal-missing', message: 'Literal missing', stage: 'missing', sourceType: 'missing' },
      { name: 'unrecorded', message: 'No stage or source' },
      { name: 'type-only', message: 'No source index', stage: 'validation', sourceType: 'figma' },
      { name: 'index-only', message: 'No source type', sourceIndex: 0 },
      { name: 'shared', message: 'Legacy validation', stage: 'validate', sourceType: 'figma', sourceIndex: 1, fileKey: 'ZbCdEfGhIjKlMnOpQrStUv', nodeId: '8:9' },
    ]
    const content = (issues, failed) => ({ json: { prefix: 'brand', width: 24, height: 24, icons: { shared: { body: '<circle cx="12" cy="12" r="6"/>' } } }, files: { 'private.txt': 'private-file' }, issues, failed, sources: [], config: { token: 'private-config' } })
    let sequence = 0
    const add = async (data, attempt) => {
      const body = JSON.stringify(data)
      const snapshot = { id: crypto.randomUUID(), projectId: fixture.project.id, jobId: crypto.randomUUID(), ...(attempt === undefined ? {} : { attempt }), createdAt: Date.now() - 9000 + sequence++ * 1000, digest: await digest(body), iconCount: 1, issues: data.issues.length + data.failed.length }
      await this.env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, body)
      this.ctx.storage.sql.exec('INSERT INTO records(key,value) VALUES (?,?)', `snapshot:${snapshot.id}`, JSON.stringify(snapshot))
      return snapshot
    }
    return { ...fixture, hostile, rich: await add(content(issues, ['shared', 'shared']), undefined), reportRich: await add(content(issues.map(issue => ({ ...issue, name: issue.name === hostile ? '</textarea><img data-injected="diagnostics"> "设计😀"' : issue.name })), ['shared', 'shared']), undefined), failedOnly: await add(content([], [hostile]), 2), invalid: await add(content(issues.slice(0, 1), []), 0) }
  }

  async completeDiagnosticsRetry(jobId) {
    const job = this.getJob(jobId)
    if (job.attempt !== 2 || job.status !== 'queued') {
      throw new Error('A real owner retry must precede completion')
    }
    const identity = { runId: '404', runAttempt: '2', repositoryId: '123', workflowRef: 'fixture/icons/.github/workflows/iconctl-console.yml@refs/heads/main', sha: 'a'.repeat(40), ref: 'refs/heads/main' }
    this.claim(jobId, identity, 'sync')
    this.progress(jobId, identity, 'validating')
    const snapshot = await this.saveSnapshot(jobId, identity, { json: { prefix: 'brand', width: 24, height: 24, icons: { shared: { body: '<circle cx="12" cy="12" r="6"/>' } } }, files: {}, issues: [], failed: [], sources: [] })
    return { job: this.getJob(jobId), snapshot }
  }
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
    if (request.method === 'POST' && path === '/__fixtures/diagnostics') {
      return Response.json(await account().seedDiagnostics())
    }
    if (request.method === 'POST' && path === '/__fixtures/diagnostics/snapshot') {
      const { jobId, content } = await request.json()
      return Response.json(await account().uploadProvenance(jobId, content))
    }
    if (request.method === 'POST' && path === '/__fixtures/diagnostics/complete-retry') {
      const { jobId } = await request.json()
      return Response.json(await account().completeDiagnosticsRetry(jobId))
    }
    return app.fetch(request, env, ctx)
  },
}

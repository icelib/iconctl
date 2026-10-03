import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { digest } from '../../worker/security.ts'
import { AccountState } from '../../worker/state.ts'

// Only storage preconditions are fixtures. Authentication, snapshot reading,
// digest validation and ZIP streaming run through the production Worker.
export class FixtureAccountState extends AccountState {
  record(key, value) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
  }

  async seedSvgArchive() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const now = Date.now()
    const project = name => ({
      ...projectInput.parse({ name, prefix: 'brand', packageName: `@test/${name}`, repository: 'fixture/icons', sources: [{ type: 'directory', dir: 'raw' }] }),
      id: crypto.randomUUID(), revision: 1, repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' }, createdAt: now - 9000,
    })
    const primary = project('svg-archive')
    const other = project('other-archive')
    const expectedFiles = {
      'svg/arrow.svg': btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\r\n<path d="M0 0h24v24H0z"/>\r\n</svg>'),
      'svg/nested/图标 & space.SVG': btoa('\x00\xFF\x01\x80'),
      'svg/empty.svg': '',
    }
    const documents = {}
    const snapshot = async (owner, files, index, baseline, icons = { kept: { body: '<circle cx="12" cy="12" r="8"/>' }, added: { body: '<path d="M4 12h16"/>' } }) => {
      const content = { json: { prefix: owner.prefix, width: 24, height: 24, icons }, files, issues: [], failed: [], sources: [{ type: 'directory', notModified: false }] }
      const document = JSON.stringify(content)
      const metadata = { id: crypto.randomUUID(), projectId: owner.id, jobId: crypto.randomUUID(), attempt: 1, createdAt: now - (8 - index) * 1000, digest: await digest(document), iconCount: Object.keys(icons).length, issues: 0, ...(baseline ? { baselineId: baseline.id } : {}) }
      documents[metadata.id] = document
      await this.env.ARTIFACTS.put(`snapshots/${metadata.id}/${metadata.digest}`, document)
      this.record(`snapshot:${metadata.id}`, metadata)
      this.record(`job:${metadata.jobId}`, { id: metadata.jobId, projectId: owner.id, project: owner, operation: 'sync', status: 'succeeded', stage: 'complete', snapshotId: metadata.id, createdAt: metadata.createdAt, updatedAt: metadata.createdAt, dispatchAttempts: 1, attempt: 1, sourceCommit: 'a'.repeat(40), workflowCommit: 'a'.repeat(40), executorCommit: 'a'.repeat(40), workflowDigest: 'a'.repeat(64) })
      return metadata
    }
    const baseline = await snapshot(primary, { 'svg/previous.svg': btoa('<svg>previous</svg>') }, 0, undefined, { kept: { body: '<circle cx="12" cy="12" r="8"/>' }, removed: { body: '<path/>' } })
    const current = await snapshot(primary, { ...expectedFiles, 'icons.json': btoa('{}'), 'preview.html': btoa('<html/>'), 'svg/notes.txt': btoa('not an SVG') }, 1, baseline)
    const alternate = await snapshot(primary, { 'svg/alternate.svg': btoa('<svg>alternate</svg>') }, 2, current)
    const empty = await snapshot(primary, { 'icons.json': btoa('{}') }, 3, alternate)
    const large = await snapshot(primary, { 'svg/large.svg': btoa('x'.repeat(1024 * 1024 + 1)) }, 4, empty)
    const otherSnapshot = await snapshot(other, { 'svg/other.svg': btoa('<svg>other</svg>') }, 5)
    const release = { id: crypto.randomUUID(), projectId: primary.id, jobId: baseline.jobId, snapshotId: baseline.id, version: '1.0.0', packageName: primary.packageName, integrity: 'sha512-fixture', commit: 'b'.repeat(40), createdAt: now - 7000, url: 'https://github.com/fixture/icons/releases/tag/1.0.0' }
    primary.snapshotId = current.id
    primary.releaseId = release.id
    other.snapshotId = otherSnapshot.id
    this.record(`project:${primary.id}`, primary)
    this.record(`project:${other.id}`, other)
    this.record(`release:${release.id}`, release)
    this.record('fixture:svg-documents', documents)
    return { project: primary, otherProject: other, baseline, current, alternate, empty, large, otherSnapshot, expectedFiles, session: await this.newSession(OWNER_ID) }
  }

  async changeSvgArtifact({ snapshotId, action }) {
    const snapshot = await this.snapshot(snapshotId)
    const key = `snapshots/${snapshot.id}/${snapshot.digest}`
    if (action === 'missing') {
      await this.env.ARTIFACTS.delete(key)
    }
    else if (action === 'corrupt') {
      await this.env.ARTIFACTS.put(key, '{}')
    }
    else if (action === 'restore') {
      const row = this.ctx.storage.sql.exec('SELECT value FROM records WHERE key = ?', 'fixture:svg-documents').one()
      await this.env.ARTIFACTS.put(key, JSON.parse(row.value)[snapshot.id])
    }
    else {
      throw new Error(`Unknown fixture action: ${action}`)
    }
    return { action }
  }

  async alarm() {}
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.startsWith('/__fixtures/snapshot-svg-archive')) {
      const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
      return Response.json(path === '/__fixtures/snapshot-svg-archive'
        ? await account.seedSvgArchive()
        : await account.changeSvgArtifact(await request.json()))
    }
    return app.fetch(request, env, ctx)
  },
}

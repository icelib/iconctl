import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import app from '../../worker/index.ts'
import { AccountState } from '../../worker/state.ts'

export class FixtureAccountState extends AccountState {
  async seedUpload() {
    this.ctx.storage.sql.exec('DELETE FROM records')
    const projects = ['upload-icons', 'other-icons'].map(name => ({ ...projectInput.parse({ name, prefix: 'brand', packageName: `@test/${name}`, repository: 'fixture/icons', sources: [{ type: 'iconify', file: 'vendor/icons.json' }], color: 'currentColor', output: { svg: true, types: true, preview: true, changelog: true } }), id: crypto.randomUUID(), revision: 1, repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' }, createdAt: Date.now() }))
    for (const project of projects) {
      this.ctx.storage.sql.exec('INSERT INTO records(key,value) VALUES (?,?)', `project:${project.id}`, JSON.stringify(project))
    }
    return { projects, session: await this.newSession(OWNER_ID), repository: this.env.E2E_REPOSITORY, sourceCommit: this.env.E2E_SOURCE_COMMIT }
  }

  mutateRevision(id) {
    const row = this.ctx.storage.sql.exec('SELECT value FROM records WHERE key=?', `project:${id}`).one()
    const project = JSON.parse(row.value)
    project.revision++
    this.ctx.storage.sql.exec('UPDATE records SET value=? WHERE key=?', JSON.stringify(project), `project:${id}`)
    return project
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname
    const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
    if (request.method === 'POST' && path.startsWith('/__fixtures/iconify-upload')) {
      if (path === '/__fixtures/iconify-upload') {
        return Response.json(await account().seedUpload())
      }
      const input = await request.json()
      if (path.endsWith('/runner')) {
        const job = await account().getJob(input.jobId)
        const signed = await fetch('https://iconctl-browser.test/runner', { method: 'POST', body: JSON.stringify(job) })
        return Response.json({ job, ...await signed.json() })
      }
      if (path.endsWith('/revision')) {
        return Response.json(await account().mutateRevision(input.projectId))
      }
      return fetch('https://iconctl-browser.test/control', { method: 'POST', body: JSON.stringify(input) })
    }
    return app.fetch(request, env, ctx)
  },
}

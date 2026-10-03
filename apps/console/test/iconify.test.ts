import type { Job, Project } from '@iconctl/console-contracts'
import { OWNER_ID } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { runnerWorkflow } from '../worker/workflow'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const sha = 'a'.repeat(40)
const input = {
  name: 'icons',
  prefix: 'brand',
  packageName: '@test/icons',
  repository: 'owner/repo',
  sources: [{ type: 'iconify', file: 'vendor/icons.json', include: [], namePrefix: 'vendor-' }],
}
async function sessionHeaders() {
  const session = await account().newSession(OWNER_ID)
  return {
    'Cookie': `__Host-iconctl-session=${session.token}`,
    'Origin': env.APP_ORIGIN,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('saves repository Iconify projects, freezes their selection in jobs and grants no upload or credential scope', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    const path = new URL(String(request)).pathname
    if (path.endsWith('/installation')) {
      return Response.json({ id: 1, permissions: { contents: 'write', actions: 'write', pull_requests: 'write', workflows: 'write' } })
    }
    if (path.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    if (path === '/repos/owner/repo') {
      return Response.json({ id: 123, default_branch: 'main' })
    }
    if (path.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha } })
    }
    if (path.includes('/contents/.github/workflows/')) {
      return Response.json({ content: btoa(runnerWorkflow(env.APP_ORIGIN, env.EXECUTOR_REPOSITORY, sha)) })
    }
    throw new Error(`Unexpected GitHub request: ${path}`)
  })
  const headers = await sessionHeaders()
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/projects`, { method: 'POST', headers, body: JSON.stringify(input) })
  expect(response.status).toBe(201)
  const saved = await response.json<Project>()
  expect(saved.sources).toEqual(input.sources)
  expect((await account().state()).projects[0]!.sources).toEqual(input.sources)
  const job: Job = await account().createJob(saved.id, 'sync', crypto.randomUUID())
  expect(job.project.sources).toEqual(input.sources)
  expect(job.sourceCommit).toBe(sha)
  const identity = { runId: '1234', runAttempt: '1', repositoryId: '123', workflowRef: 'owner/repo/.github/workflows/iconctl-console.yml@refs/heads/main', sha, ref: 'refs/heads/main' }
  await account().claim(job.id, identity, 'sync')
  const result = await runInDurableObject(account(), async (instance) => {
    const errors: string[] = []
    for (const request of [
      () => instance.jobCredential(job.id, identity, crypto.randomUUID()),
      () => instance.uploadAllowed(job.id, identity, crypto.randomUUID()),
    ]) {
      try {
        await request()
      }
      catch (error) { errors.push((error as Error).message) }
    }
    return errors
  })
  expect(result).toEqual(expect.arrayContaining([expect.stringContaining('Credential is outside task scope'), expect.stringContaining('Upload is outside task scope')]))
})

it.each([
  { file: '../private.json' },
  { file: 'https://example.com/icons.json' },
  { upload: '00000000-0000-4000-8000-000000000000' },
  { connection: '00000000-0000-4000-8000-000000000000' },
])('rejects unsafe Iconify project payloads before contacting GitHub: %j', async (extra) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected network request')
  })
  const headers = await sessionHeaders()
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...input, sources: [{ ...input.sources[0], ...extra }] }),
  })
  expect(response.status).toBe(400)
  expect(fetch).not.toHaveBeenCalled()
  expect((await account().state()).projects).toEqual([])
})

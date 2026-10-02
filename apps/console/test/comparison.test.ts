import type { Job, Project, Release, ReleasePreview, Snapshot, SnapshotContent, SnapshotPreview } from '@iconctl/console-contracts'
import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { digest } from '../worker/security'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const sha = 'a'.repeat(40)
async function seed(key: string, value: unknown) {
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
  })
}
function project(): Project {
  return {
    ...projectInput.parse({ name: 'icons', prefix: 'test', packageName: '@test/icons', repository: 'owner/repo', sources: [{ type: 'directory', dir: 'raw' }] }),
    id: crypto.randomUUID(),
    revision: 1,
    repositoryInfo: { id: 123, installationId: 1, defaultBranch: 'main' },
    createdAt: Date.now(),
  }
}
async function snapshot(saved: Project, icons: SnapshotContent['json']['icons'], baselineId?: string, width = 24) {
  const content: SnapshotContent = { json: { prefix: 'test', icons, width, height: 24 }, files: {}, issues: [], failed: [], sources: [] }
  const text = JSON.stringify(content)
  const job: Job = {
    id: crypto.randomUUID(),
    projectId: saved.id,
    project: saved,
    operation: 'sync',
    status: 'succeeded',
    sourceCommit: sha,
    workflowCommit: sha,
    executorCommit: sha,
    workflowDigest: sha,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dispatchAttempts: 1,
    attempt: 1,
    stage: 'complete',
  }
  const result: Snapshot = {
    id: crypto.randomUUID(),
    jobId: job.id,
    projectId: saved.id,
    digest: await digest(text),
    createdAt: Date.now(),
    iconCount: Object.keys(icons).length,
    issues: 0,
    ...(baselineId ? { baselineId } : {}),
  }
  await env.ARTIFACTS.put(`snapshots/${result.id}/${result.digest}`, text)
  await seed(`job:${job.id}`, { ...job, snapshotId: result.id })
  await seed(`snapshot:${result.id}`, result)
  return result
}
async function history() {
  const saved = project()
  const first = await snapshot(saved, { arrow: { body: '<path/>' }, retired: { body: '<circle/>' } })
  const second = await snapshot(saved, { arrow: { body: '<path/>' }, added: { body: '<rect/>' } }, first.id, 16)
  const third = await snapshot(saved, { arrow: { body: '<path/>' }, added: { body: '<rect/>' } }, second.id, 16)
  const release: Release = {
    id: crypto.randomUUID(),
    projectId: saved.id,
    jobId: crypto.randomUUID(),
    snapshotId: first.id,
    version: '1.0.0',
    packageName: saved.packageName,
    integrity: 'sha512-test',
    commit: sha,
    createdAt: Date.now(),
    url: 'https://npmjs.com/package/@test/icons',
  }
  saved.releaseId = release.id
  saved.snapshotId = third.id
  await seed(`release:${release.id}`, release)
  await seed(`project:${saved.id}`, saved)
  return { saved, first, second, third, release }
}
async function owner() {
  const session = await account().newSession(OWNER_ID)
  return {
    'Cookie': `__Host-iconctl-session=${session.token}`,
    'Origin': env.APP_ORIGIN,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  }
}
function mockGithub(head: string | null, onHead?: () => void) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    if (path.includes('/git/ref/heads/')) {
      onHead?.()
      return head ? Response.json({ object: { sha: head } }) : new Response(null, { status: 404 })
    }
    throw new Error(`Unexpected upstream request: ${path}`)
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('compares a later sync against its original baseline, a release, or any same-project snapshot through HTTP', async () => {
  const { first, second, third, release } = await history()
  const headers = await owner()
  for (const [query, baseline, mode, changes] of [
    ['', second, 'previous', { added: [], changed: [], removed: [] }],
    ['?compareTo=release', first, 'release', { added: ['added'], changed: ['arrow'], removed: ['retired'] }],
    [`?compareTo=${first.id}`, first, 'snapshot', { added: ['added'], changed: ['arrow'], removed: ['retired'] }],
    [`?compareTo=${third.id}`, third, 'snapshot', { added: [], changed: [], removed: [] }],
  ] as const) {
    const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${third.id}${query}`, { headers })
    expect(response.status).toBe(200)
    const preview = await response.json<SnapshotPreview>()
    expect(preview.diff).toEqual(changes)
    expect(preview.comparison).toEqual({
      mode,
      snapshot: baseline,
      release: mode === 'release' ? { id: release.id, version: release.version, snapshotId: first.id } : null,
    })
    expect(preview.snapshot.baselineId).toBe(second.id)
  }
})

it('compares an initial release against an empty set in both preview and confirmation', async () => {
  const saved = project()
  await seed(`project:${saved.id}`, saved)
  const first = await snapshot(saved, { arrow: { body: '<path/>' } })
  const preview = JSON.parse(await account().snapshotPreviewDocument(first.id, 'release')) as SnapshotPreview
  mockGithub(null)
  const confirmation = await account().confirmRelease(saved.id, first.id, 'patch')
  for (const value of [preview, confirmation]) {
    expect(value.comparison).toEqual({ mode: 'release', snapshot: null, release: null })
    expect(value.diff).toEqual({ added: ['arrow'], changed: [], removed: [] })
  }
  expect(confirmation.release.baselineReleaseId).toBeUndefined()
  expect(confirmation.release.version).toBe('0.1.0')
})

it('rejects invalid, unknown and cross-project comparison targets through the owner route', async () => {
  const { third } = await history()
  const other = await snapshot(project(), { foreign: { body: '<path/>' } })
  const headers = await owner()
  for (const [target, status] of [['invalid', 400], [crypto.randomUUID(), 404], [other.id, 400]] as const) {
    const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${third.id}?compareTo=${target}`, { headers })
    expect(response.status).toBe(status)
  }
})

it('does not substitute an empty baseline when a published snapshot is missing or corrupt', async () => {
  const { first, third } = await history()
  const headers = await owner()
  const path = `snapshots/${first.id}/${first.digest}`
  await env.ARTIFACTS.delete(path)
  expect((await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${third.id}?compareTo=release`, { headers })).status).toBe(404)
  await env.ARTIFACTS.put(path, JSON.stringify({ corrupted: true }))
  expect((await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${third.id}?compareTo=release`, { headers })).status).toBe(409)
})

it('confirms cumulative changes independently of the preview and rejects a changed release before publication', async () => {
  const { saved, third, release } = await history()
  const headers = await owner()
  const preview = JSON.parse(await account().snapshotPreviewDocument(third.id)) as SnapshotPreview
  expect(preview.diff.removed).toEqual([])
  mockGithub(sha)
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/projects/${saved.id}/release/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ snapshotId: third.id, bump: 'minor' }),
  })
  expect(response.status).toBe(200)
  const confirmation = await response.json<ReleasePreview>()
  expect(confirmation.release).toMatchObject({ baselineReleaseId: release.id, snapshotId: third.id, digest: third.digest, version: '1.1.0' })
  expect(confirmation.comparison.release?.id).toBe(release.id)
  expect(confirmation.diff).toEqual({ added: ['added'], changed: ['arrow'], removed: ['retired'] })
  await seed(`project:${saved.id}`, { ...saved, releaseId: crypto.randomUUID() })
  const publish = await exports.default.fetch(`${env.APP_ORIGIN}/api/projects/${saved.id}/release/confirm`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ confirmationId: confirmation.id }),
  })
  expect(publish.status).toBe(409)
  expect((await publish.json<{ error: string }>()).error).toContain('stale')
})

it.each(['revision', 'release', 'lock'] as const)('does not persist confirmation after a concurrent %s change', async (change) => {
  const { saved, third } = await history()
  const result = await runInDurableObject(account(), async (instance, state) => {
    mockGithub(sha, () => {
      if (change === 'lock') {
        const source = instance.getJob(third.jobId)
        state.storage.sql.exec('UPDATE records SET value=? WHERE key=?', JSON.stringify({ ...source, status: 'running' }), `job:${source.id}`)
      }
      else {
        const changed = { ...saved, ...(change === 'revision' ? { revision: 2 } : { releaseId: crypto.randomUUID() }) }
        state.storage.sql.exec('UPDATE records SET value=? WHERE key=?', JSON.stringify(changed), `project:${saved.id}`)
      }
    })
    let error = ''
    try {
      await instance.confirmRelease(saved.id, third.id, 'patch')
    }
    catch (cause) {
      error = (cause as Error).message
    }
    return { error, count: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM records WHERE key LIKE \'confirmation:%\'').one().count }
  })
  expect(result.error).toContain('changed while preparing confirmation')
  expect(result.count).toBe(0)
})

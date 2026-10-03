import type { Job, Project, ProjectInput, SnapshotContent } from '@iconctl/console-contracts'
import type { AccountState } from '../worker/state'
import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const sha = 'a'.repeat(40)
const identity = {
  runId: '1234',
  runAttempt: '1',
  repositoryId: '123',
  workflowRef: 'owner/repo/.github/workflows/iconctl-console.yml@refs/heads/main',
  sha,
  ref: 'refs/heads/main',
}
const content: SnapshotContent = {
  json: { prefix: 'test', icons: { arrow: { body: '<path d="M0 0h24v24H0z"/>' } }, width: 24, height: 24 },
  files: {},
  issues: [],
  failed: [],
  sources: [],
}
function project(): Project {
  return {
    ...projectInput.parse({ name: 'icons', prefix: 'test', packageName: '@test/icons', repository: 'owner/repo', sources: [{ type: 'directory', dir: 'raw' }] }),
    id: crypto.randomUUID(),
    revision: 1,
    createdAt: Date.now(),
    repositoryInfo: { id: 123, installationId: 1, defaultBranch: 'main' },
  }
}
function task(saved: Project, publish = false): Job {
  return {
    id: crypto.randomUUID(),
    projectId: saved.id,
    project: saved,
    operation: publish ? 'publish' : 'sync',
    status: 'running',
    attempt: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dispatchAttempts: 1,
    sourceCommit: sha,
    workflowCommit: sha,
    executorCommit: sha,
    workflowDigest: '',
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    stage: 'packing',
    ...(publish ? { integrity: 'sha512-fixed', releaseCommit: 'b'.repeat(40), release: { snapshotId: crypto.randomUUID(), digest: 'fixed', version: '0.1.0', branchHead: null, confirmation: crypto.randomUUID() } } : {}),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

// The repository lookup is the outbound gate. Run real task completion while
// saveProject is suspended, then return GitHub's normal successful response.
async function saveAcross(
  saved: Project,
  input: ProjectInput,
  during: (instance: AccountState, put: (key: string, value: unknown) => void) => Promise<void> | void,
  initial: [string, unknown][] = [],
) {
  return runInDurableObject(account(), async (instance, state) => {
    const put = (key: string, value: unknown) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
    }
    put(`project:${saved.id}`, saved)
    initial.forEach(([key, value]) => put(key, value))
    let entered = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/installation')) {
        expect(entered).toBe(false)
        entered = true
        await during(instance, put)
        return Response.json({ id: 1, permissions: { contents: 'write', actions: 'write', pull_requests: 'write', workflows: 'write' } })
      }
      if (path.endsWith('/access_tokens')) {
        return Response.json({ token: 'installation-token' })
      }
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        return Response.json({ dist: { integrity: 'sha512-fixed' } })
      }
      if (path.includes('/git/ref/heads/')) {
        return Response.json({ object: { sha: 'b'.repeat(40) } })
      }
      return Response.json({ id: 123, default_branch: 'main' })
    })
    let result: Project | undefined
    let error = ''
    try {
      result = await instance.saveProject(projectInput.strip().parse(input), saved.id, saved.revision)
    }
    catch (cause) {
      error = (cause as Error).message
    }
    expect(entered).toBe(true)
    return { result, error, state: instance.state() }
  })
}

it('preserves a snapshot completed during the repository lookup', async () => {
  const saved = project()
  let snapshotId = ''
  const outcome = await saveAcross(saved, { ...saved, prefix: 'new' }, async (instance, put) => {
    const job = task(saved)
    put(`job:${job.id}`, job)
    snapshotId = (await instance.saveSnapshot(job.id, identity, content)).id
  })
  expect(outcome.error).toBe('')
  expect(outcome.result).toMatchObject({ revision: 2, prefix: 'new', snapshotId })
  expect(outcome.state.projects[0]?.snapshotId).toBe(snapshotId)
  expect(outcome.state.jobs[0]?.status).toBe('succeeded')
})

it.each([false, true])('preserves a completed release during save (previous release: %s)', async (previous) => {
  const saved = { ...project(), ...(previous ? { releaseId: crypto.randomUUID() } : {}) }
  const job = task(saved, true)
  const outcome = await saveAcross(saved, { ...saved, prefix: 'new' }, async (instance, put) => {
    put(`job:${job.id}`, job)
    expect(await instance.finishRelease(job.id)).toBe(true)
  })
  expect(outcome.error).toBe('')
  expect(outcome.result).toMatchObject({ revision: 2, prefix: 'new', releaseId: job.id })
  expect(outcome.state.projects[0]?.releaseId).toBe(job.id)
  expect(outcome.state.releases[0]?.id).toBe(job.id)
})

it.each(['name', 'packageName', 'repository'] as const)('rejects %s identity changes if the first release completes during save', async (field) => {
  const saved = project()
  const job = task(saved, true)
  const changed = { name: 'other', packageName: '@test/other', repository: 'owner/other' }
  const outcome = await saveAcross(saved, { ...saved, [field]: changed[field] }, async (instance, put) => {
    put(`job:${job.id}`, job)
    expect(await instance.finishRelease(job.id)).toBe(true)
  })
  expect(outcome.error).toContain('published project cannot change')
  expect(outcome.state.projects[0]).toMatchObject({ revision: 1, releaseId: job.id, [field]: saved[field] })
})

it.each(['revision', 'lock'] as const)('keeps the existing %s guard across repository lookup', async (change) => {
  const saved = project()
  const outcome = await saveAcross(saved, { ...saved, prefix: 'new' }, (_instance, put) => {
    if (change === 'revision') {
      put(`project:${saved.id}`, { ...saved, revision: 2, prefix: 'other' })
    }
    else {
      const job = task(saved)
      put(`job:${job.id}`, job)
    }
  })
  expect(outcome.error).toContain('Project changed')
  expect(outcome.state.projects[0]?.prefix).toBe(change === 'revision' ? 'other' : 'test')
})

it('saves an unchanged unlocked project with the next revision', async () => {
  const saved = project()
  const outcome = await saveAcross(saved, { ...saved, prefix: 'new' }, () => {})
  expect(outcome.error).toBe('')
  expect(outcome.result).toMatchObject({ id: saved.id, revision: 2, prefix: 'new' })
})

it('rejects a source connection disconnected during the repository lookup', async () => {
  const saved = project()
  const connection = crypto.randomUUID()
  const input: ProjectInput = { ...saved, sources: [{ type: 'mastergo', connection, fileId: '123', layerId: '456' }] }
  const outcome = await saveAcross(saved, input, instance => instance.disconnect(connection), [
    [`connection:${connection}`, { id: connection, type: 'mastergo', label: 'MasterGo', encrypted: '', revision: 1, reconnect: false }],
  ])
  expect(outcome.error).toContain('Record not found')
  expect(outcome.state.projects[0]).toMatchObject({ revision: 1, sources: saved.sources })
  expect(outcome.state.connections).toEqual([])
})

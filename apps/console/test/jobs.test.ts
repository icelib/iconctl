import type { Job, Project, SnapshotContent } from '@iconctl/console-contracts'
import type { RunnerIdentity } from '../worker/github'
import { OWNER_ID, projectInput } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { base64, digest, encrypt } from '../worker/security'
import { runnerWorkflow } from '../worker/workflow'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const sha = 'a'.repeat(40)
function project(): Project {
  return {
    ...projectInput.parse({
      name: 'icons',
      prefix: 'test',
      packageName: '@test/icons',
      repository: 'owner/repo',
      sources: [{ type: 'directory', dir: 'raw' }],
    }),
    id: crypto.randomUUID(),
    revision: 1,
    repositoryInfo: { id: 123, installationId: 1, defaultBranch: 'main' },
    createdAt: Date.now(),
  }
}
const identity: RunnerIdentity = {
  runId: '1234',
  runAttempt: '1',
  repositoryId: '123',
  workflowRef:
    'owner/repo/.github/workflows/iconctl-console.yml@refs/heads/main',
  sha,
  ref: 'refs/heads/main',
}
function content(): SnapshotContent {
  return {
    json: {
      prefix: 'test',
      icons: { arrow: { body: '<path d="M0 0h24v24H0z"/>' } },
      width: 24,
      height: 24,
    },
    files: {},
    issues: [],
    failed: [],
    sources: [{ type: 'directory', notModified: false }],
  }
}
async function seed(key: string, value: unknown) {
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec(
      'INSERT OR REPLACE INTO records(key,value) VALUES (?,?)',
      key,
      JSON.stringify(value),
    )
  })
}
async function read<T>(key: string): Promise<T> {
  return runInDurableObject(
    account(),
    (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ value: string }>('SELECT value FROM records WHERE key=?', key)
          .one().value,
      ) as T,
  )
}
async function failure(
  action: (instance: import('../worker/state').AccountState) => unknown,
) {
  return runInDurableObject(account(), async (instance) => {
    try {
      await action(instance)
      return ''
    }
    catch (error) {
      return (error as Error).message
    }
  })
}
function mockGithub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    )
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    if (url.pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha } })
    }
    if (url.pathname.includes('/contents/.github/workflows/')) {
      return Response.json({
        content: btoa(
          runnerWorkflow(env.APP_ORIGIN, env.EXECUTOR_REPOSITORY, sha),
        ),
      })
    }
    return new Response(null, { status: 404 })
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('persists one idempotent job and lets only one Actions run claim it', async () => {
  mockGithub()
  const saved = project()
  await seed(`project:${saved.id}`, saved)
  const key = crypto.randomUUID()
  const jobs = await Promise.all([
    account().createJob(saved.id, 'sync', key),
    account().createJob(saved.id, 'sync', key),
  ])
  expect(jobs[0]?.id).toBe(jobs[1]?.id)
  expect((await account().state()).jobs).toHaveLength(1)
  const job = jobs[0]!
  expect(job.sourceCommit).toBe(sha)
  expect(job.dispatchAttempts).toBe(0)
  await account().claim(job.id, identity, 'sync')
  expect(
    await failure(instance =>
      instance.claim(job.id, { ...identity, runId: 'other' }, 'sync'),
    ),
  ).toContain('another run')
  expect(
    await failure(instance => instance.claim(job.id, identity, 'publish')),
  ).toContain('cannot be claimed')
  expect(
    await failure(instance =>
      instance.createJob(saved.id, 'sync', crypto.randomUUID()),
    ),
  ).toContain('active task')
})
it('stores immutable snapshots and advances the baseline only for successful sync', async () => {
  mockGithub()
  const saved = project()
  await seed(`project:${saved.id}`, saved)
  const job = await account().createJob(saved.id, 'sync', crypto.randomUUID())
  await account().claim(job.id, identity, 'sync')
  const snapshot = await account().saveSnapshot(job.id, identity, content())
  expect(snapshot.iconCount).toBe(1)
  expect(
    (await account().saveSnapshot(job.id, identity, content())).digest,
  ).toBe(snapshot.digest)
  expect(
    await failure(instance =>
      instance.saveSnapshot(job.id, identity, {
        ...content(),
        failed: ['bad'],
      }),
    ),
  ).toContain('immutable')
  expect((await account().state()).projects[0]?.snapshotId).toBe(snapshot.id)
  const check = await account().createJob(
    saved.id,
    'dry-run',
    crypto.randomUUID(),
  )
  await account().claim(check.id, identity, 'dry-run')
  const dry = await account().saveSnapshot(check.id, identity, content())
  expect((await account().state()).projects[0]?.snapshotId).toBe(snapshot.id)
  expect(
    await failure(instance =>
      instance.confirmRelease(saved.id, dry.id, 'minor'),
    ),
  ).toContain('not publishable')
})
it('a failed validation snapshot cannot be released or replace the baseline', async () => {
  mockGithub()
  const saved = project()
  await seed(`project:${saved.id}`, saved)
  const job = await account().createJob(saved.id, 'sync', crypto.randomUUID())
  await account().claim(job.id, identity, 'sync')
  const snapshot = await account().saveSnapshot(job.id, identity, {
    ...content(),
    issues: [{ name: 'arrow', message: 'Invalid width' }],
  })
  expect((await account().state()).projects[0]?.snapshotId).toBeUndefined()
  expect(
    await failure(instance =>
      instance.confirmRelease(saved.id, snapshot.id, 'patch'),
    ),
  ).toContain('not publishable')
})
it('confirms the initial target version and invalidates stale project configuration', async () => {
  mockGithub()
  const saved = project()
  await seed(`project:${saved.id}`, saved)
  const job = await account().createJob(saved.id, 'sync', crypto.randomUUID())
  await account().claim(job.id, identity, 'sync')
  const snapshot = await account().saveSnapshot(job.id, identity, content())
  const confirmation = await account().confirmRelease(
    saved.id,
    snapshot.id,
    'major',
  )
  expect(confirmation.release.version).toBe('0.1.0')
  expect(confirmation.release.digest).toBe(snapshot.digest)
  await seed(`project:${saved.id}`, { ...saved, revision: 2 })
  expect(
    await failure(instance =>
      instance.createJob(
        saved.id,
        'publish',
        crypto.randomUUID(),
        confirmation.id,
      ),
    ),
  ).toContain('stale')
})
it('plugin pairing is scoped, revocable, and never grants publication', async () => {
  mockGithub()
  const one = project()
  const two = { ...project(), name: 'second' }
  await seed(`project:${one.id}`, one)
  await seed(`project:${two.id}`, two)
  const pair = await account().startPairing()
  expect((await account().pollPairing(pair.id, pair.pollToken)).pending).toBe(
    true,
  )
  expect(
    await failure(instance => instance.pollPairing(pair.id, 'wrong')),
  ).toContain('Invalid')
  await account().approvePairing(pair.code, one.id, 'Figma')
  const device = await account().pollPairing(pair.id, pair.pollToken)
  expect(device.pending).toBe(false)
  const credential = device as { token: string, deviceId: string }
  const job = await account().deviceJob(
    credential.deviceId,
    credential.token,
    crypto.randomUUID(),
  )
  expect(job.projectId).toBe(one.id)
  expect(job.operation).toBe('sync')
  const other = await account().createJob(two.id, 'sync', crypto.randomUUID())
  expect(
    await failure(instance =>
      instance.deviceStatus(credential.deviceId, credential.token, other.id),
    ),
  ).toContain('outside plugin scope')
  await account().revokeDevice(credential.deviceId)
  expect(
    await failure(instance =>
      instance.deviceJob(
        credential.deviceId,
        credential.token,
        crypto.randomUUID(),
      ),
    ),
  ).toContain('not found')
})
it('encrypts backups and excludes login and OAuth secrets from exported rows', async () => {
  await account().newSession(OWNER_ID)
  await account().saveOAuth('state', {
    browser: 'browser',
    provider: 'github',
    verifier: 'pkce',
    expiresAt: Date.now() + 10000,
  })
  const backup = await account().backup()
  expect(backup).toMatch(/^v1\./)
  expect(backup).not.toContain('pkce')
})
it('restores encrypted records without reviving sessions, plugins or stale rotating tokens', async () => {
  const saved = project()
  const rows = [
    { key: `project:${saved.id}`, value: JSON.stringify(saved) },
    { key: 'connection:old', value: JSON.stringify({ type: 'figma', refreshing: true }) },
    { key: 'job:old', value: JSON.stringify({ status: 'running' }) },
    { key: 'session:old', value: '{}' },
    { key: 'device:old', value: '{}' },
  ]
  const backup = await encrypt(env.CREDENTIAL_ENCRYPTION_KEY, 'iconctl-backup-v1', { schema: 1, rows })
  expect(await account().restore(backup)).toEqual({ restored: 3 })
  expect(await read('connection:old')).toMatchObject({ reconnect: true, refreshing: false })
  expect(await read('job:old')).toMatchObject({ status: 'failed', error: 'restored-reconcile-before-retry' })
  expect((await account().state()).devices).toEqual([])
  expect(await account().session('old')).toBeNull()
  expect(await failure(instance => instance.restore(backup))).toContain('empty account')
})
it('recovers a prepared commit after a lost ref update without creating another commit', async () => {
  const saved = project()
  const snapshotId = crypto.randomUUID()
  const jobId = crypto.randomUUID()
  const snapshotContent = content()
  const json = JSON.stringify(snapshotContent.json)
  snapshotContent.files = {
    'icons.json': base64(new TextEncoder().encode(json)),
  }
  const document = JSON.stringify(snapshotContent)
  const hash = await digest(document)
  await env.ARTIFACTS.put(`snapshots/${snapshotId}/${hash}`, document)
  await seed(`snapshot:${snapshotId}`, {
    id: snapshotId,
    digest: hash,
    projectId: saved.id,
    jobId: snapshotId,
    createdAt: Date.now(),
    iconCount: 1,
    issues: 0,
  })
  await seed(`project:${saved.id}`, saved)
  const tarball = new Uint8Array(new TextEncoder().encode('fixed-tarball'))
    .buffer
  const integrity = `sha512-${base64(new Uint8Array(await crypto.subtle.digest('SHA-512', tarball)))}`
  const job: Job = {
    id: jobId,
    projectId: saved.id,
    project: saved,
    operation: 'publish',
    status: 'running',
    sourceCommit: sha,
    workflowCommit: sha,
    executorCommit: sha,
    workflowDigest: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dispatchAttempts: 1,
    attempt: 1,
    stage: 'packing',
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    integrity,
    releaseCommit: 'b'.repeat(40),
    release: {
      snapshotId,
      digest: hash,
      version: '0.1.0',
      branchHead: null,
      confirmation: crypto.randomUUID(),
    },
  }
  await seed(`job:${jobId}`, job)
  const fetch = mockGithub()
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    if (url.pathname.endsWith('/git/refs') && init?.method === 'POST') {
      return Response.json({ ref: 'refs/heads/iconctl/icons' })
    }
    return new Response(null, { status: 404 })
  })
  const files = {
    ...snapshotContent.files,
    'package.json': btoa(
      JSON.stringify({ name: saved.packageName, version: '0.1.0' }),
    ),
  }
  const result = await account().prepareRelease(
    jobId,
    identity,
    integrity,
    tarball,
    files,
  )
  expect(result.commit).toBe('b'.repeat(40))
  expect(
    fetch.mock.calls.some(([input]) => String(input).endsWith('/git/commits')),
  ).toBe(false)
  expect(
    fetch.mock.calls.some(([input]) => String(input).endsWith('/git/refs')),
  ).toBe(true)
  expect((await read<Job>(`job:${jobId}`)).integrity).toBe(integrity)
  // npm succeeded but its completion callback was lost. Reconcile from registry
  // integrity and create the release record without another publish operation.
  fetch.mockImplementation(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'registry.npmjs.org') {
      return Response.json({ dist: { integrity } })
    }
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    if (url.pathname.includes('/git/ref/heads/')) {
      return Response.json({ object: { sha: job.releaseCommit } })
    }
    return Response.json({})
  })
  expect(await account().finishRelease(jobId)).toBe(true)
  expect(await account().finishRelease(jobId)).toBe(true)
  expect((await account().state()).releases).toHaveLength(1)
  expect((await read<Job>(`job:${jobId}`)).status).toBe('succeeded')
})

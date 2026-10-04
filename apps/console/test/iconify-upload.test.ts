import type { Job, Project, Source } from '@iconctl/console-contracts'
import { MAX_UPLOAD_BYTES, OWNER_ID, projectInput } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, expect, it, vi } from 'vitest'
import { digest } from '../worker/security'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const bytes = (value = '{"prefix":"vendor","icons":{}}') => new Uint8Array(new TextEncoder().encode(value)).buffer
const sha = 'a'.repeat(40)
const identity = { runId: '1234', runAttempt: '1', repositoryId: '123', workflowRef: 'owner/repo/.github/workflows/iconctl-console.yml@refs/heads/main', sha, ref: 'refs/heads/main' }
const input = (sources: Source[]) => projectInput.parse({ name: 'icons', prefix: 'brand', packageName: '@test/icons', repository: 'owner/repo', sources })
function github() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    const path = new URL(String(request)).pathname
    if (path.endsWith('/installation')) {
      return Response.json({ id: 1, permissions: { contents: 'write', actions: 'write', pull_requests: 'write', workflows: 'write' } })
    }
    if (path.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    return Response.json({ id: 123, default_branch: 'main' })
  })
}
async function headers() {
  const session = await account().newSession(OWNER_ID)
  return { 'Cookie': `__Host-iconctl-session=${session.token}`, 'Origin': env.APP_ORIGIN, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }
}
function task(project: Project, operation: Job['operation'] = 'sync'): Job {
  return { id: crypto.randomUUID(), projectId: project.id, project, operation, status: 'running', sourceCommit: sha, workflowCommit: sha, executorCommit: sha, workflowDigest: '', createdAt: 1, updatedAt: 1, dispatchAttempts: 1, attempt: 1, stage: 'fetching', runId: identity.runId, runAttempt: identity.runAttempt }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('uploads authenticated JSON with original BOM bytes, saves a source and preserves its exact include contract', async () => {
  github()
  const body = bytes('\uFEFF{"prefix":" Vendor_1","icons":{"raw-name":null},"aliases":{"broken":{"parent":"absent"}},"info":{"name":"metadata"}}')
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/uploads?kind=iconify-json`, { method: 'POST', headers: await headers(), body })
  expect(response.status).toBe(201)
  const upload = await response.json<{ id: string, digest: string }>()
  expect(upload.digest).toBe(await digest(body))
  expect(await (await env.ARTIFACTS.get(`uploads/${upload.id}`))!.arrayBuffer()).toEqual(body)
  const project = await account().saveProject(input([{ type: 'iconify', upload: upload.id, include: [], namePrefix: ' x_' }]))
  expect(project.sources).toEqual([{ type: 'iconify', upload: upload.id, include: [], namePrefix: ' x_' }])
  expect((await account().state()).projects[0]!.sources).toEqual(project.sources)
})

it.each([
  ['?kind=unknown', bytes(), 400],
  ['?kind=iconify-json', bytes('not json'), 400],
  ['?kind=iconify-json', new Uint8Array([0xFF]).buffer, 400],
  ['?kind=iconify-json', bytes('{"prefix":"x","icons":[]}'), 400],
  ['?kind=iconify-json', bytes(' '.repeat(MAX_UPLOAD_BYTES + 1)), 413],
] as const)('rejects invalid upload transport %s before storing metadata', async (query, body, status) => {
  const response = await exports.default.fetch(`${env.APP_ORIGIN}/api/uploads${query}`, { method: 'POST', headers: await headers(), body })
  expect(response.status).toBe(status)
  expect(await runInDurableObject(account(), (_instance, state) => state.storage.sql.exec('SELECT key FROM records WHERE key LIKE ?', 'upload:%').toArray())).toEqual([])
})

it('accepts exactly the raw byte limit and keeps legacy ZIP format readable', async () => {
  const document = bytes()
  const body = new Uint8Array(MAX_UPLOAD_BYTES).fill(32)
  body.set(new Uint8Array(document))
  const upload = await account().saveUpload(body.buffer, 'iconify-json')
  expect((await env.ARTIFACTS.head(`uploads/${upload.id}`))!.size).toBe(MAX_UPLOAD_BYTES)
  const zip = await account().saveUpload(bytes('legacy zip bytes'))
  github()
  await runInDurableObject(account(), async (_instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `upload:${zip.id}`, JSON.stringify({ ...zip, bytes: 16 }))
  })
  const project = await account().saveProject(input([{ type: 'directory', dir: 'svg', upload: zip.id }]))
  const job = task(project)
  const result = await runInDurableObject(account(), (instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `job:${job.id}`, JSON.stringify(job))
    return instance.uploadAllowed(job.id, identity, zip.id)
  })
  expect(result.kind).toBe('svg-zip')
})

it('does not publish metadata when R2 put fails', async () => {
  await runInDurableObject(account(), async (instance, state) => {
    vi.spyOn(env.ARTIFACTS, 'put').mockRejectedValueOnce(new Error('R2 interrupted'))
    await expect(instance.saveUpload(bytes(), 'iconify-json')).rejects.toThrow('R2 interrupted')
    expect(state.storage.sql.exec('SELECT key FROM records WHERE key LIKE ?', 'upload:%').toArray()).toEqual([])
  })
})

it.each(['missing', 'zip', 'wrong-id', 'unknown-kind', 'null-kind', 'missing-object', 'size'] as const)('rejects an unavailable JSON reference: %s', async (problem) => {
  github()
  const upload = await account().saveUpload(bytes(), problem === 'zip' ? 'svg-zip' : 'iconify-json')
  await runInDurableObject(account(), async (_instance, state) => {
    if (problem === 'missing') {
      state.storage.sql.exec('DELETE FROM records WHERE key = ?', `upload:${upload.id}`)
    }
    if (problem === 'wrong-id' || problem === 'unknown-kind' || problem === 'null-kind') {
      state.storage.sql.exec('UPDATE records SET value = ? WHERE key = ?', JSON.stringify({ ...upload, bytes: bytes().byteLength, kind: problem === 'null-kind' ? null : problem === 'unknown-kind' ? 'unknown' : 'iconify-json', id: problem === 'wrong-id' ? crypto.randomUUID() : upload.id }), `upload:${upload.id}`)
    }
    if (problem === 'missing-object') {
      await env.ARTIFACTS.delete(`uploads/${upload.id}`)
    }
    if (problem === 'size') {
      await env.ARTIFACTS.put(`uploads/${upload.id}`, '{}')
    }
  })
  await runInDurableObject(account(), async (instance) => {
    await expect(instance.saveProject(input([{ type: 'iconify', upload: upload.id }]))).rejects.toThrow(/upload|Upload/)
  })
  expect((await account().state()).projects).toEqual([])
})

it('rejects JSON uploads referenced as SVG ZIP sources', async () => {
  const upload = await account().saveUpload(bytes(), 'iconify-json')
  for (const type of ['directory', 'jsdesign'] as const) {
    await runInDurableObject(account(), async (instance) => {
      await expect(instance.saveProject(input([{ type, dir: 'svg', upload: upload.id }]))).rejects.toThrow('format does not match')
    })
  }
})

it.each(['revision', 'active', 'metadata'] as const)('rechecks %s after asynchronous R2 head', async (change) => {
  github()
  const upload = await account().saveUpload(bytes(), 'iconify-json')
  const project = await account().saveProject(input([{ type: 'iconify', upload: upload.id }]))
  await runInDurableObject(account(), async (instance, state) => {
    const head = env.ARTIFACTS.head.bind(env.ARTIFACTS)
    vi.spyOn(env.ARTIFACTS, 'head').mockImplementationOnce(async (...args) => {
      const object = await head(...args)
      const key = change === 'metadata' ? `upload:${upload.id}` : change === 'revision' ? `project:${project.id}` : `job:active`
      const value = change === 'metadata' ? { ...upload, digest: 'b'.repeat(64), bytes: bytes().byteLength, kind: 'iconify-json' } : change === 'revision' ? { ...project, revision: 2 } : task(project)
      state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', key, JSON.stringify(value))
      return object
    })
    await expect(instance.saveProject(input(project.sources), project.id, 1)).rejects.toThrow(change === 'metadata' ? 'Upload changed' : 'Project changed')
  })
})

it('authorizes only frozen source uploads, denies publishing, and retains old task input after replacement', async () => {
  github()
  const upload = await account().saveUpload(bytes(), 'iconify-json')
  const next = await account().saveUpload(bytes('{"prefix":"next","icons":{}}'), 'iconify-json')
  const project = await account().saveProject(input([{ type: 'iconify', upload: upload.id }]))
  const job = { ...task(project), status: 'failed' as const }
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `job:${job.id}`, JSON.stringify(job))
  })
  const updated = await account().saveProject(input([{ type: 'iconify', upload: next.id }]), project.id, 1)
  expect(updated.revision).toBe(2)
  await runInDurableObject(account(), async (instance) => {
    await expect(instance.retry(job.id)).rejects.toThrow(/changed|new task/i)
  })
  await runInDurableObject(account(), (instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `job:${job.id}`, JSON.stringify({ ...job, status: 'running' }))
    expect(instance.uploadAllowed(job.id, identity, upload.id).kind).toBe('iconify-json')
    expect(() => instance.uploadAllowed(job.id, identity, next.id)).toThrow('outside task scope')
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `job:${job.id}`, JSON.stringify({ ...job, status: 'running', operation: 'publish' }))
    expect(() => instance.uploadAllowed(job.id, identity, upload.id)).toThrow('outside task scope')
  })
})

it('requires the current session and CSRF token for JSON uploads', async () => {
  const endpoint = `${env.APP_ORIGIN}/api/uploads?kind=iconify-json`
  const unauthenticated = await exports.default.fetch(endpoint, { method: 'POST', body: bytes() })
  expect(unauthenticated.status).toBe(401)
  const authenticated = await headers()
  const csrf = await exports.default.fetch(endpoint, { method: 'POST', headers: { ...authenticated, 'X-CSRF-Token': 'wrong' }, body: bytes() })
  expect(csrf.status).toBe(403)
  expect(await runInDurableObject(account(), (_instance, state) => state.storage.sql.exec('SELECT key FROM records WHERE key LIKE ?', 'upload:%').toArray())).toEqual([])
})

it('keeps project configuration when R2 availability cannot be checked', async () => {
  github()
  const upload = await account().saveUpload(bytes(), 'iconify-json')
  await runInDurableObject(account(), async (instance) => {
    vi.spyOn(env.ARTIFACTS, 'head').mockRejectedValueOnce(new Error('private R2 error'))
    await expect(instance.saveProject(input([{ type: 'iconify', upload: upload.id }]))).rejects.toThrow('Cannot verify Iconify JSON upload; try again or upload the file again and save')
    expect(instance.state().projects).toEqual([])
  })
})

it('serves original upload bytes and stored MIME through the signed runner endpoint', async () => {
  const json = await account().saveUpload(bytes(), 'iconify-json')
  const zip = await account().saveUpload(bytes('zip bytes'))
  const project: Project = { ...input([{ type: 'iconify', upload: json.id }, { type: 'directory', dir: 'svg', upload: zip.id }]), id: crypto.randomUUID(), revision: 1, createdAt: 1, repositoryInfo: { id: 123, installationId: 1, defaultBranch: 'main' } }
  const job = task(project)
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT OR REPLACE INTO records(key,value) VALUES (?,?)', `job:${job.id}`, JSON.stringify(job))
    // The old metadata shape still yields the legacy ZIP media type.
    state.storage.sql.exec('UPDATE records SET value = ? WHERE key = ?', JSON.stringify({ ...zip, bytes: 9 }), `upload:${zip.id}`)
  })
  const pair = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'upload-actions', alg: 'RS256' }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    const url = String(request)
    if (url.includes('/.well-known/jwks')) {
      return Response.json({ keys: [jwk] })
    }
    if (url.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    return Response.json({ display_title: `iconctl-${job.id}-1`, head_sha: sha, event: 'workflow_dispatch', path: '.github/workflows/iconctl-console.yml' })
  })
  const token = await new SignJWT({ repository_id: '123', repository: 'owner/repo', ref: identity.ref, workflow_ref: identity.workflowRef, sha, event_name: 'workflow_dispatch', runner_environment: 'github-hosted', run_id: identity.runId, run_attempt: identity.runAttempt })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(env.APP_ORIGIN)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey)
  const request = (id: string) => exports.default.fetch(`${env.APP_ORIGIN}/api/runner/${job.id}/uploads/${id}`, { headers: { Authorization: `Bearer ${token}` } })
  for (const [upload, mime, expected] of [[json, 'application/json', bytes()], [zip, 'application/zip', bytes('zip bytes')]] as const) {
    const response = await request(upload.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(mime)
    expect(response.headers.get('X-Content-SHA256')).toBe(upload.digest)
    expect(await response.arrayBuffer()).toEqual(expected)
  }
  expect((await request(crypto.randomUUID())).status).toBe(403)
  await env.ARTIFACTS.delete(`uploads/${json.id}`)
  expect((await request(json.id)).status).toBe(404)
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('UPDATE records SET value = ? WHERE key = ?', JSON.stringify({ ...job, operation: 'publish' }), `job:${job.id}`)
  })
  expect((await request(zip.id)).status).toBe(403)
})

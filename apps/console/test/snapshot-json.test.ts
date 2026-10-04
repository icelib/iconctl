import type { Snapshot, SnapshotContent } from '@iconctl/console-contracts'
import { MAX_ARTIFACT_BYTES, OWNER_ID } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { digest } from '../worker/security'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const collection = {
  prefix: 'reviewed',
  width: 24,
  height: 32,
  icons: { arrow: { body: '<path id="<&雪"/>', width: 48, height: 16, custom: { tags: ['one'] } } },
  aliases: { copy: { parent: 'arrow', rotate: 1 } },
  info: { name: 'Collection', author: { name: 'Designer' } },
  metadata: { retained: true },
}
const content: SnapshotContent = { json: collection, files: {}, issues: [], failed: [], sources: [] }
async function stored(document = JSON.stringify(content), metadata: Partial<Snapshot> = {}) {
  const snapshot: Snapshot = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), jobId: crypto.randomUUID(), createdAt: 1, digest: await digest(document), iconCount: 1, issues: 0, attempt: 1, ...metadata }
  await env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, document)
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT INTO records(key,value) VALUES (?,?)', `snapshot:${snapshot.id}`, JSON.stringify(snapshot))
  })
  return snapshot
}
async function owner() {
  const session = await account().newSession(OWNER_ID)
  return { session, headers: { Cookie: `__Host-iconctl-session=${session.token}` } }
}
const request = (id: string, headers: HeadersInit = {}) => exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${id}/icons.json`, { headers })
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('exports precisely the stored collection with metadata and keeps legacy artifact bytes unchanged', async () => {
  const legacyBytes = '  { "prefix": "different", "icons": {} }\n'
  const snapshot = await stored(JSON.stringify({ ...content, files: { 'icons.json': btoa(legacyBytes) } }))
  const { headers } = await owner()
  const before = await account().state()
  const objectsBefore = await env.ARTIFACTS.list()
  const outgoing = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'))
  const response = await request(snapshot.id, headers)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="iconctl-icons-${snapshot.id}-${snapshot.digest.slice(0, 12)}.json"`)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(response.headers.get('Content-Security-Policy')).toBe('sandbox; default-src \'none\'')
  expect(await response.json()).toEqual(collection)
  const legacy = await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${snapshot.id}/files/icons.json`, { headers })
  expect(await legacy.text()).toBe(legacyBytes)
  expect(await account().state()).toEqual(before)
  expect(await env.ARTIFACTS.list()).toEqual(objectsBefore)
  expect(outgoing).not.toHaveBeenCalled()
})

it.each(['check', 'dry-run', 'failed-old-attempt', 'legacy-attempt', 'empty'])('exports a %s collection without generated files or new task state', async (kind) => {
  const saved = {
    ...content,
    ...(kind === 'empty' ? { json: { prefix: 'empty', icons: {} } } : {}),
    ...(kind === 'failed-old-attempt' ? { issues: [{ name: 'failed-icon', message: 'Could not download', stage: 'source' }], failed: ['failed-icon'] } : {}),
  }
  const snapshot = await stored(JSON.stringify(saved), { attempt: kind === 'legacy-attempt' ? undefined : 1, issues: saved.issues.length })
  if (kind === 'failed-old-attempt') {
    // A newer result must never replace the requested older immutable collection.
    await stored(JSON.stringify({ ...content, json: { prefix: 'newer', icons: {} } }), { projectId: snapshot.projectId, jobId: snapshot.jobId, attempt: 2 })
  }
  const { headers } = await owner()
  const before = await account().state()
  const response = await request(snapshot.id, headers)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(saved.json)
  expect(await account().snapshotContent(snapshot.id)).toEqual(saved)
  expect(await account().state()).toEqual(before)
})

it('requires a live owner session rather than a runner or device token', async () => {
  const snapshot = await stored()
  expect((await request(snapshot.id)).status).toBe(401)
  expect((await request(snapshot.id, { Authorization: 'Bearer runner-or-device' })).status).toBe(401)
  const { session, headers } = await owner()
  await account().logout(await digest(session.token))
  expect((await request(snapshot.id, headers)).status).toBe(401)
})

it('rejects invalid identifiers, absent metadata/object and invalid or mismatched digests', async () => {
  const { headers } = await owner()
  expect((await request('bad', headers)).status).toBe(400)
  expect((await request(crypto.randomUUID(), headers)).status).toBe(404)
  const invalid = await stored(undefined, { digest: 'invalid' })
  expect((await request(invalid.id, headers)).status).toBe(409)
  const snapshot = await stored()
  const key = `snapshots/${snapshot.id}/${snapshot.digest}`
  await env.ARTIFACTS.delete(key)
  expect((await request(snapshot.id, headers)).status).toBe(404)
  await env.ARTIFACTS.put(key, '{}')
  expect((await request(snapshot.id, headers)).status).toBe(409)
})

it.each(['private-invalid-json', 'null', '{}', '{"json":{"prefix":"test","icons":{"bad":{"body":1}}}}'])('rejects matching-digest corrupt documents without reflecting data: %s', async (document) => {
  const snapshot = await stored(document)
  const { headers } = await owner()
  const response = await request(snapshot.id, headers)
  expect(response.status).toBe(409)
  expect(response.headers.has('Content-Disposition')).toBe(false)
  expect(await response.json()).toEqual({ error: document === 'private-invalid-json' ? 'Snapshot document is invalid JSON' : 'Snapshot icon collection is invalid' })
})

it('accepts the 25 MiB document boundary and rejects one byte over without lowering normal artifact limits', async () => {
  const { headers } = await owner()
  const base = JSON.stringify({ ...content, json: { prefix: 'large', icons: {}, metadata: '' } })
  const padded = base.replace('"metadata":""', `"metadata":"${'x'.repeat(MAX_ARTIFACT_BYTES - base.length)}"`)
  expect(new TextEncoder().encode(padded).length).toBe(MAX_ARTIFACT_BYTES)
  const exact = await stored(padded)
  const response = await request(exact.id, headers)
  expect(response.status).toBe(200)
  const result = await response.json<{ metadata: string }>()
  expect(result.metadata.length).toBe(MAX_ARTIFACT_BYTES - base.length)
  const over = await stored(`${padded} `)
  const rejected = await request(over.id, headers)
  expect(rejected.status).toBe(413)
  expect(rejected.headers.has('Content-Disposition')).toBe(false)
  expect(await rejected.json()).toEqual({ error: 'Snapshot exceeds the document limit' })
})

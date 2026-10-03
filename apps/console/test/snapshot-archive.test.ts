import type { Snapshot, SnapshotContent } from '@iconctl/console-contracts'
import { OWNER_ID } from '@iconctl/console-contracts'
import { reset, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { unzipSync } from 'fflate/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { digest } from '../worker/security'
import { MAX_SVG_ARCHIVE_DOCUMENT_BYTES } from '../worker/svg-archive'

const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
async function stored(files: SnapshotContent['files'], extra: Partial<SnapshotContent> = {}) {
  const content: SnapshotContent = { json: { prefix: 'test', icons: { arrow: { body: '<path/>' } } }, files, issues: [], failed: [], sources: [], ...extra }
  const document = JSON.stringify(content)
  const snapshot: Snapshot = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), jobId: crypto.randomUUID(), createdAt: 1, digest: await digest(document), iconCount: 1, issues: content.issues.length, attempt: 1 }
  await env.ARTIFACTS.put(`snapshots/${snapshot.id}/${snapshot.digest}`, document)
  await runInDurableObject(account(), (_instance, state) => {
    state.storage.sql.exec('INSERT INTO records(key,value) VALUES (?,?)', `snapshot:${snapshot.id}`, JSON.stringify(snapshot))
  })
  return { content, document, snapshot }
}
async function owner() {
  const session = await account().newSession(OWNER_ID)
  return { session, headers: { Cookie: `__Host-iconctl-session=${session.token}` } }
}
const request = (id: string, headers: HeadersInit = {}) => exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${id}/svg.zip`, { headers })
afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

it('downloads only the immutable stored SVG set through session, DO metadata and R2 digest verification', async () => {
  const { snapshot, content } = await stored({ 'svg/arrow.svg': btoa('<svg>A</svg>'), 'svg/nested/con.SVG': btoa('\x00\xFF'), 'icons.json': btoa('{}'), 'preview.html': btoa('<script/>') }, { issues: [{ name: 'bad', message: 'validation failed' }], failed: ['bad'] })
  const { headers } = await owner()
  const before = await account().state()
  const outgoing = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'))
  const response = await request(snapshot.id, headers)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/zip')
  expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="iconctl-svg-${snapshot.id}-${snapshot.digest.slice(0, 12)}.zip"`)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(response.headers.get('Content-Security-Policy')).toBe('sandbox; default-src \'none\'')
  const first = new Uint8Array(await response.arrayBuffer())
  const files = unzipSync(first)
  expect(Object.keys(files)).toEqual(['svg/arrow.svg', 'svg/nested/con.SVG'])
  expect(Array.from(files['svg/nested/con.SVG']!)).toEqual([0, 255])
  expect(new TextDecoder().decode(files['svg/arrow.svg'])).toBe(atob(content.files['svg/arrow.svg']!))
  expect(new Uint8Array(await (await request(snapshot.id, headers)).arrayBuffer())).toEqual(first)
  expect(await account().state()).toEqual(before)
  expect(outgoing).not.toHaveBeenCalled()
})

it('requires a live owner session even when the snapshot ID is known', async () => {
  const { snapshot } = await stored({ 'svg/a.svg': '' })
  expect((await request(snapshot.id)).status).toBe(401)
  expect((await request(snapshot.id, { Authorization: 'Bearer runner-or-plugin' })).status).toBe(401)
  const { session, headers } = await owner()
  await account().logout(await digest(session.token))
  expect((await request(snapshot.id, headers)).status).toBe(401)
})

it('fails closed for invalid UUID, missing metadata/object and corrupt content', async () => {
  const { headers } = await owner()
  expect((await request('bad', headers)).status).toBe(400)
  expect((await request(crypto.randomUUID(), headers)).status).toBe(404)
  const { snapshot } = await stored({ 'svg/a.svg': '' })
  const key = `snapshots/${snapshot.id}/${snapshot.digest}`
  await env.ARTIFACTS.delete(key)
  expect((await request(snapshot.id, headers)).status).toBe(404)
  await env.ARTIFACTS.put(key, '{}')
  expect((await request(snapshot.id, headers)).status).toBe(409)
})

it.each<Record<string, string>>([{}, { 'icons.json': btoa('{}') }])('does not synthesize SVG files for absent stored artifacts: %j', async (files) => {
  const { snapshot } = await stored(files)
  const { headers } = await owner()
  expect((await request(snapshot.id, headers)).status).toBe(404)
})

it.each<Record<string, string>>([{ 'svg/../bad.svg': '' }, { 'svg/a.svg': 'AB==' }, { 'svg/a.svg': '', 'svg/a.svg/b.svg': '' }])('rejects unsuitable stored members before sending an archive: %j', async (files) => {
  const { snapshot } = await stored(files)
  const { headers } = await owner()
  const response = await request(snapshot.id, headers)
  expect(response.status).toBe(409)
  expect(response.headers.get('Content-Type')).toContain('application/json')
})

it('caps the whole export document while preserving the existing individual download and snapshot reader', async () => {
  const { snapshot, content } = await stored({ 'svg/a.svg': btoa('<svg/>') }, { json: { prefix: 'test', icons: {}, metadata: 'x'.repeat(MAX_SVG_ARCHIVE_DOCUMENT_BYTES) } } as Partial<SnapshotContent>)
  const { headers } = await owner()
  expect((await request(snapshot.id, headers)).status).toBe(413)
  const file = await exports.default.fetch(`${env.APP_ORIGIN}/api/snapshots/${snapshot.id}/files/svg/a.svg`, { headers })
  expect(file.status).toBe(200)
  expect(await file.text()).toBe('<svg/>')
  expect(await account().snapshotContent(snapshot.id)).toEqual(content)
})

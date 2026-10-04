import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_UPLOAD_BYTES } from '@iconctl/console-contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { materializeIconifyUpload, sha256 } from '../src/files'
import { classifyFailure } from '../src/index'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, open: vi.fn(actual.open) }
})
const { readFile, mkdtemp, rm, writeFile } = filesystem
let root: string
let destination: string
const bytes = new TextEncoder().encode('{"prefix":"x","icons":{}}')
const headers = { 'Content-Type': 'application/json', 'X-Content-SHA256': sha256(bytes) }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'iconctl-upload-'))
  destination = join(root, 'iconify-0.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('writes verified bytes exclusively and does not remove an existing target', async () => {
  await materializeIconifyUpload(new Response(bytes, { headers }), destination)
  expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
  await expect(materializeIconifyUpload(new Response(bytes, { headers }), destination)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
})

it.each([
  ['MIME', { ...headers, 'Content-Type': 'application/zip' }, bytes, 'configuration'],
  ['digest', { ...headers, 'X-Content-SHA256': '0'.repeat(64) }, bytes, 'conflict'],
  ['truncated', headers, bytes.subarray(0, 10), 'conflict'],
  ['format', { ...headers, 'X-Content-SHA256': sha256('no') }, new TextEncoder().encode('no'), 'configuration'],
  ['advertised size', { ...headers, 'Content-Length': String(MAX_UPLOAD_BYTES + 1) }, bytes, 'configuration'],
] as const)('rejects %s before creating a file', async (_name, responseHeaders, body, category) => {
  const failure = await materializeIconifyUpload(new Response(body, { headers: responseHeaders }), destination).catch(error => error)
  expect(classifyFailure(failure)).toBe(category)
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([undefined, '1'])('cancels over-limit chunks with Content-Length %s without retaining a partial file', async (length) => {
  const cancel = vi.fn(() => {
    throw new Error('cancel rejected')
  })
  let calls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(calls++ === 0 ? MAX_UPLOAD_BYTES : 1))
    },
    cancel,
  }, { highWaterMark: 0 })
  const response = new Response(stream, { headers: { ...headers, ...(length ? { 'Content-Length': length } : {}) } })
  const failure = await materializeIconifyUpload(response, destination).catch(error => error)
  expect(failure.message).toContain('10 MiB')
  expect(classifyFailure(failure)).toBe('configuration')
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(calls).toBe(2)
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps the MIME failure when cancellation also rejects', async () => {
  const cancel = vi.fn(() => {
    throw new Error('cancel rejected')
  })
  const stream = new ReadableStream<Uint8Array>({ cancel })
  await expect(materializeIconifyUpload(new Response(stream, { headers: { 'Content-Type': 'text/plain' } }), destination)).rejects.toThrow('content type')
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('keeps an interrupted R2 stream retryable and does not write partial JSON', async () => {
  let calls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (calls++ === 0) {
        controller.enqueue(bytes.subarray(0, 10))
      }
      else {
        controller.error(new Error('R2 source stream interrupted'))
      }
    },
  }, { highWaterMark: 0 })
  const failure = await materializeIconifyUpload(new Response(stream, { headers }), destination).catch(error => error)
  expect(classifyFailure(failure)).toBe('runner')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts exactly the byte limit with omitted Content-Length', async () => {
  const body = new Uint8Array(MAX_UPLOAD_BYTES).fill(32)
  body.set(bytes)
  await materializeIconifyUpload(new Response(body, { headers: { ...headers, 'X-Content-SHA256': sha256(body) } }), destination)
  expect((await readFile(destination)).byteLength).toBe(MAX_UPLOAD_BYTES)
})

it('does not use response filename or prefix as an output path', async () => {
  const body = '{"prefix":"../../outside","icons":{}}'
  await writeFile(join(root, 'unrelated'), 'keep')
  await materializeIconifyUpload(new Response(body, { headers: { ...headers, 'X-Content-SHA256': sha256(body), 'Content-Disposition': 'attachment; filename="../../outside.json"' } }), destination)
  expect(await readFile(destination, 'utf8')).toBe(body)
  expect(await readFile(join(root, 'unrelated'), 'utf8')).toBe('keep')
})

it.each(['write', 'close'] as const)('removes its own input when file %s fails and preserves the original failure', async (stage) => {
  const { open: originalOpen } = await vi.importActual<typeof filesystem>('node:fs/promises')
  const failure = new Error(`${stage} failed`)
  const open = vi.mocked(filesystem.open).mockClear().mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args)
    if (stage === 'write') {
      const write = file.writeFile.bind(file)
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
        await write('partial')
        throw failure
      })
    }
    else {
      vi.spyOn(file, 'close').mockRejectedValueOnce(failure)
    }
    return file
  })
  await expect(materializeIconifyUpload(new Response(bytes, { headers }), destination)).rejects.toBe(failure)
  expect(open).toHaveBeenCalledTimes(1)
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

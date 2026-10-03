import type { Source } from '@iconctl/console-contracts'
import { expect, it, vi } from 'vitest'
import { createSourceUpload } from '../src/features/projects/source-upload'

const source = (dir = 'raw', upload?: string): Extract<Source, { type: 'directory' }> => ({ type: 'directory', dir, ...(upload ? { upload } : {}) })
const file = (name = 'a.zip') => new File([name], name, { type: 'application/zip' })
function sourceFactory() {
  return source('surviving-directory')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  const context = { session: 1, sources: [source('raw', 'previous-upload')] }
  const request = deferred<string>()
  const upload = vi.fn<(_file: File, _signal: AbortSignal) => Promise<string>>(() => request.promise)
  const uploads = createSourceUpload({ sources: () => context.sources, session: () => context.session, upload })
  return { context, source: context.sources[0]!, uploads, upload, request }
}

it('attaches the returned ID only after success and defaults an unchanged directory to the ZIP root', async () => {
  const { uploads, upload, source, request } = setup()
  const selected = file()
  const work = uploads.start(source, selected)
  expect(upload.mock.calls[0]?.[0]).toBe(selected)
  expect(source).toMatchObject({ dir: 'raw', upload: 'previous-upload' })
  expect(uploads.get(source)).toMatchObject({ phase: 'pending', fileName: 'a.zip' })
  request.resolve('uploaded-a')
  expect(await work).toBe('uploaded')
  expect(source).toMatchObject({ dir: 'svg', upload: 'uploaded-a' })
  expect(uploads.pending.value).toBe(false)
  expect(uploads.get(source)?.phase).toBe('uploaded')
  expect(await uploads.retry(source)).toBe('blocked')
})

it('preserves a subdirectory typed while the upload is pending', async () => {
  const { uploads, source, request } = setup()
  const work = uploads.start(source, file())
  source.dir = 'svg/custom-subfolder'
  request.resolve('uploaded-a')
  await work
  expect(source).toMatchObject({ dir: 'svg/custom-subfolder', upload: 'uploaded-a' })
})

it('serializes uploads without replacing the active filename or sending a second request', async () => {
  const { context, uploads, upload, source, request } = setup()
  const other = { type: 'directory' as const, dir: 'other' }
  context.sources.push(other)
  const work = uploads.start(source, file('a.zip'))
  expect(await uploads.start(source, file('b.zip'))).toBe('blocked')
  expect(await uploads.start(other, file('b.zip'))).toBe('blocked')
  expect(upload).toHaveBeenCalledTimes(1)
  expect(uploads.get(source)?.fileName).toBe('a.zip')
  expect(uploads.get(other)).toBeUndefined()
  request.resolve('a-only')
  await work
  expect(source.upload).toBe('a-only')
  expect(other).not.toHaveProperty('upload')
})

it('keeps a previous attachment on failure and retries the same File only on explicit request', async () => {
  const { uploads, upload, source, request } = setup()
  const selected = file()
  const work = uploads.start(source, selected)
  request.reject(new Error('Upload unavailable'))
  expect(await work).toBe('failed')
  expect(source).toMatchObject({ dir: 'raw', upload: 'previous-upload' })
  expect(uploads.get(source)).toMatchObject({ phase: 'failed', fileName: 'a.zip', error: 'Upload unavailable' })
  expect(upload).toHaveBeenCalledTimes(1)
  const retry = deferred<string>()
  upload.mockReturnValueOnce(retry.promise)
  const retried = uploads.retry(source)
  expect(upload.mock.calls[1]?.[0]).toBe(selected)
  expect(upload.mock.calls[1]?.[1]).not.toBe(upload.mock.calls[0]?.[1])
  expect(await uploads.retry(source)).toBe('blocked')
  expect(uploads.get(source)).toMatchObject({ phase: 'pending', error: '' })
  retry.resolve('retried-upload')
  await retried
  expect(source.upload).toBe('retried-upload')
  expect(upload).toHaveBeenCalledTimes(2)
})

it.each(['resolve', 'reject'] as const)('settles cancellation immediately and ignores an old %s after selecting a new file', async (outcome) => {
  const { uploads, upload, source, request } = setup()
  const work = uploads.start(source, file('a.zip'))
  const signal = upload.mock.calls[0]![1]
  uploads.cancel(source)
  expect(await work).toBe('cancelled')
  expect(signal.aborted).toBe(true)
  expect(uploads.pending.value).toBe(false)
  expect(source.upload).toBe('previous-upload')
  const next = deferred<string>()
  upload.mockReturnValueOnce(next.promise)
  const nextWork = uploads.start(source, file('b.zip'))
  if (outcome === 'resolve') {
    request.resolve('stale-a')
  }
  else { request.reject(new Error('stale a failure')) }
  await Promise.resolve()
  expect(uploads.get(source)).toMatchObject({ phase: 'pending', fileName: 'b.zip', error: '' })
  expect(source.upload).toBe('previous-upload')
  next.resolve('current-b')
  await nextWork
  expect(source.upload).toBe('current-b')
})

it('lets a canceled file be selected again without retrying the canceled request', async () => {
  const { uploads, upload, source, request } = setup()
  const selected = file()
  const work = uploads.start(source, selected)
  uploads.cancel(source)
  await work
  expect(await uploads.retry(source)).toBe('blocked')
  upload.mockResolvedValueOnce('same-file-second-request')
  await uploads.start(source, selected)
  expect(source.upload).toBe('same-file-second-request')
  expect(upload).toHaveBeenCalledTimes(2)
  request.resolve('ignored-first-request')
  await Promise.resolve()
  expect(source.upload).toBe('same-file-second-request')
})

it('cancels removed sources while retaining the identity of surviving sources', async () => {
  const { context, uploads, upload, source, request } = setup()
  const survivor = sourceFactory()
  context.sources.push(survivor)
  const survivorKey = uploads.key(survivor)
  const work = uploads.start(source, file())
  context.sources.splice(0, 1)
  uploads.prune()
  expect(await work).toBe('cancelled')
  expect(upload.mock.calls[0]?.[1].aborted).toBe(true)
  expect(uploads.get(source)).toBeUndefined()
  expect(uploads.key(survivor)).toBe(survivorKey)
  request.resolve('removed-upload')
  await Promise.resolve()
  expect(survivor).not.toHaveProperty('upload')
  expect(source.upload).toBe('previous-upload')
})

it('keeps an upload attached to its source when an earlier source is removed', async () => {
  const { context, uploads, source, request } = setup()
  const earlier = sourceFactory()
  context.sources.unshift(earlier)
  const key = uploads.key(source)
  const work = uploads.start(source, file())
  context.sources.splice(0, 1)
  uploads.prune()
  request.resolve('correct-source')
  expect(await work).toBe('uploaded')
  expect(source.upload).toBe('correct-source')
  expect(earlier).not.toHaveProperty('upload')
  expect(uploads.key(source)).toBe(key)
})

it('forgets pending replacement uploads before restoring repository mode', async () => {
  const { uploads, source, request } = setup()
  const work = uploads.start(source, file())
  uploads.forget(source)
  delete source.upload
  expect(await work).toBe('cancelled')
  expect(uploads.get(source)).toBeUndefined()
  request.resolve('must-not-reattach')
  await Promise.resolve()
  expect(source).not.toHaveProperty('upload')
})

it('does not resurrect an A upload after moving through B and reopening A', async () => {
  const { context, uploads, source: firstA, request } = setup()
  const work = uploads.start(firstA, file())
  context.session++
  uploads.invalidate()
  context.sources = [source('b')]
  expect(await work).toBe('cancelled')
  context.session++
  uploads.invalidate()
  const nextA = source('raw', 'previous-upload')
  context.sources = [nextA]
  request.resolve('old-a-result')
  await Promise.resolve()
  expect(nextA).toMatchObject({ dir: 'raw', upload: 'previous-upload' })
  expect(uploads.get(nextA)).toBeUndefined()
  expect(uploads.get(firstA)).toBeUndefined()
})

it.each(['session', 'source'] as const)('rejects a stale result even before the %s invalidation notification runs', async (change) => {
  const { context, uploads, source: original, request } = setup()
  const work = uploads.start(original, file())
  if (change === 'session') {
    context.session++
  }
  else { context.sources = [source('replacement')] }
  request.resolve('stale-result')
  expect(await work).toBe('cancelled')
  expect(original.upload).toBe('previous-upload')
  expect(uploads.pending.value).toBe(false)
  expect(uploads.get(original)).toBeUndefined()
})

it('replaces a failed file with a newly selected file instead of retaining its retry data', async () => {
  const { uploads, upload, source, request } = setup()
  const work = uploads.start(source, file('failed-a.zip'))
  request.reject(new Error('failed A'))
  await work
  upload.mockResolvedValueOnce('new-b')
  await uploads.start(source, file('new-b.zip'))
  expect(source.upload).toBe('new-b')
  expect(uploads.get(source)).toMatchObject({ phase: 'uploaded', fileName: 'new-b.zip', error: '' })
  expect(await uploads.retry(source)).toBe('blocked')
})

it('settles synchronous upload failures and treats abort rejection as cancellation', async () => {
  const { uploads, upload, source } = setup()
  upload.mockImplementationOnce(() => {
    throw new Error('synchronous failure')
  })
  expect(await uploads.start(source, file())).toBe('failed')
  expect(uploads.get(source)?.error).toBe('synchronous failure')
  upload.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
  expect(await uploads.retry(source)).toBe('cancelled')
  expect(uploads.get(source)).toMatchObject({ phase: 'cancelled', error: '' })
  expect(uploads.pending.value).toBe(false)
})

it('settles disposal before the network completes and suppresses late errors and retries', async () => {
  const { uploads, upload, source, request } = setup()
  const work = uploads.start(source, file())
  uploads.dispose()
  expect(await work).toBe('cancelled')
  expect(upload.mock.calls[0]?.[1].aborted).toBe(true)
  request.reject(new Error('late disposal failure'))
  await Promise.resolve()
  expect(uploads.get(source)).toBeUndefined()
  expect(uploads.pending.value).toBe(false)
  expect(source.upload).toBe('previous-upload')
  expect(await uploads.start(source, file())).toBe('cancelled')
  expect(await uploads.retry(source)).toBe('blocked')
})

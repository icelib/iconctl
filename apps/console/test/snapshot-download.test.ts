import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotDownload, saveBlobDownload } from '../src/features/review/snapshot-download'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const snapshot = { id: 'a', digest: 'f'.repeat(64) }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('downloads once with the clicked identity, independent of later object mutation', async () => {
  const pending = deferred<Blob>()
  const download = vi.fn().mockReturnValue(pending.promise)
  const save = vi.fn()
  const current = { ...snapshot }
  const controller = createSnapshotDownload(download, save)
  const work = controller.start(current)
  expect(controller.state.value.pending).toBe(true)
  expect(await controller.start(snapshot)).toBe('blocked')
  current.id = 'b'
  const blob = new Blob(['zip'])
  pending.resolve(blob)
  expect(await work).toBe('downloaded')
  expect(download).toHaveBeenCalledTimes(1)
  expect(download).toHaveBeenCalledWith('a', expect.any(AbortSignal))
  expect(save).toHaveBeenCalledWith(blob, `iconctl-svg-a-${'f'.repeat(12)}.zip`)
  expect(controller.state.value).toEqual({ pending: false, error: '', message: '已发起下载' })
})

it.each(['success', 'failure'])('settles cancellation immediately and isolates late %s after A→B→A', async (outcome) => {
  const first = deferred<Blob>()
  const second = deferred<Blob>()
  const download = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const save = vi.fn()
  const controller = createSnapshotDownload(download, save)
  const old = controller.start(snapshot)
  controller.invalidate()
  expect(await old).toBe('cancelled')
  expect(download.mock.calls[0]![1].aborted).toBe(true)
  const next = controller.start(snapshot)
  if (outcome === 'success') {
    first.resolve(new Blob(['old']))
  }
  else {
    first.reject(new Error('old error'))
  }
  await Promise.resolve()
  expect(save).not.toHaveBeenCalled()
  expect(controller.state.value).toEqual({ pending: true, error: '', message: '正在准备 SVG 下载…' })
  const blob = new Blob(['new'])
  second.resolve(blob)
  expect(await next).toBe('downloaded')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toBe(blob)
})

it('keeps errors local and retries only on another explicit start', async () => {
  const download = vi.fn().mockRejectedValueOnce(new Error('Archive too large')).mockResolvedValueOnce(new Blob(['zip']))
  const save = vi.fn()
  const controller = createSnapshotDownload(download, save)
  expect(await controller.start(snapshot)).toBe('failed')
  expect(controller.state.value).toEqual({ pending: false, error: 'Archive too large', message: '' })
  expect(download).toHaveBeenCalledTimes(1)
  expect(await controller.start(snapshot)).toBe('downloaded')
  expect(controller.state.value.error).toBe('')
})

it('handles synchronous request/save failures and clears feedback on invalidation', async () => {
  const save = vi.fn().mockImplementationOnce(() => {
    throw new Error('Download click failed')
  })
  const controller = createSnapshotDownload(() => Promise.resolve(new Blob()), save)
  expect(await controller.start(snapshot)).toBe('failed')
  expect(controller.state.value.error).toBe('Download click failed')
  controller.invalidate()
  expect(controller.state.value).toEqual({ pending: false, error: '', message: '' })
  const broken = createSnapshotDownload(() => {
    throw new Error('Request failed')
  }, save)
  expect(await broken.start(snapshot)).toBe('failed')
  expect(broken.state.value.error).toBe('Request failed')
})

it('disposes before the network settles and prevents new downloads', async () => {
  const pending = deferred<Blob>()
  const save = vi.fn()
  const controller = createSnapshotDownload(() => pending.promise, save)
  const work = controller.start(snapshot)
  controller.dispose()
  expect(await work).toBe('cancelled')
  expect(await controller.start(snapshot)).toBe('blocked')
  pending.resolve(new Blob(['late']))
  await Promise.resolve()
  expect(save).not.toHaveBeenCalled()
})

it.each(['none', 'create', 'append', 'click', 'remove', 'revoke'])('removes the temporary link and revokes the Blob URL after %s failure', (failure) => {
  const link = {
    append: vi.fn(() => {
      if (failure === 'append') {
        throw new Error('append')
      }
    }),
    click: vi.fn(() => {
      if (failure === 'click') {
        throw new Error('click')
      }
    }),
    remove: vi.fn(() => {
      if (failure === 'remove') {
        throw new Error('remove')
      }
    }),
  }
  const target = {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(() => {
      if (failure === 'revoke') {
        throw new Error('revoke')
      }
    }),
    createLink: vi.fn(() => {
      if (failure === 'create') {
        throw new Error('create')
      }
      return link
    }),
  }
  const work = () => saveBlobDownload(new Blob(['zip']), 'test.zip', target)
  if (failure === 'none') {
    work()
  }
  else {
    expect(work).toThrow(failure)
  }
  expect(target.createLink).toHaveBeenCalledWith('blob:test', 'test.zip')
  expect(link.remove).toHaveBeenCalledTimes(failure === 'create' ? 0 : 1)
  expect(target.revokeObjectURL).toHaveBeenCalledWith('blob:test')
})

it('keeps SVG and JSON single-flight state independent and snapshots the JSON filename', async () => {
  const zip = deferred<Blob>()
  const json = deferred<Blob>()
  const save = vi.fn()
  const svgRequest = vi.fn(() => zip.promise)
  const jsonRequest = vi.fn((_id: string, _signal: AbortSignal) => json.promise)
  const svg = createSnapshotDownload(svgRequest, save)
  const icons = createSnapshotDownload(jsonRequest, save, { prefix: 'iconctl-icons', extension: 'json', label: 'Iconify JSON' })
  const clicked = { ...snapshot }
  const first = svg.start(clicked)
  const second = icons.start(clicked)
  expect(await icons.start(clicked)).toBe('blocked')
  expect(icons.state.value.message).toBe('正在准备 Iconify JSON 下载…')
  clicked.id = 'changed'
  clicked.digest = '0'.repeat(64)
  svg.invalidate()
  expect(await first).toBe('cancelled')
  expect(jsonRequest.mock.calls[0]![1].aborted).toBe(false)
  expect(icons.state.value.pending).toBe(true)
  const body = new Blob(['{"prefix":"a","icons":{}}'])
  json.resolve(body)
  expect(await second).toBe('downloaded')
  expect(save).toHaveBeenCalledExactlyOnceWith(body, `iconctl-icons-a-${'f'.repeat(12)}.json`)
  zip.resolve(new Blob(['old zip']))
  await Promise.resolve()
  expect(save).toHaveBeenCalledTimes(1)
  icons.dispose()
  svg.dispose()
})

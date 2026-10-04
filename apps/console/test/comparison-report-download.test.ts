import type { SnapshotPreview } from '@iconctl/console-contracts'
import type { createComparisonReport } from '../src/features/review/comparison-report-render'
import { expect, it, vi } from 'vitest'
import { createComparisonReportDownload } from '../src/features/review/comparison-report-download'

const preview = {} as SnapshotPreview
const artifact = { blob: new Blob(['report']), filename: 'report.json' }
function deferred() {
  let resolve!: (value: typeof artifact) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<typeof artifact>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const gate = deferred()
  const current = vi.fn<() => SnapshotPreview | undefined>(() => preview)
  const blocked = vi.fn(() => false)
  const build = vi.fn<typeof createComparisonReport>(() => gate.promise)
  const save = vi.fn()
  const download = createComparisonReportDownload({ current, blocked, build, save })
  return { gate, current, blocked, build, save, download }
}

it('uses one generation for both formats and captures only the current review', async () => {
  const context = fixture()
  const pending = context.download.start('json')
  expect(await context.download.start('html')).toBe('blocked')
  expect(context.build).toHaveBeenCalledExactlyOnceWith(preview, 'json', expect.any(AbortSignal))
  context.gate.resolve(artifact)
  expect(await pending).toBe('downloaded')
  expect(context.save).toHaveBeenCalledExactlyOnceWith(artifact.blob, artifact.filename)
  expect(context.download.state.value).toEqual({ pending: false, error: '', message: '已发起比较报告下载' })
})

it('blocks pending/no committed review, then permits an explicit retry of the retained response', async () => {
  const context = fixture()
  context.current.mockReturnValue(undefined)
  expect(await context.download.start('json')).toBe('blocked')
  context.current.mockReturnValue(preview)
  context.blocked.mockReturnValue(true)
  expect(await context.download.start('html')).toBe('blocked')
  expect(context.build).not.toHaveBeenCalled()
  context.blocked.mockReturnValue(false)
  context.gate.resolve(artifact)
  expect(await context.download.start('html')).toBe('downloaded')
})

it.each(['current', 'blocked'] as const)('rechecks %s before saving even if a caller misses invalidation', async (condition) => {
  const context = fixture()
  const pending = context.download.start('json')
  if (condition === 'current') {
    context.current.mockReturnValue({} as SnapshotPreview)
  }
  else { context.blocked.mockReturnValue(true) }
  context.gate.resolve(artifact)
  expect(await pending).toBe('cancelled')
  expect(context.save).not.toHaveBeenCalled()
  expect(context.download.state.value.error).toBe('')
})

it.each(['success', 'failure'] as const)('settles cancellation immediately and ignores old %s after A→B→A', async (outcome) => {
  const context = fixture()
  const old = context.download.start('json')
  const signal = context.build.mock.calls[0]![2] as AbortSignal
  context.download.invalidate()
  expect(await old).toBe('cancelled')
  expect(signal.aborted).toBe(true)
  const next = deferred()
  context.build.mockReturnValueOnce(next.promise)
  const fresh = context.download.start('html')
  if (outcome === 'success') {
    context.gate.resolve(artifact)
  }
  else { context.gate.reject(new Error('old failure')) }
  await Promise.resolve()
  expect(context.download.state.value).toEqual({ pending: true, error: '', message: '正在准备比较报告…' })
  expect(context.save).not.toHaveBeenCalled()
  next.resolve({ ...artifact, filename: 'fresh.html' })
  expect(await fresh).toBe('downloaded')
  expect(context.save).toHaveBeenCalledExactlyOnceWith(artifact.blob, 'fresh.html')
})

it('keeps generation and save failures local and retries only on explicit action', async () => {
  const context = fixture()
  context.build.mockImplementationOnce(() => {
    throw new Error('size limit')
  })
  expect(await context.download.start('json')).toBe('failed')
  expect(context.download.state.value.error).toBe('size limit')
  expect(context.build).toHaveBeenCalledTimes(1)
  context.gate.resolve(artifact)
  context.save.mockImplementationOnce(() => {
    throw new Error('click failed')
  })
  expect(await context.download.start('json')).toBe('failed')
  expect(context.download.state.value.error).toBe('click failed')
  expect(await context.download.start('html')).toBe('downloaded')
})

it('disposes before completion and never downloads or updates after unmount', async () => {
  const context = fixture()
  const pending = context.download.start('html')
  context.download.dispose()
  expect(await pending).toBe('cancelled')
  context.gate.resolve(artifact)
  await Promise.resolve()
  expect(context.save).not.toHaveBeenCalled()
  expect(await context.download.start('json')).toBe('blocked')
  expect(context.download.state.value).toEqual({ pending: false, error: '', message: '' })
})

it('does not restore old feedback when the document leaves during the synchronous save callback', async () => {
  const context = fixture()
  context.save.mockImplementationOnce(context.download.dispose)
  context.gate.resolve(artifact)
  expect(await context.download.start('json')).toBe('cancelled')
  expect(context.download.state.value).toEqual({ pending: false, error: '', message: '' })
})

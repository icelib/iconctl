import type { SnapshotPreview } from '@iconctl/console-contracts'
import { expect, it, vi } from 'vitest'
import { createDiagnosticCopy } from '../src/features/history/diagnostic-copy'
import { diagnosticIdentityKey, diagnosticLocation } from '../src/features/history/snapshot-diagnostics'

function preview(): SnapshotPreview {
  return {
    snapshot: { id: 'snapshot-A', projectId: 'project', jobId: 'job', digest: 'a'.repeat(64), createdAt: 1, iconCount: 0, issues: 2, attempt: 1 },
    content: { json: { prefix: 'test', icons: {} }, files: {}, sources: [], issues: [{ name: 'old', message: 'problem' }], failed: ['failed'] },
    diff: { added: [], changed: [], removed: [] },
    comparison: { mode: 'previous', snapshot: null, release: null },
  }
}
function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const value = preview()
  const target = { identity: diagnosticIdentityKey(value.snapshot), kind: 'issue' as const, index: 0 }
  const gate = deferred()
  const current = vi.fn<() => SnapshotPreview | undefined>(() => value)
  const blocked = vi.fn(() => false)
  const write = vi.fn<(text: string) => Promise<void>>(() => gate.promise)
  const copy = createDiagnosticCopy({ current, blocked, write })
  return { value, target, gate, current, blocked, write, copy }
}

it('invokes native write synchronously in the click stack, captures immutable text and refuses a second write', async () => {
  const context = fixture()
  const expected = diagnosticLocation(context.value, context.target)
  const pending = context.copy.start(context.target)
  expect(context.write).toHaveBeenCalledExactlyOnceWith(expected)
  expect(context.copy.state.value.pending).toBe(true)
  expect(await context.copy.start({ ...context.target, kind: 'failed' })).toBe('blocked')
  context.value.content.issues[0]!.message = 'later mutation'
  context.gate.resolve()
  expect(await pending).toBe('copied')
  expect(context.copy.state.value).toMatchObject({ pending: false, text: '', error: '', message: '已复制定位信息' })
})

it.each(['success', 'failure'] as const)('holds native lock across logical invalidation, unmount/remount and A→B→A until late %s settles', async (outcome) => {
  const context = fixture()
  const pending = context.copy.start(context.target)
  context.copy.invalidate()
  context.current.mockReturnValue({ ...context.value, snapshot: { ...context.value.snapshot, id: 'snapshot-B' } })
  context.copy.invalidate()
  context.current.mockReturnValue(context.value)
  context.copy.invalidate()
  expect(context.copy.state.value).toMatchObject({ pending: true, error: '', message: '', text: '' })
  expect(await context.copy.start(context.target)).toBe('blocked')
  expect(context.write).toHaveBeenCalledTimes(1)
  if (outcome === 'success') {
    context.gate.resolve()
  }
  else { context.gate.reject(new Error('late error')) }
  expect(await pending).toBe('cancelled')
  expect(context.copy.state.value).toMatchObject({ pending: false, error: '', message: '', text: '' })
  context.write.mockResolvedValueOnce()
  expect(await context.copy.start(context.target)).toBe('copied')
  expect(context.write).toHaveBeenCalledTimes(2)
})

it.each(['success', 'failure'] as const)('allows manual text during a pending write and preserves it after old %s, without another native call', async (outcome) => {
  const context = fixture()
  const pending = context.copy.start(context.target)
  const failed = { ...context.target, kind: 'failed' as const }
  context.copy.showText(failed)
  const manual = context.copy.state.value
  expect(manual.text).toBe(diagnosticLocation(context.value, failed))
  expect(manual.pending).toBe(true)
  expect(context.write).toHaveBeenCalledTimes(1)
  if (outcome === 'success') {
    context.gate.resolve()
  }
  else { context.gate.reject(new Error('old reject')) }
  expect(await pending).toBe('cancelled')
  expect(context.copy.state.value).toEqual({ ...manual, pending: false })
})

it.each(['throw', 'reject'] as const)('shows local readonly fallback on current native %s and retries only on a new click', async (mode) => {
  const context = fixture()
  const failure = new Error('Clipboard permission denied')
  if (mode === 'throw') {
    context.write.mockImplementationOnce(() => {
      throw failure
    })
  }
  else { context.write.mockRejectedValueOnce(failure) }
  expect(await context.copy.start(context.target)).toBe('failed')
  expect(context.copy.state.value).toMatchObject({ pending: false, text: diagnosticLocation(context.value, context.target), error: failure.message })
  expect(context.write).toHaveBeenCalledTimes(1)
  context.copy.showText(context.target)
  expect(context.write).toHaveBeenCalledTimes(1)
  context.write.mockResolvedValueOnce()
  expect(await context.copy.start(context.target)).toBe('copied')
})

it('uses manual fallback when the native API is absent without a permission request or alternate copy API', async () => {
  const context = fixture()
  vi.stubGlobal('navigator', {})
  try {
    const copy = createDiagnosticCopy({ current: context.current, blocked: context.blocked })
    expect(await copy.start(context.target)).toBe('failed')
    expect(copy.state.value).toMatchObject({ pending: false, text: diagnosticLocation(context.value, context.target) })
    expect(copy.state.value.error).toContain('不支持剪贴板')
  }
  finally { vi.unstubAllGlobals() }
})

it('blocks pending or absent review and stale identities; keeps a failed replacement old review usable', async () => {
  const context = fixture()
  context.blocked.mockReturnValue(true)
  expect(await context.copy.start(context.target)).toBe('blocked')
  context.copy.showText(context.target)
  expect(context.copy.state.value.text).toBe('')
  context.blocked.mockReturnValue(false)
  context.current.mockReturnValue(undefined)
  expect(await context.copy.start(context.target)).toBe('blocked')
  context.current.mockReturnValue(context.value)
  expect(await context.copy.start({ ...context.target, identity: 'other' })).toBe('blocked')
  expect(context.write).not.toHaveBeenCalled()
  context.gate.resolve()
  expect(await context.copy.start(context.target)).toBe('copied')
})

it('refuses corrupt/oversized location records before native write and does not present truncated fallback', async () => {
  const context = fixture()
  context.value.content.issues[0]!.message = 'x'.repeat(17 * 1024)
  expect(await context.copy.start(context.target)).toBe('failed')
  expect(context.copy.state.value).toMatchObject({ pending: false, text: '' })
  expect(context.copy.state.value.error).toContain('16 KiB')
  expect(context.write).not.toHaveBeenCalled()
  context.copy.showText(context.target)
  expect(context.copy.state.value.text).toBe('')
})

it.each(['current', 'blocked'] as const)('rechecks %s before feedback even if the caller missed invalidation', async (condition) => {
  const context = fixture()
  const pending = context.copy.start(context.target)
  if (condition === 'current') {
    context.current.mockReturnValue({ ...context.value, snapshot: { ...context.value.snapshot, attempt: 2 } })
  }
  else { context.blocked.mockReturnValue(true) }
  const captured = context.copy.state.value
  context.gate.resolve()
  expect(await pending).toBe('cancelled')
  expect(context.copy.state.value).toEqual({ ...captured, pending: false })
})

it.each(['success', 'failure'] as const)('does not mutate reactive state after document disposal on late %s', async (outcome) => {
  const context = fixture()
  const pending = context.copy.start(context.target)
  context.copy.dispose()
  const afterDispose = context.copy.state.value
  if (outcome === 'success') {
    context.gate.resolve()
  }
  else { context.gate.reject(new Error('late')) }
  expect(await pending).toBe('cancelled')
  expect(context.copy.state.value).toBe(afterDispose)
  expect(await context.copy.start(context.target)).toBe('blocked')
  context.copy.showText(context.target)
  context.copy.resume()
  expect(context.copy.state.value).toBe(afterDispose)
})

it('suspends on pagehide without late DOM state updates and retains the native lock on a persisted restore', async () => {
  const context = fixture()
  const pending = context.copy.start(context.target)
  context.copy.suspend()
  const hidden = context.copy.state.value
  expect(await context.copy.start(context.target)).toBe('blocked')
  context.copy.resume()
  expect(context.copy.state.value.pending).toBe(true)
  expect(await context.copy.start(context.target)).toBe('blocked')
  context.copy.suspend()
  const hiddenAgain = context.copy.state.value
  context.gate.reject(new Error('settled while hidden'))
  expect(await pending).toBe('cancelled')
  expect(context.copy.state.value).toBe(hiddenAgain)
  expect(hidden.text).toBe('')
  context.copy.resume()
  expect(context.copy.state.value).toMatchObject({ pending: false, message: '', error: '', text: '' })
})

it('handles synchronous disposal during the native call without restoring feedback', async () => {
  const context = fixture()
  context.write.mockImplementationOnce(() => {
    context.copy.dispose()
    throw new Error('disposed native call')
  })
  expect(await context.copy.start(context.target)).toBe('cancelled')
  expect(context.copy.state.value.message).toBe('')
})

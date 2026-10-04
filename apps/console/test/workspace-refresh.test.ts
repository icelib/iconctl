import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../src/api-response'
import { createWorkspaceRefresh } from '../src/features/workspace/workspace-refresh'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const initialize = vi.fn(async (_signal: AbortSignal): Promise<void> => undefined)
  const read = vi.fn(async (_signal: AbortSignal) => 'initial')
  const commit = vi.fn<(value: string, selectDefault: boolean) => void>()
  const automatic = vi.fn(() => true)
  const visibilityTarget = new EventTarget()
  const onlineTarget = new EventTarget()
  const workspace = createWorkspaceRefresh({ initialize, read, commit, automatic, visibilityTarget, onlineTarget })
  controllers.push(workspace)
  return { workspace, initialize, read, commit, automatic, visibilityTarget, onlineTarget }
}
const controllers: ReturnType<typeof createWorkspaceRefresh<string>>[] = []
async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.dispose())
  await flush()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it('retries failed session setup before reading state and enables the normal cadence after recovery', async () => {
  const { workspace, initialize, read, commit } = fixture()
  initialize.mockRejectedValueOnce(new Error('Session unavailable'))
  await expect(workspace.refresh()).rejects.toThrow('Session unavailable')
  expect(workspace.state.value).toMatchObject({ ready: false, pending: false, error: 'Session unavailable' })
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(initialize).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledTimes(1)
  expect(commit).toHaveBeenCalledWith('initial', true)
  expect(workspace.state.value).toMatchObject({ ready: true, pending: false, error: '' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(initialize).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledTimes(2)
})

it('returns the accepted fresh workspace value to explicit callers', async () => {
  const { workspace, commit } = fixture()
  await expect(workspace.refresh()).resolves.toBe('initial')
  expect(commit).toHaveBeenCalledWith('initial', true)
})

it('coalesces bootstrap retries and retries only state once the session succeeded', async () => {
  const { workspace, initialize, read } = fixture()
  read.mockRejectedValueOnce(new Error('State unavailable'))
  const first = workspace.refresh()
  expect(workspace.refresh()).toBe(first)
  await expect(first).rejects.toThrow('State unavailable')
  const retry = workspace.refresh()
  expect(workspace.refresh()).toBe(retry)
  await retry
  expect(initialize).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(2)
  expect(workspace.state.value.ready).toBe(true)
})

it('keeps last accepted state while failures back off at 10, 20, 40 and at most 60 seconds', async () => {
  const { workspace, read, commit } = fixture()
  await workspace.refresh()
  const lastUpdated = workspace.state.value.lastUpdated
  read.mockRejectedValue(new Error('Offline'))
  await expect(workspace.refresh()).rejects.toThrow('Offline')
  for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
    const before = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(read).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(before + 1)
    expect(workspace.state.value).toMatchObject({ ready: true, pending: false, lastUpdated, error: 'Offline' })
  }
  expect(commit).toHaveBeenCalledTimes(1)
  read.mockResolvedValue('recovered')
  await workspace.refresh()
  expect(commit).toHaveBeenLastCalledWith('recovered', true)
  expect(workspace.state.value.error).toBe('')
  await vi.advanceTimersByTimeAsync(9_999)
  const count = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(count + 1)
})

it('accepts a read slower than two polling intervals and starts the next interval after it settles', async () => {
  const { workspace, read, commit } = fixture()
  await workspace.refresh()
  const slow = deferred<string>()
  read.mockReturnValueOnce(slow.promise)
  await vi.advanceTimersByTimeAsync(10_000)
  const joined = workspace.refresh()
  await vi.advanceTimersByTimeAsync(25_000)
  expect(read).toHaveBeenCalledTimes(2)
  slow.resolve('slow success')
  await joined
  expect(commit).toHaveBeenLastCalledWith('slow success', true)
  await vi.advanceTimersByTimeAsync(9_999)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(3)
})

it('times out an abort-insensitive read and isolates its late result from a successful retry', async () => {
  const { workspace, read, commit } = fixture()
  const slow = deferred<string>()
  read.mockReturnValueOnce(slow.promise)
  const work = workspace.refresh()
  const failure = expect(work).rejects.toThrow('读取超时')
  await vi.advanceTimersByTimeAsync(30_000)
  await failure
  expect(read.mock.calls[0]![0].aborted).toBe(true)
  expect(workspace.state.value.pending).toBe(false)
  read.mockResolvedValue('recovered')
  await workspace.refresh()
  slow.resolve('stale')
  await flush()
  expect(commit.mock.calls).toEqual([['recovered', true]])
})

it('times out bootstrap too and retries session instead of accepting a late initialization', async () => {
  const { workspace, initialize, read } = fixture()
  const slow = deferred<void>()
  initialize.mockReturnValueOnce(slow.promise)
  const failure = expect(workspace.refresh()).rejects.toThrow('读取超时')
  await vi.advanceTimersByTimeAsync(30_000)
  await failure
  await workspace.refresh()
  slow.resolve()
  await flush()
  expect(initialize).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(['resolve', 'reject'] as const)('does not resolve editor recovery from a discarded read that later %ss', async (outcome) => {
  const { workspace, read, commit } = fixture()
  await workspace.refresh()
  const beforeWrite = deferred<string>()
  const afterWrite = deferred<string>()
  read.mockReturnValueOnce(beforeWrite.promise).mockReturnValueOnce(afterWrite.promise)
  let settled = false
  const work = workspace.refresh().then(() => {
    settled = true
  })
  await flush()
  workspace.invalidate()
  const editorRead = workspace.refresh(false)
  await flush()
  expect(read.mock.calls[1]![0].aborted).toBe(true)
  expect(read).toHaveBeenCalledTimes(3)
  if (outcome === 'resolve') {
    beforeWrite.resolve('before write')
  }
  else { beforeWrite.reject(new Error('old failure')) }
  await flush()
  expect(settled).toBe(false)
  expect(commit.mock.calls).toEqual([['initial', true]])
  afterWrite.resolve('after write')
  await Promise.all([work, editorRead])
  expect(commit.mock.calls).toEqual([['initial', true], ['after write', false]])
  expect(workspace.state.value.error).toBe('')
})

it('rejects an explicit post-write refresh if its fresh read fails instead of falsely reporting the discarded read as success', async () => {
  const { workspace, read, commit } = fixture()
  const old = deferred<string>()
  read.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('New state unavailable'))
  const work = workspace.refresh()
  await flush()
  workspace.invalidate()
  const editor = workspace.refresh(false)
  await expect(editor).rejects.toThrow('New state unavailable')
  await expect(work).rejects.toThrow('New state unavailable')
  old.resolve('old')
  await flush()
  expect(commit).not.toHaveBeenCalled()
})

it('preserves an explicit refresh(false) when joined with automatic work', async () => {
  const { workspace, read, commit } = fixture()
  await workspace.refresh()
  const slow = deferred<string>()
  read.mockReturnValueOnce(slow.promise)
  await vi.advanceTimersByTimeAsync(10_000)
  const editor = workspace.refresh(false)
  const manual = workspace.refresh()
  slow.resolve('new')
  await Promise.all([editor, manual])
  expect(commit).toHaveBeenLastCalledWith('new', false)
})

it('skips automatic reads when hidden or busy, permits explicit reads, and coalesces visibility/online recovery', async () => {
  const { workspace, read, automatic, visibilityTarget, onlineTarget } = fixture()
  await workspace.refresh()
  automatic.mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(30_000)
  visibilityTarget.dispatchEvent(new Event('visibilitychange'))
  onlineTarget.dispatchEvent(new Event('online'))
  expect(read).toHaveBeenCalledTimes(1)
  await workspace.refresh(false)
  expect(read).toHaveBeenCalledTimes(2)
  automatic.mockReturnValue(true)
  const slow = deferred<string>()
  read.mockReturnValueOnce(slow.promise)
  visibilityTarget.dispatchEvent(new Event('visibilitychange'))
  onlineTarget.dispatchEvent(new Event('online'))
  await flush()
  expect(read).toHaveBeenCalledTimes(3)
  slow.resolve('visible')
  await workspace.refresh()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(read).toHaveBeenCalledTimes(4)
})

it('stops automatic retries on authentication failure but permits explicit recovery', async () => {
  const { workspace, initialize, read, visibilityTarget, onlineTarget } = fixture()
  initialize.mockRejectedValueOnce(new ApiError('请重新登录', 401))
  await expect(workspace.refresh()).rejects.toMatchObject({ status: 401 })
  await vi.advanceTimersByTimeAsync(120_000)
  visibilityTarget.dispatchEvent(new Event('visibilitychange'))
  onlineTarget.dispatchEvent(new Event('online'))
  expect(initialize).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  await workspace.refresh()
  expect(read).toHaveBeenCalledTimes(1)
  expect(workspace.state.value.ready).toBe(true)
})

it.each(['session', 'state'] as const)('disposes during %s without committing, retrying, or recreating a timer', async (stage) => {
  const { workspace, initialize, read, commit, visibilityTarget, onlineTarget } = fixture()
  const pending = deferred<never>()
  if (stage === 'session') {
    initialize.mockReturnValueOnce(pending.promise)
  }
  else { read.mockReturnValueOnce(pending.promise) }
  const work = workspace.refresh()
  await flush()
  const signal = stage === 'session' ? initialize.mock.calls[0]![0] : read.mock.calls[0]![0]
  const failure = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  workspace.dispose()
  workspace.dispose()
  await failure
  expect(signal.aborted).toBe(true)
  pending.reject(new Error('late failure'))
  await flush()
  visibilityTarget.dispatchEvent(new Event('visibilitychange'))
  onlineTarget.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(commit).not.toHaveBeenCalled()
  expect(workspace.state.value).toMatchObject({ ready: false, pending: false, error: '' })
  expect(vi.getTimerCount()).toBe(0)
  await expect(workspace.refresh()).rejects.toMatchObject({ name: 'AbortError' })
})

it('disposes before bootstrap starts and while a failure retry timer is armed', async () => {
  const first = fixture()
  const work = first.workspace.refresh()
  first.workspace.dispose()
  await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  expect(first.initialize).not.toHaveBeenCalled()
  const second = fixture()
  second.read.mockRejectedValueOnce(new Error('offline'))
  await expect(second.workspace.refresh()).rejects.toThrow('offline')
  expect(vi.getTimerCount()).toBe(1)
  second.workspace.dispose()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(second.read).toHaveBeenCalledTimes(1)
})

it('does not wait on navigation to schedule the next accepted workspace read', async () => {
  const { workspace, read, commit } = fixture()
  const navigation = deferred<void>()
  commit.mockImplementation(() => {
    void navigation.promise
  })
  await workspace.refresh()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(read).toHaveBeenCalledTimes(2)
  navigation.resolve()
})

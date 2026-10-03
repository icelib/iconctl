import { expect, it, vi } from 'vitest'
import { createDraftNavigation } from '../src/features/projects/draft-navigation'

function setup() {
  const context = { dirty: true, session: 1 }
  const navigation = createDraftNavigation({ dirty: () => context.dirty, session: () => context.session })
  return { context, navigation }
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

it('keeps the navigation action untouched until explicit confirmation', async () => {
  const { navigation } = setup()
  const run = vi.fn(() => true)
  const result = navigation.request({ label: '项目 B', run })
  expect(run).not.toHaveBeenCalled()
  expect(navigation.state.value.pending?.label).toBe('项目 B')
  await navigation.confirm()
  expect(await result).toBe('completed')
  expect(run).toHaveBeenCalledTimes(1)
  expect(navigation.state.value.pending).toBeUndefined()
})

it('cancels without running the action or changing the caller context', async () => {
  const { navigation, context } = setup()
  const run = vi.fn(() => true)
  const result = navigation.request({ label: '任务与版本', run })
  navigation.cancel()
  expect(await result).toBe('cancelled')
  expect(context).toEqual({ dirty: true, session: 1 })
  expect(run).not.toHaveBeenCalled()
  expect(navigation.state.value.error).toBe('')
})

it('executes clean navigation synchronously before yielding', async () => {
  const { navigation, context } = setup()
  context.dirty = false
  const run = vi.fn(() => true)
  const result = navigation.request({ label: '项目 B', run })
  expect(run).toHaveBeenCalledTimes(1)
  expect(navigation.state.value.pending).toBeUndefined()
  expect(await result).toBe('completed')
})

it('blocks automatic navigation from a dirty editor without opening a dialog', async () => {
  const { navigation } = setup()
  const run = vi.fn(() => true)
  expect(await navigation.request({ label: '新任务', run }, true)).toBe('blocked')
  expect(navigation.state.value.pending).toBeUndefined()
  expect(run).not.toHaveBeenCalled()
})

it('does not automatically navigate when a pending save makes the draft clean', async () => {
  const { navigation, context } = setup()
  const run = vi.fn(() => true)
  const result = navigation.request({ label: '项目 B', run })
  context.dirty = false
  expect(run).not.toHaveBeenCalled()
  expect(navigation.state.value.pending?.label).toBe('项目 B')
  await navigation.confirm()
  expect(await result).toBe('completed')
  expect(run).toHaveBeenCalledTimes(1)
})

it('settles a stale intent without applying it to another editing session', async () => {
  const { navigation, context } = setup()
  const run = vi.fn(() => true)
  const result = navigation.request({ label: '项目 B', run })
  context.session++
  await navigation.confirm()
  expect(await result).toBe('cancelled')
  expect(run).not.toHaveBeenCalled()
})

it('preserves the first intent while a confirmation is open', async () => {
  const { navigation } = setup()
  const first = vi.fn(() => true)
  const second = vi.fn(() => true)
  const pending = navigation.request({ label: '项目 B', run: first })
  expect(await navigation.request({ label: '项目 C', run: second })).toBe('blocked')
  expect(await navigation.request({ label: '新任务', run: second }, true)).toBe('blocked')
  expect(navigation.state.value.pending?.label).toBe('项目 B')
  await navigation.confirm()
  expect(await pending).toBe('completed')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).not.toHaveBeenCalled()
})

it('executes an asynchronous logout only once and preserves failures', async () => {
  const { navigation, context } = setup()
  const request = deferred<boolean>()
  const run = vi.fn(() => request.promise)
  const result = navigation.request({ label: '退出登录', run })
  const confirmation = navigation.confirm()
  await navigation.confirm()
  expect(await navigation.request({ label: '退出登录', run })).toBe('blocked')
  expect(run).toHaveBeenCalledTimes(1)
  request.reject(new Error('Logout unavailable'))
  await confirmation
  expect(await result).toBe('failed')
  expect(navigation.state.value.error).toBe('Logout unavailable')
  expect(navigation.state.value.executing).toBe(false)
  expect(context.dirty).toBe(true)
})

it('keeps an unsuccessful reveal distinguishable from completed navigation', async () => {
  const { navigation, context } = setup()
  context.dirty = false
  expect(await navigation.request({ label: '任务', run: () => false })).toBe('unavailable')
  expect(navigation.state.value.error).toBe('')
})

it('settles invalidated and disposed pending intents without executing them', async () => {
  for (const lifecycle of ['invalidate', 'dispose'] as const) {
    const { navigation } = setup()
    const run = vi.fn(() => true)
    const result = navigation.request({ label: '项目 B', run })
    navigation[lifecycle]()
    expect(await result).toBe('cancelled')
    await navigation.confirm()
    expect(run).not.toHaveBeenCalled()
    expect(navigation.state.value.pending).toBeUndefined()
  }
})

it('does not write navigation errors after disposal during an action', async () => {
  const { navigation, context } = setup()
  context.dirty = false
  const request = deferred<boolean>()
  const result = navigation.request({ label: '退出登录', run: () => request.promise })
  navigation.dispose()
  expect(await result).toBe('cancelled')
  request.reject(new Error('late failure'))
  await Promise.resolve()
  expect(navigation.state.value.error).toBe('')
})

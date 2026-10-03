import { shallowRef } from 'vue'

export type NavigationResult = 'completed' | 'cancelled' | 'blocked' | 'unavailable' | 'failed'
export interface NavigationIntent {
  label: string
  run: () => boolean | Promise<boolean>
}

/** Keep navigation intent separate from its side effects until the user decides. */
export function createDraftNavigation(context: { dirty: () => boolean, session: () => number }) {
  let disposed = false
  let pending: { intent: NavigationIntent, session: number, resolve: (result: NavigationResult) => void } | undefined
  let finishActive: ((result: NavigationResult) => void) | undefined
  const state = shallowRef<{ pending?: { label: string }, executing: boolean, error: string }>({ executing: false, error: '' })

  function execute(intent: NavigationIntent): Promise<NavigationResult> {
    const session = context.session()
    state.value = { executing: true, error: '' }
    return new Promise((resolve) => {
      const finish = (result: NavigationResult) => {
        if (finishActive !== finish) {
          return
        }
        finishActive = undefined
        if (!disposed) {
          state.value = { ...state.value, executing: false }
        }
        resolve(result)
      }
      finishActive = finish
      const fail = (cause: unknown) => {
        if (!disposed && context.session() === session) {
          state.value = { ...state.value, error: cause instanceof Error ? cause.message : '无法前往，请重试' }
        }
        finish(disposed ? 'cancelled' : 'failed')
      }
      try {
        // The action may change navigation synchronously before yielding.
        Promise.resolve(intent.run()).then(completed => finish(disposed ? 'cancelled' : completed ? 'completed' : 'unavailable'), fail)
      }
      catch (cause) { fail(cause) }
    })
  }
  function request(intent: NavigationIntent, automatic = false): Promise<NavigationResult> {
    if (disposed) {
      return Promise.resolve('cancelled')
    }
    if (pending || state.value.executing) {
      return Promise.resolve('blocked')
    }
    if (!context.dirty()) {
      return execute(intent)
    }
    if (automatic) {
      return Promise.resolve('blocked')
    }
    return new Promise((resolve) => {
      pending = { intent, session: context.session(), resolve }
      state.value = { executing: false, error: '', pending: { label: intent.label } }
    })
  }
  function cancel() {
    const previous = pending
    pending = undefined
    state.value = { ...state.value, pending: undefined }
    previous?.resolve('cancelled')
  }
  async function confirm() {
    const previous = pending
    if (!previous) {
      return
    }
    if (disposed || previous.session !== context.session()) {
      cancel()
      return
    }
    pending = undefined
    state.value = { ...state.value, pending: undefined }
    previous.resolve(await execute(previous.intent))
  }
  function invalidate() {
    cancel()
    state.value = { ...state.value, error: '' }
  }
  function dispose() {
    disposed = true
    cancel()
    finishActive?.('cancelled')
  }
  return { state, request, confirm, cancel, invalidate, dispose }
}

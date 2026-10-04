import { shallowRef } from 'vue'
import { ApiError } from '../../api-response'

interface WorkspaceStatus {
  ready: boolean
  pending: boolean
  error: string
  lastUpdated?: number
}
interface WorkspaceOptions<T> {
  initialize: (signal: AbortSignal) => Promise<void>
  read: (signal: AbortSignal) => Promise<T>
  commit: (value: T, selectDefault: boolean) => void
  automatic: () => boolean
  visibilityTarget?: EventTarget
  onlineTarget?: EventTarget
}

const interval = 10_000
const timeout = 30_000
const maximumBackoff = 60_000

/** Own bootstrap, reads and timers together; writes only invalidate old reads. */
export function createWorkspaceRefresh<T>(options: WorkspaceOptions<T>) {
  const state = shallowRef<WorkspaceStatus>({ ready: false, pending: false, error: '' })
  let initialized = false
  let started = false
  let disposed = false
  let authenticationFailed = false
  let epoch = 0
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: { promise: Promise<void>, controller?: AbortController, selectDefault: boolean } | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }
  function schedule() {
    clearTimer()
    if (disposed || authenticationFailed) {
      return
    }
    const delay = Math.min(interval * 2 ** Math.min(Math.max(failures - 1, 0), 3), maximumBackoff)
    timer = setTimeout(() => {
      timer = undefined
      if (options.automatic()) {
        void refresh().catch(() => undefined)
      }
      else { schedule() }
    }, delay)
  }
  function wake() {
    if (started && !disposed && !authenticationFailed && !active && options.automatic()) {
      void refresh().catch(() => undefined)
    }
  }
  async function attempt(controller: AbortController): Promise<T> {
    const { signal } = controller
    let expired: ReturnType<typeof setTimeout> | undefined
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason)
      signal.addEventListener('abort', rejectAbort, { once: true })
      expired = setTimeout(() => controller.abort(new Error('工作空间读取超时，请重试')), timeout)
    })
    const read = async () => {
      signal.throwIfAborted()
      if (!initialized) {
        await options.initialize(signal)
        signal.throwIfAborted()
        initialized = true
      }
      const value = await options.read(signal)
      signal.throwIfAborted()
      return value
    }
    try {
      // A transport or response parser may ignore abort; its late settlement
      // remains observed, but cannot keep this owner or its callers waiting.
      return await Promise.race([read(), cancelled])
    }
    finally {
      clearTimeout(expired)
      signal.removeEventListener('abort', rejectAbort)
    }
  }
  function refresh(selectDefault = true): Promise<void> {
    if (disposed) {
      return Promise.reject(new DOMException('Workspace disposed', 'AbortError'))
    }
    if (!started) {
      started = true
      options.visibilityTarget?.addEventListener('visibilitychange', wake)
      options.onlineTarget?.addEventListener('online', wake)
    }
    if (active) {
      // An editor's explicit refresh(false) must not adopt a default project
      // merely because it joins a background read of the same workspace.
      active.selectDefault &&= selectDefault
      return active.promise
    }
    clearTimer()
    authenticationFailed = false
    state.value = { ...state.value, pending: true }
    const flight = { promise: Promise.resolve(), controller: undefined as AbortController | undefined, selectDefault }
    active = flight
    flight.promise = Promise.resolve().then(async () => {
      try {
        for (;;) {
          if (disposed) {
            throw new DOMException('Workspace disposed', 'AbortError')
          }
          const revision = epoch
          const controller = new AbortController()
          flight.controller = controller
          let value: T
          try {
            value = await attempt(controller)
          }
          catch (cause) {
            if (!disposed && revision !== epoch) {
              continue
            }
            throw cause
          }
          if (disposed) {
            throw new DOMException('Workspace disposed', 'AbortError')
          }
          if (revision !== epoch) {
            continue
          }
          options.commit(value, flight.selectDefault)
          failures = 0
          state.value = { ready: true, pending: true, error: '', lastUpdated: Date.now() }
          return
        }
      }
      catch (cause) {
        if (!disposed) {
          failures++
          authenticationFailed = cause instanceof ApiError && cause.status === 401
          if (authenticationFailed) {
            initialized = false
          }
          state.value = { ...state.value, error: cause instanceof Error ? cause.message : '工作空间暂时无法读取，请重试' }
        }
        throw cause
      }
      finally {
        if (active === flight) {
          active = undefined
          if (!disposed) {
            state.value = { ...state.value, pending: false }
            schedule()
          }
        }
      }
    })
    return flight.promise
  }
  function invalidate() {
    if (disposed) {
      return
    }
    epoch++
    // Keep logical callers pending until a new-epoch read is accepted. A
    // discarded old read must not look like successful editor recovery.
    active?.controller?.abort(new DOMException('Workspace changed', 'AbortError'))
  }
  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    epoch++
    clearTimer()
    options.visibilityTarget?.removeEventListener('visibilitychange', wake)
    options.onlineTarget?.removeEventListener('online', wake)
    active?.controller?.abort(new DOMException('Workspace disposed', 'AbortError'))
    state.value = { ...state.value, pending: false }
  }
  return { state, refresh, invalidate, dispose }
}

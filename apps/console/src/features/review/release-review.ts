import type { Job, ReleasePreview } from '@iconctl/console-contracts'
import { shallowRef } from 'vue'
import { ApiError } from '../../api-response'

export interface ReleaseContext {
  projectId: string
  snapshotId: string
  bump: 'patch' | 'minor' | 'major'
}

interface ReleaseState {
  open: boolean
  context?: ReleaseContext
  confirmation?: ReleasePreview
  idempotencyKey?: string
  pending?: 'preview' | 'publish'
  error: string
  needsPreview: boolean
  failedPublish: boolean
}

interface Dependencies {
  preview: (context: ReleaseContext, signal: AbortSignal) => Promise<ReleasePreview>
  publish: (context: ReleaseContext, confirmationId: string, idempotencyKey: string) => Promise<Job>
  published: (job: Job, current: boolean) => Promise<void>
}

const empty = (): ReleaseState => ({ open: false, error: '', needsPreview: false, failedPublish: false })

/** Dialog ownership is independent from the server's publication job lifetime. */
export function createReleaseReview(dependencies: Dependencies) {
  const state = shallowRef<ReleaseState>(empty())
  const keys = new Map<string, string>()
  let generation = 0
  let controller: AbortController | undefined
  let disposed = false

  function close() {
    generation++
    controller?.abort()
    controller = undefined
    state.value = empty()
  }

  async function preview() {
    const context = state.value.context
    if (!state.value.open || !context || state.value.pending) {
      return
    }
    const request = ++generation
    controller?.abort()
    controller = new AbortController()
    state.value = { ...state.value, pending: 'preview', error: '', needsPreview: true, failedPublish: false }
    try {
      const confirmation = await dependencies.preview(context, controller.signal)
      if (request !== generation) {
        return
      }
      const idempotencyKey = keys.get(confirmation.id) ?? crypto.randomUUID()
      keys.set(confirmation.id, idempotencyKey)
      state.value = { open: true, context, confirmation, idempotencyKey, error: '', needsPreview: false, failedPublish: false }
    }
    catch (cause) {
      if (request === generation) {
        state.value = { ...state.value, pending: undefined, error: cause instanceof Error ? cause.message : '发布预览失败，请重试' }
      }
    }
    finally {
      if (request === generation) {
        controller = undefined
      }
    }
  }

  async function open(context: ReleaseContext) {
    close()
    state.value = { ...empty(), open: true, context }
    await preview()
  }

  async function publish() {
    const { context, confirmation, idempotencyKey } = state.value
    if (!state.value.open || !context || !confirmation || !idempotencyKey || state.value.pending || state.value.needsPreview) {
      return
    }
    const request = generation
    state.value = { ...state.value, pending: 'publish', error: '' }
    let job: Job
    try {
      // Keep this key after an ambiguous response: the confirmation may already
      // be consumed, while the server can still return the job for the same key.
      job = await dependencies.publish(context, confirmation.id, idempotencyKey)
    }
    catch (cause) {
      if (request === generation) {
        state.value = {
          ...state.value,
          pending: undefined,
          error: cause instanceof Error ? cause.message : '发布请求失败，请重试',
          needsPreview: cause instanceof ApiError && [404, 409, 410].includes(cause.status),
          failedPublish: true,
        }
      }
      return
    }
    const current = request === generation
    if (current) {
      close()
    }
    if (!disposed) {
      await dependencies.published(job, current)
    }
  }

  function dispose() {
    disposed = true
    close()
    keys.clear()
  }

  return { state, open, preview, publish, close, dispose }
}

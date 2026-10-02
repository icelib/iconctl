import type { SnapshotPreview } from '@iconctl/console-contracts'
import { shallowRef } from 'vue'

interface Selection {
  id: string
  compareTo: string
}

interface ReviewState {
  committed?: Selection & { preview: SnapshotPreview }
  pending?: Selection
  error: string
}

/** One committed selection owns its image, comparison and downloads together. */
export function createSnapshotReview(load: (id: string, compareTo: string, signal: AbortSignal) => Promise<SnapshotPreview>) {
  const state = shallowRef<ReviewState>({ error: '' })
  let generation = 0
  let controller: AbortController | undefined

  function invalidate(clear = false) {
    generation++
    controller?.abort()
    controller = undefined
    state.value = { ...(clear ? {} : { committed: state.value.committed }), error: '' }
  }

  async function open(id: string, compareTo = '') {
    invalidate()
    if (!id) {
      return
    }
    const request = generation
    controller = new AbortController()
    state.value = { ...state.value, pending: { id, compareTo } }
    try {
      const preview = await load(id, compareTo, controller.signal)
      // Abort does not prevent an already received response from finishing JSON.
      if (request === generation) {
        state.value = { committed: { id, compareTo, preview }, error: '' }
      }
    }
    catch (cause) {
      if (request === generation) {
        state.value = { committed: state.value.committed, error: cause instanceof Error ? cause.message : '快照加载失败，请重试' }
      }
    }
    finally {
      if (request === generation) {
        controller = undefined
      }
    }
  }

  return { state, open, invalidate }
}

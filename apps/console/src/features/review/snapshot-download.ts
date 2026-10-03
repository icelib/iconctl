import type { Snapshot } from '@iconctl/console-contracts'
import { shallowRef } from 'vue'

type Result = 'downloaded' | 'failed' | 'cancelled' | 'blocked'

interface DownloadLink {
  append: () => void
  click: () => void
  remove: () => void
}
interface DownloadTarget {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  createLink: (url: string, filename: string) => DownloadLink
}

export function saveBlobDownload(blob: Blob, filename: string, target: DownloadTarget) {
  const url = target.createObjectURL(blob)
  let link: DownloadLink | undefined
  try {
    link = target.createLink(url, filename)
    link.append()
    link.click()
  }
  finally {
    try {
      link?.remove()
    }
    finally {
      target.revokeObjectURL(url)
    }
  }
}

/** A download belongs to the review that requested it, including after A→B→A. */
export function createSnapshotDownload(
  download: (id: string, signal: AbortSignal) => Promise<Blob>,
  save: (blob: Blob, filename: string) => void,
) {
  const state = shallowRef({ pending: false, error: '', message: '' })
  let disposed = false
  let active: { controller: AbortController, settle: (result: Result) => void } | undefined

  function invalidate() {
    const previous = active
    active = undefined
    previous?.controller.abort()
    previous?.settle('cancelled')
    state.value = { pending: false, error: '', message: '' }
  }

  function start(snapshot: Pick<Snapshot, 'id' | 'digest'>): Promise<Result> {
    if (disposed || active) {
      return Promise.resolve('blocked')
    }
    const id = snapshot.id
    const filename = `iconctl-svg-${id}-${snapshot.digest.slice(0, 12)}.zip`
    return new Promise((settle) => {
      const request = { controller: new AbortController(), settle }
      active = request
      state.value = { pending: true, error: '', message: '正在准备 SVG 下载…' }
      void (async () => {
        try {
          const blob = await download(id, request.controller.signal)
          if (active !== request) {
            return
          }
          save(blob, filename)
          state.value = { pending: false, error: '', message: '已发起下载' }
          settle('downloaded')
        }
        catch (cause) {
          if (active === request) {
            state.value = { pending: false, error: cause instanceof Error ? cause.message : 'SVG 下载失败，请重试', message: '' }
            settle('failed')
          }
        }
        finally {
          if (active === request) {
            active = undefined
          }
        }
      })()
    })
  }

  return {
    state,
    start,
    invalidate,
    dispose() {
      disposed = true
      invalidate()
    },
  }
}

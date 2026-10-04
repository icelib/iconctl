import type { SnapshotPreview } from '@iconctl/console-contracts'
import type { ReportFormat } from './comparison-report'
import { shallowRef } from 'vue'
import { createComparisonReport } from './comparison-report-render'

type Result = 'downloaded' | 'failed' | 'cancelled' | 'blocked'

export function createComparisonReportDownload(options: {
  current: () => SnapshotPreview | undefined
  blocked: () => boolean
  save: (blob: Blob, filename: string) => void
  build?: typeof createComparisonReport
}) {
  const state = shallowRef({ pending: false, error: '', message: '' })
  let disposed = false
  let active: { controller: AbortController, settle: (result: Result) => void } | undefined
  function invalidate() {
    const old = active
    active = undefined
    old?.controller.abort()
    old?.settle('cancelled')
    state.value = { pending: false, error: '', message: '' }
  }
  function start(format: ReportFormat): Promise<Result> {
    const preview = options.current()
    if (disposed || active || !preview || options.blocked()) {
      return Promise.resolve('blocked')
    }
    return new Promise((settle) => {
      const request = { controller: new AbortController(), settle }
      active = request
      state.value = { pending: true, error: '', message: '正在准备比较报告…' }
      void (async () => {
        try {
          const result = await (options.build ?? createComparisonReport)(preview, format, request.controller.signal)
          if (active !== request) {
            return
          }
          if (options.current() !== preview || options.blocked()) {
            invalidate()
            return
          }
          options.save(result.blob, result.filename)
          if (active !== request) {
            return
          }
          state.value = { pending: false, error: '', message: '已发起比较报告下载' }
          settle('downloaded')
        }
        catch (cause) {
          if (active === request) {
            if (options.current() !== preview || options.blocked()) {
              invalidate()
              return
            }
            state.value = { pending: false, error: cause instanceof Error ? cause.message : '比较报告下载失败，请重试', message: '' }
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

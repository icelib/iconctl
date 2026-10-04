import type { SnapshotPreview } from '@iconctl/console-contracts'
import type { DiagnosticTarget } from './snapshot-diagnostics'
import { shallowRef } from 'vue'
import { diagnosticIdentityKey, diagnosticLocation, diagnosticTargetKey } from './snapshot-diagnostics'

interface CopyState { pending: boolean, target: string, text: string, error: string, message: string }
type CopyResult = 'copied' | 'failed' | 'cancelled' | 'blocked'

function nativeWrite(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : (navigator as { clipboard?: { writeText: (text: string) => Promise<void> } }).clipboard
  if (!clipboard?.writeText) {
    throw new Error('浏览器不支持剪贴板写入，请手动复制定位文本')
  }
  return clipboard.writeText(text)
}

// App owns this controller: unmounting a diagnostic list must not release a native write.
export function createDiagnosticCopy(options: {
  current: () => SnapshotPreview | undefined
  blocked: () => boolean
  write?: (text: string) => Promise<void>
}) {
  let active: object | undefined
  const empty = (): CopyState => ({ pending: !!active, target: '', text: '', error: '', message: '' })
  let generation = 0
  let disposed = false
  let suspended = false
  const state = shallowRef<CopyState>(empty())
  function invalidate() {
    generation++
    if (!disposed && !suspended) {
      state.value = empty()
    }
  }
  function capture(target: DiagnosticTarget) {
    const preview = options.current()
    if (disposed || suspended || options.blocked() || !preview || diagnosticIdentityKey(preview.snapshot) !== target.identity) {
      return undefined
    }
    return diagnosticLocation(preview, target)
  }
  function failure(target: DiagnosticTarget, cause: unknown, text = '') {
    state.value = { ...empty(), target: diagnosticTargetKey(target), text, error: cause instanceof Error ? cause.message : '复制失败，请手动复制定位文本', message: '' }
  }
  function showText(target: DiagnosticTarget) {
    try {
      const text = capture(target)
      if (text === undefined) {
        return
      }
      invalidate()
      state.value = { ...empty(), target: diagnosticTargetKey(target), text, message: '选择定位文本后，使用系统复制快捷键', error: '' }
    }
    catch (cause) {
      invalidate()
      failure(target, cause)
    }
  }
  function start(target: DiagnosticTarget): Promise<CopyResult> {
    if (active || disposed || suspended) {
      return Promise.resolve('blocked')
    }
    let text: string | undefined
    try {
      text = capture(target)
    }
    catch (cause) {
      invalidate()
      failure(target, cause)
      return Promise.resolve('failed')
    }
    if (text === undefined) {
      return Promise.resolve('blocked')
    }
    invalidate()
    const requestGeneration = generation
    const request = {}
    active = request
    state.value = { ...empty(), target: diagnosticTargetKey(target), message: '正在复制定位信息…' }
    const current = () => !disposed && !suspended && generation === requestGeneration && !options.blocked()
      && options.current() !== undefined && diagnosticIdentityKey(options.current()!.snapshot) === target.identity
    const finish = (cause?: unknown, failed = false): CopyResult => {
      if (active === request) {
        active = undefined
      }
      if (disposed || suspended) {
        return 'cancelled'
      }
      if (!current()) {
        // A late callback may only unlock. Preserve the current manual text/feedback.
        state.value = { ...state.value, pending: false }
        return 'cancelled'
      }
      if (failed) {
        failure(target, cause, text)
        return 'failed'
      }
      state.value = { ...empty(), target: diagnosticTargetKey(target), message: '已复制定位信息' }
      return 'copied'
    }
    try {
      // No await before this call: clipboard activation belongs to the user's click.
      const pending = options.write ? options.write(text) : nativeWrite(text)
      return Promise.resolve(pending).then(() => finish(), cause => finish(cause, true))
    }
    catch (cause) { return Promise.resolve(finish(cause, true)) }
  }
  return {
    state,
    start,
    showText,
    invalidate,
    suspend() {
      invalidate()
      suspended = true
    },
    resume() {
      if (!disposed) {
        suspended = false
        invalidate()
      }
    },
    dispose() {
      invalidate()
      disposed = true
    },
  }
}

export type DiagnosticCopy = ReturnType<typeof createDiagnosticCopy>

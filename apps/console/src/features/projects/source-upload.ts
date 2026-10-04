import type { Source, UploadKind } from '@iconctl/console-contracts'
import { computed, shallowRef } from 'vue'

type UploadSource = Extract<Source, { type: 'directory' | 'jsdesign' | 'iconify' }>
type UploadResult = 'uploaded' | 'failed' | 'cancelled' | 'blocked'
interface UploadState {
  fileName: string
  phase: 'pending' | 'uploaded' | 'failed' | 'cancelled'
  error: string
}
interface UploadEntry {
  source: UploadSource
  session: number
  kind: UploadKind
  input: { file?: string, upload?: string }
  state: UploadState
  file?: File
  cancel?: () => void
}

/** An upload belongs to one source object in one editing session. */
export function createSourceUpload(options: {
  sources: () => Source[]
  session: () => number
  upload: (file: File, signal: AbortSignal, kind: UploadKind) => Promise<string>
}) {
  let disposed = false
  let nextKey = 0
  const keys = new WeakMap<Source, number>()
  const entries = new Map<Source, UploadEntry>()
  const state = shallowRef<ReadonlyMap<Source, UploadState>>(new Map())
  const pending = computed(() => [...state.value.values()].some(item => item.phase === 'pending'))

  function key(source: Source) {
    if (!keys.has(source)) {
      keys.set(source, ++nextKey)
    }
    return keys.get(source)!
  }
  function current(entry: UploadEntry) {
    return !disposed && entry.session === options.session()
      && entries.get(entry.source) === entry && options.sources().includes(entry.source)
      && (entry.kind === 'iconify-json'
        ? entry.source.type === 'iconify' && entry.source.file === entry.input.file && entry.source.upload === entry.input.upload
        : entry.source.type === 'directory' || entry.source.type === 'jsdesign')
  }
  function publish(entry: UploadEntry) {
    state.value = new Map(state.value).set(entry.source, entry.state)
  }
  function forget(source: Source) {
    const entry = entries.get(source)
    entry?.cancel?.()
    if (entry) {
      entry.file = undefined
    }
    entries.delete(source)
    const next = new Map(state.value)
    next.delete(source)
    state.value = next
  }
  function start(source: Source, file: File): Promise<UploadResult> {
    if (disposed || !options.sources().includes(source)) {
      return Promise.resolve('cancelled')
    }
    if (pending.value || (!('dir' in source) && source.type !== 'iconify')) {
      return Promise.resolve('blocked')
    }
    const entry: UploadEntry = {
      source,
      file,
      session: options.session(),
      kind: source.type === 'iconify' ? 'iconify-json' : 'svg-zip',
      input: { ...('file' in source ? { file: source.file } : {}), upload: source.upload },
      state: { fileName: file.name, phase: 'pending', error: '' },
    }
    const directory = 'dir' in source ? source.dir : undefined
    const controller = new AbortController()
    entries.set(source, entry)
    publish(entry)
    return new Promise((resolve) => {
      let settled = false
      function finish(result: Exclude<UploadResult, 'blocked'>, error = '') {
        if (settled) {
          return
        }
        settled = true
        entry.cancel = undefined
        entry.state = { ...entry.state, phase: result, error }
        if (result !== 'failed') {
          entry.file = undefined
        }
        if (current(entry)) {
          publish(entry)
        }
        else if (entries.get(source) === entry) {
          forget(source)
        }
        resolve(result)
      }
      entry.cancel = () => {
        finish('cancelled')
        controller.abort()
      }
      const failed = (cause: unknown) => {
        if (settled) {
          return
        }
        if (!current(entry) || controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
          finish('cancelled')
          return
        }
        finish('failed', cause instanceof Error ? cause.message : '上传失败，请重试')
      }
      try {
        Promise.resolve(options.upload(file, controller.signal, entry.kind)).then((id) => {
          if (settled) {
            return
          }
          if (!current(entry)) {
            finish('cancelled')
            return
          }
          if (source.type === 'iconify') {
            delete source.file
            source.upload = id
            entry.input = { upload: id }
          }
          else {
            source.upload = id
            if (source.dir === directory) {
              source.dir = 'svg'
            }
          }
          finish('uploaded')
        }, failed)
      }
      catch (cause) { failed(cause) }
    })
  }
  function retry(source: Source) {
    const entry = entries.get(source)
    if (!entry || !current(entry) || entry.state.phase !== 'failed' || !entry.file) {
      return Promise.resolve<UploadResult>('blocked')
    }
    return start(source, entry.file)
  }
  function cancel(source: Source) {
    entries.get(source)?.cancel?.()
  }
  function prune() {
    for (const [source, entry] of entries) {
      if (!current(entry)) {
        forget(source)
      }
    }
  }
  function invalidate() {
    for (const source of entries.keys()) {
      forget(source)
    }
  }
  function dispose() {
    disposed = true
    invalidate()
  }
  return { pending, key, get: (source: Source) => state.value.get(source), start, retry, cancel, forget, prune, invalidate, dispose }
}

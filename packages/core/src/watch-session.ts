import type { LoadConfigOptions } from './load-config'
import type { SyncResult } from './sync'
import type { WatchConfigSnapshot } from './watch-config-snapshot'
import type { LoadedWatchConfig, WatchRequest, WatchResponse } from './watch-protocol'
import process from 'node:process'
import { SHARE_ENV, Worker } from 'node:worker_threads'
import { IconctlError } from './errors'
import { packWatchFailure, unpackWatchFailure } from './watch-protocol'

export interface WatchSession {
  load: (options: LoadConfigOptions, onConfigFile: (file: string) => void, onConfigRead?: (snapshot: WatchConfigSnapshot) => void) => Promise<LoadedWatchConfig>
  sync: (options: { signal: AbortSignal, dryRun?: boolean, continueOnError?: boolean }) => Promise<SyncResult>
  close: () => Promise<void>
}

/** A configuration and its native module graph live until that version is retired. */
export function createWatchSession(cwd: string, onFailure: (error: unknown) => void): WatchSession {
  // --input-type describes eval/stdin, and Node rejects it for a file worker.
  // Keep the parent's import loaders, conditions and other execution options.
  const execArgv = process.execArgv.filter((argument, index, arguments_) => argument !== '--input-type'
    && !argument.startsWith('--input-type=') && arguments_[index - 1] !== '--input-type')
  const worker = new Worker(new URL('./watch-worker.mjs', import.meta.url), {
    env: SHARE_ENV,
    ...(execArgv.length !== process.execArgv.length ? { execArgv } : {}),
    workerData: { cwd, argv: [...process.argv] },
  })
  const pending = new Map<number, {
    resolve: (value: LoadedWatchConfig | SyncResult) => void
    reject: (error: unknown) => void
    settled: Promise<unknown>
    onConfigFile?: (file: string) => void
    onConfigRead?: (snapshot: WatchConfigSnapshot) => void
  }>()
  let nextId = 0
  let failure: unknown
  let failed = false
  let closing = false
  let closed: Promise<void> | undefined
  const fail = (error: unknown) => {
    if (failed || closing) {
      return
    }
    failed = true
    failure = error
    for (const request of pending.values()) {
      request.reject(error)
    }
    pending.clear()
    onFailure(error)
  }
  worker.on('error', fail)
  worker.on('exit', code => fail(new IconctlError(`Watch configuration worker exited unexpectedly (${code}).`)))
  worker.on('message', (message: WatchResponse) => {
    const request = pending.get(message.id)
    if (!request) {
      return
    }
    if (message.type === 'config-file') {
      request.onConfigFile?.(message.file)
      return
    }
    if (message.type === 'config-snapshot') {
      request.onConfigRead?.(message.snapshot)
      return
    }
    pending.delete(message.id)
    if (message.type === 'error') {
      try {
        request.reject(unpackWatchFailure(message.error))
      }
      catch (error) {
        request.reject(error)
      }
    }
    else {
      request.resolve(message.value)
    }
  })
  const request = (message: WatchRequest, onConfigFile?: (file: string) => void, onConfigRead?: (snapshot: WatchConfigSnapshot) => void) => {
    if (failed || closing) {
      return Promise.reject(failure ?? new IconctlError('Watch configuration worker is closed.'))
    }
    let resolve!: (value: LoadedWatchConfig | SyncResult) => void
    let reject!: (error: unknown) => void
    const result = new Promise<LoadedWatchConfig | SyncResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    pending.set(message.id, { resolve, reject, settled: result.catch(() => {}), ...(onConfigFile ? { onConfigFile } : {}), ...(onConfigRead ? { onConfigRead } : {}) })
    try {
      worker.postMessage(message)
    }
    catch (error) {
      pending.delete(message.id)
      reject(error)
    }
    return result
  }
  return {
    async load(options, onConfigFile, onConfigRead) {
      return await request({ id: ++nextId, type: 'load', options }, onConfigFile, onConfigRead) as LoadedWatchConfig
    },
    async sync({ signal, ...options }) {
      const id = ++nextId
      const result = request({ id, type: 'sync', ...options })
      const abort = () => {
        if (!failed && !closing && pending.has(id)) {
          worker.postMessage({ id, type: 'abort', reason: packWatchFailure(signal.reason) } satisfies WatchRequest)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
      try {
        return await result as SyncResult
      }
      finally {
        signal.removeEventListener('abort', abort)
      }
    },
    close() {
      closed ??= (async () => {
        // Never interrupt an output transaction or leave an active load behind.
        await Promise.all([...pending.values()].map(request => request.settled))
        closing = true
        await worker.terminate()
      })()
      return closed
    },
  }
}

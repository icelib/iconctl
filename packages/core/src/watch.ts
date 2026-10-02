import type { FSWatcher } from 'chokidar'
import type { ResolvedIconctlConfig } from './config'
import type { SyncResult } from './sync'
import type { WatchPaths } from './watch-paths'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError } from './errors'
import { loadConfigDetails } from './load-config'
import { sync } from './sync'
import { containsPath, isWatchSourceEvent, validateWatchInputs, watchPaths } from './watch-paths'

export type WatchEvent
  = | { type: 'ready', configFile: string, roots: string[] }
    | { type: 'start', runId: number, reason: 'initial' | 'source' | 'config' }
    | { type: 'result', runId: number, result: SyncResult }
    | { type: 'error', runId?: number, phase: 'config' | 'sync' | 'watch', fatal: boolean, error: unknown }
    | { type: 'stopped', reason: 'aborted' | 'error' }

export interface WatchOptions {
  cwd?: string
  configFile?: string
  signal?: AbortSignal
  dryRun?: boolean
  continueOnError?: boolean
  onEvent: (event: WatchEvent) => void
}

/** Watch local SVG sources until cancelled. Config edits invalidate any active run. */
export async function watch(options: WatchOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const watchers = new Set<FSWatcher>()
  let currentWatcher: FSWatcher | undefined
  let configFile = options.configFile
  let config: ResolvedIconctlConfig | undefined
  let paths: WatchPaths | undefined
  let active: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let fatal: unknown
  let revision = 0
  let configDirty = true
  let sourceDirty = false
  let due = 0
  let runId = 0
  let initialized = false
  let closing = false
  const notify = () => wake?.()
  const stop = () => {
    active?.abort(options.signal?.reason)
    notify()
  }
  const emit = (event: WatchEvent) => options.onEvent(event)
  const failWatcher = (error: unknown) => {
    fatal = error
    active?.abort(error)
    notify()
  }
  const wait = async (milliseconds?: number) => {
    await new Promise<void>((resolveWait) => {
      wake = resolveWait
      if (milliseconds !== undefined) {
        timer = setTimeout(resolveWait, milliseconds)
      }
    })
    clearTimeout(timer)
    timer = undefined
    wake = undefined
  }
  const install = async (next: WatchPaths) => {
    let listener: FSWatcher
    try {
      listener = watchFiles([...new Set([...next.roots, ...next.configFiles].map(dirname))], {
        ignoreInitial: true,
        atomic: true,
        ignored: next.ignored,
      })
    }
    catch (error) {
      failWatcher(error)
      throw error
    }
    watchers.add(listener)
    listener.on('error', failWatcher)
    listener.on('all', (event, input) => {
      if (closing || !watchers.has(listener)) {
        return
      }
      const file = resolve(input)
      if (next.configFiles.includes(file)) {
        revision++
        configDirty = true
        sourceDirty = false
        due = Date.now() + 150
        active?.abort('Configuration changed')
        notify()
      }
      else if (config && isWatchSourceEvent(next, event, file)) {
        sourceDirty = true
        due = Date.now() + 150
        notify()
      }
    })
    await new Promise<void>((resolveReady, rejectReady) => {
      const handlers = {
        ready() {
          handlers.finish()
          resolveReady()
        },
        error(error: unknown) {
          handlers.finish()
          rejectReady(error)
        },
        aborted() {
          handlers.finish()
          rejectReady(new IconctlAbortError(options.signal?.reason))
        },
        finish() {
          listener.off('ready', handlers.ready)
          listener.off('error', handlers.error)
          options.signal?.removeEventListener('abort', handlers.aborted)
        },
      }
      listener.once('ready', handlers.ready)
      listener.once('error', handlers.error)
      options.signal?.addEventListener('abort', handlers.aborted, { once: true })
      if (options.signal?.aborted) {
        handlers.aborted()
      }
    })
    const previous = currentWatcher
    currentWatcher = listener
    if (previous) {
      watchers.delete(previous)
      await previous.close()
    }
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    while (!options.signal?.aborted) {
      if (fatal) {
        throw fatal
      }
      if (!configDirty && !sourceDirty) {
        await wait()
        continue
      }
      if (due > Date.now()) {
        await wait(due - Date.now())
        continue
      }
      const nextReason = !initialized ? 'initial' : configDirty ? 'config' : 'source'
      const currentRevision = revision
      if (configDirty) {
        configDirty = false
        config = undefined
        const attemptedFiles = new Set(paths?.configFiles ?? [])
        try {
          // Once resolved, deletion must pause watch instead of selecting another config.
          if (initialized && configFile) {
            await access(resolve(cwd, configFile))
          }
          const loaded = await loadConfigDetails({ cwd, ...(configFile ? { configFile } : {}) }, true, file => attemptedFiles.add(file))
          const nextPaths = await watchPaths(loaded.config, cwd, loaded.files)
          if (revision !== currentRevision || options.signal?.aborted) {
            continue
          }
          await install(nextPaths)
          if (revision !== currentRevision || options.signal?.aborted) {
            continue
          }
          config = loaded.config
          paths = nextPaths
          configFile = loaded.config.configFile
          initialized = true
          emit({ type: 'ready', configFile: configFile!, roots: paths.roots })
        }
        catch (error) {
          if (options.signal?.aborted) {
            break
          }
          if (fatal) {
            throw error
          }
          emit({ type: 'error', phase: 'config', fatal: !initialized, error })
          if (!initialized) {
            throw error
          }
          if (paths && [...attemptedFiles].some(file => !paths!.configFiles.includes(file))) {
            const previousIgnored = paths.ignored
            const nextFiles = [...attemptedFiles]
            paths = {
              ...paths,
              configFiles: nextFiles,
              ignored: file => !nextFiles.some(config => containsPath(file, config)) && previousIgnored(file),
            }
            await install(paths)
            // The newly referenced file may have appeared while the replacement
            // listener was starting with ignoreInitial. Recheck once after ready.
            configDirty = true
            due = Date.now() + 150
          }
          continue
        }
      }
      sourceDirty = false
      if (options.signal?.aborted || fatal) {
        continue
      }
      if (!config || !paths) {
        continue
      }
      const id = ++runId
      active = new AbortController()
      emit({ type: 'start', runId: id, reason: nextReason })
      try {
        await validateWatchInputs(paths, active.signal)
        const result = await sync({
          cwd,
          config,
          signal: active.signal,
          ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
          ...(options.continueOnError !== undefined ? { continueOnError: options.continueOnError } : {}),
        })
        if (!active.signal.aborted) {
          emit({ type: 'result', runId: id, result })
        }
      }
      catch (error) {
        if (!active.signal.aborted) {
          emit({ type: 'error', runId: id, phase: 'sync', fatal: false, error })
        }
      }
      finally {
        active = undefined
      }
    }
    throw new IconctlAbortError(options.signal?.reason)
  }
  catch (error) {
    if (fatal && !options.signal?.aborted) {
      emit({ type: 'error', phase: 'watch', fatal: true, error: fatal })
    }
    throw error
  }
  finally {
    closing = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    await Promise.all([...watchers].map(listener => listener.close()))
    emit({ type: 'stopped', reason: options.signal?.aborted ? 'aborted' : 'error' })
  }
}

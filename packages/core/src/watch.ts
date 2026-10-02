import type { FSWatcher } from 'chokidar'
import type { ResolvedIconctlConfig } from './config'
import type { SyncResult } from './sync'
import type { WatchPaths } from './watch-paths'
import { access, readlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError } from './errors'
import { loadConfigDetails } from './load-config'
import { sync } from './sync'
import { containsPath, isWatchSourceEvent, validateWatchInputs, watchConfigFiles, watchPaths } from './watch-paths'

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
  const dirtySource = () => {
    sourceDirty = true
    due = Date.now() + 150
    notify()
  }
  const dirtyConfig = () => {
    revision++
    configDirty = true
    sourceDirty = false
    due = Date.now() + 150
    active?.abort('Configuration changed')
    notify()
  }
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
  const closeWatcher = async (listener: FSWatcher) => {
    watchers.delete(listener)
    const closed = listener.close()
    // Chokidar removes all listeners synchronously but can still finish a pending
    // stat afterwards. A closed watcher owns those late errors; it starts no work.
    listener.on('error', () => {})
    await closed
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
  const watchedDirectories = (next: WatchPaths) => [...new Set([
    ...next.observedRoots,
    ...next.observedSourceFiles,
    ...next.observedConfigFiles,
  ].map(dirname))].sort()
  const install = async (next: WatchPaths, signal = options.signal) => {
    let listener: FSWatcher
    let starting = true
    try {
      listener = watchFiles(watchedDirectories(next), {
        ignoreInitial: true,
        atomic: true,
        followSymlinks: false,
        ignored: next.ignored,
      })
    }
    catch (error) {
      failWatcher(error)
      throw error
    }
    watchers.add(listener)
    listener.on('error', failWatcher)
    listener.on('all', (event, input, stats) => {
      if (closing || !watchers.has(listener)) {
        return
      }
      // With followSymlinks disabled, Chokidar emits initial link discovery as
      // add even with ignoreInitial. The following sync validates that snapshot.
      if (starting && event === 'add' && stats?.isSymbolicLink()) {
        return
      }
      const file = resolve(input)
      if (next.observedConfigFiles.includes(file)) {
        dirtyConfig()
      }
      else if (config && isWatchSourceEvent(next, event, file, stats?.isSymbolicLink())) {
        dirtySource()
      }
    })
    listener.on('raw', (event, input, details) => {
      const watchedPath = typeof details === 'object' && details !== null && 'watchedPath' in details && typeof details.watchedPath === 'string'
        ? details.watchedPath
        : undefined
      // Raw change also reports access-time updates from our own reads. Only
      // rename describes entry topology; normal content changes use all-events.
      if (event !== 'rename' || starting || closing || !watchers.has(listener) || !input || !watchedPath) {
        return
      }
      const file = resolve(watchedPath, input)
      if (next.ignored(file)) {
        return
      }
      const configuration = next.observedConfigFiles.includes(file)
      if (!configuration && (!config || (!next.observedSourceFiles.includes(file) && !next.observedRoots.some(root => containsPath(root, file))))) {
        return
      }
      // Chokidar emits no all-event for dangling or self-referential links.
      // Compare the link itself with the installed snapshot. Raw rename can also
      // replay an entry's creation from before readiness, which is not a change.
      void readlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EINVAL') {
          return undefined
        }
        throw error
      }).then((target) => {
        if (closing || !watchers.has(listener) || next.linkTargets.get(file) === target) {
          return
        }
        if (target === undefined) {
          next.linkTargets.delete(file)
        }
        else {
          next.linkTargets.set(file, target)
          next.links.add(file)
        }
        if (configuration) {
          dirtyConfig()
        }
        else {
          dirtySource()
        }
      }).catch((error: unknown) => {
        if (!closing && watchers.has(listener)) {
          failWatcher(error)
        }
      })
    })
    try {
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
            rejectReady(new IconctlAbortError(signal?.reason))
          },
          finish() {
            listener.off('ready', handlers.ready)
            listener.off('error', handlers.error)
            signal?.removeEventListener('abort', handlers.aborted)
          },
        }
        listener.once('ready', handlers.ready)
        listener.once('error', handlers.error)
        signal?.addEventListener('abort', handlers.aborted, { once: true })
        if (signal?.aborted) {
          handlers.aborted()
        }
      })
      starting = false
    }
    catch (error) {
      await closeWatcher(listener)
      throw error
    }
    const previous = currentWatcher
    currentWatcher = listener
    if (previous) {
      await closeWatcher(previous)
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
          const nextPaths = await watchPaths(loaded.config, cwd, loaded.files, options.signal)
          if (revision !== currentRevision || options.signal?.aborted) {
            continue
          }
          await install(nextPaths)
          if (revision !== currentRevision || options.signal?.aborted) {
            continue
          }
          config = loaded.config
          paths = nextPaths
          configFile = loaded.entryFile
          initialized = true
          emit({ type: 'ready', configFile: configFile!, roots: [...paths.roots, ...paths.sourceFiles] })
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
            const nextFiles = [...attemptedFiles]
            paths = await watchConfigFiles(paths, nextFiles)
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
        const nextPaths = await validateWatchInputs(paths, active.signal)
        const topology = (item: WatchPaths) => JSON.stringify([
          item.observedRoots,
          item.observedSourceFiles,
          item.observedConfigFiles,
          [...item.links],
        ].map(items => [...items].sort()))
        if (topology(paths) !== topology(nextPaths)) {
          await install(nextPaths, active.signal)
          paths = nextPaths
        }
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
    await Promise.all([...watchers].map(closeWatcher))
    emit({ type: 'stopped', reason: options.signal?.aborted ? 'aborted' : 'error' })
  }
}

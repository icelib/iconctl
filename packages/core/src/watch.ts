import type { FSWatcher } from 'chokidar'
import type { SyncResult } from './sync'
import type { WatchConfigSnapshot } from './watch-config-snapshot'
import type { WatchPaths } from './watch-paths'
import type { WatchSession } from './watch-session'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { watch as watchFiles } from 'chokidar'
import { throwIfAborted } from './abort'
import { IconctlAbortError } from './errors'
import { watchConfigChangedSinceRead } from './watch-config-snapshot'
import { createWatchObserver } from './watch-observer'
import { isWatchSourceEvent, validateWatchInputs, watchConfigFiles, watchPaths } from './watch-paths'
import { createWatchSession } from './watch-session'

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
  let session: WatchSession | undefined
  let configReady = false
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
  let observer: ReturnType<typeof createWatchObserver>
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
    observer.stop()
    notify()
  }
  const emit = (event: WatchEvent) => options.onEvent(event)
  const failWatcher = (error: unknown) => {
    fatal = error
    active?.abort(error)
    observer.stop()
    notify()
  }
  observer = createWatchObserver((configuration) => {
    if (closing || options.signal?.aborted) {
      return
    }
    if (configuration) {
      dirtyConfig()
    }
    else if (configReady) {
      dirtySource()
    }
  }, failWatcher)
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
    await observer.replace(next)
    throwIfAborted(signal)
    let listener: FSWatcher
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
      const file = resolve(input)
      if (next.observedConfigFiles.includes(file) || isWatchSourceEvent(next, event, file, stats?.isSymbolicLink())) {
        observer.request()
      }
    })
    listener.on('raw', (event, input, details) => {
      const watchedPath = typeof details === 'object' && details !== null && 'watchedPath' in details && typeof details.watchedPath === 'string'
        ? details.watchedPath
        : undefined
      // File watchers and directory watchers both expose watchedPath. Both forms
      // are only wake hints; the observer samples actual entries and link states.
      if (event === 'rename' && !closing && watchers.has(listener) && input && watchedPath
        && [resolve(watchedPath, input), resolve(dirname(watchedPath), input)].some(file => !next.ignored(file))) {
        observer.request()
      }
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
        configReady = false
        await session?.close()
        session = undefined
        const attemptedFiles = new Set(paths?.configFiles ?? [])
        let attemptedSnapshot: WatchConfigSnapshot | undefined
        try {
          // Once resolved, deletion must pause watch instead of selecting another config.
          if (initialized && configFile) {
            await access(resolve(cwd, configFile))
          }
          session = createWatchSession(cwd, failWatcher)
          const loaded = await session.load({ cwd, ...(configFile ? { configFile } : {}) }, file => attemptedFiles.add(file), (snapshot) => {
            attemptedSnapshot = snapshot
          })
          const nextPaths = await watchPaths(loaded.input, cwd, loaded.files, options.signal)
          if (revision !== currentRevision || options.signal?.aborted || fatal) {
            continue
          }
          await install(nextPaths)
          if (await watchConfigChangedSinceRead(loaded.configReadSnapshot, options.signal)) {
            dirtyConfig()
          }
          if (revision !== currentRevision || options.signal?.aborted || fatal) {
            continue
          }
          configReady = true
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
          if (attemptedSnapshot && await watchConfigChangedSinceRead(attemptedSnapshot, options.signal)) {
            dirtyConfig()
          }
          continue
        }
        finally {
          if (!configReady) {
            await session?.close()
            session = undefined
          }
        }
      }
      sourceDirty = false
      if (options.signal?.aborted || fatal) {
        continue
      }
      if (!configReady || !session || !paths) {
        continue
      }
      const id = ++runId
      active = new AbortController()
      emit({ type: 'start', runId: id, reason: nextReason })
      try {
        const topology = (item: WatchPaths) => JSON.stringify([
          item.observedRoots,
          item.observedSourceFiles,
          item.observedConfigFiles,
          [...item.links],
        ].map(items => [...items].sort()))
        const rememberLink = (file: string, version: string, target: string) => {
          paths!.missingLinks.delete(file)
          paths!.links.add(file)
          paths!.entryVersions.set(file, version)
          paths!.linkTargets.set(file, target)
        }
        while (true) {
          const before = await observer.check()
          throwIfAborted(active.signal)
          let nextPaths = await validateWatchInputs(paths, active.signal, rememberLink)
          while (topology(paths) !== topology(nextPaths)) {
            await install(nextPaths, active.signal)
            paths = nextPaths
            // Establish the new scope before validating it again. Inputs that
            // change during listener handover must pass a fresh graph check.
            nextPaths = await validateWatchInputs(paths, active.signal, rememberLink)
          }
          const after = await observer.check()
          throwIfAborted(active.signal)
          if (before === after) {
            // Only this unchanged, validated observation is covered by the
            // upcoming import. Later changes remain queued for another run.
            sourceDirty = false
            break
          }
        }
        const result = await session.sync({
          signal: active.signal,
          ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
          ...(options.continueOnError !== undefined ? { continueOnError: options.continueOnError } : {}),
        })
        // Keep the pre-sync baseline: changes made during an import still need
        // a follow-up, even when no native event arrived before it completed.
        await observer.check()
        if (!active.signal.aborted) {
          emit({ type: 'result', runId: id, result })
        }
      }
      catch (error) {
        // The pre-validation sample records the rejected graph. A repair that
        // arrives while validation/import fails must still queue another run.
        await observer.check()
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
    await observer.close()
    await session?.close()
    await Promise.all([...watchers].map(closeWatcher))
    emit({ type: 'stopped', reason: options.signal?.aborted ? 'aborted' : 'error' })
  }
}

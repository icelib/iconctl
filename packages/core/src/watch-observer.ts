import type { Stats } from 'node:fs'
import type { WatchPaths } from './watch-paths'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { dirname, extname, join, parse, relative, resolve, sep } from 'node:path'
import { checkpoint, throwIfAborted } from './abort'
import { watchEntryVersion } from './watch-paths'

interface Snapshot {
  config: Map<string, string>
  source: Map<string, string>
}

class ChangedDirectoryError extends Error {}

/** Sample only approved scopes. A link is an entry, never a traversal instruction. */
async function scan(paths: WatchPaths, signal: AbortSignal): Promise<Snapshot> {
  const result: Snapshot = { config: new Map(), source: new Map() }
  const entries = new Map<string, Promise<{ info?: Stats, target?: string, version: string }>>()
  const entry = (file: string) => {
    let pending = entries.get(file)
    if (!pending) {
      pending = (async () => {
        throwIfAborted(signal)
        try {
          const info = await lstat(file)
          throwIfAborted(signal)
          const target = info.isSymbolicLink() ? await readlink(file) : undefined
          throwIfAborted(signal)
          return { info, ...(target === undefined ? {} : { target }), version: `${watchEntryVersion(info)}${target === undefined ? '' : `:${target}`}` }
        }
        catch (error) {
          throwIfAborted(signal)
          const code = (error as NodeJS.ErrnoException).code
          if (!code) {
            throw error
          }
          // Stable inaccessible/missing states are recoverable, not a retry loop.
          return { version: `error:${code}` }
        }
      })()
      entries.set(file, pending)
    }
    return pending
  }
  const verifyParents = async (file: string, includeSelf = false) => {
    const root = parse(file).root
    let parent = root
    const end = includeSelf ? file : dirname(file)
    for (const part of [...relative(root, end).split(sep), undefined]) {
      const expected = await entry(parent)
      throwIfAborted(signal)
      const current = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (!error.code) {
          throw error
        }
        return undefined
      })
      throwIfAborted(signal)
      if (!current?.isDirectory() || current.isSymbolicLink() || watchEntryVersion(current) !== expected.version) {
        throw new ChangedDirectoryError()
      }
      if (part !== undefined) {
        parent = join(parent, part)
      }
    }
  }
  const record = async (file: string, output: Map<string, string>) => {
    const value = await entry(file)
    output.set(file, value.version)
    return value
  }
  const safeEntry = async (input: string, output: Map<string, string>, onLink?: (target: string) => void) => {
    const file = resolve(input)
    const root = parse(file).root
    let parent = root
    for (const part of relative(root, file).split(sep)) {
      const value = await record(parent, output)
      if (value.target !== undefined) {
        onLink?.(resolve(dirname(parent), value.target, relative(parent, file)))
      }
      if (!value.info?.isDirectory() || value.info.isSymbolicLink()) {
        return undefined
      }
      parent = join(parent, part)
    }
    await verifyParents(file)
    const value = await record(file, output)
    if (value.target !== undefined) {
      onLink?.(resolve(dirname(file), value.target))
    }
    return value.info
  }
  const configQueue = paths.observedConfigFiles.map(file => ({ file, depth: 0 }))
  const configVisited = new Set<string>()
  for (const { file, depth } of configQueue) {
    if (configVisited.has(file)) {
      continue
    }
    configVisited.add(file)
    // Config recovery can depend on a new link target appearing while the link
    // itself stays unchanged. Sample that chain's metadata, never its contents.
    await safeEntry(file, result.config, (target) => {
      if (depth < 40) {
        configQueue.push({ file: target, depth: depth + 1 })
      }
    })
  }
  const sourceQueue = paths.observedSourceFiles.map(file => ({ file, depth: 0 }))
  const visited = new Set<string>()
  const visit = async (directory: string) => {
    if (visited.has(directory)) {
      return
    }
    visited.add(directory)
    throwIfAborted(signal)
    await verifyParents(directory, true)
    let names: string[]
    try {
      names = await readdir(directory)
    }
    catch (error) {
      throwIfAborted(signal)
      const code = (error as NodeJS.ErrnoException).code
      if (!code) {
        throw error
      }
      result.source.set(directory, `error:${code}`)
      return
    }
    // A directory may have become a link while readdir awaited the kernel. Do
    // not inspect any returned child until every ancestor still has its identity.
    await verifyParents(directory, true)
    for (const name of names.sort()) {
      throwIfAborted(signal)
      if (name.startsWith('.')) {
        continue
      }
      const file = join(directory, name)
      if (paths.ignored(file)) {
        continue
      }
      const value = await entry(file)
      if (value.info?.isDirectory() || value.info?.isSymbolicLink() || extname(name).toLowerCase() === '.svg') {
        result.source.set(file, value.version)
      }
      if (value.target !== undefined) {
        sourceQueue.push({ file: resolve(dirname(file), value.target), depth: 1 })
      }
      if (value.info?.isDirectory() && !value.info.isSymbolicLink()) {
        await visit(file)
      }
    }
    await verifyParents(directory, true)
  }
  for (const root of paths.observedRoots) {
    const info = await safeEntry(root, result.source, (target) => {
      sourceQueue.push({ file: target, depth: 1 })
    })
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      await visit(root)
    }
  }
  const sourceVisited = new Set<string>()
  for (const { file, depth } of sourceQueue) {
    if (sourceVisited.has(file)) {
      continue
    }
    sourceVisited.add(file)
    // Rejected links can be repaired at a target outside the accepted scope.
    // Track that finite chain's entries without traversing target directories.
    await safeEntry(file, result.source, (target) => {
      if (depth < 40) {
        sourceQueue.push({ file: target, depth: depth + 1 })
      }
    })
  }
  throwIfAborted(signal)
  return result
}

async function snapshot(paths: WatchPaths, signal: AbortSignal): Promise<Snapshot> {
  while (true) {
    try {
      return await scan(paths, signal)
    }
    catch (error) {
      if (!(error instanceof ChangedDirectoryError)) {
        throw error
      }
      // Discard the whole inconsistent sample. It cannot become an accepted
      // baseline, and cancellation still interrupts repeated topology changes.
      await checkpoint(signal)
    }
  }
}

function changed(previous: Map<string, string>, next: Map<string, string>): boolean {
  return previous.size !== next.size || [...previous].some(([file, version]) => next.get(file) !== version)
}

/** Native events are hints; one serialized observer owns all input transitions. */
export function createWatchObserver(onChange: (configuration: boolean) => void, onError: (error: unknown) => void) {
  const controller = new AbortController()
  let paths: WatchPaths | undefined
  let previous: Snapshot | undefined
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let requested = false
  let queued = false
  let closed = false
  let revision = 0
  const publish = (next: Snapshot) => {
    if (previous && !closed) {
      if (changed(previous.config, next.config)) {
        revision++
        onChange(true)
      }
      else if (changed(previous.source, next.source)) {
        revision++
        onChange(false)
      }
    }
    previous = next
  }
  const sample = async () => {
    if (paths && !closed) {
      publish(await snapshot(paths, controller.signal))
    }
  }
  const enqueue = (action: () => Promise<void>) => {
    const operation = pending.then(async () => {
      if (!closed) {
        await action()
      }
    })
    pending = operation.catch((error: unknown) => {
      if (!closed) {
        onError(error)
      }
    })
    return operation
  }
  function schedule(callback: () => void) {
    clearTimeout(timer)
    if (!closed && paths) {
      timer = setTimeout(callback, 1000)
    }
  }
  function request() {
    if (closed) {
      return
    }
    requested = true
    if (queued) {
      return
    }
    queued = true
    void enqueue(async () => {
      try {
        requested = false
        await sample()
      }
      finally {
        queued = false
        if (requested) {
          // A busy native stream must not starve queued scope changes or the
          // pre-publication check. Put the next scan behind those operations.
          request()
        }
        else {
          schedule(request)
        }
      }
    }).catch(() => {})
  }
  const stop = () => {
    closed = true
    clearTimeout(timer)
    controller.abort('Watch observer closed')
  }
  return {
    request,
    stop,
    async replace(next: WatchPaths) {
      await enqueue(async () => {
        // Compare the old scope before installing a new baseline. In particular,
        // edits during config loading or watcher handover must not disappear.
        await sample()
        const baseline = await snapshot(next, controller.signal)
        if (previous && [...previous.config].some(([file, version]) => baseline.config.has(file) && baseline.config.get(file) !== version)) {
          revision++
          onChange(true)
        }
        else if (previous && [...previous.source].some(([file, version]) => baseline.source.has(file) && baseline.source.get(file) !== version)) {
          revision++
          onChange(false)
        }
        paths = next
        previous = baseline
        schedule(request)
      })
    },
    async check() {
      await enqueue(sample)
      return revision
    },
    async close() {
      stop()
      await pending
    },
  }
}

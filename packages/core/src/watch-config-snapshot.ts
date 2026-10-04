import type { Stats } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { throwIfAborted } from './abort'
import { watchEntryVersion } from './watch-paths'

/** Metadata recorded before c12 resolves or evaluates an explicit config layer. */
export interface WatchConfigSnapshot {
  files: string[]
  versions: [string, string][]
}

/** Follow only a finite set of candidate paths and their link chains, never imports. */
export async function watchConfigSnapshot(files: string[], signal?: AbortSignal): Promise<WatchConfigSnapshot> {
  const versions = new Map<string, string>()
  const entries = new Map<string, Promise<{ info?: Stats, target?: string }>>()
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
          versions.set(file, `${watchEntryVersion(info)}${target === undefined ? '' : `:${target}`}`)
          return { info, ...(target === undefined ? {} : { target }) }
        }
        catch (error) {
          throwIfAborted(signal)
          const code = (error as NodeJS.ErrnoException).code
          if (!code) {
            throw error
          }
          versions.set(file, `error:${code}`)
          return {}
        }
      })()
      entries.set(file, pending)
    }
    return pending
  }
  const candidates = [...new Set(files.map(file => resolve(file)))]
  const queue = candidates.map(file => ({ file, depth: 0 }))
  const visited = new Set<string>()
  for (const { file, depth } of queue) {
    if (visited.has(file)) {
      continue
    }
    visited.add(file)
    const root = parse(file).root
    let current = root
    for (const part of [...relative(root, file).split(sep), undefined]) {
      const value = await entry(current)
      if (value.target !== undefined && depth < 40) {
        queue.push({ file: resolve(dirname(current), value.target, relative(current, file)), depth: depth + 1 })
      }
      if (part === undefined || !value.info?.isDirectory() || value.info.isSymbolicLink()) {
        break
      }
      current = join(current, part)
    }
  }
  throwIfAborted(signal)
  return { files: candidates, versions: [...versions] }
}

export async function watchConfigChangedSinceRead(previous: WatchConfigSnapshot, signal?: AbortSignal): Promise<boolean> {
  const next = new Map((await watchConfigSnapshot(previous.files, signal)).versions)
  return next.size !== previous.versions.length || previous.versions.some(([file, version]) => next.get(file) !== version)
}

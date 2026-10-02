import type { ResolvedIconctlConfig } from './config'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { checkpoint } from './abort'
import { IconctlError } from './errors'

function comparable(file: string) {
  return process.platform === 'win32' ? file.toLowerCase() : file
}

export function containsPath(parent: string, file: string): boolean {
  const path = relative(comparable(parent), comparable(file))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[a-z]:/i.test(path))
}

function overlaps(left: string, right: string) {
  return containsPath(left, right) || containsPath(right, left)
}

async function canonical(file: string): Promise<string> {
  let ancestor = file
  while (true) {
    try {
      return join(await realpath(ancestor), relative(ancestor, file))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) {
        throw error
      }
      ancestor = dirname(ancestor)
    }
  }
}

export interface WatchPaths {
  roots: string[]
  configFiles: string[]
  directories: string[]
  files: string[]
  cache: string
  ignored: (file: string) => boolean
}

export async function watchPaths(config: ResolvedIconctlConfig, cwd: string, configFiles: string[]): Promise<WatchPaths> {
  const roots = [...new Set(config.sources.map((source) => {
    if (source.type === 'directory' || (source.type === 'jsdesign' && source.dir) || (source.type === 'iconfont' && source.dir && !source.url)) {
      return resolve(cwd, source.dir!)
    }
    throw new IconctlError(`Watch supports local directory sources only; ${source.type} requires a one-shot sync.`)
  }))]
  const output = config.output
  const directories = [output.svg, output.jsonPackage?.dir].filter((file): file is string => Boolean(file)).map(file => resolve(cwd, file))
  const files = [output.json, output.types, output.preview, output.changelog].filter((file): file is string => Boolean(file)).map(file => resolve(cwd, file))
  const cache = resolve(cwd, config.cacheDir)
  const watchedConfig = configFiles.map(file => resolve(cwd, file))
  const resolvedRoots = await Promise.all(roots.map(canonical))
  const resolvedDirectories = await Promise.all(directories.map(canonical))
  const resolvedFiles = await Promise.all(files.map(canonical))
  const resolvedConfig = await Promise.all(watchedConfig.map(canonical))
  const resolvedCache = await canonical(cache)
  for (const root of resolvedRoots) {
    if (resolvedDirectories.some(directory => overlaps(directory, root)) || containsPath(resolvedCache, root)
      || (containsPath(root, resolvedCache) && !relative(root, resolvedCache).split(sep).some(part => part.startsWith('.')))
      || resolvedFiles.some(file => file === root || (extname(file).toLowerCase() === '.svg' && containsPath(root, file)))) {
      throw new IconctlError(`Watch input overlaps an output or cache path: ${root}. Use separate input (for example raw-svg) and output directories.`)
    }
  }
  for (const file of resolvedConfig) {
    if (resolvedDirectories.some(directory => containsPath(directory, file)) || resolvedFiles.includes(file) || containsPath(resolvedCache, file)) {
      throw new IconctlError(`Watch configuration would be overwritten by an output: ${file}`)
    }
  }
  const allowedRoots = [...new Set([...roots, ...resolvedRoots])]
  const allowedConfig = [...new Set([...watchedConfig, ...resolvedConfig])]
  const excludedDirs = [...directories, ...resolvedDirectories, cache, resolvedCache]
  const excludedFiles = [...files, ...resolvedFiles]
  const ignored = (input: string): boolean => {
    const file = resolve(input)
    if (allowedConfig.includes(file) || allowedConfig.some(item => containsPath(file, item))) {
      return false
    }
    if (excludedDirs.some(directory => containsPath(directory, file)) || excludedFiles.includes(file)) {
      return true
    }
    return !allowedRoots.some((root) => {
      if (containsPath(file, root)) {
        return true
      }
      return containsPath(root, file) && !relative(root, file).split(sep).some(part => part.startsWith('.'))
    })
  }
  return { roots, configFiles: watchedConfig, directories, files, cache, ignored }
}

/** Also inspect directory links: ignoring generated events alone cannot prevent re-imports. */
export async function validateWatchInputs(paths: WatchPaths, signal?: AbortSignal): Promise<void> {
  const directories = await Promise.all(paths.directories.map(canonical))
  const files = await Promise.all(paths.files.map(canonical))
  const cache = await canonical(paths.cache)
  const ancestors = new Set<string>()
  const visit = async (directory: string) => {
    await checkpoint(signal)
    let target: string
    let entries: string[]
    try {
      target = await realpath(directory)
      entries = await readdir(directory)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return // A missing source is recoverable when its parent sees it recreated.
      }
      throw error
    }
    if (directories.some(output => overlaps(output, target)) || containsPath(cache, target)) {
      throw new IconctlError(`Watch input links to an output or cache directory: ${directory}`)
    }
    if (ancestors.has(target)) {
      throw new IconctlError(`Watch input contains a recursive directory link: ${directory}`)
    }
    ancestors.add(target)
    try {
      for (const entry of entries) {
        await checkpoint(signal)
        if (entry.startsWith('.')) {
          continue
        }
        const file = join(directory, entry)
        const info = await stat(file)
        if (info.isDirectory()) {
          await visit(file)
        }
        else if (info.isFile() && extname(entry).toLowerCase() === '.svg') {
          const actual = await canonical(file)
          if (files.includes(actual) || directories.some(output => containsPath(output, actual)) || containsPath(cache, actual)) {
            throw new IconctlError(`Watch SVG input links to a generated file: ${file}`)
          }
        }
      }
    }
    finally {
      ancestors.delete(target)
    }
  }
  for (const root of paths.roots) {
    await visit(root)
  }
}

export function isWatchSourceEvent(paths: WatchPaths, event: string, file: string): boolean {
  if (paths.ignored(file)) {
    return false
  }
  if (event === 'addDir' || event === 'unlinkDir') {
    return paths.roots.some(root => containsPath(root, file) || containsPath(file, root))
  }
  return ['add', 'change', 'unlink'].includes(event) && extname(basename(file)).toLowerCase() === '.svg'
    && paths.roots.some(root => containsPath(root, file))
}

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

interface WatchLocations {
  roots: string[]
  sourceFiles: string[]
  configFiles: string[]
  directories: string[]
  files: string[]
  cache: string
}

export interface WatchPaths extends WatchLocations {
  ignored: (file: string) => boolean
}

async function pathVariants(paths: string[]): Promise<string[]> {
  return [...new Set([...paths, ...await Promise.all(paths.map(canonical))])]
}

/** Protect both the link entry and its target: publication can replace either. */
async function validatePathIsolation(paths: WatchLocations) {
  const [roots, sourceFiles, configFiles, directories, files, caches] = await Promise.all([
    pathVariants(paths.roots),
    pathVariants(paths.sourceFiles),
    pathVariants(paths.configFiles),
    pathVariants(paths.directories),
    pathVariants(paths.files),
    pathVariants([paths.cache]),
  ])
  const overwritesFile = (file: string) => directories.some(directory => containsPath(directory, file))
    || files.some(output => comparable(output) === comparable(file)) || caches.some(cache => containsPath(cache, file))
  for (const file of sourceFiles) {
    if (overwritesFile(file)) {
      throw new IconctlError(`Watch Iconify input overlaps an output or cache path: ${file}`)
    }
  }
  for (const root of roots) {
    if (directories.some(directory => overlaps(directory, root)) || caches.some(cache => containsPath(cache, root)
      || (containsPath(root, cache) && !relative(root, cache).split(sep).some(part => part.startsWith('.'))))
    || files.some(file => comparable(file) === comparable(root) || (extname(file).toLowerCase() === '.svg' && containsPath(root, file)))) {
      throw new IconctlError(`Watch input overlaps an output or cache path: ${root}. Use separate input (for example raw-svg) and output directories.`)
    }
  }
  for (const file of configFiles) {
    if (overwritesFile(file)) {
      throw new IconctlError(`Watch configuration would be overwritten by an output: ${file}`)
    }
  }
  return { roots, sourceFiles, configFiles, directories, files, caches }
}

export async function watchPaths(config: ResolvedIconctlConfig, cwd: string, configFiles: string[]): Promise<WatchPaths> {
  const sourceFiles = [...new Set(config.sources.filter(source => source.type === 'iconify').map(source => resolve(cwd, source.file)))]
  const roots = [...new Set(config.sources.flatMap((source) => {
    if (source.type === 'iconify') {
      return []
    }
    if (source.type === 'directory' || (source.type === 'jsdesign' && source.dir) || (source.type === 'iconfont' && source.dir && !source.url)) {
      return resolve(cwd, source.dir!)
    }
    throw new IconctlError(`Watch supports local SVG directories and Iconify JSON files only; ${source.type} requires a one-shot sync.`)
  }))]
  const output = config.output
  const directories = [output.svg, output.jsonPackage?.dir].filter((file): file is string => Boolean(file)).map(file => resolve(cwd, file))
  const files = [output.json, output.types, output.preview, output.changelog].filter((file): file is string => Boolean(file)).map(file => resolve(cwd, file))
  const cache = resolve(cwd, config.cacheDir)
  const watchedConfig = configFiles.map(file => resolve(cwd, file))
  const locations = { roots, sourceFiles, configFiles: watchedConfig, directories, files, cache }
  const variants = await validatePathIsolation(locations)
  const excludedDirs = [...variants.directories, ...variants.caches]
  const ignored = (input: string): boolean => {
    const file = resolve(input)
    if (variants.configFiles.some(item => containsPath(file, item))) {
      return false
    }
    if (excludedDirs.some(directory => containsPath(directory, file)) || variants.files.includes(file)) {
      return true
    }
    if (variants.sourceFiles.some(item => containsPath(file, item))) {
      return false
    }
    return !variants.roots.some((root) => {
      if (containsPath(file, root)) {
        return true
      }
      return containsPath(root, file) && !relative(root, file).split(sep).some(part => part.startsWith('.'))
    })
  }
  return { ...locations, ignored }
}

/** Also inspect directory links: ignoring generated events alone cannot prevent re-imports. */
export async function validateWatchInputs(paths: WatchPaths, signal?: AbortSignal): Promise<void> {
  await checkpoint(signal)
  const { directories, files, caches } = await validatePathIsolation(paths)
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
    if (directories.some(output => overlaps(output, target)) || caches.some(cache => containsPath(cache, target))) {
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
          if (files.includes(actual) || directories.some(output => containsPath(output, actual)) || caches.some(cache => containsPath(cache, actual))) {
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
    return paths.roots.some(root => containsPath(root, file) || containsPath(file, root)) || paths.sourceFiles.some(source => containsPath(file, source))
  }
  if (paths.sourceFiles.includes(file)) {
    return ['add', 'change', 'unlink'].includes(event)
  }
  return ['add', 'change', 'unlink'].includes(event) && extname(basename(file)).toLowerCase() === '.svg'
    && paths.roots.some(root => containsPath(root, file))
}

import type { Stats } from 'node:fs'
import type { ResolvedIconctlConfig } from './config'
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
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

async function canonical(file: string, links = new Set<string>()): Promise<string> {
  let ancestor = file
  while (true) {
    try {
      return join(await realpath(ancestor), relative(ancestor, file))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) {
        throw error
      }
      const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
        return undefined
      })
      if (info?.isSymbolicLink()) {
        if (links.has(ancestor)) {
          throw new IconctlError(`Watch input contains a recursive link: ${ancestor}`)
        }
        links.add(ancestor)
        return await canonical(resolve(dirname(ancestor), await readlink(ancestor), relative(ancestor, file)), links)
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
  observedRoots: string[]
  observedSourceFiles: string[]
  observedConfigFiles: string[]
  links: Set<string>
  missingLinks: Set<string>
  linkTargets: Map<string, string>
  entryVersions: Map<string, string>
  ignored: (file: string) => boolean
}

/** Directory contents have their own events; reading a file only changes atime. */
export function watchEntryVersion(info: Stats): string {
  return info.isDirectory()
    ? `directory:${info.dev}:${info.ino}:${info.birthtimeMs}`
    : `${info.isSymbolicLink() ? 'link' : 'file'}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

async function captureEntryVersions(files: string[]) {
  const versions = new Map<string, string>()
  await Promise.all(files.map(async (file) => {
    // Unknown or missing entries have no baseline: their notifications must run.
    const info = await lstat(file).catch(() => undefined)
    if (info) {
      versions.set(file, watchEntryVersion(info))
    }
  }))
  return versions
}

async function pathVariants(paths: string[]): Promise<string[]> {
  const targets = await Promise.all(paths.map(file => canonical(file)))
  const entries = await Promise.all(paths.map(async file => join(await canonical(dirname(file)), basename(file))))
  return [...new Set([...paths, ...entries, ...targets])]
}

async function captureLinkTargets(files: string[]) {
  const targets = new Map<string, string>()
  await Promise.all(files.map(async (file) => {
    // Ordinary files and missing entries are represented by absence from the map.
    const target = await readlink(file).catch(() => undefined)
    if (target !== undefined) {
      targets.set(file, target)
    }
  }))
  return targets
}

/** Configuration recovery must observe newly referenced link targets as well. */
export async function watchConfigFiles(paths: WatchPaths, configFiles: string[]): Promise<WatchPaths> {
  // Loading already reported the configuration error. A broken target must not
  // prevent listening to its link entry while the user repairs that configuration.
  const targets = await Promise.all(configFiles.map(file => canonical(file).catch(() => file)))
  const entries = await Promise.all(configFiles.map(async file => join(await canonical(dirname(file)).catch(() => dirname(file)), basename(file))))
  const observedConfigFiles = [...new Set([...configFiles, ...entries, ...targets])]
  const linkTargets = new Map([...paths.linkTargets, ...await captureLinkTargets(observedConfigFiles)])
  return {
    ...paths,
    configFiles,
    observedConfigFiles,
    linkTargets,
    entryVersions: new Map([...paths.entryVersions, ...await captureEntryVersions(observedConfigFiles)]),
    ignored: file => !observedConfigFiles.some(config => containsPath(file, config)) && paths.ignored(file),
  }
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

/** Resolve links ourselves so the filesystem watcher never follows an unchecked graph. */
export async function validateWatchInputs(paths: WatchLocations, signal?: AbortSignal, onLink?: (file: string, version: string, target: string) => void): Promise<WatchPaths> {
  await checkpoint(signal)
  const links = new Set<string>()
  let rootTargets: (readonly [string, string])[] = []
  const rememberLink = async (file: string, info: Stats, entries = [file]) => {
    const aliases = new Set(entries)
    for (const [root, canonicalRoot] of rootTargets) {
      if (containsPath(canonicalRoot, file)) {
        aliases.add(join(root, relative(canonicalRoot, file)))
      }
    }
    for (const alias of aliases) {
      links.add(alias)
    }
    // Retain discoveries before validating their targets so an active watcher
    // can recognize removal or repair even when this scan rejects the graph.
    if (onLink) {
      const version = watchEntryVersion(info)
      const target = await readlink(file)
      for (const alias of aliases) {
        onLink(alias, version, target)
      }
    }
  }
  for (const root of paths.roots) {
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
      return undefined
    })
    if (info?.isSymbolicLink()) {
      // Even canonical path validation can reject a replaced root's target.
      const entry = join(await canonical(dirname(root)), basename(root))
      await rememberLink(root, info, [root, entry])
    }
  }
  const variants = await validatePathIsolation(paths)
  rootTargets = await Promise.all(variants.roots.map(async root => [root, await canonical(root)] as const))
  const { directories, files, caches } = variants
  const observedRoots = new Set(variants.roots)
  const observedSourceFiles = new Set(variants.sourceFiles)
  const entryVersions = new Map<string, string>()
  const ancestors = new Set<string>()
  const visited = new Set<string>()
  const visit = async (directory: string) => {
    await checkpoint(signal)
    let target: string
    let entries: string[]
    try {
      const directoryInfo = await lstat(directory)
      if (directoryInfo.isSymbolicLink()) {
        await rememberLink(directory, directoryInfo)
      }
      target = await realpath(directory)
      entries = await readdir(target)
      entryVersions.set(target, watchEntryVersion(await stat(target)))
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
    if (target !== directory) {
      observedRoots.add(target)
    }
    if (visited.has(target)) {
      return
    }
    visited.add(target)
    ancestors.add(target)
    try {
      for (const entry of entries) {
        await checkpoint(signal)
        if (entry.startsWith('.')) {
          continue
        }
        const file = join(target, entry)
        const entryInfo = await lstat(file)
        const linked = entryInfo.isSymbolicLink()
        if (linked) {
          await rememberLink(file, entryInfo)
        }
        const info = linked
          ? await stat(file).catch(async (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') {
                throw error
              }
              const actual = await canonical(file)
              // Keep the target's parent observable while a dangling link is repaired.
              if (extname(file).toLowerCase() === '.svg') {
                observedSourceFiles.add(actual)
              }
              else {
                observedRoots.add(actual)
              }
              return undefined
            })
          : entryInfo
        if (!info) {
          continue
        }
        if (info.isDirectory()) {
          await visit(file)
        }
        else if (info.isFile() && extname(entry).toLowerCase() === '.svg') {
          const actual = linked ? await canonical(file) : file
          if (files.includes(actual) || directories.some(output => containsPath(output, actual)) || caches.some(cache => containsPath(cache, actual))) {
            throw new IconctlError(`Watch SVG input links to a generated file: ${file}`)
          }
          if (actual !== file) {
            observedSourceFiles.add(actual)
          }
          if (!linked) {
            entryVersions.set(file, watchEntryVersion(info))
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
  for (const [root, target] of rootTargets) {
    for (const file of [...links]) {
      if (containsPath(target, file)) {
        links.add(join(root, relative(target, file)))
      }
    }
    for (const [file, version] of [...entryVersions]) {
      if (containsPath(target, file)) {
        entryVersions.set(join(root, relative(target, file)), version)
      }
    }
  }
  const explicitFiles = [...observedSourceFiles, ...variants.configFiles, ...links, ...variants.roots]
  for (const [file, version] of await captureEntryVersions([...explicitFiles, ...explicitFiles.map(dirname)])) {
    entryVersions.set(file, version)
  }
  const observed = {
    observedRoots: [...observedRoots],
    observedSourceFiles: [...observedSourceFiles],
    observedConfigFiles: variants.configFiles,
    links,
    missingLinks: new Set<string>(),
    linkTargets: await captureLinkTargets([...links, ...variants.roots, ...variants.sourceFiles, ...variants.configFiles]),
    entryVersions,
  }
  const excludedDirs = [...directories, ...caches]
  const ignored = (input: string): boolean => {
    const file = resolve(input)
    if (observed.observedConfigFiles.some(item => containsPath(file, item))) {
      return false
    }
    if (excludedDirs.some(directory => containsPath(directory, file)) || files.includes(file)) {
      return true
    }
    if (observed.observedSourceFiles.some(item => containsPath(file, item))) {
      return false
    }
    return !observed.observedRoots.some((root) => {
      if (containsPath(file, root)) {
        return true
      }
      return containsPath(root, file) && !relative(root, file).split(sep).some(part => part.startsWith('.'))
    })
  }
  return { ...paths, ...observed, ignored }
}

export async function watchPaths(config: ResolvedIconctlConfig, cwd: string, configFiles: string[], signal?: AbortSignal): Promise<WatchPaths> {
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
  return await validateWatchInputs({ roots, sourceFiles, configFiles: watchedConfig, directories, files, cache }, signal)
}

export function isWatchSourceEvent(paths: WatchPaths, event: string, file: string, symlink = false): boolean {
  if (paths.ignored(file)) {
    return false
  }
  if (event === 'addDir' || event === 'unlinkDir') {
    return paths.observedRoots.some(root => containsPath(root, file) || containsPath(file, root)) || paths.observedSourceFiles.some(source => containsPath(file, source))
  }
  if (symlink && paths.observedRoots.some(root => containsPath(root, file))) {
    // Retain new links even when validation rejects them, so unlink can recover.
    paths.links.add(file)
  }
  if (paths.observedSourceFiles.includes(file) || paths.links.has(file)) {
    return ['add', 'change', 'unlink'].includes(event)
  }
  return ['add', 'change', 'unlink'].includes(event) && extname(basename(file)).toLowerCase() === '.svg'
    && paths.observedRoots.some(root => containsPath(root, file))
}

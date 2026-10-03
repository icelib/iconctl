import type { IconSet } from '@iconify/tools'
import type { LoadedSource, ResolvedDirectorySourceConfig } from './types'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { extname, isAbsolute, join, resolve } from 'pathe'
import { checkpoint, settleWithAbort, throwIfAborted } from '../abort'
import { IconctlError } from '../errors'
import { shouldSkipName, toIconName } from '../naming'

export interface ImportLocalSvgDirectoryOptions {
  skipPrefix?: string[]
  signal?: AbortSignal
}

async function readLocalSvgDirectory(
  dir: string,
  prefix: string,
  options: ImportLocalSvgDirectoryOptions,
  inspection = false,
): Promise<{ iconSet: IconSet, failures: { name: string, message: string, file?: string }[], count: number }> {
  await checkpoint(options.signal)
  const skipPrefix = options.skipPrefix ?? ['_', '.']
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) {
      throw new IconctlError(`iconctl directory source is not a directory: ${dir}`)
    }
  }
  catch (error) {
    if (error instanceof IconctlError) {
      throw error
    }
    throw new IconctlError(`iconctl directory source does not exist: ${dir}`, { cause: error })
  }

  const iconSet = blankIconSet(prefix)
  const failures: { name: string, message: string, file?: string }[] = []
  const names = new Set<string>()
  let count = 0
  const ancestors = new Set<string>()
  const visit = async (directory: string) => {
    await checkpoint(options.signal)
    const canonical = await realpath(directory)
    if (ancestors.has(canonical)) {
      throw new IconctlError(`iconctl directory source contains a recursive directory link: ${directory}`)
    }
    ancestors.add(canonical)
    try {
      const files = (await readdir(directory)).sort()
      for (const file of files) {
        await checkpoint(options.signal)
        // Preserve the importer's exclusion of hidden files and folders.
        if (!inspection && file.startsWith('.')) {
          continue
        }
        const target = join(directory, file)
        const info = await stat(target)
        if (info.isDirectory()) {
          await visit(target)
          continue
        }
        const extension = extname(file)
        const rawName = file.slice(0, -extension.length)
        if (!info.isFile() || extension.toLowerCase() !== '.svg' || (!inspection && shouldSkipName(rawName, skipPrefix))) {
          continue
        }
        count++
        const name = inspection ? rawName : toIconName(rawName)
        if (!name) {
          failures.push({ name: rawName, message: 'The SVG filename cannot be converted to an icon name.' })
          continue
        }
        if (inspection && names.has(name)) {
          failures.push({ name, file: target, message: `Duplicate SVG icon name "${name}".` })
          continue
        }
        names.add(name)
        // Read failures make the source unavailable; malformed content is an
        // individual icon failure that sync can report or explicitly skip.
        let content: string
        try {
          content = await settleWithAbort(() => readFile(target, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) }), options.signal)
        }
        catch (error) {
          if (!inspection) {
            throw error
          }
          failures.push({ name, file: target, message: `Cannot read SVG: ${(error as Error).message}` })
          continue
        }
        throwIfAborted(options.signal)
        try {
          const svg = new SVG(content)
          if (!inspection) {
            cleanupSVG(svg)
          }
          if (!iconSet.fromSVG(name, svg)) {
            throw new Error('Cannot import SVG')
          }
        }
        catch {
          failures.push({ name, ...(inspection ? { file: target } : {}), message: 'Cannot import the SVG. Check its markup and dimensions.' })
        }
      }
    }
    finally {
      ancestors.delete(canonical)
    }
  }
  await visit(dir)
  throwIfAborted(options.signal)
  return { iconSet, failures, count }
}

/** Inspect generated artifacts without renaming or filtering their icon names. */
export async function inspectSvgDirectory(dir: string, prefix: string) {
  return await readLocalSvgDirectory(dir, prefix, {}, true)
}

export async function importLocalSvgDirectory(
  dir: string,
  prefix: string,
  options: ImportLocalSvgDirectoryOptions = {},
): Promise<IconSet> {
  const loaded = await readLocalSvgDirectory(dir, prefix, options)
  if (loaded.failures.length) {
    throw new IconctlError(`Cannot import SVG icons:\n${loaded.failures.map(({ name, message }) => `- ${name}: ${message}`).join('\n')}`)
  }
  return loaded.iconSet
}

export async function loadDirectorySource(
  source: ResolvedDirectorySourceConfig,
  options: { cwd: string, prefix: string, skipPrefix?: string[], signal?: AbortSignal },
): Promise<LoadedSource> {
  const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
  const loaded = await readLocalSvgDirectory(dir, options.prefix, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.skipPrefix ? { skipPrefix: options.skipPrefix } : {}),
  })
  return {
    type: 'directory',
    iconSet: loaded.iconSet,
    notModified: false,
    issues: loaded.failures.map(failure => ({ ...failure, stage: 'import', sourceType: 'directory' })),
    ...(loaded.failures.length ? { failures: loaded.failures } : {}),
  }
}

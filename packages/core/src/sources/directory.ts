import type { IconSet } from '@iconify/tools'
import type { LoadedSource, ResolvedDirectorySourceConfig } from './types'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { extname, isAbsolute, join, resolve } from 'pathe'
import { IconctlError } from '../errors'
import { shouldSkipName, toIconName } from '../naming'

export interface ImportLocalSvgDirectoryOptions {
  skipPrefix?: string[]
}

async function readLocalSvgDirectory(
  dir: string,
  prefix: string,
  options: ImportLocalSvgDirectoryOptions,
): Promise<{ iconSet: IconSet, failures: NonNullable<LoadedSource['failures']> }> {
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
  const failures: NonNullable<LoadedSource['failures']> = []
  const ancestors = new Set<string>()
  const visit = async (directory: string) => {
    const canonical = await realpath(directory)
    if (ancestors.has(canonical)) {
      throw new IconctlError(`iconctl directory source contains a recursive directory link: ${directory}`)
    }
    ancestors.add(canonical)
    try {
      const files = (await readdir(directory)).sort()
      for (const file of files) {
        // Preserve the importer's exclusion of hidden files and folders.
        if (file.startsWith('.')) {
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
        if (!info.isFile() || extension.toLowerCase() !== '.svg' || shouldSkipName(rawName, skipPrefix)) {
          continue
        }
        const name = toIconName(rawName)
        if (!name) {
          failures.push({ name: rawName, message: 'The SVG filename cannot be converted to an icon name.' })
          continue
        }
        // Read failures make the source unavailable; malformed content is an
        // individual icon failure that sync can report or explicitly skip.
        const content = await readFile(target, 'utf8')
        try {
          const svg = new SVG(content)
          cleanupSVG(svg)
          iconSet.fromSVG(name, svg)
        }
        catch {
          failures.push({ name, message: 'Cannot import the SVG. Check its markup and dimensions.' })
        }
      }
    }
    finally {
      ancestors.delete(canonical)
    }
  }
  await visit(dir)
  return { iconSet, failures }
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
  options: { cwd: string, prefix: string, skipPrefix?: string[] },
): Promise<LoadedSource> {
  const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
  const loaded = await readLocalSvgDirectory(dir, options.prefix, {
    ...(options.skipPrefix ? { skipPrefix: options.skipPrefix } : {}),
  })
  return {
    type: 'directory',
    iconSet: loaded.iconSet,
    notModified: false,
    ...(loaded.failures.length ? { failures: loaded.failures } : {}),
  }
}

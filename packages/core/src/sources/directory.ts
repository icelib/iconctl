import type { IconSet } from '@iconify/tools'
import type { LoadedSource, ResolvedDirectorySourceConfig } from './types'
import { stat } from 'node:fs/promises'
import { importDirectory } from '@iconify/tools'
import { isAbsolute, resolve } from 'pathe'
import { IconctlError } from '../errors'
import { shouldSkipName, toIconName } from '../naming'

export interface ImportLocalSvgDirectoryOptions {
  skipPrefix?: string[]
}

export async function importLocalSvgDirectory(
  dir: string,
  prefix: string,
  options: ImportLocalSvgDirectoryOptions = {},
): Promise<IconSet> {
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

  return await importDirectory(dir, {
    prefix,
    keyword: (file) => {
      if (shouldSkipName(file.file, skipPrefix)) {
        return undefined
      }
      return toIconName(file.file) || undefined
    },
  })
}

export async function loadDirectorySource(
  source: ResolvedDirectorySourceConfig,
  options: { cwd: string, prefix: string, skipPrefix?: string[] },
): Promise<LoadedSource> {
  const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
  return {
    type: 'directory',
    iconSet: await importLocalSvgDirectory(dir, options.prefix, {
      ...(options.skipPrefix ? { skipPrefix: options.skipPrefix } : {}),
    }),
    notModified: false,
  }
}

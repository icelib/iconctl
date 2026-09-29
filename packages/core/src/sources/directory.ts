import type { IconSet } from '@iconify/tools'
import type { LoadedSource, ResolvedDirectorySourceConfig } from './types'
import { stat } from 'node:fs/promises'
import { importDirectory } from '@iconify/tools'
import { isAbsolute, resolve } from 'pathe'
import { checkpoint } from '../abort'
import { IconctlError } from '../errors'
import { shouldSkipName, toIconName } from '../naming'

export interface ImportLocalSvgDirectoryOptions {
  skipPrefix?: string[]
  signal?: AbortSignal
}

export async function importLocalSvgDirectory(
  dir: string,
  prefix: string,
  options: ImportLocalSvgDirectoryOptions = {},
): Promise<IconSet> {
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

  return await importDirectory(dir, {
    prefix,
    keyword: async (file) => {
      await checkpoint(options.signal)
      if (shouldSkipName(file.file, skipPrefix)) {
        return undefined
      }
      return toIconName(file.file) || undefined
    },
  })
}

export async function loadDirectorySource(
  source: ResolvedDirectorySourceConfig,
  options: { cwd: string, prefix: string, skipPrefix?: string[], signal?: AbortSignal },
): Promise<LoadedSource> {
  const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
  return {
    type: 'directory',
    iconSet: await importLocalSvgDirectory(dir, options.prefix, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.skipPrefix ? { skipPrefix: options.skipPrefix } : {}),
    }),
    notModified: false,
  }
}

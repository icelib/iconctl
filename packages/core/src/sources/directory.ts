import type { IconSet } from '@iconify/tools'
import type { LoadedSource, ResolvedDirectorySourceConfig } from './types'
import { importDirectory } from '@iconify/tools'
import { isAbsolute, resolve } from 'pathe'

export async function importLocalSvgDirectory(dir: string, prefix: string): Promise<IconSet> {
  return await importDirectory(dir, { prefix })
}

export async function loadDirectorySource(
  source: ResolvedDirectorySourceConfig,
  options: { cwd: string, prefix: string },
): Promise<LoadedSource> {
  const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
  return {
    type: 'directory',
    iconSet: await importLocalSvgDirectory(dir, options.prefix),
    notModified: false,
  }
}

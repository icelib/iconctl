import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from '../config'
import type { LoadedSource, ResolvedSourceConfig } from './types'
import { blankIconSet } from '@iconify/tools'
import { IconctlError } from '../errors'
import { loadDirectorySource } from './directory'
import { loadFigmaSource } from './figma'
import { loadIconfontSource } from './iconfont'
import { loadJsdesignSource } from './jsdesign'
import { loadMastergoSource } from './mastergo'

export function emptyIconSet(prefix: string): IconSet {
  return blankIconSet(prefix)
}

export function mergeIconSets(prefix: string, sets: IconSet[]): IconSet {
  const merged = blankIconSet(prefix)
  for (const iconSet of sets) {
    iconSet.forEachSync((name, type) => {
      if (type !== 'icon') {
        return
      }
      const svg = iconSet.toSVG(name)
      if (svg) {
        merged.fromSVG(name, svg)
      }
    })
  }
  return merged
}

export interface LoadSourcesOptions {
  cwd: string
  config: ResolvedIconctlConfig
  env?: NodeJS.Dict<string>
  figmaIfModifiedSince?: string
}

async function loadOneSource(source: ResolvedSourceConfig, options: LoadSourcesOptions): Promise<LoadedSource> {
  switch (source.type) {
    case 'directory':
      return await loadDirectorySource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
      })
    case 'iconfont':
      return await loadIconfontSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
      })
    case 'jsdesign':
      return await loadJsdesignSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
      })
    case 'mastergo':
      return await loadMastergoSource(source, {
        prefix: options.config.prefix,
        ...(options.env ? { env: options.env } : {}),
      })
    case 'figma': {
      const onlyFigma = options.config.sources.every(item => item.type === 'figma')
      return await loadFigmaSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        cacheDir: options.config.cacheDir,
        skipPrefix: options.config.validate.skipPrefix,
        ...(options.env ? { env: options.env } : {}),
        ...(onlyFigma && options.figmaIfModifiedSince ? { ifModifiedSince: options.figmaIfModifiedSince } : {}),
      })
    }
  }
}

export async function loadSources(options: LoadSourcesOptions): Promise<LoadedSource[]> {
  if (!options.config.sources.length) {
    throw new IconctlError('iconctl config is missing `sources`')
  }

  const loaded: LoadedSource[] = []
  for (const source of options.config.sources) {
    loaded.push(await loadOneSource(source, options))
  }
  return loaded
}

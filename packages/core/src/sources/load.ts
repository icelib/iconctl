import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from '../config'
import type { FigmaSourceLoadOptions } from './figma'
import type { LoadedSource, ResolvedSourceConfig } from './types'
import { blankIconSet } from '@iconify/tools'
import { checkpoint } from '../abort'
import { IconctlError } from '../errors'
import { loadDirectorySource } from './directory'
import { loadFigmaSource } from './figma'
import { loadIconfontSource } from './iconfont'
import { loadIconifySource } from './iconify'
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
  signal?: AbortSignal
  config: ResolvedIconctlConfig
  env?: NodeJS.Dict<string>
  figmaIfModifiedSince?: string
  figmaAuthProvider?: FigmaSourceLoadOptions['authProvider']
  offline?: boolean
}

async function loadOneSource(source: ResolvedSourceConfig, options: LoadSourcesOptions, sourceIndex: number): Promise<LoadedSource> {
  const cancellation = options.signal ? { signal: options.signal } : {}
  switch (source.type) {
    case 'iconify':
      return await loadIconifySource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        skipPrefix: options.config.validate.skipPrefix,
        cacheDir: options.config.cacheDir,
        ...(options.offline ? { offline: true } : {}),
        ...cancellation,
      })
    case 'directory':
      return await loadDirectorySource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        ...cancellation,
        skipPrefix: options.config.validate.skipPrefix,
      })
    case 'iconfont':
      return await loadIconfontSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        ...cancellation,
      })
    case 'jsdesign':
      return await loadJsdesignSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        ...cancellation,
        skipPrefix: options.config.validate.skipPrefix,
      })
    case 'mastergo':
      return await loadMastergoSource(source, {
        prefix: options.config.prefix,
        ...cancellation,
        ...(options.env ? { env: options.env } : {}),
      })
    case 'figma': {
      const onlyFigma = options.config.sources.length === 1
      return await loadFigmaSource(source, {
        cwd: options.cwd,
        prefix: options.config.prefix,
        ...cancellation,
        cacheDir: options.config.cacheDir,
        skipPrefix: options.config.validate.skipPrefix,
        // A failed revision may have been repaired since its document was cached.
        refreshDocument: !onlyFigma || !options.figmaIfModifiedSince,
        sourceIndex,
        ...(options.env ? { env: options.env } : {}),
        ...(options.figmaAuthProvider ? { authProvider: item => options.figmaAuthProvider!(item, sourceIndex) } : {}),
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
  for (const [index, source] of options.config.sources.entries()) {
    await checkpoint(options.signal)
    const result = await loadOneSource(source, options, index)
    if (result.issues) {
      result.issues = result.issues.map(issue => ({ ...issue, sourceType: source.type, sourceIndex: index }))
    }
    loaded.push(result)
    await checkpoint(options.signal)
  }
  return loaded
}

export interface IconOrigin {
  sourceType: LoadedSource['type']
  sourceIndex: number
  fileKey?: string
  nodeId?: string
}

export async function mergeLoadedSources(prefix: string, loaded: LoadedSource[], signal?: AbortSignal): Promise<{ iconSet: IconSet, origins: Map<string, IconOrigin> }> {
  const iconSet = blankIconSet(prefix)
  const origins = new Map<string, IconOrigin>()
  for (const [sourceIndex, source] of loaded.entries()) {
    await checkpoint(signal)
    const sourceSet = source.iconSet
    await sourceSet?.forEach(async (name, type) => {
      await checkpoint(signal)
      if (type === 'icon') {
        const svg = sourceSet.toSVG(name)
        if (svg && iconSet.fromSVG(name, svg)) {
          // Replace the entire origin when this icon wins, including removing
          // Figma coordinates when a later local source supplies the icon.
          origins.set(name, {
            sourceType: source.type,
            sourceIndex,
            ...source.iconOrigins?.get(name),
          })
        }
      }
    })
  }
  await checkpoint(signal)
  return { iconSet, origins }
}

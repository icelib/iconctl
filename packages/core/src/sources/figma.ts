import type { LoadedSource, ResolvedFigmaSourceConfig } from './types'
import { importFromFigma } from '@iconify/tools'
import { join } from 'pathe'
import { parseFigmaFileKey } from '../file-key'
import { defaultIconNameForNode } from '../naming'
import { resolveFigmaToken } from '../token'

export interface FigmaSourceLoadOptions {
  cwd: string
  prefix: string
  cacheDir: string
  skipPrefix: string[]
  env?: NodeJS.Dict<string>
  ifModifiedSince?: string
}

export async function loadFigmaSource(
  source: ResolvedFigmaSourceConfig,
  options: FigmaSourceLoadOptions,
): Promise<LoadedSource> {
  const fileKey = parseFigmaFileKey(source.file)
  const token = resolveFigmaToken(source.token, options.env)
  const figmaOptions = {
    token,
    file: fileKey,
    prefix: options.prefix,
    depth: source.depth,
    cacheDir: join(options.cwd, options.cacheDir),
    iconNameForNode: source.iconNameForNode ?? (node => defaultIconNameForNode(node, {
      skipPrefix: options.skipPrefix,
    })),
    ...(source.pages ? { pages: source.pages } : {}),
    ...(source.ids ? { ids: source.ids } : {}),
  }
  const imported = options.ifModifiedSince
    ? await importFromFigma({ ...figmaOptions, ifModifiedSince: options.ifModifiedSince })
    : await importFromFigma(figmaOptions)

  if (imported === 'not_modified') {
    return {
      type: 'figma',
      notModified: true,
      fileKey,
    }
  }

  const loaded: LoadedSource = {
    type: 'figma',
    iconSet: imported.iconSet,
    notModified: false,
    fileKey,
    lastModified: imported.lastModified,
  }
  if (imported.version) {
    loaded.fileVersion = imported.version
  }
  return loaded
}

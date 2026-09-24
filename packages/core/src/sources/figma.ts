import type { FigmaAPIImagesResponse, FigmaDocument } from '@iconify/tools/lib/import/figma/types/api'
import type { LoadedSource, ResolvedFigmaSourceConfig } from './types'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { getFigmaIconNodes } from '@iconify/tools/lib/import/figma/nodes'
import { join } from 'pathe'
import { IconctlError } from '../errors'
import { resolveFigmaAuth } from '../figma/auth'
import { FigmaClient } from '../figma/client'
import { parseFigmaFileKey } from '../file-key'
import { defaultIconNameForNode } from '../naming'

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
  const auth = await resolveFigmaAuth(source.token, options.env)
  // Refresh even when the remote response can be served from cache.
  await auth.token()
  const client = new FigmaClient(auth, join(options.cwd, options.cacheDir))
  const parameters = new URLSearchParams({ depth: String(source.depth) })
  if (source.ids) {
    parameters.set('ids', source.ids.join(','))
  }
  if (options.ifModifiedSince) {
    const head = await client.json<FigmaDocument>(`files/${fileKey}`, new URLSearchParams({ ...Object.fromEntries(parameters), depth: '1' }), true)
    if (head.lastModified === options.ifModifiedSince) {
      return { type: 'figma', notModified: true, fileKey }
    }
  }
  const document = await client.json<FigmaDocument>(`files/${fileKey}`, parameters, Boolean(options.ifModifiedSince))
  if (document.editorType !== 'figma' || !Array.isArray(document.document?.children) || typeof document.version !== 'string' || typeof document.lastModified !== 'string') {
    throw new IconctlError('Invalid Figma document. Use a Figma design file.')
  }
  const nodes = getFigmaIconNodes(document, {
    iconNameForNode: source.iconNameForNode ?? (node => defaultIconNameForNode(node, {
      skipPrefix: options.skipPrefix,
    })),
    ...(source.pages ? { pages: source.pages } : {}),
  })
  const icons = Object.values(nodes.icons)
  // Bound both encoded URL size and the number of simultaneous downloads.
  let batch: string[] = []
  const render = async () => {
    const result = await client.json<FigmaAPIImagesResponse>(`images/${fileKey}`, new URLSearchParams({
      ids: batch.join(','),
      format: 'svg',
      version: document.version,
      svg_include_id: 'false',
      svg_simplify_stroke: 'false',
      use_absolute_bounds: 'false',
    }))
    if (!result.images || typeof result.images !== 'object') {
      throw new IconctlError('Invalid Figma image export response.')
    }
    for (const id of batch) {
      const url = result.images[id]
      if (typeof url === 'string') {
        nodes.icons[id]!.url = url
      }
    }
    batch = []
  }
  for (const icon of icons) {
    if (batch.length && encodeURIComponent([...batch, icon.id].join(',')).length > 1500) {
      await render()
    }
    batch.push(icon.id)
  }
  if (batch.length) {
    await render()
  }
  const iconSet = blankIconSet(options.prefix)
  for (let offset = 0; offset < icons.length; offset += 4) {
    await Promise.all(icons.slice(offset, offset + 4).map(async (icon) => {
      if (icon.url) {
        try {
          icon.content = await client.svg(icon.url)
        }
        catch {}
      }
    }))
  }
  let imported = 0
  for (const icon of icons) {
    if (icon.content) {
      try {
        const svg = new SVG(icon.content)
        cleanupSVG(svg)
        iconSet.fromSVG(icon.keyword, svg)
        imported++
      }
      catch {}
    }
  }
  if (!imported) {
    throw new IconctlError('No valid Figma icons could be imported. Check layers, filters and SVG downloads.')
  }
  const loaded: LoadedSource = {
    type: 'figma',
    iconSet,
    notModified: false,
    fileKey,
    lastModified: document.lastModified,
  }
  if (document.version) {
    loaded.fileVersion = document.version
  }
  return loaded
}

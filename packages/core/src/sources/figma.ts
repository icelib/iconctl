import type { FigmaAPIImagesResponse, FigmaDocument } from '@iconify/tools/lib/import/figma/types/api'
import type { SyncIssue } from '../errors'
import type { FigmaAuth } from '../figma/auth'
import type { LoadedSource, ResolvedFigmaSourceConfig } from './types'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { getFigmaIconNodes } from '@iconify/tools/lib/import/figma/nodes'
import { resolve } from 'pathe'
import { checkpoint, settleWithAbort, throwIfAborted } from '../abort'
import { IconctlError, IconctlSyncError } from '../errors'
import { resolveFigmaAuth } from '../figma/auth'
import { FigmaClient } from '../figma/client'
import { parseFigmaFileKey } from '../file-key'
import { defaultIconNameForNode } from '../naming'

function isSvgDownloadUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  }
  catch {
    return false
  }
}

export interface FigmaSourceLoadOptions {
  cwd: string
  signal?: AbortSignal
  sourceIndex?: number
  prefix: string
  cacheDir: string
  skipPrefix: string[]
  env?: NodeJS.Dict<string>
  ifModifiedSince?: string
  authProvider?: (source: ResolvedFigmaSourceConfig, sourceIndex?: number) => Promise<FigmaAuth>
  refreshDocument?: boolean
}

export async function loadFigmaSource(
  source: ResolvedFigmaSourceConfig,
  options: FigmaSourceLoadOptions,
): Promise<LoadedSource> {
  throwIfAborted(options.signal)
  const issues: SyncIssue[] = []
  const fileKey = parseFigmaFileKey(source.file)
  const auth = await settleWithAbort(() => options.authProvider ? options.authProvider(source) : resolveFigmaAuth(source.token, options.env), options.signal)
  throwIfAborted(options.signal)
  // Refresh even when the remote response can be served from cache.
  await settleWithAbort(() => auth.token(), options.signal)
  throwIfAborted(options.signal)
  const client = new FigmaClient(auth, resolve(options.cwd, options.cacheDir), options.signal)
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
  const document = await client.json<FigmaDocument>(`files/${fileKey}`, parameters, Boolean(options.ifModifiedSince || options.refreshDocument))
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
  const report = (icon: typeof icons[number], stage: SyncIssue['stage'], message: string) => {
    issues.push({ name: icon.keyword, nodeId: icon.id, fileKey, sourceType: 'figma', stage, message, ...(options.sourceIndex !== undefined ? { sourceIndex: options.sourceIndex } : {}) })
  }
  // Bound both encoded URL size and the number of simultaneous downloads.
  let batch: string[] = []
  const render = async () => {
    await checkpoint(options.signal)
    const parameters = new URLSearchParams({
      ids: batch.join(','),
      format: 'svg',
      version: document.version,
      svg_include_id: 'false',
      svg_simplify_stroke: 'false',
      use_absolute_bounds: 'false',
    })
    const result = await client.json<FigmaAPIImagesResponse>(`images/${fileKey}`, parameters, false, value => value.images != null
      && typeof value.images === 'object'
      && batch.every(id => isSvgDownloadUrl(value.images[id])))
    if (!result.images || typeof result.images !== 'object') {
      await client.invalidateImages(`images/${fileKey}`, parameters)
      throw new IconctlError('Invalid Figma image export response.')
    }
    for (const id of batch) {
      const url = result.images[id]
      if (typeof url === 'string' && url.length) {
        nodes.icons[id]!.url = url
      }
      else {
        report(nodes.icons[id]!, 'export-url', 'Figma did not return an SVG export URL')
      }
    }
    if (batch.some(id => !nodes.icons[id]!.url)) {
      await client.invalidateImages(`images/${fileKey}`, parameters)
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
    await checkpoint(options.signal)
    const downloads = await Promise.allSettled(icons.slice(offset, offset + 4).map(async (icon) => {
      if (!icon.url) {
        return
      }
      try {
        icon.content = await client.svg(icon.url)
      }
      catch (error) {
        throwIfAborted(options.signal)
        report(icon, 'download', error instanceof IconctlError ? error.message : 'Could not download the SVG (request failed or timed out)')
      }
    }))
    throwIfAborted(options.signal)
    for (const download of downloads) {
      if (download.status === 'rejected') {
        throw download.reason
      }
    }
  }
  let imported = 0
  for (const icon of icons) {
    await checkpoint(options.signal)
    if (icon.content !== undefined) {
      try {
        const svg = new SVG(icon.content)
        cleanupSVG(svg)
        if (!iconSet.fromSVG(icon.keyword, svg)) {
          throw new Error('Invalid SVG')
        }
        imported++
      }
      catch {
        report(icon, 'import', 'Could not parse or import the SVG')
        if (icon.url) {
          await client.invalidate(icon.url)
        }
      }
    }
  }
  issues.sort((left, right) => (left.nodeId ?? '').localeCompare(right.nodeId ?? ''))
  if (!imported) {
    throw new IconctlSyncError(issues, 'No valid Figma icons could be imported. Check layers, filters and SVG downloads')
  }
  const loaded: LoadedSource = {
    type: 'figma',
    issues,
    iconSet,
    notModified: false,
    fileKey,
    lastModified: document.lastModified,
    ...(issues.length ? { failures: issues.map(({ name, message }) => ({ name, message })) } : {}),
  }
  if (document.version) {
    loaded.fileVersion = document.version
  }
  return loaded
}

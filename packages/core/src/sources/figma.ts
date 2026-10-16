import type { FigmaAPIImagesResponse, FigmaDocument } from '@iconify/tools/lib/import/figma/types/api'
import type { SyncIssue } from '../errors'
import type { FigmaNamingManifest, FigmaNamingPlan } from '../figma-naming-plan'
import type { FigmaAuth } from '../figma/auth'
import type { ProgressReporter } from '../progress'
import type { RequestOptions } from '../request-options'
import type { LoadedSource, ResolvedFigmaSourceConfig } from './types'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { getFigmaIconNodes } from '@iconify/tools/lib/import/figma/nodes'
import { resolve } from 'pathe'
import { checkpoint, settleWithAbort, throwIfAborted } from '../abort'
import { IconctlError, IconctlSyncError } from '../errors'
import { allocateFigmaNames } from '../figma-naming'
import { figmaNamingSourceKey, preservesFigmaNames } from '../figma-naming-plan'
import { resolveFigmaAuth } from '../figma/auth'
import { FigmaClient } from '../figma/client'
import { parseFigmaFileKey } from '../file-key'
import { defaultIconNameForNode, toIconName } from '../naming'

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

export interface FigmaSourceLoadOptions extends RequestOptions {
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
  report?: ProgressReporter
  namingManifest?: FigmaNamingManifest
  namingOnly?: boolean
}

export async function loadFigmaSource(
  source: ResolvedFigmaSourceConfig,
  options: FigmaSourceLoadOptions,
): Promise<LoadedSource> {
  throwIfAborted(options.signal)
  const issues: SyncIssue[] = []
  const fileKey = parseFigmaFileKey(source.file)
  const report: ProgressReporter = event => options.report?.({ ...event, sourceType: 'figma', ...(options.sourceIndex === undefined ? {} : { sourceIndex: options.sourceIndex }), fileKey })
  report({ stage: 'document', completed: 0, total: 1 })
  const auth = await settleWithAbort(() => options.authProvider ? options.authProvider(source) : resolveFigmaAuth(source.token, options.env, options), options.signal)
  throwIfAborted(options.signal)
  // Refresh even when the remote response can be served from cache.
  await settleWithAbort(() => auth.token(), options.signal)
  throwIfAborted(options.signal)
  const client = new FigmaClient(auth, resolve(options.cwd, options.cacheDir), options.signal, options)
  const parameters = new URLSearchParams({ depth: String(source.depth) })
  if (source.ids) {
    parameters.set('ids', source.ids.join(','))
  }
  if (options.ifModifiedSince) {
    const head = await client.json<FigmaDocument>(`files/${fileKey}`, new URLSearchParams({ ...Object.fromEntries(parameters), depth: '1' }), true)
    if (head.lastModified === options.ifModifiedSince) {
      report({ stage: 'document', completed: 1, total: 1 })
      throwIfAborted(options.signal)
      return { type: 'figma', notModified: true, fileKey }
    }
  }
  const document = await client.json<FigmaDocument>(`files/${fileKey}`, parameters, Boolean(options.ifModifiedSince || options.refreshDocument))
  if (document.editorType !== 'figma' || !Array.isArray(document.document?.children) || typeof document.version !== 'string' || typeof document.lastModified !== 'string') {
    throw new IconctlError('Invalid Figma document. Use a Figma design file.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-api' })
  }
  report({ stage: 'document', completed: 1, total: 1 })
  throwIfAborted(options.signal)
  const parentPaths = new Map<string, string[]>()
  const nodes = getFigmaIconNodes(document, {
    iconNameForNode: (node, result, document) => {
      parentPaths.set(node.id, node.parents.map(parent => parent.name))
      // The legacy callback remains a complete override, including filtering
      // and exact custom keywords. The new transform composes with defaults.
      if (source.iconNameForNode) {
        return source.iconNameForNode(node, result, document)
      }
      const baseName = defaultIconNameForNode(node, { skipPrefix: options.skipPrefix })
      if (baseName === null || !source.naming?.transform) {
        return baseName
      }
      const transformed = source.naming.transform(baseName, node)
      if (transformed === null) {
        return null
      }
      if (typeof transformed !== 'string') {
        throw new IconctlError('Figma naming.transform must return a string or null.', { code: 'FIGMA_NAMING_TRANSFORM_INVALID' })
      }
      return toIconName(transformed) || null
    },
    ...(source.pages ? { pages: source.pages } : {}),
  })
  const candidates = Object.values(nodes.icons)
  const namingCandidates = candidates.map(icon => ({ nodeId: icon.id, originalName: icon.name, baseName: icon.keyword, parentPath: parentPaths.get(icon.id) ?? [] }))
  const policy = source.naming?.duplicates ?? 'error'
  const namespace = source.naming?.namespace ?? ''
  const namingSourceKey = figmaNamingSourceKey(fileKey, namespace)
  const previous = options.namingManifest?.sources[namingSourceKey]
  const preserveNames = preservesFigmaNames(source)
  const allocation = allocateFigmaNames(namingCandidates, {
    duplicates: policy,
    preserveNames,
    ...(previous ? { previous: previous.entries } : {}),
  })
  const proposed = policy === 'error' && allocation.collisions.length
    ? allocateFigmaNames(namingCandidates, { duplicates: 'suffix-node-id', preserveNames, ...(previous ? { previous: previous.entries } : {}) }).names
    : allocation.names
  const figmaUrl = (nodeId: string) => `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId)}`
  for (const group of allocation.collisions) {
    for (const candidate of group.nodes) {
      issues.push({
        name: group.baseName,
        nodeId: candidate.nodeId,
        fileKey,
        sourceType: 'figma',
        stage: 'import',
        code: policy === 'error' ? 'FIGMA_DUPLICATE_NAME' : 'FIGMA_NAME_DISAMBIGUATED',
        severity: policy === 'error' ? 'error' : 'warning',
        collisionGroup: group.baseName,
        originalName: candidate.originalName,
        normalizedName: group.baseName,
        parentPath: candidate.parentPath,
        figmaUrl: figmaUrl(candidate.nodeId),
        proposedName: proposed[candidate.nodeId]!,
        message: policy === 'error'
          ? `Duplicate icon name "${group.baseName}" is shared by ${group.nodes.length} Figma nodes. Rename the layers, use naming.transform or opt in to naming.duplicates: "suffix-node-id".`
          : `Resolved duplicate icon name "${group.baseName}" for ${group.nodes.length} Figma nodes with stable public names.`,
        ...(options.sourceIndex === undefined ? {} : { sourceIndex: options.sourceIndex }),
      })
    }
  }
  for (const renamed of allocation.renamed) {
    if (allocation.collisions.some(group => group.baseName === renamed.from)) {
      continue
    }
    const candidate = namingCandidates.find(candidate => candidate.nodeId === renamed.nodeId)!
    issues.push({
      name: renamed.to,
      nodeId: renamed.nodeId,
      fileKey,
      sourceType: 'figma',
      stage: 'import',
      code: 'FIGMA_NAME_PRESERVED',
      severity: 'warning',
      originalName: candidate.originalName,
      normalizedName: renamed.from,
      proposedName: renamed.to,
      parentPath: candidate.parentPath,
      figmaUrl: figmaUrl(candidate.nodeId),
      message: `Kept public name "${renamed.to}" instead of "${renamed.from}" to preserve node/name ownership.`,
      ...(options.sourceIndex === undefined ? {} : { sourceIndex: options.sourceIndex }),
    })
  }
  const mappings = namingCandidates.map(candidate => ({
    ...candidate,
    figmaUrl: figmaUrl(candidate.nodeId),
    ...(allocation.names[candidate.nodeId] === undefined ? {} : { name: allocation.names[candidate.nodeId] }),
    ...(previous?.entries[candidate.nodeId] ? { previousName: previous.entries[candidate.nodeId]!.name } : {}),
  })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  const oldNames = new Set((previous?.activeNodeIds ?? []).map(id => previous!.entries[id]!.name))
  const newNames = new Set(Object.values(allocation.names))
  const namingPlan: FigmaNamingPlan = {
    sourceIndex: options.sourceIndex ?? 0,
    fileKey,
    namespace,
    fileVersion: document.version,
    lastModified: document.lastModified,
    policy,
    mappings,
    changes: {
      added: [...newNames].filter(name => !oldNames.has(name)).sort(),
      removed: [...oldNames].filter(name => !newNames.has(name)).sort(),
      renamed: mappings.flatMap(mapping => mapping.name && mapping.previousName && mapping.name !== mapping.previousName
        ? [{ nodeId: mapping.nodeId, from: mapping.previousName, to: mapping.name }]
        : []),
      disambiguated: allocation.renamed,
    },
  }
  const naming = {
    namingPlan,
    ...(preserveNames ? { namingSourceKey, namingEntries: allocation.entries } : {}),
  }
  if (options.namingOnly) {
    return { type: 'figma', notModified: false, issues, fileKey, fileVersion: document.version, lastModified: document.lastModified, ...naming }
  }
  const reportIssue = (icon: typeof candidates[number], stage: SyncIssue['stage'], message: string, error?: unknown) => {
    const issue: SyncIssue = { name: icon.keyword, nodeId: icon.id, fileKey, sourceType: 'figma', stage, message, ...(options.sourceIndex !== undefined ? { sourceIndex: options.sourceIndex } : {}) }
    if (error instanceof IconctlError) {
      for (const key of ['code', 'httpStatus', 'retryable', 'retryAfterMs', 'operation'] as const) {
        if (error[key] !== undefined) {
          Object.assign(issue, { [key]: error[key] })
        }
      }
    }
    issues.push(issue)
  }
  const icons = candidates.filter(icon => Object.hasOwn(allocation.names, icon.id))
  for (const icon of icons) {
    icon.keyword = allocation.names[icon.id]!
  }
  let exported = 0
  report({ stage: 'export-url', completed: 0, total: icons.length })
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
      throw new IconctlError('Invalid Figma image export response.', { code: 'INVALID_RESPONSE', sourceType: 'figma', operation: 'figma-api' })
    }
    for (const id of batch) {
      const url = result.images[id]
      if (typeof url === 'string' && url.length) {
        nodes.icons[id]!.url = url
      }
      else {
        reportIssue(nodes.icons[id]!, 'export-url', 'Figma did not return an SVG export URL')
      }
      report({ stage: 'export-url', name: nodes.icons[id]!.keyword, nodeId: id, completed: ++exported, total: icons.length })
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
  const iconOrigins: NonNullable<LoadedSource['iconOrigins']> = new Map()
  let downloaded = 0
  report({ stage: 'download', completed: 0, total: icons.length })
  for (let offset = 0; offset < icons.length; offset += 4) {
    await checkpoint(options.signal)
    const downloads = await Promise.allSettled(icons.slice(offset, offset + 4).map(async (icon) => {
      if (!icon.url) {
        report({ stage: 'download', name: icon.keyword, nodeId: icon.id, completed: ++downloaded, total: icons.length })
        return
      }
      try {
        icon.content = await client.svg(icon.url)
      }
      catch (error) {
        throwIfAborted(options.signal)
        reportIssue(icon, 'download', error instanceof IconctlError ? error.message : 'Could not download the SVG (request failed or timed out)', error)
      }
      report({ stage: 'download', name: icon.keyword, nodeId: icon.id, completed: ++downloaded, total: icons.length })
    }))
    throwIfAborted(options.signal)
    for (const download of downloads) {
      if (download.status === 'rejected') {
        throw download.reason
      }
    }
  }
  let imported = 0
  let attempted = 0
  report({ stage: 'import', completed: 0, total: icons.length })
  for (const icon of icons) {
    await checkpoint(options.signal)
    if (icon.content !== undefined) {
      try {
        const svg = new SVG(icon.content)
        cleanupSVG(svg)
        if (!iconSet.fromSVG(icon.keyword, svg)) {
          throw new Error('Invalid SVG')
        }
        iconOrigins.set(icon.keyword, { fileKey, nodeId: icon.id })
        imported++
      }
      catch {
        reportIssue(icon, 'import', 'Could not parse or import the SVG')
        if (icon.url) {
          await client.invalidate(icon.url)
        }
      }
    }
    report({ stage: 'import', name: icon.keyword, nodeId: icon.id, completed: ++attempted, total: icons.length })
  }
  await checkpoint(options.signal)
  issues.sort((left, right) => (left.nodeId ?? '').localeCompare(right.nodeId ?? ''))
  if (!imported) {
    throw new IconctlSyncError(issues, 'No valid Figma icons could be imported. Check names, layers, filters and SVG downloads')
  }
  const loaded: LoadedSource = {
    type: 'figma',
    issues,
    iconSet,
    iconOrigins,
    ...naming,
    notModified: false,
    fileKey,
    lastModified: document.lastModified,
    ...(issues.some(issue => issue.severity !== 'warning') ? { failures: issues.filter(issue => issue.severity !== 'warning').map(({ name, message }) => ({ name, message })) } : {}),
  }
  if (document.version) {
    loaded.fileVersion = document.version
  }
  return loaded
}

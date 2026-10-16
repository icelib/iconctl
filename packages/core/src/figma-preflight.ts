import type { ResolvedIconctlConfig } from './config'
import type { SyncIssue } from './errors'
import type { FigmaNamingPlan } from './figma-naming-plan'
import type { RequestOptions } from './request-options'
import type { FigmaSourceLoadOptions } from './sources/figma'
import process from 'node:process'
import { resolve } from 'pathe'
import { throwIfAborted } from './abort'
import { IconctlError } from './errors'
import { readPreviousIconJson } from './export'
import { namingManifestPath, readFigmaNamingManifest, usesFigmaNamingManifest } from './figma-naming-plan'
import { resolveRequestOptions } from './request-options'
import { loadSources } from './sources/load'

export interface FigmaNamingPreflightOptions extends RequestOptions {
  config: ResolvedIconctlConfig
  cwd?: string
  signal?: AbortSignal
  env?: NodeJS.Dict<string>
  figmaAuthProvider?: FigmaSourceLoadOptions['authProvider']
}

export interface FigmaNamingPreflightResult {
  complete: boolean
  naming: FigmaNamingPlan[]
  issues: SyncIssue[]
  publicNames: { added: string[], removed: string[], deletionsReliable: boolean }
  files: string[]
}

/** Only reads Figma documents. Authentication and transport caches may update. */
export async function preflightFigmaNaming(options: FigmaNamingPreflightOptions): Promise<FigmaNamingPreflightResult> {
  throwIfAborted(options.signal)
  if (!options.config.sources.some(source => source.type === 'figma')) {
    throw new IconctlError('Naming preflight requires at least one Figma source.')
  }
  const cwd = options.cwd ?? process.cwd()
  const manifest = usesFigmaNamingManifest(options.config)
    ? await readFigmaNamingManifest(namingManifestPath(options.config, cwd))
    : undefined
  const loaded = await loadSources({
    ...options,
    ...resolveRequestOptions(options),
    cwd,
    namingOnly: true,
    ...(manifest ? { namingManifest: manifest } : {}),
  })
  const naming = loaded.flatMap(source => source.namingPlan ? [source.namingPlan] : [])
  const issues = loaded.flatMap(source => source.issues ?? [])
  for (const plan of naming) {
    if (!plan.mappings.some(mapping => mapping.name !== undefined)
      && !issues.some(issue => issue.sourceIndex === plan.sourceIndex && issue.severity !== 'warning')) {
      issues.push({
        name: '(source)',
        message: 'No eligible Figma icon nodes were found. Check pages, node IDs, layer types and naming filters.',
        stage: 'import',
        code: 'FIGMA_NO_ICON_CANDIDATES',
        severity: 'error',
        sourceType: 'figma',
        sourceIndex: plan.sourceIndex,
        fileKey: plan.fileKey,
      })
    }
    for (const mapping of plan.mappings) {
      if (mapping.name === undefined) {
        continue
      }
      const pattern = new RegExp(options.config.validate.name.source, options.config.validate.name.flags)
      if (!pattern.test(mapping.name)) {
        issues.push({ name: mapping.name, message: 'Icon name does not match the configured validation pattern.', stage: 'validation', code: 'FIGMA_NAME_INVALID', severity: 'error', sourceType: 'figma', sourceIndex: plan.sourceIndex, fileKey: plan.fileKey, nodeId: mapping.nodeId, originalName: mapping.originalName, normalizedName: mapping.baseName, parentPath: mapping.parentPath, figmaUrl: mapping.figmaUrl })
      }
    }
  }
  const complete = issues.every(issue => issue.severity === 'warning')
  const deletionsReliable = complete && options.config.sources.every(source => source.type === 'figma')
  const previous = await readPreviousIconJson(resolve(cwd, options.config.output.json))
  const previousNames = new Set([...Object.keys(previous?.icons ?? {}), ...Object.keys(previous?.aliases ?? {})])
  const currentNames = new Set(naming.flatMap(plan => plan.mappings.flatMap(mapping => mapping.name === undefined ? [] : [mapping.name])))
  throwIfAborted(options.signal)
  return {
    complete,
    naming,
    issues,
    publicNames: {
      added: [...currentNames].filter(name => !previousNames.has(name)).sort(),
      removed: deletionsReliable ? [...previousNames].filter(name => !currentNames.has(name)).sort() : [],
      deletionsReliable,
    },
    files: [],
  }
}

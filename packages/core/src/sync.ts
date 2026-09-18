import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedIconctlConfig } from './config'
import type { IconDiff } from './diff'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { diffIconSets } from './diff'
import { IconctlError } from './errors'
import { exportOutputs, readPreviousIconJson } from './export'
import { writePreviewHtml } from './preview'
import { processIconSet } from './process'
import { loadSources, mergeIconSets } from './sources/load'
import { formatValidationIssues, validateIconSet } from './validate'

export interface SyncOptions {
  cwd?: string
  config: ResolvedIconctlConfig
  env?: NodeJS.Dict<string>
  dryRun?: boolean
  continueOnError?: boolean
  iconSet?: IconSet
}

export interface SyncResult {
  prefix: string
  fileKey?: string
  fileVersion?: string
  notModified: boolean
  processed: number
  failed: string[]
  issues: { name: string, message: string }[]
  sources: { type: string, notModified: boolean, fileKey?: string }[]
  diff: IconDiff
  files: string[]
  json: IconifyJSON
}

interface CacheMeta {
  lastModified?: string
  version?: string
}

async function readCacheMeta(file: string): Promise<CacheMeta | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CacheMeta
  }
  catch {
    return undefined
  }
}

async function writeCacheMeta(file: string, meta: CacheMeta) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

export async function sync(options: SyncOptions): Promise<SyncResult> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config
  const previous = await readPreviousIconJson(join(cwd, config.output.json))
  const cacheMetaFile = join(cwd, config.cacheDir, 'meta.json')
  const previousMeta = await readCacheMeta(cacheMetaFile)

  let iconSet = options.iconSet
  let fileVersion: string | undefined
  let fileKey: string | undefined
  let notModified = false
  const sourceSummaries: SyncResult['sources'] = []

  if (!iconSet) {
    const loaded = await loadSources({
      cwd,
      config,
      ...(options.env ? { env: options.env } : {}),
      ...(previousMeta?.lastModified ? { figmaIfModifiedSince: previousMeta.lastModified } : {}),
    })

    notModified = loaded.length > 0 && loaded.every(item => item.notModified)
    if (notModified) {
      const json = previous ?? { prefix: config.prefix, icons: {} }
      const result: SyncResult = {
        prefix: config.prefix,
        notModified,
        processed: 0,
        failed: [],
        issues: [],
        sources: loaded.map(item => ({
          type: item.type,
          notModified: item.notModified,
          ...(item.fileKey ? { fileKey: item.fileKey } : {}),
        })),
        diff: diffIconSets(json, json),
        files: [],
        json,
      }
      if (previousMeta?.version) {
        result.fileVersion = previousMeta.version
      }
      if (loaded[0]?.fileKey) {
        result.fileKey = loaded[0].fileKey
      }
      return result
    }

    const sets = loaded.flatMap(item => item.iconSet ? [item.iconSet] : [])
    iconSet = mergeIconSets(config.prefix, sets)
    fileVersion = loaded.find(item => item.fileVersion)?.fileVersion
    fileKey = loaded.find(item => item.fileKey)?.fileKey
    for (const item of loaded) {
      sourceSummaries.push({
        type: item.type,
        notModified: item.notModified,
        ...(item.fileKey ? { fileKey: item.fileKey } : {}),
      })
    }

    const figma = loaded.find(item => item.type === 'figma' && item.lastModified)
    if (!options.dryRun && figma?.lastModified) {
      await writeCacheMeta(cacheMetaFile, {
        lastModified: figma.lastModified,
        ...(figma.fileVersion ? { version: figma.fileVersion } : {}),
      })
    }
  }

  const processed = processIconSet(iconSet, config)
  const { issues } = validateIconSet(iconSet, config)

  if (issues.length && !options.continueOnError) {
    throw new IconctlError(`Icon validation failed:\n${formatValidationIssues(issues)}`)
  }

  const exported = await exportOutputs(iconSet, config, {
    cwd,
    ...(options.dryRun ? { dryRun: true } : {}),
  })

  if (!options.dryRun && config.output.preview) {
    const previewFile = join(cwd, config.output.preview)
    await writePreviewHtml(previewFile, exported.json)
    exported.files.push(previewFile)
  }

  const result: SyncResult = {
    prefix: config.prefix,
    notModified,
    processed: processed.processed,
    failed: processed.failed,
    issues,
    sources: sourceSummaries,
    diff: diffIconSets(previous, exported.json),
    files: exported.files,
    json: exported.json,
  }
  if (fileVersion) {
    result.fileVersion = fileVersion
  }
  if (fileKey) {
    result.fileKey = fileKey
  }
  return result
}

export { importLocalSvgDirectory } from './sources/directory'
export { emptyIconSet, mergeIconSets } from './sources/load'

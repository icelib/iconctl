import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedFigmaIconifyConfig } from './config'
import type { IconDiff } from './diff'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { blankIconSet, importDirectory, importFromFigma } from '@iconify/tools'
import { dirname, join } from 'pathe'
import { diffIconSets } from './diff'
import { FigmaIconifyError } from './errors'
import { exportOutputs, readPreviousIconJson } from './export'
import { parseFigmaFileKey } from './file-key'
import { defaultIconNameForNode } from './naming'
import { writePreviewHtml } from './preview'
import { processIconSet } from './process'
import { resolveFigmaToken } from './token'
import { formatValidationIssues, validateIconSet } from './validate'

export interface SyncOptions {
  cwd?: string
  config: ResolvedFigmaIconifyConfig
  env?: NodeJS.Dict<string>
  dryRun?: boolean
  continueOnError?: boolean
  iconSet?: IconSet
}

export interface SyncResult {
  prefix: string
  fileKey: string
  fileVersion?: string
  notModified: boolean
  processed: number
  failed: string[]
  issues: { name: string, message: string }[]
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

export async function importLocalSvgDirectory(dir: string, prefix: string): Promise<IconSet> {
  return await importDirectory(dir, { prefix })
}

export function emptyIconSet(prefix: string): IconSet {
  return blankIconSet(prefix)
}

export async function sync(options: SyncOptions): Promise<SyncResult> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config
  const fileKey = parseFigmaFileKey(config.file)
  const previous = await readPreviousIconJson(join(cwd, config.output.json))
  const cacheMetaFile = join(cwd, config.cacheDir, 'meta.json')
  const previousMeta = await readCacheMeta(cacheMetaFile)

  let iconSet = options.iconSet
  let fileVersion: string | undefined
  let notModified = false

  if (!iconSet) {
    const token = resolveFigmaToken(config.token, options.env ?? process.env)
    const figmaOptions = {
      token,
      file: fileKey,
      prefix: config.prefix,
      depth: config.depth,
      cacheDir: join(cwd, config.cacheDir),
      iconNameForNode: config.iconNameForNode ?? (node => defaultIconNameForNode(node, {
        skipPrefix: config.validate.skipPrefix,
      })),
      ...(config.pages ? { pages: config.pages } : {}),
      ...(config.ids ? { ids: config.ids } : {}),
    }
    const imported = previousMeta?.lastModified
      ? await importFromFigma({ ...figmaOptions, ifModifiedSince: previousMeta.lastModified })
      : await importFromFigma(figmaOptions)

    if (imported === 'not_modified') {
      notModified = true
      const json = previous ?? { prefix: config.prefix, icons: {} }
      const result: SyncResult = {
        prefix: config.prefix,
        fileKey,
        notModified,
        processed: 0,
        failed: [],
        issues: [],
        diff: diffIconSets(json, json),
        files: [],
        json,
      }
      if (previousMeta?.version) {
        result.fileVersion = previousMeta.version
      }
      return result
    }

    iconSet = imported.iconSet
    fileVersion = imported.version
    if (!options.dryRun) {
      await writeCacheMeta(cacheMetaFile, {
        lastModified: imported.lastModified,
        version: imported.version,
      })
    }
  }

  const processed = processIconSet(iconSet, config)
  const { issues } = validateIconSet(iconSet, config)

  if (issues.length && !options.continueOnError) {
    throw new FigmaIconifyError(`Icon validation failed:\n${formatValidationIssues(issues)}`)
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
    fileKey,
    notModified,
    processed: processed.processed,
    failed: processed.failed,
    issues,
    diff: diffIconSets(previous, exported.json),
    files: exported.files,
    json: exported.json,
  }
  if (fileVersion) {
    result.fileVersion = fileVersion
  }
  return result
}

import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedIconctlConfig } from './config'
import type { IconDiff } from './diff'
import type { SyncIssue } from './errors'
import type { FigmaSourceLoadOptions } from './sources/figma'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname, resolve } from 'pathe'
import { checkpoint, throwIfAborted } from './abort'
import { writeChangelog } from './changelog'
import { diffIconSets } from './diff'
import { IconctlSyncError } from './errors'
import { generateOutputs, outputTargets, readPreviousIconJson, stagedConfig } from './export'
import { OutputTransaction } from './output-transaction'
import { writePreviewHtml } from './preview'
import { processIconSetAsync } from './process'
import { loadSources, mergeIconSetsAsync } from './sources/load'
import { validateIconSetAsync } from './validate'

export interface SyncOptions {
  cwd?: string
  signal?: AbortSignal
  config: ResolvedIconctlConfig
  env?: NodeJS.Dict<string>
  dryRun?: boolean
  continueOnError?: boolean
  iconSet?: IconSet
  figmaAuthProvider?: FigmaSourceLoadOptions['authProvider']
}

export interface SyncResult {
  complete: boolean
  prefix: string
  fileKey?: string
  fileVersion?: string
  notModified: boolean
  processed: number
  failed: string[]
  issues: SyncIssue[]
  sources: { type: string, notModified: boolean, fileKey?: string }[]
  diff: IconDiff & { deletionsReliable: boolean }
  files: string[]
  json: IconifyJSON
}

interface CacheMeta {
  configDigest?: string
  outputDigest?: string
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
  throwIfAborted(options.signal)
  const cancellation = options.signal ? { signal: options.signal } : {}
  const cwd = options.cwd ?? process.cwd()
  const config = options.config
  const previous = await readPreviousIconJson(resolve(cwd, config.output.json))
  const cacheMetaFile = resolve(cwd, config.cacheDir, 'meta.json')
  const previousMeta = await readCacheMeta(cacheMetaFile)
  const configDigest = createHash('sha256')
    .update(
      JSON.stringify(config, (key, value) =>
        key === 'token'
          ? undefined
          : typeof value === 'function' || value instanceof RegExp
            ? String(value)
            : value),
    )
    .digest('hex')

  let iconSet = options.iconSet
  let fileVersion: string | undefined
  let fileKey: string | undefined
  let notModified = false
  let nextMeta: CacheMeta | undefined
  const sourceIssues: SyncIssue[] = []
  const sourceSummaries: SyncResult['sources'] = []

  if (!iconSet) {
    const loaded = await loadSources({
      cwd,
      config,
      ...cancellation,
      ...(options.env ? { env: options.env } : {}),
      ...(options.figmaAuthProvider
        ? { figmaAuthProvider: options.figmaAuthProvider }
        : {}),
      ...(previous
        && previousMeta?.outputDigest === createHash('sha256').update(JSON.stringify(previous)).digest('hex')
        && previousMeta?.configDigest === configDigest
        && previousMeta?.lastModified
        ? { figmaIfModifiedSince: previousMeta.lastModified }
        : {}),
    })

    await checkpoint(options.signal)
    sourceIssues.push(...loaded.flatMap((item, sourceIndex) => item.issues ?? item.failures?.map(failure => ({
      ...failure,
      stage: 'import' as const,
      sourceType: item.type,
      sourceIndex,
    })) ?? []))
    if (sourceIssues.length && !options.continueOnError) {
      throw new IconctlSyncError(sourceIssues)
    }
    notModified = loaded.length > 0 && loaded.every(item => item.notModified)
    if (notModified) {
      const json = previous ?? { prefix: config.prefix, icons: {} }
      const result: SyncResult = {
        prefix: config.prefix,
        complete: true,
        notModified,
        processed: 0,
        failed: [],
        issues: [],
        sources: loaded.map(item => ({
          type: item.type,
          notModified: item.notModified,
          ...(item.fileKey ? { fileKey: item.fileKey } : {}),
        })),
        diff: { ...diffIconSets(json, json), deletionsReliable: true },
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

    const sets = loaded.flatMap(item => (item.iconSet ? [item.iconSet] : []))
    iconSet = await mergeIconSetsAsync(config.prefix, sets, options.signal)
    fileVersion = loaded.find(item => item.fileVersion)?.fileVersion
    fileKey = loaded.find(item => item.fileKey)?.fileKey
    for (const item of loaded) {
      sourceSummaries.push({
        type: item.type,
        notModified: item.notModified,
        ...(item.fileKey ? { fileKey: item.fileKey } : {}),
      })
    }

    const figma = loaded.find(
      item => item.type === 'figma' && item.lastModified,
    )
    if (!options.dryRun && figma?.lastModified) {
      nextMeta = {
        configDigest,
        lastModified: figma.lastModified,
        ...(figma.fileVersion ? { version: figma.fileVersion } : {}),
      }
    }
  }

  const processed = await processIconSetAsync(iconSet, config, options.signal)
  const validation = await validateIconSetAsync(iconSet, config, options.signal)
  const issues: SyncIssue[] = [
    ...sourceIssues,
    ...processed.issues,
    ...validation.issues.map(issue => ({ ...issue, stage: 'validation' as const })),
  ]
  const failed = [...new Set([...sourceIssues.map(issue => issue.name), ...processed.failed])].sort()
  const complete = !issues.length
  if (!complete && !options.continueOnError) {
    throw new IconctlSyncError(issues, 'Icon processing or validation failed')
  }

  await checkpoint(options.signal)
  const json = iconSet.export()
  const diff = { ...diffIconSets(previous, json), deletionsReliable: complete }
  if (!complete) {
    diff.removed = []
  }
  const files: string[] = []
  if (!options.dryRun) {
    // Keep every configured target visible to collision checks, even when an
    // incomplete run preserves the changelog instead of appending to it.
    const { changelog } = config.output
    const targets = outputTargets(config, cwd)
    const transaction = await OutputTransaction.create([...targets, { path: cacheMetaFile }], options.signal)
    try {
      const staged = stagedConfig(config, cwd, transaction)
      await generateOutputs(iconSet, staged, { cwd, ...cancellation })
      // Package cleanup may encompass the changelog. Seed it from the live
      // output before appending a complete diff (or preserving a partial run).
      if (changelog) {
        const stagedChangelog = transaction.path(resolve(cwd, changelog))
        try {
          await mkdir(dirname(stagedChangelog), { recursive: true })
          await copyFile(resolve(cwd, changelog), stagedChangelog)
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
      files.push(resolve(cwd, config.output.json))
      if (config.output.svg) {
        files.push(resolve(cwd, config.output.svg))
      }
      if (config.output.jsonPackage) {
        files.push(resolve(cwd, config.output.jsonPackage.dir))
      }
      if (config.output.types) {
        files.push(resolve(cwd, config.output.types))
      }
      await checkpoint(options.signal)
      if (staged.output.preview) {
        await writePreviewHtml(staged.output.preview, json)
        files.push(resolve(cwd, config.output.preview!))
      }
      await checkpoint(options.signal)
      if (complete && staged.output.changelog) {
        const written = await writeChangelog(staged.output.changelog, diff)
        if (written) {
          files.push(resolve(cwd, changelog!))
        }
      }
      await checkpoint(options.signal)
      const stagedMeta = transaction.path(cacheMetaFile)
      if (complete && nextMeta) {
        await writeCacheMeta(stagedMeta, {
          ...nextMeta,
          outputDigest: createHash('sha256').update(JSON.stringify(json)).digest('hex'),
        })
      }
      else {
        await rm(stagedMeta, { force: true })
      }
      await transaction.commit(options.signal)
    }
    finally {
      await transaction.dispose()
    }
  }
  else {
    await checkpoint(options.signal)
  }

  const result: SyncResult = {
    prefix: config.prefix,
    notModified,
    complete,
    processed: processed.processed,
    failed,
    issues,
    sources: sourceSummaries,
    diff,
    files,
    json,
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

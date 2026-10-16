import type { ResolvedIconctlConfig } from './config'
import type { FigmaNameEntry } from './figma-naming'
import type { ResolvedFigmaSourceConfig } from './sources/types'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { lock } from 'proper-lockfile'
import { IconctlError } from './errors'
import { canonicalTarget } from './output-transaction'

export interface FigmaNamingMapping {
  nodeId: string
  originalName: string
  baseName: string
  parentPath: string[]
  figmaUrl: string
  name?: string
  previousName?: string
}

export interface FigmaNamingPlan {
  sourceIndex: number
  fileKey: string
  namespace: string
  fileVersion: string
  lastModified: string
  policy: 'error' | 'suffix-node-id'
  mappings: FigmaNamingMapping[]
  changes: {
    added: string[]
    removed: string[]
    renamed: { nodeId: string, from: string, to: string }[]
    disambiguated: { nodeId: string, from: string, to: string }[]
  }
}

export interface FigmaNamingManifestSource {
  fileKey: string
  namespace: string
  entries: Record<string, FigmaNameEntry>
  activeNodeIds: string[]
}

export interface FigmaNamingManifest {
  version: 1
  sources: Record<string, FigmaNamingManifestSource>
}

export function preservesFigmaNames(source: ResolvedFigmaSourceConfig): boolean {
  return source.naming?.preserveNames ?? source.naming?.duplicates === 'suffix-node-id'
}

export function usesFigmaNamingManifest(config: ResolvedIconctlConfig): boolean {
  return config.sources.some(source => source.type === 'figma' && preservesFigmaNames(source))
}

export function figmaNamingSourceKey(fileKey: string, namespace = ''): string {
  return JSON.stringify([fileKey, namespace])
}

export function namingManifestPath(config: ResolvedIconctlConfig, cwd: string): string {
  return resolve(cwd, config.namingManifest ?? '.iconctl-names.json')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function readFigmaNamingManifest(file: string): Promise<FigmaNamingManifest> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, sources: {} }
    }
    throw new IconctlError('Could not read Figma naming manifest.', { code: 'FIGMA_NAMING_MANIFEST_INVALID', cause: error })
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!record(value) || value['version'] !== 1 || !record(value['sources'])) {
      throw new Error('Expected version 1 and a sources object')
    }
    for (const [key, source] of Object.entries(value['sources'])) {
      if (!record(source) || typeof source['fileKey'] !== 'string' || !source['fileKey']
        || typeof source['namespace'] !== 'string' || key !== figmaNamingSourceKey(source['fileKey'], source['namespace'])
        || !record(source['entries']) || !Array.isArray(source['activeNodeIds'])) {
        throw new Error('Invalid source identity or entries')
      }
      const names = new Set<string>()
      for (const [id, entry] of Object.entries(source['entries'])) {
        if (!id || !record(entry) || typeof entry['name'] !== 'string' || !entry['name'].trim()
          || typeof entry['baseName'] !== 'string' || !entry['baseName'].trim() || names.has(entry['name'])) {
          throw new Error('Empty or duplicate public name')
        }
        names.add(entry['name'])
      }
      const ids = source['activeNodeIds']
      if (ids.some(id => typeof id !== 'string' || !Object.hasOwn(source['entries'] as object, id)) || new Set(ids).size !== ids.length) {
        throw new Error('Invalid active node IDs')
      }
    }
    return value as unknown as FigmaNamingManifest
  }
  catch (error) {
    throw new IconctlError('Invalid Figma naming manifest. Restore a valid version-1 manifest or explicitly review and repair its name assignments; it will not be reset automatically.', { code: 'FIGMA_NAMING_MANIFEST_INVALID', cause: error })
  }
}

/** Stable ordering makes this file suitable for code review and source control. */
export function serializeFigmaNamingManifest(manifest: FigmaNamingManifest): string {
  return `${JSON.stringify({
    version: 1,
    sources: Object.fromEntries(Object.entries(manifest.sources).sort(([a], [b]) => a.localeCompare(b)).map(([key, source]) => [key, {
      ...source,
      activeNodeIds: [...source['activeNodeIds']].sort(),
      entries: Object.fromEntries(Object.entries(source['entries']).sort(([a], [b]) => a.localeCompare(b))),
    }])),
  }, null, 2)}\n`
}

export async function writeFigmaNamingManifest(file: string, manifest: FigmaNamingManifest): Promise<void> {
  await writeFile(file, serializeFigmaNamingManifest(manifest), 'utf8')
}

/** Keep the lock outside output directories, which may be atomically replaced. */
export async function withFigmaNamingLock<T>(file: string, action: (assertOwned: () => void) => Promise<T>): Promise<T> {
  const canonical = await canonicalTarget(file)
  const lockfilePath = join(tmpdir(), `iconctl-names-${createHash('sha256').update(canonical.path).digest('hex')}.lock`)
  let compromised = false
  const assertOwned = () => {
    if (compromised) {
      throw new IconctlError('Figma naming lock was lost; retry the sync.', { code: 'FIGMA_NAMING_LOCK_LOST', retryable: true })
    }
  }
  let release: () => Promise<void>
  try {
    release = await lock(canonical.path, {
      realpath: false,
      lockfilePath,
      stale: 30_000,
      update: 10_000,
      retries: 0,
      onCompromised: () => { compromised = true },
    })
  }
  catch (error) {
    throw new IconctlError('Cannot lock the Figma naming manifest. Another sync may be running; retry after it completes.', { code: 'FIGMA_NAMING_LOCKED', retryable: true, cause: error })
  }
  try {
    assertOwned()
    const result = await action(assertOwned)
    assertOwned()
    return result
  }
  finally {
    if (!compromised) {
      await release()
    }
  }
}

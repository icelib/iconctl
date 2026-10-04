import type { IconifyJSON } from '@iconify/types'
import { IconctlError } from './errors'
import { generateIconNameTypes } from './export'
import { normalizeIconifyJson } from './iconify-json'
import { writeTextOutput } from './text-output'

export interface IconNameTypesSummary {
  prefix: string
  count: number
}

export interface WriteIconNameTypesOptions {
  /** Protect source paths, including symlink and hard-link aliases. */
  inputs?: readonly string[]
  /** Fully validate without creating output, parents or staging files. */
  dryRun?: boolean
}

function prepareIconNameTypes(json: IconifyJSON): { types: string, summary: IconNameTypesSummary } {
  const normalized = normalizeIconifyJson(json)
  if (normalized.issues.length) {
    throw new IconctlError(`Invalid icon name type collection:\n${normalized.issues.map(issue => `- ${issue.name}: ${issue.message}`).join('\n')}`)
  }
  const names = Object.keys(normalized.json.icons).sort()
  return {
    types: generateIconNameTypes(normalized.json.prefix, names),
    summary: { prefix: normalized.json.prefix, count: names.length },
  }
}

/** Describe every icon and resolved alias without source cleanup or name changes. */
export function renderIconNameTypes(json: IconifyJSON): string {
  return prepareIconNameTypes(json).types
}

/** Validate the collection and atomically publish one TypeScript file. */
export async function writeIconNameTypes(file: string, json: IconifyJSON, options: WriteIconNameTypesOptions = {}): Promise<IconNameTypesSummary> {
  const { types, summary } = prepareIconNameTypes(json)
  await writeTextOutput(file, types, { ...options, label: 'Types' })
  return summary
}

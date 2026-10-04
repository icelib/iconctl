import type { IconifyJSON } from '@iconify/types'
import { IconSet } from '@iconify/tools'
import { IconctlError } from './errors'
import { normalizeIconifyJson } from './iconify-json'
import { generateSvgSprite } from './sprite'
import { writeTextOutput } from './text-output'

export interface SvgSpriteSummary {
  prefix: string
  count: number
}

export interface WriteSvgSpriteOptions {
  /** Protect source paths, including symlink and hard-link aliases. */
  inputs?: readonly string[]
  /** Fully validate without creating output, parents or staging files. */
  dryRun?: boolean
}

async function prepareSvgSprite(json: IconifyJSON): Promise<{ svg: string, summary: SvgSpriteSummary }> {
  const normalized = normalizeIconifyJson(json)
  if (normalized.issues.length) {
    throw new IconctlError(`Invalid SVG sprite icon set:\n${normalized.issues.map(issue => `- ${issue.name}: ${issue.message}`).join('\n')}`)
  }
  const svg = await generateSvgSprite(new IconSet(normalized.json))
  return { svg, summary: { prefix: normalized.json.prefix, count: Object.keys(normalized.json.icons).length } }
}

/** Render every icon and resolved alias without source cleanup or color changes. */
export async function renderSvgSprite(json: IconifyJSON): Promise<string> {
  return (await prepareSvgSprite(json)).svg
}

/** Validate and atomically publish a single static SVG sprite. */
export async function writeSvgSprite(file: string, json: IconifyJSON, options: WriteSvgSpriteOptions = {}): Promise<SvgSpriteSummary> {
  const { svg, summary } = await prepareSvgSprite(json)
  await writeTextOutput(file, svg, { ...options, label: 'Sprite' })
  return summary
}

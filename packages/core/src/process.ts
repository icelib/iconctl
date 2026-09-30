import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from './config'
import type { SyncIssue } from './errors'
import {
  cleanupSVG,
  isEmptyColor,
  parseColors,
  removeFigmaClipPathFromSVG,
  runSVGO,
} from '@iconify/tools'

import { checkpoint } from './abort'

export interface ProcessResult {
  processed: number
  failed: string[]
  issues: SyncIssue[]
}

function processIcon(iconSet: IconSet, config: ResolvedIconctlConfig, name: string, result: ProcessResult): void {
  try {
    const svg = iconSet.toSVG(name)
    if (!svg) {
      throw new Error('Icon is not a valid SVG')
    }
    cleanupSVG(svg)
    removeFigmaClipPathFromSVG(svg)
    if (config.color !== false) {
      const color = config.color
      parseColors(svg, {
        defaultColor: color,
        callback: (_attr, colorStr, parsed) => {
          if (!parsed || isEmptyColor(parsed)) {
            return colorStr
          }
          return color
        },
      })
    }
    runSVGO(svg)
    if (!iconSet.fromSVG(name, svg)) {
      throw new Error('Could not import the processed SVG')
    }
    result.processed++
  }
  catch (error) {
    iconSet.remove(name)
    result.failed.push(name)
    result.issues.push({ name, stage: 'process', message: error instanceof Error ? error.message : 'SVG processing failed' })
  }
}

export function processIconSet(iconSet: IconSet, config: ResolvedIconctlConfig): ProcessResult {
  const result: ProcessResult = { processed: 0, failed: [], issues: [] }
  iconSet.forEachSync((name, type) => {
    if (type === 'icon') {
      processIcon(iconSet, config, name, result)
    }
  })
  return result
}

export async function processIconSetAsync(iconSet: IconSet, config: ResolvedIconctlConfig, signal?: AbortSignal): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, failed: [], issues: [] }
  await iconSet.forEach(async (name, type) => {
    await checkpoint(signal)
    if (type === 'icon') {
      processIcon(iconSet, config, name, result)
    }
  })
  await checkpoint(signal)
  return result
}

import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from './config'
import type { SyncIssue } from './errors'
import type { ProgressReporter } from './progress'
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

type ProcessOptions = Pick<ResolvedIconctlConfig, 'color'>

function processIcon(iconSet: IconSet, config: ProcessOptions, name: string, result: ProcessResult): void {
  let stage = 'reading SVG'
  try {
    const svg = iconSet.toSVG(name)
    if (!svg) {
      throw new Error('Icon is not a valid SVG')
    }
    stage = 'cleaning SVG'
    cleanupSVG(svg)
    removeFigmaClipPathFromSVG(svg)
    if (config.color !== false) {
      stage = 'normalizing SVG colors'
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
    stage = 'optimizing SVG'
    runSVGO(svg)
    if (!iconSet.fromSVG(name, svg)) {
      throw new Error('Could not import the processed SVG')
    }
    result.processed++
  }
  catch {
    iconSet.remove(name)
    result.failed.push(name)
    result.issues.push({ name, stage: 'process', message: `Failed while ${stage}. Check the source SVG.` })
  }
}

export function processIconSet(iconSet: IconSet, config: ProcessOptions): ProcessResult {
  const result: ProcessResult = { processed: 0, failed: [], issues: [] }
  iconSet.forEachSync((name, type) => {
    if (type === 'icon') {
      processIcon(iconSet, config, name, result)
    }
  })
  return result
}

export async function processIconSetAsync(iconSet: IconSet, config: ProcessOptions, signal?: AbortSignal, report?: ProgressReporter): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, failed: [], issues: [] }
  const total = iconSet.list(['icon']).length
  let completed = 0
  report?.({ stage: 'process', completed, total })
  await iconSet.forEach(async (name, type) => {
    await checkpoint(signal)
    if (type === 'icon') {
      processIcon(iconSet, config, name, result)
      report?.({ stage: 'process', name, completed: ++completed, total })
    }
  })
  await checkpoint(signal)
  return result
}

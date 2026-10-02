import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from './config'
import {
  cleanupSVG,
  isEmptyColor,
  parseColors,
  removeFigmaClipPathFromSVG,
  runSVGO,
} from '@iconify/tools'

export interface ProcessResult {
  processed: number
  failed: string[]
  issues: { name: string, message: string }[]
}

export function processIconSet(iconSet: IconSet, config: ResolvedIconctlConfig): ProcessResult {
  const failed: string[] = []
  const issues: ProcessResult['issues'] = []
  let processed = 0

  iconSet.forEachSync((name, type) => {
    if (type !== 'icon') {
      return
    }

    let stage = 'reading SVG'
    try {
      const svg = iconSet.toSVG(name)
      if (!svg) {
        throw new Error('Invalid SVG')
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
      iconSet.fromSVG(name, svg)
      processed += 1
    }
    catch {
      iconSet.remove(name)
      failed.push(name)
      issues.push({ name, message: `Failed while ${stage}. Check the source SVG.` })
    }
  })

  return { processed, failed, issues }
}

import type { IconSet } from '@iconify/tools'
import type { ResolvedFigmaIconifyConfig } from './config'
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
}

export function processIconSet(iconSet: IconSet, config: ResolvedFigmaIconifyConfig): ProcessResult {
  const failed: string[] = []
  let processed = 0

  iconSet.forEachSync((name, type) => {
    if (type !== 'icon') {
      return
    }

    const svg = iconSet.toSVG(name)
    if (!svg) {
      iconSet.remove(name)
      failed.push(name)
      return
    }

    try {
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
      iconSet.fromSVG(name, svg)
      processed += 1
    }
    catch (error) {
      iconSet.remove(name)
      failed.push(name)
      void error
    }
  })

  return { processed, failed }
}

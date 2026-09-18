import type { IconSet } from '@iconify/tools'
import { blankIconSet, SVG } from '@iconify/tools'
import { toIconName } from './naming'

export function addSvgToIconSet(iconSet: IconSet, name: string, svg: string) {
  iconSet.fromSVG(name, new SVG(svg))
}

export function applyNameTransform(
  iconSet: IconSet,
  transform: (name: string) => string | null,
): IconSet {
  const next = blankIconSet(iconSet.prefix)
  iconSet.forEachSync((name, type) => {
    if (type !== 'icon') {
      return
    }
    const renamed = transform(name)
    const svg = iconSet.toSVG(name)
    if (!renamed || !svg) {
      return
    }
    next.fromSVG(renamed, svg)
  })
  return next
}

export function stripIconPrefix(name: string, stripPrefix: string): string {
  const trimmed = stripPrefix && name.startsWith(stripPrefix) ? name.slice(stripPrefix.length) : name
  return toIconName(trimmed)
}

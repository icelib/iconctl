import type { FigmaImportNodeData } from '@iconify/tools/lib/import/figma/types/nodes'
import { cleanupIconKeyword } from '@iconify/tools'

export interface IconNameOptions {
  skipPrefix?: string[]
}

export function toIconName(raw: string): string {
  return cleanupIconKeyword(raw, true)
}

export function shouldSkipName(name: string, skipPrefix: string[] = ['_', '.']): boolean {
  const trimmed = name.trim()
  return !trimmed || skipPrefix.some(prefix => trimmed.startsWith(prefix))
}

export function defaultIconNameForNode(
  node: FigmaImportNodeData,
  options: IconNameOptions = {},
): string | null {
  if (shouldSkipName(node.name, options.skipPrefix)) {
    return null
  }

  if (node.type !== 'COMPONENT' && node.type !== 'FRAME') {
    return null
  }

  const componentSet = [...node.parents].reverse().find(parent => parent.type === 'COMPONENT_SET')
  const raw = componentSet ? `${componentSet.name}-${node.name}` : node.name
  const keyword = toIconName(raw)
  return keyword || null
}

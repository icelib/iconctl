export interface FigmaNamingParentNode {
  id: string
  name: string
  type: string
}

/** The structural node information available to Figma naming helpers. */
export interface FigmaNamingNode {
  id: string
  name: string
  type: string
  parents: readonly FigmaNamingParentNode[]
  width?: number
  height?: number
}

/** Transform the default name after the default node filters have run. */
export type FigmaNameTransform = (name: string, node: FigmaNamingNode) => string | null

export interface FigmaNamingOptions {
  duplicates?: 'error' | 'suffix-node-id'
  preserveNames?: boolean
  namespace?: string
  transform?: FigmaNameTransform
}

export interface IconNameOptions {
  skipPrefix?: string[]
}

export function toIconName(raw: string): string {
  // Keep the established @iconify/tools cleanupIconKeyword(raw, true) behavior,
  // including treating each consecutive uppercase run as one word.
  return raw.replace(/[A-Z]+/g, chars => `_${chars.toLowerCase()}`)
    .toLowerCase()
    .trim()
    .replace(/[\s_.:/\\]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function shouldSkipName(name: string, skipPrefix: string[] = ['_', '.']): boolean {
  const trimmed = name.trim()
  return !trimmed || skipPrefix.some(prefix => trimmed.startsWith(prefix))
}

export function defaultIconNameForNode(
  node: FigmaNamingNode,
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

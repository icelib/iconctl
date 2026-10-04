import type { PreflightItem } from './preflight'

export interface NamesJson {
  json: string
  componentCount: number
  uniqueCount: number
  duplicateCount: number
}

export interface NodeIdsJson {
  json: string
  componentCount: number
}

/** Node IDs remain useful even when local names cannot be determined. */
export function visibleNodeIdsJson(items: readonly PreflightItem[]): NodeIdsJson {
  if (!items.length) {
    throw new Error('No visible components. Adjust or clear the filters before copying.')
  }
  if (items.length > 5000) {
    throw new Error('This view exceeds 5000 components. Narrow the filters before copying.')
  }
  const ids = items.map(item => item.id)
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Visible components contain missing or duplicate node IDs. Rescan before copying; no partial list is copied.')
  }
  const json = `${JSON.stringify(ids.sort(), null, 2)}\n`
  if (new TextEncoder().encode(json).byteLength > 1024 * 1024) {
    throw new Error('The node IDs JSON exceeds 1 MiB. Narrow the filters before copying.')
  }
  return { json, componentCount: items.length }
}

/** UI-only formatter. The caller supplies the existing filtered, non-draft view. */
export function visibleNamesJson(items: readonly PreflightItem[]): NamesJson {
  if (!items.length) {
    throw new Error('No visible components. Adjust or clear the filters before copying.')
  }
  if (items.length > 5000) {
    throw new Error('This view exceeds 5000 components. Narrow the filters before copying.')
  }
  const missing = items.filter(item => typeof item.iconName !== 'string' || !item.iconName.trim()).length
  if (missing) {
    throw new Error(`${missing} visible ${missing === 1 ? 'component has' : 'components have'} no local name. Fix the names or adjust the filters; no partial list is copied.`)
  }
  const names = [...new Set(items.map(item => item.iconName!))].sort()
  const json = `${JSON.stringify(names, null, 2)}\n`
  if (new TextEncoder().encode(json).byteLength > 1024 * 1024) {
    throw new Error('The names JSON exceeds 1 MiB. Narrow the filters before copying.')
  }
  return { json, componentCount: items.length, uniqueCount: names.length, duplicateCount: items.length - names.length }
}

import {
  DEFAULT_NAME_PATTERN,
  DEFAULT_SIZE,
  shouldSkipName,
  toIconName,
} from './naming'

export interface PreflightInput {
  id: string
  name: string
  type: string
  width: number
  height: number
  parentName?: string
  parentType?: string
}

export interface PreflightItem {
  id: string
  name: string
  iconName: string | null
  skipped: boolean
  width: number
  height: number
  issues: string[]
}

export interface PreflightRules {
  width?: number | undefined
  height?: number | undefined
  name?: string | undefined
  skipPrefix?: string[]
  namingMode?: 'default' | 'server'
}
const legacyRules: PreflightRules = { width: DEFAULT_SIZE, height: DEFAULT_SIZE }

export function inspectComponent(input: PreflightInput, rules: PreflightRules = legacyRules): PreflightItem {
  if (shouldSkipName(input.name, rules.skipPrefix)) {
    return {
      id: input.id,
      name: input.name,
      iconName: null,
      skipped: true,
      width: input.width,
      height: input.height,
      issues: [],
    }
  }

  const raw
    = input.parentType === 'COMPONENT_SET' && input.parentName
      ? `${input.parentName}-${input.name}`
      : input.name
  const iconName = toIconName(raw) || null
  const issues: string[] = []

  const pattern = rules.name === undefined ? DEFAULT_NAME_PATTERN : new RegExp(rules.name)
  if (rules.namingMode !== 'server' && (!iconName || !pattern.test(iconName))) {
    issues.push(
      `Name "${input.name}" does not match the naming rule (got ${iconName || '(empty)'})`,
    )
  }
  if ((rules.width !== undefined && input.width !== rules.width) || (rules.height !== undefined && input.height !== rules.height)) {
    issues.push(
      `Canvas is ${input.width}×${input.height}, expected ${rules.width ?? 'any'}×${rules.height ?? 'any'}`,
    )
  }

  return {
    id: input.id,
    name: input.name,
    iconName,
    skipped: false,
    width: input.width,
    height: input.height,
    issues,
  }
}

export function inspectComponents(nodes: PreflightInput[], rules?: PreflightRules): PreflightItem[] {
  const items = nodes.map(node => inspectComponent(node, rules))
  // A server hook can assign different final names to equal local previews.
  if (rules?.namingMode === 'server') {
    return items
  }
  const names = new Map<string, Set<string>>()
  for (const item of items) {
    if (!item.skipped && item.iconName) {
      const ids = names.get(item.iconName) ?? new Set<string>()
      ids.add(item.id)
      names.set(item.iconName, ids)
    }
  }
  for (const item of items) {
    const count = !item.skipped && item.iconName ? names.get(item.iconName)?.size ?? 0 : 0
    if (count > 1) {
      item.issues.push(`Duplicate icon name "${item.iconName}" on this page (${count} components). Rename a component and rescan.`)
    }
  }
  return items
}

export function canSubmit(items: PreflightItem[]): boolean {
  const visible = items.filter(item => !item.skipped)
  return (
    visible.length > 0 && visible.every(item => item.issues.length === 0)
  )
}

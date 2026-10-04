import type { PreflightDiagnostic } from './diagnostics'
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
  diagnostics?: PreflightDiagnostic[]
}

export interface PreflightRules {
  width?: number | undefined
  height?: number | undefined
  name?: string | undefined
  skipPrefix?: string[]
  namingMode?: 'default' | 'server'
}
const legacyRules: PreflightRules = { width: DEFAULT_SIZE, height: DEFAULT_SIZE }

type ScannedItem = Omit<PreflightItem, 'issues'> & { diagnostics: PreflightDiagnostic[] }

function withIssues(item: ScannedItem): PreflightItem {
  return { ...item, issues: item.diagnostics.map(diagnostic => diagnostic.message) }
}

function scanComponent(input: PreflightInput, rules: PreflightRules = legacyRules): ScannedItem {
  if (shouldSkipName(input.name, rules.skipPrefix)) {
    return {
      id: input.id,
      name: input.name,
      iconName: null,
      skipped: true,
      width: input.width,
      height: input.height,
      diagnostics: [],
    }
  }

  const raw
    = input.parentType === 'COMPONENT_SET' && input.parentName
      ? `${input.parentName}-${input.name}`
      : input.name
  const iconName = toIconName(raw) || null
  const diagnostics: PreflightDiagnostic[] = []

  const pattern = rules.name === undefined ? DEFAULT_NAME_PATTERN : new RegExp(rules.name)
  if (rules.namingMode !== 'server' && (!iconName || !pattern.test(iconName))) {
    diagnostics.push({ code: 'name-rule', message: `Name "${input.name}" does not match the naming rule (got ${iconName || '(empty)'})` })
  }
  if ((rules.width !== undefined && input.width !== rules.width) || (rules.height !== undefined && input.height !== rules.height)) {
    diagnostics.push({ code: 'canvas-size', message: `Canvas is ${input.width}×${input.height}, expected ${rules.width ?? 'any'}×${rules.height ?? 'any'}` })
  }

  return {
    id: input.id,
    name: input.name,
    iconName,
    skipped: false,
    width: input.width,
    height: input.height,
    diagnostics,
  }
}

export function inspectComponent(input: PreflightInput, rules?: PreflightRules): PreflightItem {
  return withIssues(scanComponent(input, rules))
}

export function inspectComponents(nodes: PreflightInput[], rules?: PreflightRules): PreflightItem[] {
  const items = nodes.map(node => scanComponent(node, rules))
  // A server hook can assign different final names to equal local previews.
  if (rules?.namingMode === 'server') {
    return items.map(withIssues)
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
      item.diagnostics.push({ code: 'duplicate-name', message: `Duplicate icon name "${item.iconName}" on this page (${count} components). Rename a component and rescan.` })
    }
  }
  return items.map(withIssues)
}

export function canSubmit(items: PreflightItem[]): boolean {
  const visible = items.filter(item => !item.skipped)
  return (
    visible.length > 0 && visible.every(item => item.issues.length === 0)
  )
}

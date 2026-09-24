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

export function inspectComponent(input: PreflightInput): PreflightItem {
  if (shouldSkipName(input.name)) {
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

  if (!iconName || !DEFAULT_NAME_PATTERN.test(iconName)) {
    issues.push(
      `Name "${input.name}" is not kebab-case English (got ${iconName || '(empty)'})`,
    )
  }
  if (input.width !== DEFAULT_SIZE || input.height !== DEFAULT_SIZE) {
    issues.push(
      `Canvas is ${input.width}×${input.height}, expected ${DEFAULT_SIZE}×${DEFAULT_SIZE}`,
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

export function inspectComponents(nodes: PreflightInput[]): PreflightItem[] {
  return nodes.map(inspectComponent)
}

export function canSubmit(items: PreflightItem[]): boolean {
  const visible = items.filter(item => !item.skipped)
  return (
    visible.length > 0 && visible.every(item => item.issues.length === 0)
  )
}

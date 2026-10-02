import type { IconSet } from '@iconify/tools'
import type { ResolvedIconctlConfig } from './config'
import { checkpoint } from './abort'

export interface ValidationIssue {
  name: string
  message: string
}

export interface ValidationResult {
  issues: ValidationIssue[]
}

function validator(iconSet: IconSet, config: ResolvedIconctlConfig) {
  const issues: ValidationIssue[] = []
  const names = new Set<string>()

  const validate = (name: string, type: string) => {
    if (type !== 'icon') {
      return
    }

    if (names.has(name)) {
      issues.push({ name, message: `Duplicate icon name "${name}"` })
    }
    names.add(name)

    if (!config.validate.name.test(name)) {
      issues.push({
        name,
        message: `Icon name "${name}" does not match ${config.validate.name}`,
      })
    }

    const svg = iconSet.toSVG(name)
    if (!svg) {
      issues.push({ name, message: `Icon "${name}" is not a valid SVG` })
      return
    }

    const { width, height } = svg.viewBox
    if (config.validate.width != null && width !== config.validate.width) {
      issues.push({
        name,
        message: `Icon "${name}" width is ${width}, expected ${config.validate.width}`,
      })
    }
    if (config.validate.height != null && height !== config.validate.height) {
      issues.push({
        name,
        message: `Icon "${name}" height is ${height}, expected ${config.validate.height}`,
      })
    }
  }
  return { issues, validate }
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map(issue => `- ${issue.name}: ${issue.message}`).join('\n')
}

export function validateIconSet(iconSet: IconSet, config: ResolvedIconctlConfig): ValidationResult {
  const { issues, validate } = validator(iconSet, config)
  iconSet.forEachSync(validate)
  return { issues }
}

export async function validateIconSetAsync(iconSet: IconSet, config: ResolvedIconctlConfig, signal?: AbortSignal): Promise<ValidationResult> {
  const { issues, validate } = validator(iconSet, config)
  await iconSet.forEach(async (name, type) => {
    await checkpoint(signal)
    validate(name, type)
  })
  return { issues }
}

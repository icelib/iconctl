import type { ProjectInput } from '@iconctl/console-contracts'

export const projectFieldKeys = [
  'name',
  'repository',
  'prefix',
  'packageName',
  'sources',
  'color',
  'validate',
  'output',
  'advancedConfig',
] as const

export type ProjectFieldKey = typeof projectFieldKeys[number]

type ProjectFieldValue = ProjectInput[ProjectFieldKey]

export interface ProjectReconcileField {
  key: ProjectFieldKey
  baseline: ProjectFieldValue | undefined
  local: ProjectFieldValue | undefined
  server: ProjectFieldValue | undefined
  localChanged: boolean
  serverChanged: boolean
  conflict: boolean
  choice?: 'local' | 'server'
}

export interface ProjectReconciliation {
  baselineRevision: number
  serverRevision: number
  localSignature: string
  fields: ProjectReconcileField[]
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

/** Equality for one ProjectInput group: object key order is irrelevant, arrays retain order. */
export function projectValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => projectValueEqual(value, right[index]))
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  return keysA.length === keysB.length
    && keysA.every((key, index) => key === keysB[index] && projectValueEqual(a[key], b[key]))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonicalize(object[key])]))
  }
  return value
}

export function projectInputSignature(input: ProjectInput): string {
  return JSON.stringify(projectFieldKeys.map(key => canonicalize(input[key])))
}

export function prepareProjectReconciliation(
  baseline: ProjectInput,
  local: ProjectInput,
  server: ProjectInput,
  baselineRevision: number,
  serverRevision: number,
): ProjectReconciliation {
  const fields = projectFieldKeys.map((key): ProjectReconcileField => {
    const baselineValue = clone(baseline[key])
    const localValue = clone(local[key])
    const serverValue = clone(server[key])
    const localChanged = !projectValueEqual(localValue, baselineValue)
    const serverChanged = !projectValueEqual(serverValue, baselineValue)
    return {
      key,
      baseline: baselineValue,
      local: localValue,
      server: serverValue,
      localChanged,
      serverChanged,
      conflict: localChanged && serverChanged && !projectValueEqual(localValue, serverValue),
    }
  })
  return {
    baselineRevision,
    serverRevision,
    localSignature: projectInputSignature(local),
    fields,
  }
}

export function applyProjectReconciliation(
  reconciliation: ProjectReconciliation,
  choices: Partial<Record<ProjectFieldKey, 'local' | 'server'>>,
): ProjectInput | undefined {
  const result = {} as ProjectInput
  for (const field of reconciliation.fields) {
    if (field.conflict && !choices[field.key]) {
      return undefined
    }
    const selected = field.conflict && choices[field.key] === 'server' ? field.server : field.conflict ? field.local : field.serverChanged && !field.localChanged ? field.server : field.local
    ;(result as Record<ProjectFieldKey, ProjectFieldValue>)[field.key] = clone(selected) as ProjectFieldValue
  }
  return result
}

import type { IconifyJSON } from '@iconify/types'
import type { NormalizedIconifyIcon } from './iconify-json'
import { IconctlError } from './errors'
import { normalizeIconifyJson } from './iconify-json'

export interface IconDiff {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export interface IconComparisonEntry {
  name: string
  status: keyof IconDiff
  before?: NormalizedIconifyIcon
  after?: NormalizedIconifyIcon
}

export interface IconSetComparison {
  beforePrefix: string | null
  afterPrefix: string
  prefixChanged: boolean
  hasChanges: boolean
  diff: IconDiff
  icons: IconComparisonEntry[]
}

function normalize(json: IconifyJSON, label: string) {
  const result = normalizeIconifyJson(json)
  if (result.issues.length) {
    throw new IconctlError(`Invalid ${label} icon set:\n${result.issues.map(issue => `- ${issue.name}: ${issue.message}`).join('\n')}`)
  }
  return result.json
}

/** Compare resolved Iconify geometry, without optimizing paths or changing colors. */
export function compareIconSets(previous: IconifyJSON | undefined, next: IconifyJSON): IconSetComparison {
  const before = previous === undefined ? undefined : normalize(previous, 'previous')
  const after = normalize(next, 'next')
  const diff: IconDiff = { added: [], removed: [], changed: [], unchanged: [] }
  const names = [...new Set([...Object.keys(before?.icons ?? {}), ...Object.keys(after.icons)])].sort()
  const fingerprint = (icon: NormalizedIconifyIcon) => JSON.stringify([
    icon.body,
    icon.left,
    icon.top,
    icon.width,
    icon.height,
    icon.hidden,
  ])
  const icons = names.map((name): IconComparisonEntry => {
    const left = before?.icons[name] as NormalizedIconifyIcon | undefined
    const right = after.icons[name] as NormalizedIconifyIcon | undefined
    const status = !left ? 'added' : !right ? 'removed' : fingerprint(left) === fingerprint(right) ? 'unchanged' : 'changed'
    diff[status].push(name)
    return { name, status, ...(left ? { before: left } : {}), ...(right ? { after: right } : {}) }
  })
  const prefixChanged = before !== undefined && before.prefix !== after.prefix
  return {
    beforePrefix: before?.prefix ?? null,
    afterPrefix: after.prefix,
    prefixChanged,
    hasChanges: prefixChanged || Boolean(diff.added.length + diff.removed.length + diff.changed.length),
    diff,
    icons,
  }
}

/** Keep the original synchronous result shape used by sync and its JSON output. */
export function diffIconSets(previous: IconifyJSON | undefined, next: IconifyJSON): IconDiff {
  return compareIconSets(previous, next).diff
}

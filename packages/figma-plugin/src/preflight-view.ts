import type { PreflightItem } from './preflight'
import { captureDiagnostics } from './diagnostics'

const labels = {
  'name-rule': 'Naming',
  'canvas-size': 'Canvas size',
  'duplicate-name': 'Duplicate names',
  'other': 'Other',
}
type IssueCategory = keyof typeof labels
export type IssueType = 'all' | IssueCategory
export type PreflightSort = 'page' | 'local-name' | 'original-name'

export function issueType(value: string): IssueType {
  return Object.hasOwn(labels, value) ? value as IssueCategory : 'all'
}

export function preflightSort(value: string): PreflightSort {
  return value === 'local-name' || value === 'original-name' ? value : 'page'
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSortKey(left: string | null | undefined, right: string | null | undefined): number {
  const leftBlank = left === undefined || left === null || left.trim().length === 0
  const rightBlank = right === undefined || right === null || right.trim().length === 0
  if (leftBlank !== rightBlank) {
    return leftBlank ? 1 : -1
  }
  if (leftBlank) {
    return 0
  }
  return compareText(left!, right!)
}

/** Categorize existing issues without parsing their messages or adding errors. */
function categories(item: PreflightItem): Set<IssueCategory> {
  if (item.skipped || !item.issues.length) {
    return new Set()
  }
  const diagnostics = captureDiagnostics(item.issues, item.diagnostics)
  if (!diagnostics) {
    return new Set(['other'])
  }
  return new Set(diagnostics.map(diagnostic => issueType(diagnostic.code) === 'all' ? 'other' : diagnostic.code as IssueCategory))
}

/** A derived view: never mutate or replace the complete captured scan. */
export class PreflightView {
  private items: PreflightItem[] = []
  private types = new Map<PreflightItem, Set<IssueCategory>>()
  private counts: Record<IssueCategory, number> = { 'name-rule': 0, 'canvas-size': 0, 'duplicate-name': 0, 'other': 0 }

  capture(items: PreflightItem[]) {
    this.items = items
    this.types.clear()
    this.counts = { 'name-rule': 0, 'canvas-size': 0, 'duplicate-name': 0, 'other': 0 }
    for (const item of items) {
      const types = categories(item)
      this.types.set(item, types)
      for (const type of types) {
        this.counts[type]++
      }
    }
  }

  options(selected: IssueType) {
    return [
      { value: 'all', label: 'All issue types' },
      ...Object.entries(labels)
        .filter(([type]) => type !== 'other' || this.counts.other > 0 || selected === 'other')
        .map(([type, label]) => {
          const count = this.counts[type as IssueCategory]
          return { value: type, label: `${label} (${count} ${count === 1 ? 'component' : 'components'})` }
        }),
    ]
  }

  visible(filters: { search: string, problemsOnly: boolean, issueType: IssueType, sort?: PreflightSort }) {
    const query = filters.search.trim().toLowerCase()
    const visible = this.items.filter(item => !item.skipped && (!filters.problemsOnly || item.issues.length > 0)
      && (filters.issueType === 'all' || this.types.get(item)?.has(filters.issueType))
      && [item.id, item.name, item.iconName ?? '', ...item.issues].some(value => value.toLowerCase().includes(query)))
    if (!filters.sort || filters.sort === 'page') {
      return visible
    }
    // filter made a new array; stable sort keeps capture order for complete ties.
    return visible.sort((left, right) => {
      const primary = filters.sort === 'local-name'
        ? compareSortKey(left.iconName, right.iconName)
        : compareText(left.name, right.name)
      if (primary) {
        return primary
      }
      if (filters.sort === 'local-name') {
        const original = compareText(left.name, right.name)
        if (original) {
          return original
        }
      }
      return compareText(left.id, right.id)
    })
  }
}

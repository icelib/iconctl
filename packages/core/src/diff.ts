import type { IconifyJSON } from '@iconify/types'

export interface IconDiff {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export function diffIconSets(previous: IconifyJSON | undefined, next: IconifyJSON): IconDiff {
  const previousNames = new Set(Object.keys(previous?.icons ?? {}))
  const nextNames = Object.keys(next.icons)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []

  for (const name of nextNames) {
    if (!previousNames.has(name)) {
      added.push(name)
      continue
    }
    if ((previous?.icons[name]?.body ?? '') === next.icons[name]?.body) {
      unchanged.push(name)
    }
    else {
      changed.push(name)
    }
  }

  for (const name of previousNames) {
    if (!(name in next.icons)) {
      removed.push(name)
    }
  }

  added.sort()
  removed.sort()
  changed.sort()
  unchanged.sort()

  return { added, removed, changed, unchanged }
}

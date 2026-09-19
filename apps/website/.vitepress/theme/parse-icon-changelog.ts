export interface IconChangelogDay {
  date: string
  added: string[]
  removed: string[]
  changed: string[]
}

function namesFromBullet(body: string, kind: string): string[] {
  const match = body.match(new RegExp(`^- ${kind}:\\s*(.+)$`, 'm'))
  if (!match?.[1]) {
    return []
  }
  return [...match[1].matchAll(/`([^`]+)`/g)].map(item => item[1]!).filter(Boolean)
}

export function parseIconChangelog(markdown: string): IconChangelogDay[] {
  const days: IconChangelogDay[] = []
  for (const part of markdown.split(/^## /m).slice(1)) {
    const newline = part.indexOf('\n')
    const date = (newline === -1 ? part : part.slice(0, newline)).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue
    }
    const body = newline === -1 ? '' : part.slice(newline + 1)
    days.push({
      date,
      added: namesFromBullet(body, 'Added'),
      removed: namesFromBullet(body, 'Removed'),
      changed: namesFromBullet(body, 'Changed'),
    })
  }
  return days
}

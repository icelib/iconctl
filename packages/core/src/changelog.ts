import type { IconDiff } from './diff'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'

export function changelogDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function formatChangelogBullets(diff: IconDiff): string[] {
  const lines: string[] = []
  if (diff.added.length) {
    lines.push(`- Added: ${diff.added.map(name => `\`${name}\``).join(', ')}`)
  }
  if (diff.removed.length) {
    lines.push(`- Removed: ${diff.removed.map(name => `\`${name}\``).join(', ')}`)
  }
  if (diff.changed.length) {
    lines.push(`- Changed: ${diff.changed.map(name => `\`${name}\``).join(', ')}`)
  }
  return lines
}

export function mergeChangelog(existing: string, diff: IconDiff, date = changelogDate()): string | undefined {
  const bullets = formatChangelogBullets(diff)
  if (!bullets.length) {
    return undefined
  }

  const trimmed = existing.trim()
  const heading = '# Changelog'
  const rest = trimmed.replace(/^# Changelog\s*/i, '').trim()
  const today = `## ${date}`
  const block = `${today}\n\n${bullets.join('\n')}`

  if (rest.startsWith(today)) {
    const afterDate = rest.slice(today.length).replace(/^\n+/, '')
    return `${heading}\n\n${today}\n\n${bullets.join('\n')}\n\n${afterDate}\n`
  }

  return `${heading}\n\n${block}\n${rest ? `\n${rest}\n` : ''}`
}

export async function writeChangelog(file: string, diff: IconDiff, date = changelogDate()): Promise<string | undefined> {
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  }
  catch {
    existing = ''
  }
  const next = mergeChangelog(existing, diff, date)
  if (!next) {
    return undefined
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
  return file
}

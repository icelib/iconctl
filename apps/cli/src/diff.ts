import { resolve } from 'node:path'
import process from 'node:process'
import { compareIconSets, writeDiffHtml } from '@iconctl/core'
import { readIcons } from './read-icons'

interface DiffOptions {
  html?: string
  json?: boolean
  check?: boolean
  dryRun?: boolean
}

export async function runDiff(beforeFile: string, afterFile: string, options: DiffOptions) {
  const beforePath = resolve(beforeFile)
  const afterPath = resolve(afterFile)
  const [before, after] = await Promise.all([readIcons(beforePath), readIcons(afterPath)])
  const comparison = compareIconSets(before, after)
  const output = options.html ? resolve(options.html) : undefined
  if (output) {
    await writeDiffHtml(output, comparison, { inputs: [beforePath, afterPath], ...(options.dryRun ? { dryRun: true } : {}) })
  }
  const report = {
    before: { file: beforePath, prefix: comparison.beforePrefix },
    after: { file: afterPath, prefix: comparison.afterPrefix },
    prefixChanged: comparison.prefixChanged,
    hasChanges: comparison.hasChanges,
    ...comparison.diff,
    outputFiles: output && !options.dryRun ? [output] : [],
    ...(options.dryRun ? { dryRun: true } : {}),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    const { added, changed, removed, unchanged } = comparison.diff
    process.stdout.write(`Added ${added.length} · Changed ${changed.length} · Removed ${removed.length} · Unchanged ${unchanged.length}\n`)
    if (comparison.prefixChanged) {
      process.stdout.write(`Prefix changed: ${comparison.beforePrefix} → ${comparison.afterPrefix}\n`)
    }
    if (output) {
      process.stdout.write(`${options.dryRun ? 'Would write' : 'Wrote'} ${output}\n`)
    }
  }
  if (options.check && comparison.hasChanges) {
    process.exitCode = 1
  }
}

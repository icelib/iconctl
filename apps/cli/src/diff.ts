import { resolve } from 'node:path'
import process from 'node:process'
import { compareIconSets, writeDiffHtml, writeDiffMarkdown } from '@iconctl/core'
import { readIcons } from './read-icons.ts'

interface DiffOptions {
  html?: string
  markdown?: string
  json?: boolean
  check?: boolean
  dryRun?: boolean
}

export async function runDiff(beforeFile: string, afterFile: string, options: DiffOptions) {
  const beforePath = resolve(beforeFile)
  const afterPath = resolve(afterFile)
  const [before, after] = await Promise.all([readIcons(beforePath), readIcons(afterPath)])
  const comparison = compareIconSets(before, after)
  const htmlOutput = options.html ? resolve(options.html) : undefined
  const markdownOutput = options.markdown ? resolve(options.markdown) : undefined
  if (htmlOutput && markdownOutput && htmlOutput === markdownOutput) {
    throw new Error('HTML and Markdown report outputs must be different files')
  }
  if (htmlOutput) {
    await writeDiffHtml(htmlOutput, comparison, { inputs: [beforePath, afterPath], ...(options.dryRun ? { dryRun: true } : {}) })
  }
  if (markdownOutput) {
    await writeDiffMarkdown(markdownOutput, comparison, { inputs: [beforePath, afterPath], ...(options.dryRun ? { dryRun: true } : {}) })
  }
  const report = {
    before: { file: beforePath, prefix: comparison.beforePrefix },
    after: { file: afterPath, prefix: comparison.afterPrefix },
    prefixChanged: comparison.prefixChanged,
    hasChanges: comparison.hasChanges,
    ...comparison.diff,
    outputFiles: options.dryRun ? [] : [htmlOutput, markdownOutput].filter((file): file is string => Boolean(file)),
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
    for (const output of [htmlOutput, markdownOutput].filter((file): file is string => Boolean(file))) {
      process.stdout.write(`${options.dryRun ? 'Would write' : 'Wrote'} ${output}\n`)
    }
  }
  if (options.check && comparison.hasChanges) {
    process.exitCode = 1
  }
}

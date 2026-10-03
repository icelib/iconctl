import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { compareIconSets, IconctlError, writeDiffHtml } from '@iconctl/core'

type IconifyJSON = Parameters<typeof compareIconSets>[1]

interface DiffOptions {
  html?: string
  json?: boolean
  check?: boolean
  dryRun?: boolean
}

async function readIcons(file: string): Promise<IconifyJSON> {
  try {
    // compareIconSets performs complete structure and alias validation.
    return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as IconifyJSON
  }
  catch (error) {
    throw new IconctlError(`Cannot read Iconify JSON: ${file}`, { cause: error })
  }
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

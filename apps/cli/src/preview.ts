import type { CommandContext } from './failure'
import { resolve } from 'node:path'
import process from 'node:process'
import { compareIconSets, IconctlError, writePreviewHtml } from '@iconctl/core'
import { readIcons } from './read-icons'

export interface PreviewCommandOptions {
  input?: string
  output?: string
  config?: string
  continue?: boolean
  dryRun?: boolean
  json?: boolean
}

function localPath(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /^[a-z][\w+.-]*:\/\//i.test(value.trim())) {
    throw new IconctlError(`--${option} must be a local file path; URLs and stdin/stdout are not supported.`)
  }
  return resolve(value)
}

/** Return false only when the original configuration-backed preview should run. */
export async function runLocalPreview(options: PreviewCommandOptions, context: CommandContext): Promise<boolean> {
  context.phase = 'arguments'
  if (options.input === undefined) {
    if (options.output !== undefined) {
      throw new IconctlError('Use --output with --input. Set output.preview in the config for a synced preview.')
    }
    return false
  }
  if (options.config !== undefined) {
    throw new IconctlError('Use --input or --config, not both.')
  }
  if (options.continue) {
    throw new IconctlError('--continue is not supported with --input; the complete local collection must be valid.')
  }
  const input = localPath(options.input, 'input')
  const output = localPath(options.output ?? 'preview.html', 'output')
  context.phase = 'execution'
  const json = await readIcons(input)
  const comparison = compareIconSets(undefined, json)
  await writePreviewHtml(output, json, { inputs: [input], ...(options.dryRun ? { dryRun: true } : {}) })
  const report = {
    input: { file: input, prefix: comparison.afterPrefix },
    count: comparison.icons.length,
    outputFiles: options.dryRun ? [] : [output],
    ...(options.dryRun ? { dryRun: true } : {}),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    process.stdout.write(`${options.dryRun ? 'Would write' : 'Wrote'} ${output} · ${report.count} icons for prefix "${comparison.afterPrefix}"\n`)
  }
  return true
}

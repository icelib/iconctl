import type { CommandContext } from './failure.ts'
import process from 'node:process'
import { IconctlError, writeSvgSprite } from '@iconctl/core'
import { localIconPath, readIcons } from './read-icons.ts'

export interface SpriteCommandOptions {
  input?: string
  output?: string
  config?: string
  continue?: boolean
  dryRun?: boolean
  json?: boolean
}

export async function runSprite(options: SpriteCommandOptions, context: CommandContext): Promise<void> {
  context.phase = 'arguments'
  if (options.config !== undefined) {
    throw new IconctlError('--config is not supported by sprite; use --input with a local Iconify JSON file.')
  }
  if (options.continue) {
    throw new IconctlError('--continue is not supported by sprite; the complete local collection must be valid.')
  }
  const input = localIconPath(options.input, 'input')
  const output = localIconPath(options.output ?? 'icons.svg', 'output')
  context.phase = 'execution'
  const json = await readIcons(input)
  const summary = await writeSvgSprite(output, json, { inputs: [input], ...(options.dryRun ? { dryRun: true } : {}) })
  const report = {
    input: { file: input, prefix: summary.prefix },
    count: summary.count,
    outputFiles: options.dryRun ? [] : [output],
    ...(options.dryRun ? { dryRun: true } : {}),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    process.stdout.write(`${options.dryRun ? 'Would write' : 'Wrote'} ${output} · ${summary.count} icons for prefix "${summary.prefix}"\n`)
  }
}

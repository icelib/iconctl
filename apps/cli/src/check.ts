import type { CheckReport, CheckValidation } from '@iconctl/core'
import type { CommandContext } from './failure.ts'
import process from 'node:process'
import { check, IconctlError, loadConfig } from '@iconctl/core'
import { consola } from 'consola'

export interface CheckCommandOptions {
  config?: string
  input?: string
  width?: string | number
  height?: string | number
  name?: string
  json?: boolean
}

export async function runCheck(options: CheckCommandOptions, context: CommandContext) {
  context.phase = 'arguments'
  if (options.input !== undefined && options.config !== undefined) {
    throw new IconctlError('Use --input or --config, not both.')
  }
  const validate: CheckValidation = {}
  for (const key of ['width', 'height'] as const) {
    if (options[key] !== undefined) {
      const value = options[key]
      if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) {
        throw new IconctlError(`--${key} must be a finite positive number.`)
      }
      validate[key] = Number(value)
    }
  }
  if (options.name !== undefined) {
    validate.name = options.name
  }
  let config
  if (options.input === undefined) {
    context.phase = 'configuration'
    config = await loadConfig({ cwd: process.cwd(), ...(options.config ? { configFile: options.config } : {}) })
  }
  context.phase = 'execution'
  const result = options.input !== undefined
    ? await check({ cwd: process.cwd(), input: options.input, validate })
    : await check({ cwd: process.cwd(), config: config!, validate })
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, valid: true, issues: [] } satisfies CheckReport, null, 2)}\n`)
  }
  else {
    consola.success(`Checked ${result.count} icons from ${result.source}`)
  }
}

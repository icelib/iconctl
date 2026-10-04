import type { IconctlValidateConfig, ResolvedIconctlConfig } from './config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { IconSet } from '@iconify/tools'
import { resolveValidation } from './config'
import { IconctlError } from './errors'
import { normalizeIconifyJson } from './iconify-json'
import { decodeUtf8 } from './json-input'
import { processIconSetAsync } from './process'
import { inspectSvgDirectory } from './sources/directory'
import { validateIconSetAsync } from './validate'

export type CheckValidation = Pick<IconctlValidateConfig, 'name' | 'width' | 'height'>

export interface CheckOptions {
  cwd?: string
  config: ResolvedIconctlConfig
  input?: never
  validate?: CheckValidation
}

export interface CheckInputOptions {
  cwd?: string
  input: string
  config?: never
  validate?: CheckValidation
}

export interface CheckResult {
  prefix: string
  count: number
  source: 'svg' | 'json'
}

export interface CheckIssue {
  name?: string
  file?: string
  stage: 'options' | 'read' | 'import' | 'process' | 'validation'
  message: string
}

export interface CheckReport {
  prefix: string | null
  count: number
  source: CheckResult['source'] | null
  valid: boolean
  issues: CheckIssue[]
}

export class IconctlCheckError extends IconctlError {
  readonly issues: CheckIssue[]

  constructor(public readonly report: CheckReport) {
    super(`Icon validation failed:\n${report.issues.map(issue => `- ${issue.name ?? issue.file ?? 'input'} [${issue.stage}]: ${issue.message}`).join('\n')}`)
    this.name = 'IconctlCheckError'
    this.issues = report.issues
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Inspect local artifacts only. Success keeps the original check API fields. */
export async function check(options: CheckOptions | CheckInputOptions): Promise<CheckResult> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config
  const source = config?.output.svg && options.input === undefined ? 'svg' : 'json'
  const report: CheckReport = { prefix: config?.prefix ?? null, count: 0, source, valid: false, issues: [] }
  let validate: ResolvedIconctlConfig['validate']
  try {
    if ((options.input !== undefined) === (config !== undefined)) {
      throw new Error('Provide either a local input file or a resolved configuration.')
    }
    if (options.input !== undefined && (typeof options.input !== 'string' || !options.input.trim() || /^[a-z][\w+.-]*:\/\//i.test(options.input.trim()))) {
      throw new Error('Check input must be a local Iconify JSON file path.')
    }
    const rules = { ...config?.validate, ...options.validate }
    for (const key of ['width', 'height'] as const) {
      if (rules[key] !== undefined && (typeof rules[key] !== 'number' || !Number.isFinite(rules[key]) || rules[key] <= 0)) {
        throw new Error(`Check ${key} must be a finite positive number.`)
      }
    }
    if (rules.name !== undefined && typeof rules.name !== 'string' && !(rules.name instanceof RegExp)) {
      throw new Error('Check name must be a regular expression or its source string.')
    }
    validate = resolveValidation(rules)
  }
  catch (error) {
    report.issues.push({ stage: 'options', message: message(error) })
    throw new IconctlCheckError(report)
  }

  const file = resolve(cwd, options.input ?? (source === 'svg' ? config!.output.svg! : config!.output.json))
  let iconSet: IconSet
  if (source === 'svg') {
    try {
      const loaded = await inspectSvgDirectory(file, config!.prefix)
      iconSet = loaded.iconSet
      report.count = loaded.count
      report.issues.push(...loaded.failures.map(issue => ({ ...issue, stage: 'import' as const })))
    }
    catch (error) {
      report.issues.push({ file, stage: 'read', message: message(error) })
      throw new IconctlCheckError(report)
    }
  }
  else {
    let value: unknown
    try {
      value = JSON.parse(decodeUtf8(await readFile(file)).replace(/^\uFEFF/, ''))
    }
    catch (error) {
      report.issues.push({ file, stage: 'read', message: message(error) })
      throw new IconctlCheckError(report)
    }
    try {
      const normalized = normalizeIconifyJson(value)
      report.prefix = normalized.json.prefix
      report.count = Object.keys(normalized.json.icons).length + normalized.issues.length
      report.issues.push(...normalized.issues.map(issue => ({ ...issue, file, stage: 'import' as const })))
      iconSet = new IconSet(normalized.json)
    }
    catch (error) {
      report.issues.push({ file, stage: 'import', message: message(error) })
      throw new IconctlCheckError(report)
    }
  }

  const processed = await processIconSetAsync(iconSet, { color: config?.color ?? false })
  report.issues.push(...processed.issues.map(issue => ({ name: issue.name, file, stage: 'process' as const, message: issue.message })))
  const validated = await validateIconSetAsync(iconSet, { validate })
  report.issues.push(...validated.issues.map(issue => ({ ...issue, file, stage: 'validation' as const })))
  if (report.issues.length) {
    throw new IconctlCheckError(report)
  }
  return { prefix: report.prefix!, count: report.count, source }
}

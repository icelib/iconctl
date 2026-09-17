import type { ResolvedFigmaIconifyConfig } from './config'
import process from 'node:process'
import { importDirectory } from '@iconify/tools'
import { join } from 'pathe'
import { FigmaIconifyError } from './errors'
import { readPreviousIconJson } from './export'
import { processIconSet } from './process'
import { formatValidationIssues, validateIconSet } from './validate'

export interface CheckOptions {
  cwd?: string
  config: ResolvedFigmaIconifyConfig
}

export async function check(options: CheckOptions) {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config
  const svgDir = config.output.svg ? join(cwd, config.output.svg) : undefined

  const iconSet = svgDir
    ? await importDirectory(svgDir, { prefix: config.prefix })
    : undefined

  if (iconSet) {
    processIconSet(iconSet, config)
    const { issues } = validateIconSet(iconSet, config)
    if (issues.length) {
      throw new FigmaIconifyError(`Icon validation failed:\n${formatValidationIssues(issues)}`)
    }
    return {
      prefix: config.prefix,
      count: Object.keys(iconSet.export().icons).length,
      source: 'svg' as const,
    }
  }

  const json = await readPreviousIconJson(join(cwd, config.output.json))
  if (!json) {
    throw new FigmaIconifyError(`Nothing to check. Missing ${config.output.json} and svg output.`)
  }

  const names = Object.keys(json.icons)
  const issues = names
    .filter(name => !config.validate.name.test(name))
    .map(name => ({ name, message: `Icon name "${name}" does not match ${config.validate.name}` }))
  if (issues.length) {
    throw new FigmaIconifyError(`Icon validation failed:\n${formatValidationIssues(issues)}`)
  }

  return {
    prefix: json.prefix,
    count: names.length,
    source: 'json' as const,
  }
}

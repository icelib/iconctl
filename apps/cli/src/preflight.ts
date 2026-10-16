import type { CommandContext } from './failure.ts'
import process from 'node:process'
import { formatSyncIssues, IconctlError, loadConfig, preflightFigmaNaming } from '@iconctl/core'
import { consola } from 'consola'

export interface PreflightCommandOptions {
  config?: string
  dryRun?: boolean
  json?: boolean
  continue?: boolean
  offline?: boolean
}

export async function runPreflight(options: PreflightCommandOptions, context: CommandContext) {
  context.phase = 'arguments'
  for (const flag of ['continue', 'offline'] as const) {
    if (options[flag] !== undefined) {
      throw new IconctlError(`--${flag} is not supported by preflight. Figma naming checks always fetch the document and report every naming error.`)
    }
  }
  context.phase = 'configuration'
  const config = await loadConfig({ cwd: process.cwd(), ...(options.config ? { configFile: options.config } : {}) })
  context.phase = 'execution'
  const result = await preflightFigmaNaming({ cwd: process.cwd(), config })
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      complete: result.complete,
      naming: result.naming,
      issues: result.issues,
      publicNames: result.publicNames,
      outputFiles: result.files,
    }, null, 2)}\n`)
  }
  else {
    const count = result.naming.reduce((total, plan) => total + plan.mappings.length, 0)
    const status = `Checked ${count} Figma icon nodes in ${result.naming.length} sources.`
    if (result.complete) {
      consola.success(status)
    }
    else {
      consola.warn(`Incomplete naming preflight: ${status}`)
    }
    for (const plan of result.naming) {
      const changes = plan.changes
      consola.info(`source ${plan.sourceIndex} (${plan.fileKey}): ${changes.added.length} added, ${changes.removed.length} removed, ${changes.renamed.length} renamed, ${changes.disambiguated.length} disambiguated`)
      for (const change of changes.renamed) {
        consola.info(`renamed: ${change.from} → ${change.to} (${change.nodeId})`)
      }
      for (const change of changes.disambiguated) {
        consola.info(`disambiguated: ${change.from} → ${change.to} (${change.nodeId})`)
      }
    }
    if (result.publicNames.added.length) {
      consola.info(`public names added: ${result.publicNames.added.join(', ')}`)
    }
    if (result.publicNames.removed.length) {
      consola.info(`public names removed: ${result.publicNames.removed.join(', ')}`)
    }
    if (!result.publicNames.deletionsReliable) {
      consola.warn('Public-name deletions are unknown: only Figma source names were checked.')
    }
    if (result.issues.length) {
      consola.warn(formatSyncIssues(result.issues))
    }
  }
  if (!result.complete) {
    process.exitCode = 1
  }
}

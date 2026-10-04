import type { CheckIssue, CheckReport, SyncIssue } from '@iconctl/core'
import process from 'node:process'
import { IconctlCheckError, IconctlSyncError } from '@iconctl/core'
import { consola } from 'consola'

export interface CommandContext {
  phase: 'arguments' | 'configuration' | 'authentication' | 'execution'
  exitCode?: 1 | 130
}

interface FailureOptions {
  json?: boolean
  input?: unknown
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return typeof error.message === 'string' ? error.message : 'Unknown error'
  }
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? 'Unknown error'
    : String(error)
}

function syncIssues(issues: SyncIssue[]): SyncIssue[] {
  return issues.filter(issue => issue && typeof issue.name === 'string' && typeof issue.message === 'string'
    && ['export-url', 'download', 'import', 'process', 'validation'].includes(issue.stage)).map(issue => ({
    name: issue.name,
    message: issue.message,
    stage: issue.stage,
    ...(typeof issue.sourceType === 'string' ? { sourceType: issue.sourceType } : {}),
    ...(Number.isInteger(issue.sourceIndex) && issue.sourceIndex! >= 0 ? { sourceIndex: issue.sourceIndex } : {}),
    ...(typeof issue.fileKey === 'string' ? { fileKey: issue.fileKey } : {}),
    ...(typeof issue.nodeId === 'string' ? { nodeId: issue.nodeId } : {}),
  }))
}

function checkIssues(issues: CheckIssue[]): CheckIssue[] {
  return issues.filter(issue => issue && typeof issue.message === 'string'
    && ['options', 'read', 'import', 'process', 'validation'].includes(issue.stage)).map(issue => ({
    stage: issue.stage,
    message: issue.message,
    ...(typeof issue.name === 'string' ? { name: issue.name } : {}),
    ...(typeof issue.file === 'string' ? { file: issue.file } : {}),
  }))
}

function checkReport(error: unknown, options: FailureOptions): CheckReport {
  if (!(error instanceof IconctlCheckError)) {
    return { prefix: null, count: 0, source: options.input !== undefined ? 'json' : null, valid: false, issues: [{ stage: 'options', message: errorMessage(error) }] }
  }
  const report = error.report
  return {
    prefix: typeof report.prefix === 'string' ? report.prefix : null,
    count: Number.isInteger(report.count) && report.count >= 0 ? report.count : 0,
    source: report.source === 'svg' || report.source === 'json' ? report.source : null,
    valid: false,
    issues: checkIssues(report.issues),
  }
}

/** The only one-shot failure writer. The caller still rejects with the original value. */
export function reportCliError(error: unknown, command: string | null, options: FailureOptions, context: CommandContext): void {
  process.exitCode = context.exitCode ?? 1
  const message = errorMessage(error)
  // Runtime watch errors belong to its NDJSON lifecycle. Parser failures have
  // not started that lifecycle and keep their single human-readable diagnostic.
  if (!options.json || command === 'watch') {
    consola.error(message)
    return
  }
  const report = command === 'check' ? checkReport(error, options) : undefined
  const issues = report?.issues ?? (error instanceof IconctlSyncError ? syncIssues(error.issues) : undefined)
  const phase = command === 'check' && error instanceof IconctlCheckError
    && issues?.length && issues.every(issue => issue.stage === 'options')
    ? 'arguments'
    : context.phase
  process.stdout.write(`${JSON.stringify({
    ...report,
    success: false,
    command,
    error: {
      name: error instanceof Error && typeof error.name === 'string' ? error.name : 'Error',
      message,
      phase,
      ...(issues ? { issues } : {}),
    },
  }, null, 2)}\n`)
}

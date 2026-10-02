import type { WatchEvent } from '@iconctl/core'
import process from 'node:process'
import { IconctlAbortError, IconctlSyncError, watch } from '@iconctl/core'
import { syncSummary } from './sync-summary'

interface WatchCliOptions {
  config?: string
  dryRun?: boolean
  continue?: boolean
  json?: boolean
}

function serializedError(error: unknown) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof IconctlSyncError ? { issues: error.issues } : {}),
  }
}

export function printWatchEvent(event: WatchEvent, asJson: boolean) {
  if (asJson) {
    const data = event.type === 'result'
      ? { ...event, result: syncSummary(event.result) }
      : event.type === 'error' ? { ...event, error: serializedError(event.error) } : event
    process.stdout.write(`${JSON.stringify(data)}\n`)
    return
  }
  let message: string
  switch (event.type) {
    case 'ready':
      message = `Watching ${event.roots.join(', ')} (${event.configFile})`
      break
    case 'start':
      message = `Sync #${event.runId} started (${event.reason})`
      break
    case 'result':
      message = `${event.result.complete ? 'Synced' : 'Incomplete sync:'} ${event.result.processed} icons for prefix "${event.result.prefix}"`
      break
    case 'error':
      message = `${event.fatal ? 'Fatal' : 'Recoverable'} ${event.phase} error: ${serializedError(event.error).message}`
      break
    case 'stopped':
      message = `Watch stopped (${event.reason})`
      break
  }
  process.stderr.write(`${message}\n`)
}

export async function runWatch(options: WatchCliOptions): Promise<void> {
  const controller = new AbortController()
  let exitCode: number | undefined
  let reported = false
  const interrupt = () => {
    exitCode ??= 130
    controller.abort('SIGINT')
  }
  const terminate = () => {
    exitCode ??= 143
    controller.abort('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    await watch({
      cwd: process.cwd(),
      signal: controller.signal,
      ...(options.config ? { configFile: options.config } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.continue ? { continueOnError: true } : {}),
      onEvent(event) {
        if (event.type === 'error' && event.fatal) {
          reported = true
        }
        printWatchEvent(event, Boolean(options.json))
      },
    })
  }
  catch (error) {
    if (!(controller.signal.aborted && error instanceof IconctlAbortError)) {
      exitCode = 1
      if (!reported) {
        printWatchEvent({ type: 'error', phase: 'watch', fatal: true, error }, Boolean(options.json))
      }
    }
  }
  finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    if (exitCode !== undefined) {
      process.exitCode = exitCode
    }
  }
}

export type SyncProgressStage = 'prepare' | 'source' | 'document' | 'export-url' | 'download' | 'import' | 'process' | 'validate' | 'export' | 'complete'

/** Counts describe finished attempts, including failures. Figma loading counts are per source; processing/validation counts span the merged set. */
export interface SyncProgressEvent {
  readonly stage: SyncProgressStage
  readonly timestamp: string
  readonly completed?: number
  readonly total?: number
  readonly sourceType?: string
  readonly sourceIndex?: number
  readonly name?: string
  readonly nodeId?: string
  readonly fileKey?: string
  /** Only present on the final event; false for continueOnError partial results. */
  readonly complete?: boolean
  readonly notModified?: boolean
  readonly dryRun?: boolean
}

export type SyncProgressHandler = (event: SyncProgressEvent) => void | Promise<void>
export type ProgressUpdate = Omit<SyncProgressEvent, 'timestamp'>
export type ProgressReporter = (event: ProgressUpdate) => void

/** Observers cannot block a transaction or turn a committed result into a failure. */
export function createProgressReporter(handler?: SyncProgressHandler): ProgressReporter {
  return (event) => {
    if (!handler) {
      return
    }
    try {
      const pending = handler(Object.freeze({ ...event, timestamp: new Date().toISOString() }))
      if (pending) {
        void Promise.resolve(pending).catch(() => {})
      }
    }
    catch {
      // Telemetry is best effort. The host owns reporting its observer failures.
    }
  }
}

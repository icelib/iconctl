export class IconctlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IconctlError'
  }
}

/** A failed icon, with source coordinates when available. */
export interface SyncIssue {
  name: string
  message: string
  stage: 'export-url' | 'download' | 'import' | 'process' | 'validation'
  sourceType?: string
  sourceIndex?: number
  fileKey?: string
  nodeId?: string
}

export class IconctlSyncError extends IconctlError {
  constructor(public readonly issues: SyncIssue[], message = 'Icon sync failed') {
    super(`${message}:\n${issues.map(issue => `- ${issue.name}${issue.nodeId ? ` (${issue.nodeId})` : ''} [${issue.stage}]: ${issue.message}`).join('\n')}`)
    this.name = 'IconctlSyncError'
  }
}

export class IconctlAbortError extends IconctlError {
  readonly code = 'ABORT_ERR'

  constructor(reason?: unknown) {
    super('Icon sync was aborted.', { cause: reason })
    this.name = 'AbortError'
  }
}

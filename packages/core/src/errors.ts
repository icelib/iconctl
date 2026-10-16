import { stripVTControlCharacters } from 'node:util'

export interface IconctlErrorOptions extends ErrorOptions {
  code?: string
  httpStatus?: number
  retryable?: boolean
  retryAfterMs?: number
  sourceType?: string
  sourceIndex?: number
  operation?: string
}

const metadataKeys = ['code', 'httpStatus', 'retryable', 'retryAfterMs', 'sourceType', 'sourceIndex', 'operation'] as const

export class IconctlError extends Error {
  code?: string
  httpStatus?: number
  retryable?: boolean
  retryAfterMs?: number
  sourceType?: string
  sourceIndex?: number
  operation?: string

  constructor(message: string, options?: IconctlErrorOptions) {
    super(message, options)
    this.name = 'IconctlError'
    for (const key of metadataKeys) {
      if (options?.[key] !== undefined) {
        Object.assign(this, { [key]: options[key] })
      }
    }
  }
}

/** An icon diagnostic, with source coordinates when available. */
export interface SyncIssue extends Omit<IconctlErrorOptions, 'cause'> {
  name: string
  message: string
  stage: 'export-url' | 'download' | 'import' | 'process' | 'validation'
  fileKey?: string
  nodeId?: string
  severity?: 'error' | 'warning'
  originalName?: string
  normalizedName?: string
  parentPath?: string[]
  proposedName?: string
  figmaUrl?: string
  collisionGroup?: string
}

/** Format collision groups together while preserving the legacy output for other issues. */
export function formatSyncIssues(issues: readonly SyncIssue[]): string {
  const groups = new Map<string, SyncIssue[]>()
  const entries: (SyncIssue | SyncIssue[])[] = []
  for (const issue of issues) {
    if (!issue.collisionGroup) {
      entries.push(issue)
      continue
    }
    const key = JSON.stringify([issue.collisionGroup, issue.sourceIndex, issue.fileKey])
    const group = groups.get(key)
    if (group) {
      group.push(issue)
    }
    else {
      const group = [issue]
      groups.set(key, group)
      entries.push(group)
    }
  }
  return entries.map((entry) => {
    if (!Array.isArray(entry)) {
      return `- ${entry.name}${entry.nodeId ? ` (${entry.nodeId})` : ''} [${entry.stage}]: ${entry.message}`
    }
    const first = entry[0]!
    const source = [
      first.sourceIndex === undefined ? undefined : `source ${first.sourceIndex}`,
      first.fileKey === undefined ? undefined : `file ${first.fileKey}`,
    ].filter(value => value !== undefined).join(', ')
    const heading = `- ${first.normalizedName ?? first.name} [${first.stage}]${source ? ` (${source})` : ''}: ${first.message}`
    const nodes = entry.map((issue) => {
      const details = [`name: ${JSON.stringify(issue.originalName ?? issue.name)}`]
      if (issue.nodeId !== undefined) {
        details.push(`node: ${issue.nodeId}`)
      }
      if (issue.parentPath !== undefined) {
        details.push(`path: ${issue.parentPath.map(segment => JSON.stringify(segment)).join(' > ')}`)
      }
      if (issue.normalizedName !== undefined) {
        details.push(`normalized: ${JSON.stringify(issue.normalizedName)}`)
      }
      if (issue.proposedName !== undefined) {
        details.push(`proposed: ${JSON.stringify(issue.proposedName)}`)
      }
      if (issue.name !== (issue.originalName ?? issue.name) && issue.name !== issue.proposedName) {
        details.push(`icon: ${JSON.stringify(issue.name)}`)
      }
      if (issue.figmaUrl !== undefined) {
        details.push(`URL: ${issue.figmaUrl}`)
      }
      if (issue.message !== first.message) {
        details.push(issue.message)
      }
      return `  - ${details.join('; ')}`
    })
    return [heading, ...nodes].join('\n')
  }).join('\n')
}

export class IconctlSyncError extends IconctlError {
  constructor(public readonly issues: SyncIssue[], message = 'Icon sync failed', options?: IconctlErrorOptions) {
    super(`${message}:\n${formatSyncIssues(issues)}`, options)
    this.name = 'IconctlSyncError'
  }
}

export class IconctlAbortError extends IconctlError {
  override readonly code = 'ABORT_ERR'

  constructor(reason?: unknown) {
    super('Icon sync was aborted.', { cause: reason })
    this.name = 'AbortError'
  }
}

export interface SerializedIconctlError {
  name: string
  message: string
  code?: string | number
  httpStatus?: number
  retryable?: boolean
  retryAfterMs?: number
  sourceType?: string
  sourceIndex?: number
  operation?: string
  cause?: SerializedIconctlError
  issues?: SyncIssue[]
  errors?: SerializedIconctlError[]
  truncated?: boolean
}

export interface SerializeIconctlErrorOptions {
  /** Additional credentials to remove, including their URL-encoded representations. */
  secrets?: readonly string[]
}

/** Read data properties without executing arbitrary getters on a thrown value. */
function dataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined
  }
  try {
    let current: object | null = value
    for (let depth = 0; current && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) {
        return 'value' in descriptor ? descriptor.value : undefined
      }
      current = Object.getPrototypeOf(current)
    }
  }
  catch {
    // A revoked proxy or hostile getter must not prevent reporting the failure.
  }
  return undefined
}

function arrayItems(value: unknown, maximumLength: number): { items: unknown[], length: number } | undefined {
  try {
    if (!Array.isArray(value)) {
      return undefined
    }
    const length = dataProperty(value, 'length')
    if (typeof length === 'number' && Number.isInteger(length) && length >= 0) {
      return { items: Array.from({ length: Math.min(length, maximumLength) }, (_, index) => dataProperty(value, String(index))), length }
    }
  }
  catch {
    // Array.isArray can throw for a revoked proxy.
  }
  return undefined
}

function redactMessage(value: string, secrets: readonly string[]): string {
  let message = stripVTControlCharacters(value)
  for (const secret of secrets) {
    message = message.split(secret).join('[redacted]')
  }
  return message
    .replace(/\bfig[dou]_[\w-]+/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [redacted]')
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&#][^=&#\s]*(?:token|secret|password|api[_-]?key|credential|signature)[^=&#\s]*=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/([?&#](?:code|sig)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|client[_-]?secret|api[_-]?key|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/^Require stack:\r?\n(?:-\s.*(?:\r?\n|$))*/gm, '')
    .replace(/(["'`])(?:file:\/\/\/|[a-z]:[\\/]|\\\\|\/)[^"'`\r\n]*\1/gi, '$1[path]$1')
    .replace(/(^|[\s(<[=,:])(?:file:\/\/\/|[a-z]:[\\/]|\\\\)[^\s"'`<>|),;]*/gi, '$1[path]')
    .replace(/(^|[\s(<[=,:])\/(?!\/)[^\s"'`<>|),;]*/g, '$1[path]')
    .split('\n')
    .filter(line => !/^\s*at\s/.test(line))
    .join('\n')
}

/** Public diagnostics only: never copy stack, request/response objects or arbitrary fields. */
export function serializeIconctlError(error: unknown, options: SerializeIconctlErrorOptions = {}): SerializedIconctlError {
  const secrets = [...new Set((options.secrets ?? []).filter(secret => typeof secret === 'string' && secret.trim().length > 0).flatMap((secret) => {
    const variants = [secret, secret.trim()]
    try {
      variants.push(...variants.map(value => encodeURIComponent(value)))
    }
    catch {
      // Invalid Unicode still needs its literal representation redacted.
    }
    return variants
  }))]
    .sort((left, right) => right.length - left.length)
  const seen = new Set<unknown>()
  let remainingCharacters = 16000
  let remainingErrors = 32
  const serialize = (value: unknown, depth: number): SerializedIconctlError => {
    if (seen.has(value)) {
      return { name: 'Error', message: '[Circular error cause]', truncated: true }
    }
    if (depth >= 5 || remainingErrors <= 0 || remainingCharacters <= 0) {
      return { name: 'Error', message: '[Error details truncated]', truncated: true }
    }
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      seen.add(value)
    }
    remainingErrors--
    let truncated = false
    const text = (input: string, maximumLength = 4000) => {
      const safe = redactMessage(input, secrets)
      const available = Math.max(0, Math.min(maximumLength, remainingCharacters))
      if (safe.length > available) {
        truncated = true
        const suffix = '[truncated]'
        const result = available > suffix.length ? `${safe.slice(0, available - suffix.length)}${suffix}` : suffix.slice(0, available)
        remainingCharacters -= result.length
        return result
      }
      remainingCharacters -= safe.length
      return safe
    }
    const originalName = dataProperty(value, 'name')
    const originalMessage = dataProperty(value, 'message')
    const result: SerializedIconctlError = {
      name: text(typeof originalName === 'string' ? originalName : 'Error', 128),
      message: text(typeof originalMessage === 'string' ? originalMessage : typeof value === 'string' ? value : 'Unknown error'),
    }
    for (const key of ['code', 'sourceType', 'operation'] as const) {
      const field = dataProperty(value, key)
      if (typeof field === 'string') {
        result[key] = text(field, 256)
      }
      else if (key === 'code' && typeof field === 'number' && Number.isFinite(field)) {
        result.code = field
      }
    }
    for (const key of ['httpStatus', 'sourceIndex', 'retryAfterMs'] as const) {
      const field = dataProperty(value, key)
      if (typeof field === 'number' && Number.isFinite(field) && field >= 0) {
        result[key] = field
      }
    }
    const retryable = dataProperty(value, 'retryable')
    if (typeof retryable === 'boolean') {
      result.retryable = retryable
    }
    const issues = arrayItems(dataProperty(value, 'issues'), 50)
    if (issues) {
      const stages = new Set(['export-url', 'download', 'import', 'process', 'validation'])
      result.issues = []
      for (const issue of issues.items) {
        const name = dataProperty(issue, 'name')
        const message = dataProperty(issue, 'message')
        const stage = dataProperty(issue, 'stage')
        if (typeof name !== 'string' || typeof message !== 'string' || typeof stage !== 'string' || !stages.has(stage)) {
          continue
        }
        const safe: SyncIssue = { name: text(name, 256), message: text(message), stage: stage as SyncIssue['stage'] }
        for (const key of ['sourceType', 'fileKey', 'nodeId', 'code', 'operation', 'originalName', 'normalizedName', 'proposedName', 'collisionGroup'] as const) {
          const field = dataProperty(issue, key)
          if (typeof field === 'string') {
            safe[key] = text(field, 256)
          }
        }
        const figmaUrl = dataProperty(issue, 'figmaUrl')
        if (typeof figmaUrl === 'string') {
          safe.figmaUrl = text(figmaUrl, 2000)
        }
        const severity = dataProperty(issue, 'severity')
        if (severity === 'error' || severity === 'warning') {
          safe.severity = severity
        }
        const parentPath = arrayItems(dataProperty(issue, 'parentPath'), 20)
        if (parentPath) {
          safe.parentPath = parentPath.items.filter((segment): segment is string => typeof segment === 'string').map(segment => text(segment, 256))
          truncated ||= parentPath.length > 20
        }
        const sourceIndex = dataProperty(issue, 'sourceIndex')
        if (typeof sourceIndex === 'number' && Number.isInteger(sourceIndex) && sourceIndex >= 0) {
          safe.sourceIndex = sourceIndex
        }
        for (const key of ['httpStatus', 'retryAfterMs'] as const) {
          const field = dataProperty(issue, key)
          if (typeof field === 'number' && Number.isFinite(field) && field >= 0) {
            safe[key] = field
          }
        }
        const retryable = dataProperty(issue, 'retryable')
        if (typeof retryable === 'boolean') {
          safe.retryable = retryable
        }
        result.issues.push(safe)
      }
      truncated ||= issues.length > 50
    }
    const cause = dataProperty(value, 'cause')
    if (cause !== undefined) {
      result.cause = serialize(cause, depth + 1)
    }
    const errors = arrayItems(dataProperty(value, 'errors'), 10)
    if (errors) {
      result.errors = errors.items.map(item => serialize(item, depth + 1))
      truncated ||= errors.length > 10
    }
    if (truncated) {
      result.truncated = true
    }
    return result
  }
  return serialize(error, 0)
}

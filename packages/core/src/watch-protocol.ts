import type { LoadConfigOptions } from './load-config'
import type { SyncResult } from './sync'
import type { WatchInputDescriptor } from './watch-paths'
import { IconctlAbortError, IconctlError, IconctlSyncError } from './errors'

export interface LoadedWatchConfig {
  input: WatchInputDescriptor
  files: string[]
  entryFile: string
}

export type WatchRequest
  = | { id: number, type: 'load', options: LoadConfigOptions }
    | { id: number, type: 'sync', dryRun?: boolean, continueOnError?: boolean }
    | { id: number, type: 'abort', reason: WatchFailure }

export type WatchResponse
  = | { id: number, type: 'config-file', file: string }
    | { id: number, type: 'loaded', value: LoadedWatchConfig }
    | { id: number, type: 'result', value: SyncResult }
    | { id: number, type: 'error', error: WatchFailure }

export type WatchFailure
  = | { kind: 'value', value: unknown }
    | {
      kind: 'error'
      type: 'abort' | 'sync' | 'iconctl' | 'native'
      name: string
      message: string
      stack?: string
      code?: string | number
      issues?: IconctlSyncError['issues']
      errors?: WatchFailure[]
      cause?: WatchFailure
    }

/** Error structured cloning loses custom classes, codes and sync issues. */
export function packWatchFailure(value: unknown, seen = new Set<Error>()): WatchFailure {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return { kind: 'value', value: '[Circular error cause]' }
    }
    seen.add(value)
    const code = 'code' in value ? value.code : undefined
    return {
      kind: 'error',
      type: value instanceof IconctlAbortError ? 'abort' : value instanceof IconctlSyncError ? 'sync' : value instanceof IconctlError ? 'iconctl' : 'native',
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(value instanceof IconctlSyncError ? { issues: value.issues } : {}),
      ...(value instanceof AggregateError ? { errors: value.errors.map(error => packWatchFailure(error, seen)) } : {}),
      ...('cause' in value ? { cause: packWatchFailure(value.cause, seen) } : {}),
    }
  }
  try {
    return { kind: 'value', value: structuredClone(value) }
  }
  catch {
    // An arbitrary thrown value or abort reason can contain functions or symbols.
    try {
      return { kind: 'value', value: String(value) }
    }
    catch {
      return { kind: 'value', value: 'Non-serializable thrown value' }
    }
  }
}

export function unpackWatchFailure(value: WatchFailure): unknown {
  if (value.kind === 'value') {
    return value.value
  }
  const cause = value.cause ? unpackWatchFailure(value.cause) : undefined
  const nativeErrors = new Map<string, typeof Error>(Object.entries({ Error, TypeError, SyntaxError, RangeError, ReferenceError, URIError, EvalError }))
  const error = value.type === 'abort'
    ? new IconctlAbortError(cause)
    : value.type === 'sync'
      ? new IconctlSyncError(value.issues ?? [])
      : value.type === 'iconctl'
        ? new IconctlError(value.message)
        : value.name === 'AggregateError'
          ? new AggregateError((value.errors ?? []).map(unpackWatchFailure), value.message)
          : new (nativeErrors.get(value.name) ?? Error)(value.message)
  // SyncError's message already includes formatted issues; do not format twice.
  error.name = value.name
  error.message = value.message
  if (value.stack) {
    error.stack = value.stack
  }
  if (value.cause) {
    error.cause = cause
  }
  if (value.code !== undefined) {
    Object.assign(error, { code: value.code })
  }
  return error
}

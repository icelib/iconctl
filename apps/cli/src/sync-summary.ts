import type { SyncResult } from '@iconctl/core'

export function syncSummary(result: SyncResult) {
  return {
    prefix: result.prefix,
    complete: result.complete,
    deletionsReliable: result.diff.deletionsReliable,
    fileKey: result.fileKey,
    fileVersion: result.fileVersion,
    notModified: result.notModified,
    sources: result.sources,
    added: result.diff.added,
    removed: result.diff.removed,
    changed: result.diff.changed,
    skipped: result.failed,
    issues: result.issues,
    outputFiles: result.files,
  }
}

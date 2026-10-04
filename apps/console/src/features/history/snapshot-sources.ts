/** Keep source metadata displayable even when reading an older or malformed artifact. */
export interface SnapshotSourceProjection {
  index: number
  type: string
  fileKey: string
  status: 'read' | 'not-modified' | 'unknown'
}

const SOURCE_TEXT_LIMIT = 200

function text(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return fallback
  }
  return trimmed.length > SOURCE_TEXT_LIMIT
    ? `${trimmed.slice(0, SOURCE_TEXT_LIMIT - 1)}…`
    : trimmed
}

/**
 * Project persisted source metadata into a small, safe view model.
 *
 * `sources` was added after the first snapshot artifacts. Treating it as
 * optional here keeps those immutable artifacts reviewable without guessing
 * their source list.
 */
export function projectSnapshotSources(
  sources: readonly unknown[] | null | undefined,
): SnapshotSourceProjection[] | undefined {
  if (sources === undefined || sources === null) {
    return undefined
  }
  return sources.map((source, index) => {
    const value = source !== null && typeof source === 'object'
      ? source as Record<string, unknown>
      : Object.create(null) as Record<string, unknown>
    const status = value.notModified === true
      ? 'not-modified'
      : value.notModified === false
        ? 'read'
        : 'unknown'
    return {
      index,
      type: text(value.type, '未记录类型'),
      fileKey: text(value.fileKey, '未记录'),
      status,
    }
  })
}

export function snapshotSourceStatusLabel(status: SnapshotSourceProjection['status']): string {
  if (status === 'not-modified') {
    return '未修改'
  }
  if (status === 'read') {
    return '已读取'
  }
  return '状态未知'
}

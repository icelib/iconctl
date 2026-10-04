import type { IconJSON, Snapshot, SnapshotIssue, SnapshotPreview } from '@iconctl/console-contracts'

export const REPORT_LIMITS = {
  changes: 5000,
  diagnostics: 5000,
  bodyBytes: 512 * 1024,
  selectedBytes: 4 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
} as const

export type ReportFormat = 'json' | 'html'
export type ReportStatus = 'added' | 'changed' | 'removed'
type ReportSnapshot = Omit<Snapshot, 'baselineId' | 'attempt'> & { attempt: number }
export interface ReportIcon {
  body: string
  width: number
  height: number
}
export interface ReportEntry {
  name: string
  status: ReportStatus
  before: ReportIcon | null
  after: ReportIcon | null
}
export interface ComparisonReport {
  format: 'iconctl-console-comparison'
  schemaVersion: 1
  scope: 'changes'
  snapshot: ReportSnapshot
  comparison: {
    mode: SnapshotPreview['comparison']['mode']
    snapshot: ReportSnapshot | null
    release: { id: string, version: string, snapshotId: string } | null
  }
  prefixes: { before: string | null, after: string, changed: boolean }
  diff: Record<ReportStatus, string[]>
  icons: ReportEntry[]
  diagnostics: { issues: SnapshotIssue[], failed: string[] }
}

const encoder = new TextEncoder()
function invalid(): never {
  throw new Error('比较数据不完整或不一致，请重新选择快照后重试')
}
function limit(label: string): never {
  throw new Error(`比较报告超过${label}限制，未生成文件`)
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalid()
  }
  return value
}

/** Copy only the bounded review fields before yielding; later UI changes cannot mix reports. */
export function captureComparisonReport(preview: SnapshotPreview): ComparisonReport {
  let selectedBytes = 0
  function text(value: unknown, maximum = 1000, bytes?: number): string {
    if (typeof value !== 'string' || value.length > maximum) {
      if (typeof value === 'string') {
        limit(bytes === REPORT_LIMITS.bodyBytes ? '单个图标 512 KiB' : '字段长度')
      }
      invalid()
    }
    const length = encoder.encode(value).byteLength
    if (bytes !== undefined && length > bytes) {
      limit('单个图标 512 KiB')
    }
    selectedBytes += length
    if (selectedBytes > REPORT_LIMITS.selectedBytes) {
      limit('所选文本 4 MiB')
    }
    return value
  }
  function id(value: unknown): string {
    const result = text(value, 36)
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(result)) {
      invalid()
    }
    return result
  }
  function snapshot(value: Snapshot): ReportSnapshot {
    if (!record(value)) {
      invalid()
    }
    const digest = text(value.digest, 64)
    const createdAt = integer(value.createdAt)
    if (!/^[a-f\d]{64}$/i.test(digest) || createdAt > 8_640_000_000_000_000) {
      invalid()
    }
    return {
      id: id(value.id),
      projectId: id(value.projectId),
      jobId: id(value.jobId),
      attempt: value.attempt === undefined ? 1 : integer(value.attempt, 1),
      createdAt,
      digest,
      iconCount: integer(value.iconCount),
      issues: integer(value.issues),
    }
  }
  function collection(value: unknown): IconJSON {
    if (!record(value) || !record(value.icons) || typeof value.prefix !== 'string') {
      invalid()
    }
    return value as unknown as IconJSON
  }
  function side(json: IconJSON | undefined, name: string): ReportIcon | null {
    if (!json || !Object.hasOwn(json.icons, name)) {
      return null
    }
    const icon = json.icons[name]
    if (!record(icon)) {
      invalid()
    }
    const width = icon.width ?? json.width ?? 16
    const height = icon.height ?? json.height ?? 16
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0
      || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      invalid()
    }
    return { body: text(icon.body, REPORT_LIMITS.bodyBytes, REPORT_LIMITS.bodyBytes), width, height }
  }

  if (!record(preview) || !record(preview.content) || !record(preview.comparison) || !record(preview.diff)) {
    invalid()
  }
  const current = snapshot(preview.snapshot)
  const after = collection(preview.content.json)
  const before = preview.previous === undefined ? undefined : collection(preview.previous)
  const mode = preview.comparison.mode
  if (!['previous', 'release', 'snapshot'].includes(mode)) {
    invalid()
  }
  const baseline = preview.comparison.snapshot === null ? null : snapshot(preview.comparison.snapshot)
  if (Boolean(baseline) !== Boolean(before) || (baseline && baseline.projectId !== current.projectId) || (mode === 'snapshot' && !baseline)) {
    invalid()
  }
  const released = preview.comparison.release
  if (released !== null && !record(released)) {
    invalid()
  }
  const release = released === null ? null : { id: id(released.id), version: text(released.version, 200), snapshotId: id(released.snapshotId) }
  if ((mode !== 'release' && release !== null)
    || (mode === 'release' && Boolean(release) !== Boolean(baseline))
    || (release && release.snapshotId !== baseline?.id)) {
    invalid()
  }

  const statuses = ['added', 'changed', 'removed'] as const
  let count = 0
  for (const status of statuses) {
    if (!Array.isArray(preview.diff[status])) {
      invalid()
    }
    count += preview.diff[status].length
  }
  if (count > REPORT_LIMITS.changes) {
    limit('5,000 条变化')
  }
  if (!Array.isArray(preview.content.issues) || !Array.isArray(preview.content.failed)) {
    invalid()
  }
  if (preview.content.issues.length + preview.content.failed.length > REPORT_LIMITS.diagnostics) {
    limit('5,000 项诊断')
  }
  const diff: ComparisonReport['diff'] = { added: [], changed: [], removed: [] }
  const icons: ReportEntry[] = []
  const seen = new Set<string>()
  for (const status of statuses) {
    for (const original of preview.diff[status]) {
      const name = text(original, 200)
      if (!name || seen.has(name)) {
        invalid()
      }
      seen.add(name)
      const left = side(before, name)
      const right = side(after, name)
      if ((status === 'added' && (left || !right)) || (status === 'removed' && (!left || right)) || (status === 'changed' && (!left || !right))) {
        invalid()
      }
      diff[status].push(name)
      icons.push({ name, status, before: left, after: right })
    }
  }
  const issues = preview.content.issues.map((issue) => {
    if (!record(issue)) {
      invalid()
    }
    const result: SnapshotIssue = { name: text(issue.name, 200), message: text(issue.message) }
    for (const key of ['stage', 'sourceType', 'fileKey', 'nodeId'] as const) {
      if (issue[key] !== undefined) {
        result[key] = text(issue[key], key === 'stage' || key === 'sourceType' ? 40 : 200)
      }
    }
    if (issue.sourceIndex !== undefined) {
      result.sourceIndex = integer(issue.sourceIndex)
    }
    return result
  })
  const beforePrefix = before ? text(before.prefix) : null
  const afterPrefix = text(after.prefix)
  return {
    format: 'iconctl-console-comparison',
    schemaVersion: 1,
    scope: 'changes',
    snapshot: current,
    comparison: { mode, snapshot: baseline, release },
    prefixes: { before: beforePrefix, after: afterPrefix, changed: beforePrefix !== null && beforePrefix !== afterPrefix },
    diff,
    icons,
    diagnostics: { issues, failed: preview.content.failed.map(name => text(name, 200)) },
  }
}

export function reportFilename(report: ComparisonReport, format: ReportFormat): string {
  const baseline = report.comparison.release?.id ?? report.comparison.snapshot?.id ?? 'empty'
  return `iconctl-comparison-${report.snapshot.id}-${report.snapshot.digest.slice(0, 12)}-${report.comparison.mode}-${baseline}.${format}`
}

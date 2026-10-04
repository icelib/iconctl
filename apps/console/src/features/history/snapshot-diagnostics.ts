import type { Snapshot, SnapshotIssue, SnapshotPreview } from '@iconctl/console-contracts'

export type DiagnosticIdentity = Pick<Snapshot, 'projectId' | 'id' | 'digest' | 'jobId' | 'attempt'>
export interface DiagnosticTarget {
  identity: string
  kind: 'issue' | 'failed'
  index: number
}
export interface DiagnosticOption { key: string, label: string, count: number }
export interface DiagnosticFilters { stage: string, source: string }
export const allDiagnostics = ''
export const diagnosticTextLimit = 16 * 1024

const stages: Record<string, string> = Object.assign(Object.create(null), {
  'export-url': '获取导出地址',
  'download': '下载',
  'import': '导入',
  'process': '加工',
  'validation': '校验',
})
function recorded(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function sourceIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function diagnosticStage(issue: SnapshotIssue) {
  const value = recorded(issue.stage) ? (issue.stage === 'validate' ? 'validation' : issue.stage) : null
  return { key: JSON.stringify([value]), label: value === null ? '未记录阶段' : (stages[value] ?? value) }
}
export function diagnosticSource(issue: SnapshotIssue) {
  const type = recorded(issue.sourceType) ? issue.sourceType : null
  const index = sourceIndex(issue.sourceIndex) ? issue.sourceIndex : null
  return {
    key: JSON.stringify([type, index]),
    label: type === null && index === null
      ? '未记录来源'
      : index === null ? `${type} · 序号未记录` : `${type ?? '类型未记录'} #${index + 1}`,
  }
}
export function diagnosticProjection(issues: SnapshotIssue[], filters: DiagnosticFilters) {
  const stageOptions = new Map<string, DiagnosticOption>()
  const sourceOptions = new Map<string, DiagnosticOption>()
  const rows = issues.map((issue, index) => {
    const stage = diagnosticStage(issue)
    const source = diagnosticSource(issue)
    for (const [options, item] of [[stageOptions, stage], [sourceOptions, source]] as const) {
      const previous = options.get(item.key)
      options.set(item.key, { ...item, count: (previous?.count ?? 0) + 1 })
    }
    return { issue, index, stage, source }
  })
  return {
    stages: [...stageOptions.values()],
    sources: [...sourceOptions.values()],
    rows: rows.filter(row => (!filters.stage || row.stage.key === filters.stage) && (!filters.source || row.source.key === filters.source)),
  }
}

export function diagnosticIdentityKey(snapshot: DiagnosticIdentity): string {
  return JSON.stringify([snapshot.projectId, snapshot.id, snapshot.digest, snapshot.jobId, snapshot.attempt === undefined ? 1 : snapshot.attempt])
}
export function diagnosticIdentityError(snapshot: DiagnosticIdentity): string {
  if (![snapshot.projectId, snapshot.id, snapshot.digest, snapshot.jobId].every(recorded)) {
    return '快照定位身份不完整，无法复制定位信息'
  }
  if (snapshot.attempt !== undefined && (!Number.isSafeInteger(snapshot.attempt) || snapshot.attempt < 1)) {
    return '快照尝试编号无效，无法复制定位信息'
  }
  return ''
}

export function diagnosticFigmaUrl(issue: SnapshotIssue): string | undefined {
  if (issue.sourceType !== 'figma' || !recorded(issue.fileKey) || !recorded(issue.nodeId)) {
    return undefined
  }
  if ([issue.fileKey, issue.nodeId].some(value => value === '.' || value === '..')) {
    return undefined
  }
  try {
    return `https://www.figma.com/file/${encodeURIComponent(issue.fileKey)}?node-id=${encodeURIComponent(issue.nodeId)}`
  }
  catch { return undefined }
}

export function diagnosticTargetKey(target: DiagnosticTarget): string {
  return JSON.stringify([target.identity, target.kind, target.index])
}

export function diagnosticLocation(preview: Pick<SnapshotPreview, 'snapshot' | 'content'>, target: DiagnosticTarget): string {
  const snapshot = preview.snapshot
  const invalid = diagnosticIdentityError(snapshot)
  if (invalid) {
    throw new Error(invalid)
  }
  if (target.identity !== diagnosticIdentityKey(snapshot) || !sourceIndex(target.index)) {
    throw new Error('诊断记录已变化，请重新选择')
  }
  const fields: [string, string | number][] = [
    ['projectId', snapshot.projectId],
    ['snapshotId', snapshot.id],
    ['snapshotDigest', snapshot.digest],
    ['jobId', snapshot.jobId],
    ['attempt', snapshot.attempt ?? 1],
    ['kind', target.kind],
    ['recordIndex', target.index],
  ]
  if (target.kind === 'issue') {
    const issue = preview.content.issues[target.index]
    if (!issue || typeof issue.name !== 'string' || typeof issue.message !== 'string') {
      throw new Error('诊断记录不可用')
    }
    fields.push(['name', issue.name], ['message', issue.message])
    for (const key of ['stage', 'sourceType', 'sourceIndex', 'fileKey', 'nodeId'] as const) {
      const value = issue[key]
      if (key === 'sourceIndex' && sourceIndex(value)) {
        fields.push([key, value])
      }
      else if (key !== 'sourceIndex' && typeof value === 'string') {
        fields.push([key, value])
      }
    }
    const figmaUrl = diagnosticFigmaUrl(issue)
    if (figmaUrl) {
      fields.push(['figmaUrl', figmaUrl])
    }
  }
  else if (target.kind === 'failed' && typeof preview.content.failed[target.index] === 'string') {
    fields.push(['name', preview.content.failed[target.index]!])
  }
  else { throw new Error('诊断记录不可用') }
  const text = ['iconctl diagnostic location v1', ...fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)].join('\n')
  if (new TextEncoder().encode(text).byteLength > diagnosticTextLimit) {
    throw new Error('定位信息超过 16 KiB，无法复制；记录未截断')
  }
  return text
}

import type { Snapshot, SnapshotIssue, SnapshotPreview } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { diagnosticFigmaUrl, diagnosticIdentityError, diagnosticIdentityKey, diagnosticLocation, diagnosticProjection, diagnosticSource, diagnosticStage, diagnosticTextLimit } from '../src/features/history/snapshot-diagnostics'

const snapshot: Snapshot = { id: 'old-snapshot', projectId: 'project', jobId: 'generating-job', digest: 'a'.repeat(64), createdAt: 1, iconCount: 0, issues: 7, attempt: 1 }
function fixture(issues: SnapshotIssue[] = []): SnapshotPreview {
  return {
    snapshot: { ...snapshot },
    content: { json: { prefix: 'test', icons: {} }, files: { secret: 'FILE_MARKER' }, sources: [], issues, failed: ['same', 'same'] },
    diff: { added: [], changed: [], removed: [] },
    comparison: { mode: 'previous', snapshot: null, release: null },
  }
}
const issue = (values: Partial<SnapshotIssue> = {}): SnapshotIssue => ({ name: 'same', message: 'problem', ...values })
const target = (value: SnapshotPreview, index: number, kind: 'issue' | 'failed' = 'issue') => ({ identity: diagnosticIdentityKey(value.snapshot), kind, index })
function decode(value: string) {
  return Object.fromEntries(value.split('\n').slice(1).map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 2))]
  }))
}

it('intersects stages and exact recorded sources while retaining complete independent counts and original indices', () => {
  const values = [
    issue({ stage: 'validation', sourceType: 'figma', sourceIndex: 0 }),
    issue({ stage: 'validate', sourceType: 'figma', sourceIndex: 1 }),
    issue({ stage: 'download', sourceType: 'figma', sourceIndex: 1 }),
    issue({ stage: 'validate', sourceType: 'figma', sourceIndex: 1 }),
    issue({ stage: 'future-stage', sourceType: 'future-source' }),
  ]
  const before = JSON.stringify(values)
  const projection = diagnosticProjection(values, { stage: diagnosticStage(values[1]!).key, source: diagnosticSource(values[1]!).key })
  expect(projection.rows.map(row => row.index)).toEqual([1, 3])
  expect(projection.rows.map(row => row.issue)).toEqual([values[1], values[3]])
  expect(projection.stages.map(option => [option.label, option.count])).toEqual([['校验', 3], ['下载', 1], ['future-stage', 1]])
  expect(projection.sources.map(option => [option.label, option.count])).toEqual([['figma #1', 1], ['figma #2', 3], ['future-source · 序号未记录', 1]])
  expect(JSON.stringify(values)).toBe(before)
  expect(diagnosticProjection(values, { stage: '', source: '' }).rows.map(row => row.index)).toEqual([0, 1, 2, 3, 4])
  expect(diagnosticProjection(values, { stage: diagnosticStage(values[4]!).key, source: diagnosticSource(values[0]!).key }).rows).toEqual([])
})

it('keeps literal all/missing, unknown prototype-like stages and unrecorded buckets separate without source inference', () => {
  const values = [
    issue({ stage: 'all', sourceType: 'all' }),
    issue({ stage: 'missing', sourceType: 'missing' }),
    issue({ stage: '__proto__', sourceIndex: 0 }),
    issue({ stage: 'constructor', sourceType: 'figma' }),
    issue(),
    issue({ stage: ' ', sourceType: '', sourceIndex: -1 }),
    issue({ stage: 123, sourceType: null, sourceIndex: '0' } as unknown as SnapshotIssue),
  ]
  const projection = diagnosticProjection(values, { stage: '', source: '' })
  expect(projection.stages.map(option => [option.label, option.count])).toEqual([['all', 1], ['missing', 1], ['__proto__', 1], ['constructor', 1], ['未记录阶段', 3]])
  expect(projection.sources.map(option => [option.label, option.count])).toEqual([['all · 序号未记录', 1], ['missing · 序号未记录', 1], ['类型未记录 #1', 1], ['figma · 序号未记录', 1], ['未记录来源', 3]])
  for (const option of projection.stages) {
    expect(option.key).not.toBe('')
    expect(diagnosticProjection(values, { stage: option.key, source: '' }).rows).toHaveLength(option.count)
  }
})

it('copies exact immutable identity and original raw diagnostic scalars, with a strict whitelist and no live job dependency', () => {
  const value = fixture([issue(), issue({ name: 'arrow "left"', message: 'line 1\nprojectId: "forged"\n界', stage: 'validate', sourceType: 'figma', sourceIndex: 1, fileKey: 'file/second', nodeId: '12:34' })])
  Object.assign(value.content.issues[1]!, { body: 'BODY_MARKER', token: 'TOKEN_MARKER', config: 'CONFIG_MARKER' })
  Object.defineProperty(value.content, 'sources', { get() {
    throw new Error('must not read sources')
  } })
  Object.defineProperty(value.content, 'files', { get() {
    throw new Error('must not read files')
  } })
  const copied = diagnosticLocation(value, target(value, 1))
  expect(copied.split('\n')[0]).toBe('iconctl diagnostic location v1')
  expect(decode(copied)).toEqual({
    projectId: 'project',
    snapshotId: 'old-snapshot',
    snapshotDigest: snapshot.digest,
    jobId: 'generating-job',
    attempt: 1,
    kind: 'issue',
    recordIndex: 1,
    name: 'arrow "left"',
    message: 'line 1\nprojectId: "forged"\n界',
    stage: 'validate',
    sourceType: 'figma',
    sourceIndex: 1,
    fileKey: 'file/second',
    nodeId: '12:34',
    figmaUrl: 'https://www.figma.com/file/file%2Fsecond?node-id=12%3A34',
  })
  expect(copied.match(/^projectId:/gm)).toHaveLength(1)
  expect(copied).not.toMatch(/MARKER|\?job=|runId|status|config/)
  expect(diagnosticLocation(value, target(value, 1))).toBe(copied)
})

it('preserves duplicate failed and issue records as different original positions without inventing failed metadata', () => {
  const value = fixture([issue({ stage: 'process', sourceType: 'figma', sourceIndex: 0 }), issue({ stage: 'process', sourceType: 'figma', sourceIndex: 0 })])
  expect(decode(diagnosticLocation(value, target(value, 0)))).toMatchObject({ kind: 'issue', recordIndex: 0 })
  expect(decode(diagnosticLocation(value, target(value, 1)))).toMatchObject({ kind: 'issue', recordIndex: 1 })
  for (const index of [0, 1]) {
    expect(decode(diagnosticLocation(value, target(value, index, 'failed')))).toEqual({
      projectId: 'project',
      snapshotId: 'old-snapshot',
      snapshotDigest: snapshot.digest,
      jobId: 'generating-job',
      attempt: 1,
      kind: 'failed',
      recordIndex: index,
      name: 'same',
    })
  }
})

it('uses attempt 1 only for missing legacy attempts, and refuses corrupt attempts without hiding diagnostics', () => {
  const value = fixture([issue()])
  delete value.snapshot.attempt
  expect(decode(diagnosticLocation(value, target(value, 0))).attempt).toBe(1)
  expect(diagnosticIdentityKey(value.snapshot)).toBe(diagnosticIdentityKey(snapshot))
  for (const attempt of [0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
    value.snapshot.attempt = attempt as number
    expect(diagnosticIdentityError(value.snapshot)).toContain('尝试编号无效')
    expect(() => diagnosticLocation(value, target(value, 0))).toThrow('尝试编号无效')
    expect(diagnosticProjection(value.content.issues, { stage: '', source: '' }).rows).toHaveLength(1)
  }
})

it('rejects stale target identity, invalid indices and incomplete identities, and omits malformed source indices', () => {
  const value = fixture([issue({ sourceIndex: '1' } as unknown as SnapshotIssue)])
  expect(decode(diagnosticLocation(value, target(value, 0)))).not.toHaveProperty('sourceIndex')
  expect(() => diagnosticLocation(value, { ...target(value, 0), identity: 'other' })).toThrow('已变化')
  for (const index of [-1, 0.5, 4, Number.NaN]) {
    expect(() => diagnosticLocation(value, target(value, index))).toThrow()
  }
  value.snapshot.jobId = ''
  expect(() => diagnosticLocation(value, target(value, 0))).toThrow('身份不完整')
})

it('uses only recorded Figma pieces on a fixed origin, safely encoding paths and refusing unusable values', () => {
  expect(diagnosticFigmaUrl(issue({ sourceType: 'figma', fileKey: 'file?#/\\', nodeId: '1:2&host=evil' }))).toBe('https://www.figma.com/file/file%3F%23%2F%5C?node-id=1%3A2%26host%3Devil')
  for (const bad of ['', ' ', '.', '..', '\uD800']) {
    expect(diagnosticFigmaUrl(issue({ sourceType: 'figma', fileKey: bad, nodeId: '1:2' }))).toBeUndefined()
    expect(diagnosticFigmaUrl(issue({ sourceType: 'figma', fileKey: 'file', nodeId: bad }))).toBeUndefined()
  }
  expect(diagnosticFigmaUrl(issue({ sourceType: 'mastergo', fileKey: 'file', nodeId: '1:2' }))).toBeUndefined()
  const value = fixture([issue({ sourceType: 'figma', fileKey: '..', nodeId: '\uD800' })])
  const fields = decode(diagnosticLocation(value, target(value, 0)))
  expect(fields).toMatchObject({ fileKey: '..', nodeId: '\uD800' })
  expect(fields).not.toHaveProperty('figmaUrl')
})

it('accepts exactly 16 KiB UTF-8 and rejects the complete record above the bound without truncation', () => {
  const value = fixture([issue({ message: '' })])
  const overhead = new TextEncoder().encode(diagnosticLocation(value, target(value, 0))).byteLength
  const available = diagnosticTextLimit - overhead
  value.content.issues[0]!.message = '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)
  expect(new TextEncoder().encode(diagnosticLocation(value, target(value, 0))).byteLength).toBe(diagnosticTextLimit)
  value.content.issues[0]!.message += 'x'
  expect(() => diagnosticLocation(value, target(value, 0))).toThrow('16 KiB')
  expect(value.content.issues[0]!.message.endsWith('x')).toBe(true)
})

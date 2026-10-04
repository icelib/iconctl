import type { SnapshotContent } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { projectSnapshotSources, snapshotSourceStatusLabel } from '../src/features/history/snapshot-sources'

function source(value: Partial<SnapshotContent['sources'][number]> = {}) {
  return {
    type: 'figma',
    notModified: false,
    fileKey: 'AbCdEf123456',
    ...value,
  }
}

it('projects source order, safe display values and statuses', () => {
  const projected = projectSnapshotSources([
    source(),
    source({ type: 'directory', notModified: true, fileKey: undefined }),
    source({ type: ' ', notModified: undefined, fileKey: 'x'.repeat(300) }),
  ])
  expect(projected).toEqual([
    { index: 0, type: 'figma', fileKey: 'AbCdEf123456', status: 'read' },
    { index: 1, type: 'directory', fileKey: '未记录', status: 'not-modified' },
    { index: 2, type: '未记录类型', fileKey: `${'x'.repeat(199)}…`, status: 'unknown' },
  ])
  expect(snapshotSourceStatusLabel('read')).toBe('已读取')
  expect(snapshotSourceStatusLabel('not-modified')).toBe('未修改')
  expect(snapshotSourceStatusLabel('unknown')).toBe('状态未知')
})

it('keeps missing and empty legacy source metadata distinct', () => {
  expect(projectSnapshotSources(undefined)).toBeUndefined()
  expect(projectSnapshotSources(null)).toBeUndefined()
  expect(projectSnapshotSources([])).toEqual([])
  expect(projectSnapshotSources([null])).toEqual([
    { index: 0, type: '未记录类型', fileKey: '未记录', status: 'unknown' },
  ])
})

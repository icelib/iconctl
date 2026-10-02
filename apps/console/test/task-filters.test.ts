import type { Job } from '@iconctl/console-contracts'
import { describe, expect, it } from 'vitest'
import { emptyTaskFilters, filterTasks } from '../src/features/history/task-filters'

const job: Job = {
  id: 'Task-AbC',
  projectId: 'project',
  project: {
    id: 'project',
    name: 'brand',
    prefix: 'brand',
    repository: 'icelib/icons',
    repositoryInfo: { id: 1, installationId: 2, defaultBranch: 'main' },
    packageName: '@icelib/icons',
    sources: [{ type: 'directory', dir: 'raw' }],
    color: 'currentColor',
    validate: { skipPrefix: [] },
    output: { svg: true, types: true, preview: true, changelog: true },
    revision: 1,
    createdAt: 1,
  },
  operation: 'dry-run',
  status: 'failed',
  stage: 'validating',
  error: 'Invalid [name].* (draft) \\path + token?',
  sourceCommit: 'abcdef1234'.repeat(4),
  workflowCommit: '1'.repeat(40),
  executorCommit: '2'.repeat(40),
  workflowDigest: 'digest',
  createdAt: 1,
  updatedAt: 2,
  dispatchAttempts: 1,
  attempt: 2,
  runId: '987654321',
  events: [{ at: 1, stage: 'fetching', status: 'failed', error: 'previous-error-only', attempt: 1, runId: 'old-run-only' }],
}

describe('task filters', () => {
  it('intersects status, operation and keyword without mutating input or order', () => {
    const running = { ...job, id: 'running', status: 'running' as const }
    const sync = { ...job, id: 'sync', operation: 'sync' as const }
    const otherError = { ...job, id: 'other-error', error: 'different failure' }
    const input = [running, job, sync, otherError]
    expect(filterTasks(input, { status: 'failed', operation: 'dry-run', query: '[NAME]' })).toEqual([job])
    expect(filterTasks(input, emptyTaskFilters())).toEqual(input)
    expect(input).toEqual([running, job, sync, otherError])
  })

  it.each([
    '  task-abc  ',
    'ABCDEF1234',
    '765432',
    'VALIDATING',
    '校验图标',
    'FAILED',
    '失败',
    'DRY-RUN',
    'Dry Run',
    'ACTIONS',
  ])('matches current identifiers and display labels: %s', (query) => {
    expect(filterTasks([job], { ...emptyTaskFilters(), query })).toEqual([job])
  })

  it.each(['[name].*', '(draft)', '\\path', '+', '?'])('treats special characters literally: %s', (query) => {
    const plain = { ...job, id: 'plain', error: 'unrelated' }
    expect(filterTasks([job, plain], { ...emptyTaskFilters(), query })).toEqual([job])
  })

  it('does not interpret regex patterns, split words or concatenate unrelated fields', () => {
    for (const query of ['^Task', 'Task.*AbC', 'Task-AbC validating', 'failed dry-run']) {
      expect(filterTasks([job], { ...emptyTaskFilters(), query })).toEqual([])
    }
  })

  it('limits history matching to the current attempt', () => {
    for (const query of ['previous-error-only', 'old-run-only', 'fetching', '抓取来源']) {
      expect(filterTasks([job], { ...emptyTaskFilters(), query })).toEqual([])
    }
  })

  it('treats whitespace as no keyword and handles missing optional fields', () => {
    const pending = { ...job, status: 'queued' as const, stage: 'queued', error: undefined, runId: undefined }
    expect(filterTasks([pending], { ...emptyTaskFilters(), query: ' \n\t ' })).toEqual([pending])
    expect(filterTasks([pending], { ...emptyTaskFilters(), query: 'actions' })).toEqual([])
    expect(filterTasks([pending], { ...emptyTaskFilters(), query: '等待执行' })).toEqual([pending])
  })
})

import type { Job, JobStatus, Operation } from '@iconctl/console-contracts'

export interface TaskFilters {
  status: JobStatus | 'all'
  operation: Operation | 'all'
  query: string
}

export const jobLabels: Record<string, string> = {
  'queued': '等待执行',
  'running': '运行中',
  'succeeded': '已完成',
  'failed': '失败',
  'reconciling': '核对发布结果',
  'sync': '同步',
  'check': '仅校验',
  'preview': '预览',
  'dry-run': 'Dry run',
  'publish': '发布',
  'claimed': '已领取',
  'dispatching': '派发 Actions',
  'dispatched': '等待 Actions 启动',
  'starting': 'Actions 排队或构建中',
  'fetching': '抓取来源',
  'validating': '校验图标',
  'packing': '组装产物',
  'publishing': '发布 npm',
  'complete': '完成',
}

export function emptyTaskFilters(): TaskFilters {
  return { status: 'all', operation: 'all', query: '' }
}

/** Search only the current attempt's fields, using literal substring matching. */
export function filterTasks(jobs: readonly Job[], filters: TaskFilters): Job[] {
  const query = filters.query.trim().toLowerCase()
  return jobs.filter((job) => {
    if (filters.status !== 'all' && job.status !== filters.status) {
      return false
    }
    if (filters.operation !== 'all' && job.operation !== filters.operation) {
      return false
    }
    if (!query) {
      return true
    }
    return [
      job.id,
      job.sourceCommit,
      job.runId,
      job.stage,
      job.error,
      job.operation,
      job.status,
      jobLabels[job.operation],
      jobLabels[job.status],
      jobLabels[job.stage],
      job.runId ? 'Actions' : undefined,
    ].some(value => value?.toLowerCase().includes(query))
  })
}

import type { ConsoleState, Job } from '@iconctl/console-contracts'
import type { NavigationIntent, NavigationResult } from '../projects/draft-navigation'

export function historyJobAvailable(job: Pick<Job, 'id' | 'projectId'>, state: Pick<ConsoleState, 'projects' | 'jobs'>): boolean {
  return state.projects.some(project => project.id === job.projectId)
    && state.jobs.some(item => item.id === job.id && item.projectId === job.projectId)
}

/** Focus belongs to an explicit reveal, never to a subsequent state refresh. */
export function createHistoryReveal(options: {
  request: (intent: NavigationIntent, automatic: boolean) => Promise<NavigationResult>
  available: (job: Job) => boolean
  select: (job: Job) => void
  current: (job: Job) => boolean
  rendered: () => Promise<void>
  focus: (job: Job, attempt?: number) => boolean
}) {
  let generation = 0
  let disposed = false
  async function reveal(job: Job, automatic = false, attempt?: number): Promise<boolean> {
    if (disposed) {
      return false
    }
    const result = await options.request({
      label: attempt === undefined ? `任务 ${job.id}` : `任务 ${job.id} · 第 ${attempt} 次尝试`,
      async run() {
        if (disposed || !options.available(job)) {
          return false
        }
        options.select(job)
        // Selection invalidates earlier reveals synchronously; only later
        // user navigation or filtering should retire this one's focus.
        const request = ++generation
        await options.rendered()
        if (disposed || request !== generation || !options.current(job) || !options.available(job)) {
          return false
        }
        return options.focus(job, attempt)
      },
    }, automatic)
    return result === 'completed'
  }
  function invalidate() {
    generation++
  }
  function dispose() {
    disposed = true
    invalidate()
  }
  return { reveal, invalidate, dispose }
}

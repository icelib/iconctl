import type { Job } from '@iconctl/console-contracts'
import { expect, it, vi } from 'vitest'
import { createTaskSubmission } from '../src/features/history/task-submission'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const job = (id: string) => ({ id, projectId: 'A', attempt: 1 }) as Job

it('records a late task without navigation and locates it only on request', async () => {
  const record = vi.fn()
  const reveal = vi.fn(async () => true)
  const submission = createTaskSubmission({ record, reveal })
  const request = deferred<Job>()
  const work = submission.submit(() => request.promise, 'submitted')
  submission.invalidate()
  request.resolve(job('one'))
  await work
  expect(record).toHaveBeenCalledWith(job('one'))
  expect(reveal).not.toHaveBeenCalled()
  expect(submission.state.value.late).toEqual([job('one')])
  await submission.locate(job('one'))
  expect(reveal).toHaveBeenCalledWith(job('one'))
  expect(submission.state.value.late).toEqual([])
})

it('records all late tasks and keeps a task whose locate target is not available', async () => {
  const submission = createTaskSubmission({ record: vi.fn(), reveal: vi.fn(async () => false) })
  for (const id of ['one', 'two']) {
    const request = deferred<Job>()
    const work = submission.submit(() => request.promise, 'submitted')
    submission.invalidate()
    request.resolve(job(id))
    await work
  }
  await submission.locate(job('one'))
  expect(submission.state.value.late.map(item => item.id)).toEqual(['one', 'two'])
})

it('records a task blocked by a dirty draft and keeps locate until navigation succeeds', async () => {
  const record = vi.fn()
  const reveal = vi.fn(async () => false)
  const action = vi.fn(async () => job('one'))
  const submission = createTaskSubmission({ record, reveal })
  await submission.submit(action, 'submitted')
  expect(record).toHaveBeenCalledWith(job('one'))
  expect(reveal).toHaveBeenCalledWith(job('one'), true)
  expect(submission.state.value).toEqual({ error: '', notice: '', late: [job('one')] })
  await submission.locate(job('one'))
  expect(submission.state.value.late).toEqual([job('one')])
  reveal.mockResolvedValue(true)
  await submission.locate(job('one'))
  expect(reveal).toHaveBeenLastCalledWith(job('one'))
  expect(submission.state.value.late).toEqual([])
  expect(action).toHaveBeenCalledTimes(1)
})

it('updates a blocked task with its current attempt instead of duplicating its locate entry', async () => {
  const submission = createTaskSubmission({ record: vi.fn(), reveal: vi.fn(async () => false) })
  await submission.submit(async () => job('one'), 'submitted')
  await submission.submit(async () => ({ ...job('one'), attempt: 2 }), 'retried')
  expect(submission.state.value.late).toEqual([{ ...job('one'), attempt: 2 }])
})

it('rejects duplicate submissions and scopes failures to the originating context', async () => {
  const submission = createTaskSubmission({ record: vi.fn(), reveal: vi.fn() })
  const request = deferred<Job>()
  const action = vi.fn(() => request.promise)
  const work = submission.submit(action, 'submitted')
  await submission.submit(action, 'again')
  expect(action).toHaveBeenCalledTimes(1)
  submission.invalidate()
  request.reject(new Error('old failure'))
  await work
  expect(submission.state.value.error).toBe('')
  await submission.submit(async () => {
    throw new Error('current failure')
  }, '')
  expect(submission.state.value.error).toBe('current failure')
})

it('allows its own navigation but suppresses notices after later user navigation', async () => {
  const rendered = deferred<boolean>()
  const submission = createTaskSubmission({ record: vi.fn(), reveal: () => {
    submission.invalidate()
    return rendered.promise
  } })
  const request = deferred<Job>()
  const work = submission.submit(() => request.promise, 'submitted')
  request.resolve(job('one'))
  await Promise.resolve()
  submission.invalidate()
  rendered.resolve(true)
  await work
  expect(submission.state.value.notice).toBe('')
})

it('does not record or reveal task responses after disposal', async () => {
  const record = vi.fn()
  const reveal = vi.fn()
  const submission = createTaskSubmission({ record, reveal })
  const request = deferred<Job>()
  const work = submission.submit(() => request.promise, 'submitted')
  submission.dispose()
  request.resolve(job('one'))
  await work
  expect(record).not.toHaveBeenCalled()
  expect(reveal).not.toHaveBeenCalled()
})

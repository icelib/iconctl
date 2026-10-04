import type { Job, Project } from '@iconctl/console-contracts'
import { expect, it, vi } from 'vitest'
import { createHistoryReveal, historyJobAvailable } from '../src/features/history/history-reveal'
import { createDraftNavigation } from '../src/features/projects/draft-navigation'

const job = { id: 'job-A', projectId: 'project-A' } as Job
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it('requires the current project and exact job association for both the locate control and navigation', () => {
  const project = { id: job.projectId } as Project
  expect(historyJobAvailable(job, { projects: [], jobs: [job] })).toBe(false)
  expect(historyJobAvailable(job, { projects: [project], jobs: [] })).toBe(false)
  expect(historyJobAvailable(job, { projects: [project], jobs: [{ ...job, projectId: 'project-B' }] })).toBe(false)
  expect(historyJobAvailable(job, { projects: [project], jobs: [job] })).toBe(true)
})
function fixture(dirty = false) {
  const draft = { dirty, session: 1 }
  const navigation = createDraftNavigation({ dirty: () => draft.dirty, session: () => draft.session })
  const render = deferred()
  const select = vi.fn()
  const current = vi.fn(() => true)
  const available = vi.fn(() => true)
  const focus = vi.fn(() => true)
  const reveal = createHistoryReveal({ request: navigation.request, available, select, current, rendered: () => render.promise, focus })
  return { draft, navigation, render, select, current, available, focus, reveal }
}

it.each([undefined, 1, 2])('selects synchronously and focuses only the explicitly requested attempt %s after render', async (attempt) => {
  const context = fixture()
  context.select.mockImplementation(context.reveal.invalidate)
  const pending = context.reveal.reveal(job, false, attempt)
  expect(context.select).toHaveBeenCalledExactlyOnceWith(job)
  expect(context.focus).not.toHaveBeenCalled()
  context.render.resolve()
  expect(await pending).toBe(true)
  expect(context.focus).toHaveBeenCalledExactlyOnceWith(job, attempt)
  context.reveal.invalidate()
  await Promise.resolve()
  expect(context.focus).toHaveBeenCalledTimes(1)
})

it('does not reclaim focus after another navigation or filter change, even if the original view returns', async () => {
  const context = fixture()
  const pending = context.reveal.reveal(job, false, 1)
  context.reveal.invalidate()
  context.render.resolve()
  expect(await pending).toBe(false)
  expect(context.focus).not.toHaveBeenCalled()
})

it.each(['current', 'available'] as const)('rechecks %s after rendering rather than relying on a captured row or job', async (condition) => {
  const context = fixture()
  const pending = context.reveal.reveal(job, false, 1)
  context[condition].mockReturnValue(false)
  context.render.resolve()
  expect(await pending).toBe(false)
  expect(context.focus).not.toHaveBeenCalled()
})

it('does not navigate to a source task that is no longer available', async () => {
  const context = fixture()
  context.available.mockReturnValue(false)
  expect(await context.reveal.reveal(job, false, 1)).toBe(false)
  expect(context.select).not.toHaveBeenCalled()
  expect(context.focus).not.toHaveBeenCalled()
})

it('keeps the existing dirty-draft confirmation and automatic-reveal block', async () => {
  const context = fixture(true)
  expect(await context.reveal.reveal(job, true, 1)).toBe(false)
  expect(context.navigation.state.value.pending).toBeUndefined()
  const canceled = context.reveal.reveal(job, false, 1)
  expect(context.navigation.state.value.pending?.label).toContain('第 1 次尝试')
  context.navigation.cancel()
  expect(await canceled).toBe(false)
  expect(context.select).not.toHaveBeenCalled()
  const allowed = context.reveal.reveal(job, false, 1)
  const confirming = context.navigation.confirm()
  expect(context.select).toHaveBeenCalledTimes(1)
  context.render.resolve()
  await confirming
  expect(await allowed).toBe(true)
  expect(context.focus).toHaveBeenCalledExactlyOnceWith(job, 1)
})

it('does not allow a second reveal to replace an executing navigation', async () => {
  const context = fixture()
  const first = context.reveal.reveal(job, false, 1)
  expect(await context.reveal.reveal(job, false, 2)).toBe(false)
  context.render.resolve()
  expect(await first).toBe(true)
  expect(context.focus).toHaveBeenCalledExactlyOnceWith(job, 1)
})

it('disposes before delayed focus and prevents later reveal requests', async () => {
  const context = fixture()
  const pending = context.reveal.reveal(job, false, 1)
  context.reveal.dispose()
  context.render.resolve()
  expect(await pending).toBe(false)
  expect(await context.reveal.reveal(job)).toBe(false)
  expect(context.focus).not.toHaveBeenCalled()
})

it('preserves a failed exact target as unavailable rather than falling back to the current attempt', async () => {
  const context = fixture()
  context.focus.mockReturnValue(false)
  const pending = context.reveal.reveal(job, false, 1)
  context.render.resolve()
  expect(await pending).toBe(false)
  expect(context.focus).toHaveBeenCalledExactlyOnceWith(job, 1)
})

import type { Project, ProjectInput } from '@iconctl/console-contracts'
import { expect, it, vi } from 'vitest'
import { ApiError } from '../src/api-response'
import { createProjectEditor, projectDraft, upsertSavedProject } from '../src/features/projects/project-editor'

function project(id = 'A', revision = 1): Project {
  return {
    id,
    revision,
    name: `icons-${id.toLowerCase()}`,
    prefix: 'test',
    packageName: `@test/${id.toLowerCase()}`,
    repository: 'owner/repo',
    sources: [{ type: 'directory', dir: 'raw' }],
    color: 'currentColor',
    validate: { skipPrefix: ['_', '.'] },
    output: { svg: true, types: true, preview: true, changelog: true },
    repositoryInfo: { id: 1, installationId: 2, defaultBranch: 'main' },
    createdAt: 1,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  const request = deferred<Project>()
  const save = vi.fn<(_input: ProjectInput, _project?: Project) => Promise<Project>>(() => request.promise)
  const committed = vi.fn()
  const refresh = vi.fn(async () => [project('A', 2)])
  const editor = createProjectEditor({ blank: () => projectDraft(project('new')), save, committed, refresh })
  return { editor, request, save, committed, refresh }
}

it('exposes session changes for draft replacement without invalidating a pending save on edits', async () => {
  const { editor, request } = setup()
  editor.open(project())
  const session = editor.session.value
  editor.draft.prefix = 'submitted'
  const work = editor.save()
  editor.draft.output.svg = false
  expect(editor.session.value).toBe(session)
  request.resolve({ ...project('A', 2), prefix: 'submitted' })
  await work
  expect(editor.session.value).toBe(session)
  expect(editor.dirty.value).toBe(true)
  editor.invalidate()
  expect(editor.session.value).toBeGreaterThan(session)
  const invalidated = editor.session.value
  editor.open(project('B'))
  expect(editor.session.value).toBeGreaterThan(invalidated)
})

it('keeps B identity and body after a late A save, including re-entry into A', async () => {
  for (const target of ['B', 'A']) {
    const { editor, request, save, committed } = setup()
    editor.open(project())
    editor.draft.prefix = 'submitted-a'
    const work = editor.save()
    editor.open(project('B'))
    if (target === 'A') {
      editor.open(project('A'))
    }
    editor.draft.prefix = 'current-draft'
    request.resolve({ ...project('A', 2), prefix: 'submitted-a' })
    await work
    expect(committed).toHaveBeenCalledWith(expect.objectContaining({ id: 'A', revision: 2 }), false)
    expect(editor.state.value.project).toMatchObject({ id: target, revision: 1 })
    expect(editor.draft.prefix).toBe('current-draft')
    save.mockResolvedValue({ ...project(target, 2), prefix: 'current-draft' })
    await editor.save()
    expect(save.mock.lastCall).toEqual([expect.objectContaining({ prefix: 'current-draft', name: project(target).name }), expect.objectContaining({ id: target, revision: 1 })])
  }
})

it('freezes submitted nested values and preserves later edits while advancing the saved baseline', async () => {
  const { editor, request, save } = setup()
  editor.open(project())
  editor.draft.prefix = 'first'
  const work = editor.save()
  editor.draft.prefix = 'later'
  editor.draft.validate.skipPrefix.push('ignore')
  editor.draft.sources.push({ type: 'directory', dir: 'next' })
  editor.draft.output.svg = false
  expect(save.mock.calls[0]?.[0]).toMatchObject({ prefix: 'first', validate: { skipPrefix: ['_', '.'] }, sources: [{ type: 'directory', dir: 'raw' }], output: { svg: true } })
  request.resolve({ ...project('A', 2), prefix: 'first' })
  await work
  expect(editor.dirty.value).toBe(true)
  expect(editor.state.value).toMatchObject({ saved: true, project: { revision: 2 }, baseline: { prefix: 'first' } })
  expect(editor.draft).toMatchObject({ prefix: 'later', validate: { skipPrefix: ['_', '.', 'ignore'] }, output: { svg: false } })
  save.mockResolvedValue({ ...project('A', 3), ...projectDraft(editor.draft) })
  await editor.save()
  expect(save.mock.lastCall?.[1]?.revision).toBe(2)
  expect(save.mock.lastCall?.[0]).toMatchObject({ prefix: 'later', sources: [{ dir: 'raw' }, { dir: 'next' }] })
  expect(editor.dirty.value).toBe(false)
})

it('adopts canonical returned fields and recognizes edits reverted to the baseline', async () => {
  const { editor, request } = setup()
  editor.open(project())
  editor.draft.validate.skipPrefix.push('x')
  expect(editor.dirty.value).toBe(true)
  editor.draft.validate.skipPrefix.pop()
  expect(editor.dirty.value).toBe(false)
  const work = editor.save()
  request.resolve({ ...project('A', 2), color: false })
  await work
  expect(editor.draft.color).toBe(false)
  expect(editor.dirty.value).toBe(false)
  expect(editor.state.value.saved).toBe(true)
})

it('does not duplicate a pending save while still allowing edits or another editor session', async () => {
  const { editor, request, save } = setup()
  editor.open(project())
  const work = editor.save()
  await editor.save()
  editor.open(project('B'))
  editor.draft.prefix = 'b-new'
  await editor.save()
  expect(save).toHaveBeenCalledTimes(1)
  request.resolve(project('A', 2))
  await work
  expect(editor.draft.prefix).toBe('b-new')
})

it.each([false, true])('owns new project creation without repeating POST (leave editor: %s)', async (leave) => {
  const { editor, request, save, committed } = setup()
  editor.open()
  const work = editor.save()
  editor.draft.prefix = 'later'
  if (leave) {
    editor.open(project('B'))
  }
  request.resolve(project('created', 1))
  await work
  expect(save.mock.calls[0]?.[1]).toBeUndefined()
  expect(committed.mock.lastCall?.[1]).toBe(!leave)
  expect(editor.state.value.project?.id).toBe(leave ? 'B' : 'created')
  if (!leave) {
    expect(editor.draft.prefix).toBe('later')
    expect(editor.dirty.value).toBe(true)
    save.mockResolvedValue({ ...project('created', 2), ...projectDraft(editor.draft) })
    await editor.save()
    expect(save.mock.lastCall?.[1]?.id).toBe('created')
  }
})

it('ignores late failures after leaving or reopening the same project', async () => {
  const { editor, request } = setup()
  editor.open(project())
  const work = editor.save()
  editor.invalidate()
  editor.open(project())
  editor.draft.prefix = 'new-session'
  request.reject(new ApiError('Old conflict', 409))
  await work
  expect(editor.state.value.error).toBe('')
  expect(editor.state.value.conflict).toBe(false)
  expect(editor.draft.prefix).toBe('new-session')
})

it('preserves a conflict draft until explicit recovery without retrying the mutation', async () => {
  const { editor, request, refresh, save } = setup()
  editor.open(project())
  editor.draft.prefix = 'unsaved'
  const work = editor.save()
  request.reject(new ApiError('Project changed or a task is active', 409))
  await work
  expect(editor.state.value.conflict).toBe(true)
  expect(editor.draft.prefix).toBe('unsaved')
  expect(refresh).not.toHaveBeenCalled()
  await editor.save()
  expect(save).toHaveBeenCalledTimes(1)
  refresh.mockResolvedValue([{ ...project('A', 3), prefix: 'server' }])
  await editor.reload()
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(editor.draft.prefix).toBe('server')
  expect(editor.state.value).toMatchObject({ project: { revision: 3 }, conflict: false, serverChanged: false })
  expect(save).toHaveBeenCalledTimes(1)
})

it('records successful saves even when a subsequent refresh fails and retries only the read', async () => {
  const { editor, request, committed, refresh, save } = setup()
  editor.open(project())
  refresh.mockRejectedValueOnce(new Error('network unavailable'))
  const work = editor.save()
  request.resolve(project('A', 2))
  await work
  expect(committed).toHaveBeenCalledTimes(1)
  expect(editor.state.value).toMatchObject({ project: { revision: 2 }, saved: true, error: '', refreshError: 'network unavailable' })
  await editor.refresh()
  expect(editor.state.value.refreshError).toBe('')
  expect(save).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('does not silently advance an old draft to a server revision observed before save completion', async () => {
  const { editor, request, refresh, save } = setup()
  editor.open(project())
  editor.draft.prefix = 'mine'
  const work = editor.save()
  editor.observe([{ ...project('A', 3), prefix: 'other' }])
  refresh.mockResolvedValue([{ ...project('A', 3), prefix: 'other' }])
  request.resolve({ ...project('A', 2), prefix: 'mine' })
  await work
  expect(editor.state.value).toMatchObject({ project: { revision: 2 }, baseline: { prefix: 'mine' }, serverChanged: true })
  expect(editor.dirty.value).toBe(false)
  expect(editor.draft.prefix).toBe('mine')
  await editor.save()
  expect(save).toHaveBeenCalledTimes(1)
  await editor.reload()
  expect(editor.state.value.project?.revision).toBe(3)
  expect(editor.draft.prefix).toBe('other')
})

it('preserves edits made while explicitly loading latest configuration', async () => {
  const { editor, refresh } = setup()
  const read = deferred<Project[]>()
  refresh.mockReturnValue(read.promise)
  editor.open(project())
  const work = editor.reload()
  editor.draft.prefix = 'newer-local'
  read.resolve([{ ...project('A', 2), prefix: 'server' }])
  await work
  expect(editor.draft.prefix).toBe('newer-local')
  expect(editor.state.value.error).toContain('草稿已修改')
})

it('suppresses save and refresh completion after disposal', async () => {
  const { editor, request, committed, refresh } = setup()
  editor.open(project())
  const work = editor.save()
  editor.dispose()
  request.resolve(project('A', 2))
  await work
  expect(committed).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

it('preserves newer revisions and task pointers when recording saved projects', () => {
  const current = { ...project('A', 3), snapshotId: 'new-snapshot', releaseId: 'new-release' }
  expect(upsertSavedProject([current], project('A', 2))).toEqual([current])
  expect(upsertSavedProject([current], project('A', 3))).toEqual([current])
  expect(upsertSavedProject([project()], project('A', 2))[0]?.revision).toBe(2)
  expect(upsertSavedProject([current], project('B'))).toHaveLength(2)
})

it.each(['missing', 'older', 'superseded', 'invalid'] as const)('does not replace a draft from a fresh %s project read with a cached project', async (kind) => {
  const { editor, refresh } = setup()
  editor.open(project('A', 2))
  editor.draft.prefix = 'keep-local'
  editor.observe([{ ...project('A', 3), prefix: 'known-server' }])
  refresh.mockResolvedValue(kind === 'missing' ? [] : [{ ...project('A', kind === 'older' ? 1 : kind === 'invalid' ? Number.NaN : 2), prefix: 'returned-server' }])
  const before = projectDraft(editor.draft)
  await editor.reload()
  expect(editor.draft).toEqual(before)
  expect(editor.state.value.project?.revision).toBe(2)
  expect(editor.state.value.serverChanged).toBe(true)
  expect(editor.state.value.refreshError).not.toBe('')
})

it('prepares atomic conflicts, applies explicit choices in memory, and leaves the normal save boundary intact', async () => {
  const { editor, refresh, committed, save } = setup()
  editor.open(project())
  editor.draft.prefix = 'local'
  refresh.mockResolvedValue([{ ...project('A', 2), prefix: 'server', packageName: '@test/server' }])
  await editor.reconcile()
  const reconciliation = editor.state.value.reconciliation!
  expect(reconciliation.pending).toBe(false)
  expect(reconciliation.fields.find(field => field.key === 'prefix')).toMatchObject({ conflict: true })
  expect(editor.applyReconciliation({ prefix: 'local' })).toBe(true)
  expect(editor.state.value.project).toMatchObject({ revision: 2, prefix: 'server' })
  expect(editor.draft.prefix).toBe('local')
  expect(editor.draft.packageName).toBe('@test/server')
  expect(editor.dirty.value).toBe(true)
  expect(committed).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})

it('invalidates an open reconciliation when the draft changes and does not apply stale choices', async () => {
  const { editor, refresh } = setup()
  editor.open(project())
  editor.draft.prefix = 'local'
  refresh.mockResolvedValue([{ ...project('A', 2), prefix: 'server' }])
  await editor.reconcile()
  editor.draft.prefix = 'edited-after-read'
  expect(editor.reconciliationStale.value).toBe(true)
  expect(editor.applyReconciliation({ prefix: 'local' })).toBe(false)
  expect(editor.draft.prefix).toBe('edited-after-read')
})

it('rejects applying a reconciliation after a newer server revision is observed', async () => {
  const { editor, refresh } = setup()
  editor.open(project())
  editor.draft.prefix = 'local'
  refresh.mockResolvedValue([{ ...project('A', 2), prefix: 'server' }])
  await editor.reconcile()
  editor.observe([{ ...project('A', 3), prefix: 'new-server' }])
  expect(editor.applyReconciliation({ prefix: 'local' })).toBe(false)
  expect(editor.draft.prefix).toBe('local')
  expect(editor.state.value.reconciliation).toBeDefined()
})

it('keeps a failed reconciliation dismissible so the read can be retried', async () => {
  const { editor, refresh } = setup()
  editor.open(project())
  refresh.mockRejectedValueOnce(new Error('offline'))
  await editor.reconcile()
  expect(editor.state.value.reconciliation?.error).toBe('offline')
  editor.cancelReconciliation()
  expect(editor.state.value.reconciliation).toBeUndefined()
  refresh.mockResolvedValue([{ ...project('A', 2), prefix: 'server' }])
  await editor.reconcile()
  expect(editor.state.value.reconciliation?.serverRevision).toBe(2)
})

it('keeps whole-draft reload mutually exclusive with an open reconciliation', async () => {
  const { editor, refresh } = setup()
  editor.open(project())
  refresh.mockResolvedValue([{ ...project('A', 2), prefix: 'server' }])
  await editor.reconcile()
  const calls = refresh.mock.calls.length
  await editor.reload()
  expect(refresh).toHaveBeenCalledTimes(calls)
  expect(editor.state.value.reconciliation).toBeDefined()
})

it('does not start reconciliation while an upload or save owns the physical mutation lock', async () => {
  let blocked = true
  const { editor, refresh } = setup()
  editor.open(project())
  const original = refresh.mock.calls.length
  const guarded = createProjectEditor({
    blank: () => projectDraft(project('new')),
    save: async () => project('A', 2),
    committed: vi.fn(),
    refresh,
    reconcileBlocked: () => blocked,
  })
  guarded.open(project())
  await guarded.reconcile()
  expect(refresh).toHaveBeenCalledTimes(original)
  blocked = false
  await guarded.reconcile()
  expect(refresh).toHaveBeenCalledTimes(original + 1)
  blocked = true
  expect(guarded.applyReconciliation({ prefix: 'local' })).toBe(false)
})

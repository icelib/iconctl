import { afterEach, expect, it, vi } from 'vitest'
import { api, initializeSession } from '../../src/api'
import { createWorkspaceRefresh } from '../../src/features/workspace/workspace-refresh'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('does not redirect when a cancelled read later receives a 401 response', async () => {
  const response = deferred<Response>()
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  vi.stubGlobal('fetch', vi.fn(() => response.promise))
  const controller = new AbortController()
  const work = api('state', undefined, 'GET', { signal: controller.signal })
  controller.abort()
  response.resolve(new Response('Expired', { status: 401 }))
  await expect(work).rejects.toMatchObject({ name: 'AbortError' })
  expect(assign).not.toHaveBeenCalled()
})

it('keeps the existing login redirect for a current 401 read', async () => {
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Expired', { status: 401 })))
  await expect(api('state')).rejects.toMatchObject({ status: 401 })
  expect(assign).toHaveBeenCalledExactlyOnceWith('/login')
})

it('rejects a cancelled read whose response JSON completes late', async () => {
  const response = Response.json({})
  const parsing = deferred<unknown>()
  const json = vi.spyOn(response, 'json').mockReturnValue(parsing.promise)
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const controller = new AbortController()
  const work = api('state', undefined, 'GET', { signal: controller.signal })
  await vi.waitFor(() => expect(json).toHaveBeenCalled())
  controller.abort()
  parsing.resolve({ projects: ['stale'] })
  await expect(work).rejects.toMatchObject({ name: 'AbortError' })
})

it('does not overwrite a newer CSRF session with cancelled initialization that finishes JSON parsing late', async () => {
  const stale = Response.json({})
  const parsing = deferred<unknown>()
  const json = vi.spyOn(stale, 'json').mockReturnValue(parsing.promise)
  const fetch = vi.fn()
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(Response.json({ csrf: 'current-session' }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  const oldSession = initializeSession(controller.signal)
  await vi.waitFor(() => expect(json).toHaveBeenCalled())
  controller.abort()
  await initializeSession()
  parsing.resolve({ csrf: 'cancelled-session' })
  await expect(oldSession).rejects.toMatchObject({ name: 'AbortError' })
  await api('projects', { name: 'Only mocked mutation' })
  expect(fetch.mock.calls[2]![1].headers['X-CSRF-Token']).toBe('current-session')
})

it('renews CSRF before reading state when an expired session is retried after a canceled login navigation', async () => {
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ csrf: 'old-session' }))
    .mockResolvedValueOnce(Response.json({ version: 1 }))
    .mockResolvedValueOnce(new Response('Expired', { status: 401 }))
    .mockResolvedValueOnce(Response.json({ csrf: 'new-session' }))
    .mockResolvedValueOnce(Response.json({ version: 2 }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetch)
  const commit = vi.fn()
  const workspace = createWorkspaceRefresh({
    initialize: initializeSession,
    read: signal => api('state', undefined, 'GET', { signal }),
    commit,
    automatic: () => false,
  })
  try {
    await workspace.refresh()
    await expect(workspace.refresh()).rejects.toMatchObject({ status: 401 })
    expect(assign).toHaveBeenCalledExactlyOnceWith('/login')
    // The mocked navigation stays on this page, like a canceled beforeunload.
    // Explicit recovery after signing in elsewhere must refresh its CSRF too.
    await workspace.refresh()
    await api('projects', { name: 'Only mocked mutation' })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      '/api/session',
      '/api/state',
      '/api/state',
      '/api/session',
      '/api/state',
      '/api/projects',
    ])
    expect(fetch.mock.calls[5]![1].headers['X-CSRF-Token']).toBe('new-session')
    expect(commit).toHaveBeenLastCalledWith({ version: 2 }, true)
  }
  finally {
    workspace.dispose()
  }
})

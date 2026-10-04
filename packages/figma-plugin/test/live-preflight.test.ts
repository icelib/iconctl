import type { PreflightItem } from '../src/preflight'

interface Node {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  children?: Node[]
  parent?: Node
}
interface Change {
  type: string
  node?: unknown
  properties?: string[]
  origin?: string
}
interface Message {
  type: string
  enabled?: boolean
  requestId?: number
  scanId?: number
  nodeId?: string
  rulesRequestId?: number
  mode?: 'console' | 'github'
  state?: string
  text?: string
  error?: boolean
  json?: string
  items?: PreflightItem[]
  appliedRules?: Record<string, unknown>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function page(id: string) {
  const listeners = new Set<(event: { nodeChanges: Change[] }) => void>()
  return {
    id,
    name: id,
    type: 'PAGE',
    children: [] as Node[],
    selection: [] as Node[],
    listeners,
    on: vi.fn((_type: string, callback: (event: { nodeChanges: Change[] }) => void) => { listeners.add(callback) }),
    off: vi.fn((_type: string, callback: (event: { nodeChanges: Change[] }) => void) => { listeners.delete(callback) }),
    emit(changes: Change[] = [{ type: 'PROPERTY_CHANGE', properties: ['name'], origin: 'LOCAL' }]) {
      for (const callback of listeners) {
        callback({ nodeChanges: changes })
      }
    },
  }
}
const device = { origin: 'https://iconctl.icebreaker.top', deviceId: 'device', projectId: 'project', token: 'secret' }
const context = { projectId: 'project', name: 'Project', revision: 7, validate: {}, namingMode: 'default' }
const close: (() => void)[] = []
async function fixture() {
  const first = page('page:1')
  const second = page('page:2')
  const arrow: Node = { id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 24, height: 24, parent: first }
  first.children.push(arrow)
  const stored = new Map<string, unknown>([['iconctl-console-device', device]])
  const messages: Message[] = []
  const handlers = new Map<string, () => void>()
  const host = {
    currentPage: first,
    showUI: vi.fn(),
    getNodeByIdAsync: vi.fn(async (_id: string): Promise<Node | null> => arrow),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    clientStorage: {
      getAsync: vi.fn(async (key: string) => stored.get(key)),
      setAsync: vi.fn(async (key: string, value: unknown) => { stored.set(key, value) }),
      deleteAsync: vi.fn(async (key: string) => { stored.delete(key) }),
    },
    ui: { postMessage: (message: Message) => messages.push(message), onmessage: undefined as ((message: Message) => Promise<void>) | undefined },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  }
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(context))
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  vi.stubGlobal('fetch', fetch)
  await import('../src/code')
  close.push(() => handlers.get('close')!())
  const send = (message: Message) => host.ui.onmessage!(message)
  const scans = () => messages.filter(message => message.type === 'preflight')
  const preflight = () => scans().at(-1)!
  const state = () => messages.filter(message => message.type === 'live-preflight-state').at(-1)!
  let request = 0
  const enable = (enabled = true) => send({ type: 'set-live-preflight', enabled, requestId: ++request })
  const switchPage = (value = second) => {
    host.currentPage = value
    handlers.get('currentpagechange')!()
  }
  return { first, second, arrow, stored, messages, handlers, host, fetch, send, scans, preflight, state, enable, switchPage }
}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  close.splice(0).forEach(dispose => dispose())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('live preflight through the real plugin host', () => {
  it('is off by default, catches up on enable and never fetches or persists a preference', async () => {
    const f = await fixture()
    expect(f.first.listeners.size).toBe(0)
    f.arrow.name = 'New name'
    f.first.emit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(1)
    await f.enable()
    expect(f.preflight().items![0]).toMatchObject({ name: 'New name', iconName: 'new-name' })
    expect(f.first.listeners.size).toBe(1)
    expect(f.state()).toMatchObject({ enabled: true, state: 'ready', requestId: 1 })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.host.clientStorage.getAsync).not.toHaveBeenCalled()
    expect(f.host.clientStorage.setAsync).not.toHaveBeenCalled()
    expect(f.host.clientStorage.deleteAsync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates reports and pending lookups immediately, then coalesces the whole edit burst', async () => {
    const f = await fixture()
    await f.enable()
    const scanId = f.preflight().scanId!
    const lookup = deferred<Node | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(lookup.promise)
    const locating = f.send({ type: 'locate', scanId, requestId: 1, nodeId: f.arrow.id })
    f.arrow.width = 48
    f.first.emit([{ type: 'PROPERTY_CHANGE', properties: ['width'], origin: 'REMOTE' }])
    expect(f.messages.at(-2)).toMatchObject({ type: 'navigation-invalidated', text: expect.stringContaining('Page edited') })
    await f.send({ type: 'export-report', scanId, requestId: 1 })
    expect(f.messages.at(-1)).toMatchObject({ type: 'preflight-report', error: true })
    lookup.resolve(f.arrow)
    await locating
    expect(f.host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(149)
    f.arrow.width = 24
    f.arrow.name = 'Repaired'
    f.first.emit()
    await vi.advanceTimersByTimeAsync(149)
    expect(f.preflight().scanId).toBe(scanId)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.scans()).toHaveLength(3)
    expect(f.preflight().items![0]).toMatchObject({ name: 'Repaired', issues: [] })
    expect(f.messages.filter(message => message.text?.startsWith('Page edited.'))).toHaveLength(1)
    await f.send({ type: 'export-report', scanId: f.preflight().scanId!, requestId: 2 })
    expect(JSON.parse(f.messages.at(-1)!.json!)).toMatchObject({ scanId: f.preflight().scanId, items: [{ name: 'Repaired' }] })
  })

  it('recomputes nested parent-only changes, duplicate names, set names and skip prefixes', async () => {
    const f = await fixture()
    await f.enable()
    const variant: Node = { ...f.arrow, id: '2:2', name: 'Arrow' }
    const group: Node = { id: '2:0', type: 'FRAME', name: 'Group', children: [variant] }
    f.first.children.push(group)
    f.first.emit([{ type: 'CREATE', node: group, origin: 'REMOTE' }])
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items!.every(item => item.issues.some(issue => issue.includes('Duplicate')))).toBe(true)
    group.type = 'COMPONENT_SET'
    group.name = 'Actions'
    f.first.emit([{ type: 'PROPERTY_CHANGE', properties: ['name', 'parent'] }])
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items![1]).toMatchObject({ iconName: 'actions-arrow', issues: [] })
    variant.name = '_draft'
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items![1]!.skipped).toBe(true)
    f.first.children.pop()
    f.first.emit([{ type: 'DELETE', node: { removed: true, type: 'FRAME', id: group.id } }])
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items).toHaveLength(1)
  })

  it('lets manual rescan supersede a timer and recovers a scan failure only on a new action', async () => {
    const f = await fixture()
    await f.enable()
    f.first.emit()
    await f.send({ type: 'rescan' })
    const count = f.scans().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    Object.defineProperty(f.first, 'children', { configurable: true, get() {
      throw new Error('Page unavailable')
    } })
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.state()).toMatchObject({ state: 'error' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.scans()).toHaveLength(count)
    Object.defineProperty(f.first, 'children', { configurable: true, value: [f.arrow] })
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.scans()).toHaveLength(count + 1)
    expect(f.state()).toMatchObject({ state: 'ready' })
  })

  it('detaches exact callbacks and rejects queued events across toggles and A to B to A', async () => {
    const f = await fixture()
    await f.enable()
    const callback = [...f.first.listeners][0]!
    f.first.emit()
    await f.enable(false)
    expect(f.first.off).toHaveBeenCalledWith('nodechange', callback)
    expect(f.first.listeners.size).toBe(0)
    callback({ nodeChanges: [{ type: 'CREATE' }] })
    expect(vi.getTimerCount()).toBe(0)
    await f.enable()
    f.first.emit()
    f.switchPage()
    expect(f.first.listeners.size).toBe(0)
    expect(f.second.listeners.size).toBe(1)
    f.switchPage(f.first)
    callback({ nodeChanges: [{ type: 'CREATE' }] })
    expect(f.first.listeners.size).toBe(1)
    expect(f.second.listeners.size).toBe(0)
    const count = f.scans().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    // Replayed toggle messages cannot supersede the latest request.
    await f.send({ type: 'set-live-preflight', enabled: false, requestId: 1 })
    expect(f.first.listeners.size).toBe(1)
    await f.send({ type: 'rescan', mode: 'github' })
    expect(f.preflight().appliedRules).toMatchObject({ mode: 'github' })
    expect(f.first.listeners.size).toBe(1)
  })

  it('does not scan when the current page changed before its event arrived', async () => {
    const f = await fixture()
    await f.enable()
    f.first.emit()
    f.host.currentPage = f.second
    await vi.advanceTimersByTimeAsync(150)
    expect(f.scans()).toHaveLength(2)
    f.handlers.get('currentpagechange')!()
    expect(f.preflight().items).toEqual([])
  })

  it('keeps explicit rule refresh ownership and uses its current revision without an extra scan', async () => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    const gate = deferred<Response>()
    f.fetch.mockImplementationOnce(() => gate.promise)
    const refresh = f.send({ type: 'console-refresh-rules', requestId: 41 })
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
    f.arrow.width = 32
    f.arrow.name = '!!'
    f.first.emit()
    const count = f.scans().length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    gate.resolve(Response.json({ ...context, revision: 8, namingMode: 'server' }))
    await refresh
    expect(f.preflight()).toMatchObject({ rulesRequestId: 41, appliedRules: { project: { revision: 8 }, rules: { namingMode: 'server' } } })
    expect(f.preflight().items![0]!.issues).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count + 1)
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight()).not.toHaveProperty('rulesRequestId')
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('waits for connection storage/context, but allows cached scans during the existing task poll', async () => {
    const f = await fixture()
    const storage = deferred<unknown>()
    f.host.clientStorage.getAsync.mockImplementationOnce(() => storage.promise)
    f.stored.set('iconctl-console-task', { deviceId: 'device', requestId: 'saved', expectedRevision: 6, jobId: 'running' })
    const poll = deferred<Response>()
    f.fetch.mockImplementation(async input => String(input).endsWith('/context') ? Response.json(context) : poll.promise)
    const tracking = f.send({ type: 'console-status' })
    await f.enable()
    f.first.emit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(1)
    storage.resolve(device)
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
    expect(f.preflight().appliedRules).toMatchObject({ project: { revision: 7 } })
    f.arrow.name = 'While running'
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items![0]!.name).toBe('While running')
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.host.clientStorage.setAsync).not.toHaveBeenCalled()
    poll.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await tracking
    expect(f.stored.has('iconctl-console-task')).toBe(false)
  })

  it('keeps failed refreshed rules blocked until an explicit successful refresh', async () => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 502 }))
    await f.send({ type: 'console-refresh-rules', requestId: 1 })
    f.first.emit()
    await vi.advanceTimersByTimeAsync(1000)
    const count = f.scans().length
    expect(f.state()).toMatchObject({ state: 'stale', enabled: true })
    expect(vi.getTimerCount()).toBe(0)
    await f.send({ type: 'rescan' })
    expect(f.scans()).toHaveLength(count)
    await f.send({ type: 'console-refresh-rules', requestId: 2 })
    expect(f.scans()).toHaveLength(count + 1)
    expect(f.state()).toMatchObject({ state: 'ready' })
  })

  it.each(['task-storage', 'saved-task-post'])('keeps a restored device without confirmed rules stale after %s fails', async (failure) => {
    const f = await fixture()
    const gate = deferred<void>()
    if (failure === 'task-storage') {
      f.host.clientStorage.getAsync.mockImplementation(async (key) => {
        if (key === 'iconctl-console-task') {
          await gate.promise
          throw new Error('Task storage is unavailable')
        }
        return f.stored.get(key)
      })
    }
    else {
      f.stored.set('iconctl-console-task', { deviceId: 'device', requestId: 'saved', expectedRevision: 6 })
      f.fetch.mockImplementationOnce(async () => {
        await gate.promise
        return new Response(null, { status: 400 })
      })
    }
    const startupScan = f.preflight().scanId!
    const restoring = f.send({ type: 'console-status' })
    await f.enable()
    await vi.waitFor(() => expect(f.host.clientStorage.getAsync).toHaveBeenCalledWith('iconctl-console-task'))
    gate.resolve()
    await restoring
    f.first.emit()
    await f.send({ type: 'rescan' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(1)
    expect(f.state()).toMatchObject({ enabled: true, state: 'stale' })
    expect(f.fetch.mock.calls.some(([input]) => String(input).endsWith('/context'))).toBe(false)
    await f.send({ type: 'export-report', scanId: startupScan, requestId: 1 })
    expect(f.messages.at(-1)).toMatchObject({ type: 'preflight-report', error: true })
    f.fetch.mockResolvedValueOnce(Response.json({ ...context, revision: 8 }))
    await f.send({ type: 'console-refresh-rules', requestId: 8 })
    expect(f.preflight()).toMatchObject({ rulesRequestId: 8, appliedRules: { rulesSource: 'project', project: { revision: 8 } } })
    await f.send({ type: 'export-report', scanId: f.preflight().scanId!, requestId: 2 })
    expect(JSON.parse(f.messages.at(-1)!.json!)).toMatchObject({ rulesSource: 'project', project: { revision: 8 } })
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.scans()).toHaveLength(3)
  })

  it('keeps unpaired default rules available when storage confirms there is no device', async () => {
    const f = await fixture()
    f.stored.delete('iconctl-console-device')
    const connecting = f.send({ type: 'console-status' })
    await f.enable()
    await connecting
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().appliedRules).toMatchObject({ rulesSource: 'unpaired-defaults' })
    expect(f.state()).toMatchObject({ enabled: true, state: 'ready' })
    f.arrow.name = 'Still local'
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.preflight().items![0]!.name).toBe('Still local')
    await f.send({ type: 'rescan' })
    expect(f.preflight().appliedRules).toMatchObject({ rulesSource: 'unpaired-defaults' })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('blocks manual and live scans during a newer context read while GitHub still uses legacy rules', async () => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    const gate = deferred<Response>()
    f.fetch.mockImplementationOnce(() => gate.promise)
    const connecting = f.send({ type: 'console-status' })
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
    const count = f.scans().length
    f.first.emit()
    await f.send({ type: 'rescan' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    await f.send({ type: 'rescan', mode: 'github' })
    expect(f.preflight().appliedRules).toMatchObject({ mode: 'github', rulesSource: 'legacy-defaults' })
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.scans()).toHaveLength(count + 2)
    await f.send({ type: 'rescan', mode: 'console' })
    gate.resolve(Response.json({ ...context, revision: 8 }))
    await connecting
    expect(f.preflight().appliedRules).toMatchObject({ mode: 'console', project: { revision: 8 } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a known revision conflict stale even when deleting its saved task fails', async () => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    f.stored.set('iconctl-console-task', { deviceId: 'device', requestId: 'saved', expectedRevision: 6 })
    const cleanup = deferred<void>()
    f.host.clientStorage.deleteAsync.mockImplementationOnce(async () => {
      await cleanup.promise
      throw new Error('Task storage is unavailable')
    })
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 409 }))
    const recovery = f.send({ type: 'console-status' })
    await vi.waitFor(() => expect(f.host.clientStorage.deleteAsync).toHaveBeenCalled())
    const count = f.scans().length
    f.first.emit()
    await vi.advanceTimersByTimeAsync(150)
    expect(f.scans()).toHaveLength(count)
    cleanup.resolve()
    await recovery
    f.first.emit()
    await f.send({ type: 'rescan' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    expect(f.state()).toMatchObject({ state: 'stale' })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    f.fetch.mockResolvedValueOnce(Response.json({ ...context, revision: 9 }))
    await f.send({ type: 'console-refresh-rules', requestId: 2 })
    expect(f.preflight().appliedRules).toMatchObject({ project: { revision: 9 } })
  })

  it.each(['missing', 'mismatched'])('cannot revive a previous project after a %s context response', async (kind) => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    const count = f.scans().length
    f.fetch.mockResolvedValueOnce(kind === 'missing' ? new Response(null, { status: 404 }) : Response.json({ ...context, projectId: 'other' }))
    await f.send({ type: 'console-status' })
    await f.enable()
    f.first.emit()
    await f.send({ type: 'rescan' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    expect(f.state()).toMatchObject({ state: 'stale' })
    await f.send({ type: 'console-refresh-rules', requestId: 10 })
    expect(f.scans()).toHaveLength(count + 1)
  })

  it('does not let an old request finishing release the new request gate', async () => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    const oldContext = deferred<Response>()
    f.fetch.mockImplementationOnce(() => oldContext.promise)
    const old = f.send({ type: 'console-status' })
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2))
    await f.send({ type: 'console-disconnect' })
    f.stored.set('iconctl-console-device', device)
    const newContext = deferred<Response>()
    f.fetch.mockImplementationOnce(() => newContext.promise)
    const current = f.send({ type: 'console-status' })
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3))
    await f.enable()
    oldContext.resolve(Response.json({ ...context, revision: 999 }))
    await old
    const count = f.scans().length
    f.first.emit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.scans()).toHaveLength(count)
    expect(f.state()).toMatchObject({ state: 'waiting' })
    newContext.resolve(Response.json({ ...context, revision: 10 }))
    await current
    expect(f.preflight().appliedRules).toMatchObject({ project: { revision: 10 } })
  })

  it.each(['console-disconnect', 'console-pair', 'revoke', 'close', 'pagehide'])('stops listeners immediately on %s and ignores delayed callbacks', async (reason) => {
    const f = await fixture()
    await f.send({ type: 'console-status' })
    await f.enable()
    const callback = [...f.first.listeners][0]!
    f.first.emit()
    const gate = deferred<void>()
    f.host.clientStorage.deleteAsync.mockImplementationOnce(() => gate.promise)
    let pending: Promise<void> | undefined
    if (reason === 'close') {
      f.handlers.get('close')!()
    }
    else if (reason === 'pagehide') {
      await f.enable(false)
    }
    else if (reason === 'revoke') {
      f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
      pending = f.send({ type: 'console-refresh-rules', requestId: 8 })
      await vi.waitFor(() => expect(f.first.listeners.size).toBe(0))
    }
    else {
      f.fetch.mockResolvedValueOnce(Response.json({ id: 'pair', code: 'CODE', pollToken: 'token', expiresAt: 0 }))
      pending = f.send({ type: reason })
    }
    expect(f.first.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    gate.resolve()
    await pending
    const count = f.messages.length
    callback({ nodeChanges: [{ type: 'CREATE' }] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.messages).toHaveLength(count)
  })

  it('does not loop on navigation or an empty event batch', async () => {
    const f = await fixture()
    await f.enable()
    const before = f.preflight()
    await f.send({ type: 'locate', scanId: before.scanId!, requestId: 1, nodeId: f.arrow.id })
    f.first.emit([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.first.selection).toEqual([f.arrow])
    expect(f.preflight()).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

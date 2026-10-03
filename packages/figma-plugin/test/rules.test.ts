import type { PreflightItem } from '../src/preflight'

interface Node {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  children?: Node[]
}
interface Message {
  type: string
  scanId?: number
  requestId?: number
  rulesRequestId?: number
  items?: PreflightItem[]
  json?: string
  error?: boolean
  rescan?: boolean
  reportAvailable?: boolean
  serverNamingPending?: boolean
  mode?: 'console' | 'github'
  outcome?: string
  text?: string
  paired?: boolean
  stale?: boolean
  appliedRules?: Record<string, unknown>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const arrow: Node = { id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 24, height: 24 }
  const invalid: Node = { ...arrow, id: '1:2', name: 'Wide', width: 48 }
  const draft: Node = { ...arrow, id: '1:3', name: '_draft' }
  const variant: Node = { ...arrow, id: '1:4', name: 'Filled' }
  const page: Node = { id: 'page:1', name: 'Icons', type: 'PAGE', children: [arrow, invalid, draft, { id: '1:5', name: 'Shape', type: 'COMPONENT_SET', children: [variant] }] }
  const otherPage: Node = { id: 'page:2', name: 'Other', type: 'PAGE', children: [] }
  const stored = new Map<string, unknown>([
    ['iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'device-secret-id', projectId: 'project', token: 'device-secret-token' }],
    ['iconctl-settings', { repo: 'owner/repo', token: 'github-secret-token', eventType: 'private-dispatch-name' }],
  ])
  const messages: Message[] = []
  const handlers = new Map<string, () => void>()
  const host = {
    currentPage: page,
    showUI: vi.fn(),
    getNodeByIdAsync: vi.fn(),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    clientStorage: {
      getAsync: vi.fn(async (key: string) => stored.get(key)),
      setAsync: vi.fn(async (key: string, value: unknown) => { stored.set(key, value) }),
      deleteAsync: vi.fn(async (key: string) => { stored.delete(key) }),
    },
    ui: { postMessage: (message: Message) => messages.push(message), onmessage: undefined as ((message: Message) => Promise<void>) | undefined },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  }
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ projectId: 'project', name: 'Brand', revision: 7, validate: {}, namingMode: 'default' }))
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  vi.stubGlobal('fetch', fetch)
  await import('../src/code')
  const send = (message: Message) => host.ui.onmessage!(message)
  const preflight = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const result = () => messages.filter(message => message.type === 'preflight-report').at(-1)!
  const request = async (scanId = preflight().scanId!, requestId = 1) => {
    await send({ type: 'export-report', scanId, requestId })
    return result()
  }
  return { host, page, otherPage, arrow, invalid, draft, variant, stored, fetch, messages, handlers, send, preflight, result, request }
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('project rule refresh through the actual Figma host', () => {
  it('publishes an explicit safe overview matching the exact report scan', async () => {
    const { fetch, send, preflight, request } = await fixture()
    fetch.mockResolvedValue(Response.json({ projectId: 'project', name: 'Brand', revision: 9, validate: { width: 16, name: '^brand-', skipPrefix: [], private: 'secret-rule' }, namingMode: 'server', token: 'secret-context' }))
    await send({ type: 'console-status' })
    const overview = preflight().appliedRules!
    const report = JSON.parse((await request()).json!)
    expect(overview).toEqual({ mode: 'console', rulesSource: 'project', project: { name: 'Brand', revision: 9 }, rules: { width: 16, name: '^brand-', skipPrefix: [], namingMode: 'server' }, serverValidationRequired: true })
    expect(report).toMatchObject({ ...overview, scanId: preflight().scanId })
    expect(JSON.stringify(overview)).not.toContain('secret')
    await send({ type: 'rescan', mode: 'github' })
    expect(preflight().appliedRules).toMatchObject({ mode: 'github', rulesSource: 'legacy-defaults', rules: { width: 24, height: 24 } })
    expect(preflight().appliedRules).not.toHaveProperty('project')
  })

  it.each([undefined, 'finished-job'])('reads only context while preserving durable task %s and task feedback', async (jobId) => {
    const { fetch, host, stored, send, messages, preflight, request } = await fixture()
    await send({ type: 'console-status' })
    stored.set('iconctl-console-task', { deviceId: 'device-secret-id', requestId: 'saved-request', expectedRevision: 7, ...(jobId ? { jobId } : {}) })
    const snapshot = JSON.stringify([...stored])
    host.clientStorage.getAsync.mockClear()
    host.clientStorage.setAsync.mockClear()
    host.clientStorage.deleteAsync.mockClear()
    fetch.mockClear()
    const gate = deferred<Response>()
    fetch.mockImplementationOnce(() => gate.promise)
    const oldScan = preflight().scanId
    const start = messages.length
    const refresh = send({ type: 'console-refresh-rules', requestId: 41 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(await request(oldScan)).toMatchObject({ error: true, rescan: true })
    await send({ type: 'console-refresh-rules', requestId: 42 })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'project-rules-status', requestId: 42, outcome: 'ignored' }))
    gate.resolve(Response.json({ projectId: 'project', name: 'Updated', revision: 8, validate: { width: 16 }, namingMode: 'default' }))
    await refresh
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/context')
    expect(host.clientStorage.getAsync.mock.calls).toEqual([['iconctl-console-device']])
    expect(host.clientStorage.setAsync).not.toHaveBeenCalled()
    expect(host.clientStorage.deleteAsync).not.toHaveBeenCalled()
    expect(JSON.stringify([...stored])).toBe(snapshot)
    expect(messages.slice(start).some(message => message.type === 'console-status')).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'project-rules-status', requestId: 41, outcome: 'success' }))
    expect(preflight()).toMatchObject({ rulesRequestId: 41, appliedRules: { project: { revision: 8 }, rules: { width: 16 } } })
    expect(JSON.parse((await request()).json!)).toMatchObject({ project: { revision: 8 }, rules: { width: 16 }, summary: { canSubmit: false } })
  })

  it.each([404, 502, 'network'])('keeps stale project rules unusable after %s until explicit successful refresh', async (failure) => {
    const { fetch, send, stored, messages, host, handlers, otherPage, preflight, request } = await fixture()
    await send({ type: 'console-status' })
    const snapshot = JSON.stringify([...stored])
    const scan = preflight().scanId
    if (failure === 'network') {
      fetch.mockRejectedValueOnce(new TypeError('offline'))
    }
    else {
      fetch.mockResolvedValueOnce(new Response(null, { status: Number(failure) }))
    }
    fetch.mockClear()
    await send({ type: 'console-refresh-rules', requestId: 1 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(messages).toContainEqual(expect.objectContaining({ type: 'project-rules-status', requestId: 1, outcome: 'error' }))
    expect(messages).toContainEqual({ type: 'project-rules-state', paired: true, stale: true })
    expect(JSON.stringify([...stored])).toBe(snapshot)
    await send({ type: 'rescan' })
    expect(await request(scan)).toMatchObject({ error: true })
    host.currentPage = otherPage
    handlers.get('currentpagechange')!()
    await send({ type: 'rescan' })
    expect(preflight().scanId).toBe(scan)
    await send({ type: 'rescan', mode: 'github' })
    const legacyScan = preflight().scanId
    expect(preflight().appliedRules).toMatchObject({ rulesSource: 'legacy-defaults' })
    await send({ type: 'rescan', mode: 'console' })
    await send({ type: 'console-sync' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(preflight().scanId).toBe(legacyScan)
    expect(await request(legacyScan)).toMatchObject({ error: true })
    fetch.mockResolvedValueOnce(Response.json({ projectId: 'project', name: 'Brand', revision: 10, validate: {}, namingMode: 'default' }))
    await send({ type: 'console-refresh-rules', requestId: 2 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(preflight().appliedRules).toMatchObject({ project: { revision: 10 }, rules: { skipPrefix: ['_', '.'] } })
    expect(preflight().appliedRules!['rules']).not.toHaveProperty('width')
    expect(JSON.parse((await request()).json!)).toMatchObject({ summary: { total: 0, canSubmit: false } })
  })

  it.each([401, 403])('clears revoked credentials for %s and leaves the failure in rule feedback', async (status) => {
    const { fetch, send, stored, messages } = await fixture()
    await send({ type: 'console-status' })
    stored.set('iconctl-console-task', { requestId: 'old-task' })
    const start = messages.length
    fetch.mockResolvedValueOnce(new Response(null, { status }))
    await send({ type: 'console-refresh-rules', requestId: 1 })
    expect(stored.has('iconctl-console-device')).toBe(false)
    expect(stored.has('iconctl-console-task')).toBe(false)
    expect(messages.slice(start).some(message => message.type === 'console-status')).toBe(false)
    expect(messages).toContainEqual({ type: 'project-rules-state', paired: false, stale: true })
    expect(messages.at(-1)).toMatchObject({ type: 'console-state', connected: false })
  })

  it('rejects refresh during task recovery without interrupting the existing tracker', async () => {
    const { fetch, send, stored, messages } = await fixture()
    stored.set('iconctl-console-task', { deviceId: 'device-secret-id', requestId: 'recover', expectedRevision: 7, jobId: 'running' })
    const gate = deferred<Response>()
    fetch.mockImplementationOnce(() => gate.promise)
    const tracking = send({ type: 'console-status' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await send({ type: 'console-refresh-rules', requestId: 4 })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'project-rules-status', requestId: 4, outcome: 'ignored' }))
    expect(fetch).toHaveBeenCalledOnce()
    await send({ type: 'rescan', mode: 'github' })
    fetch.mockResolvedValueOnce(Response.json({ status: 'succeeded', stage: 'complete' }))
    gate.resolve(Response.json({ projectId: 'project', name: 'Brand', revision: 7, validate: {}, namingMode: 'default' }))
    await tracking
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'console-status', url: 'https://iconctl.icebreaker.top/app/?job=running' }))
    expect(stored.has('iconctl-console-task')).toBe(false)
  })

  it.each(['github', 'disconnect', 'close'].flatMap(transition => [true, false].map(success => ({ transition, success }))))('ignores a refresh arriving after $transition (success=$success)', async ({ transition, success }) => {
    const { fetch, send, handlers, messages, preflight } = await fixture()
    await send({ type: 'console-status' })
    const gate = deferred<Response>()
    fetch.mockImplementationOnce(() => gate.promise)
    const refresh = send({ type: 'console-refresh-rules', requestId: 5 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    if (transition === 'close') {
      handlers.get('close')!()
    }
    else {
      await send(transition === 'github' ? { type: 'rescan', mode: 'github' } : { type: 'console-disconnect' })
    }
    const count = messages.length
    const current = preflight()
    gate.resolve(success ? Response.json({ projectId: 'project', name: 'Stale', revision: 99, validate: { width: 100 }, namingMode: 'server' }) : new Response(null, { status: 401 }))
    await refresh
    expect(messages).toHaveLength(count)
    expect(preflight()).toBe(current)
    if (transition === 'github') {
      await send({ type: 'rescan', mode: 'console' })
      expect(preflight()).toBe(current)
    }
  })

  it('does not clear a newly paired device when an old refresh reports revoked credentials', async () => {
    vi.useFakeTimers()
    const { fetch, send, stored, messages, preflight } = await fixture()
    await send({ type: 'console-status' })
    const gate = deferred<Response>()
    fetch.mockImplementationOnce(() => gate.promise)
    const old = send({ type: 'console-refresh-rules', requestId: 1 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/pair')) {
        return Response.json({ id: 'pair-new', code: 'ABCDEFGH', pollToken: 'poll', expiresAt: Date.now() + 300_000 })
      }
      if (url.endsWith('/pair/pair-new')) {
        return Response.json({ pending: false, deviceId: 'device-new', projectId: 'project', token: 'new-secret' })
      }
      return Response.json({ projectId: 'project', name: 'New project', revision: 20, validate: {}, namingMode: 'default' })
    })
    const pairing = send({ type: 'console-pair' })
    await vi.advanceTimersByTimeAsync(3000)
    await pairing
    const count = messages.length
    gate.resolve(new Response(null, { status: 401 }))
    await old
    expect(messages).toHaveLength(count)
    expect(stored.get('iconctl-console-device')).toMatchObject({ deviceId: 'device-new', token: 'new-secret' })
    expect(preflight().appliedRules).toMatchObject({ project: { name: 'New project', revision: 20 } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the current page when context arrives and can retry a scan failure explicitly', async () => {
    const { fetch, send, host, otherPage, handlers, preflight, request } = await fixture()
    await send({ type: 'console-status' })
    const gate = deferred<Response>()
    fetch.mockImplementationOnce(() => gate.promise)
    const refresh = send({ type: 'console-refresh-rules', requestId: 1 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    host.currentPage = otherPage
    handlers.get('currentpagechange')!()
    gate.resolve(Response.json({ projectId: 'project', name: 'Brand', revision: 8, validate: {}, namingMode: 'default' }))
    await refresh
    expect(JSON.parse((await request()).json!)).toMatchObject({ page: { id: otherPage.id }, project: { revision: 8 }, items: [] })
    const scan = preflight().scanId
    Object.defineProperty(otherPage, 'children', {
      configurable: true,
      get() {
        throw new Error('Page not ready')
      },
    })
    await send({ type: 'console-refresh-rules', requestId: 2 })
    await send({ type: 'rescan' })
    expect(await request(scan)).toMatchObject({ error: true })
    Object.defineProperty(otherPage, 'children', { configurable: true, value: [] })
    await send({ type: 'console-refresh-rules', requestId: 3 })
    expect(JSON.parse((await request()).json!).items).toEqual([])
  })
})

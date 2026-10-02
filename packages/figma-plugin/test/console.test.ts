import { DEVICE_KEY, PluginConsole, TASK_KEY } from '../src/console'
import { inspectComponents } from '../src/preflight'

const device = { origin: 'https://iconctl.icebreaker.top', deviceId: 'device', projectId: 'project', token: 'secret' }
const context = { projectId: 'project', name: 'brand', revision: 3, validate: { width: 16, height: 16, skipPrefix: ['draft-'] }, namingMode: 'default' }
const node = { id: '1:2', name: 'arrow', type: 'COMPONENT', width: 16, height: 16 }
const sessions: PluginConsole[] = []
function host(records = new Map<string, unknown>([[DEVICE_KEY, device]])) {
  const post = vi.fn()
  const storage = {
    getAsync: vi.fn(async (key: string) => records.get(key)),
    setAsync: vi.fn(async (key: string, value: unknown) => { records.set(key, structuredClone(value)) }),
    deleteAsync: vi.fn(async (key: string) => { records.delete(key) }),
  }
  const session = new PluginConsole({ storage, post, scan: rules => inspectComponents([node], rules) })
  sessions.push(session)
  return { session, post, records, storage }
}
function network(status = 'succeeded') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input).endsWith('/context')) {
      return Response.json(context)
    }
    if (options?.method === 'POST') {
      return Response.json({ id: 'job' })
    }
    return Response.json({ status, stage: status })
  })
}
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose())
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('loads project rules, persists intent before POST and removes it only after a terminal status', async () => {
  const fixture = host()
  const fetch = network()
  fetch.mockImplementation(async (input, options) => {
    if (String(input).endsWith('/context')) {
      return Response.json(context)
    }
    if (options?.method === 'POST') {
      const task = fixture.records.get(TASK_KEY) as {
        requestId: string
      }
      expect(task.requestId).toBeTruthy()
      expect(options.headers).toMatchObject({ 'Idempotency-Key': task.requestId })
      expect(JSON.parse(String(options.body))).toEqual({ expectedRevision: 3 })
      return Response.json({ id: 'job' })
    }
    return Response.json({ status: 'succeeded', stage: 'complete' })
  })
  await fixture.session.handle({ type: 'console-sync' })
  expect(fixture.records.has(TASK_KEY)).toBe(false)
  expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'preflight', items: [expect.objectContaining({ issues: [] })] }))
  expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ url: `${device.origin}/app/?job=job` }))
})
it('retries a lost submission response with the same durable request, including after reopening', async () => {
  vi.useFakeTimers()
  const fixture = host()
  const fetch = network()
  fetch.mockImplementation(async (input, options) => {
    if (String(input).endsWith('/context')) {
      return Response.json(context)
    }
    if (options?.method === 'POST') {
      throw new TypeError('response lost')
    }
    return Response.json({ status: 'succeeded', stage: 'complete' })
  })
  const first = fixture.session.handle({ type: 'console-sync' })
  await vi.waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1))
  const saved = structuredClone(fixture.records.get(TASK_KEY))
  fixture.session.dispose()
  await first
  fetch.mockImplementation(async (input, options) => {
    if (String(input).endsWith('/context')) {
      return Response.json({ ...context, revision: 4 })
    }
    return Response.json(options?.method === 'POST' ? { id: 'job' } : { status: 'succeeded', stage: 'complete' })
  })
  const reopened = host(fixture.records)
  await reopened.session.handle({ type: 'console-status' })
  const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[0]![1]?.headers).toEqual(posts[1]![1]?.headers)
  expect(posts[1]![1]?.body).toEqual(JSON.stringify({ expectedRevision: 3 }))
  expect(saved).toMatchObject({ expectedRevision: 3 })
  expect(fixture.records.has(TASK_KEY)).toBe(false)
})
it('coalesces clicks, recovers polling after a network error and tracks jobs beyond twenty minutes', async () => {
  vi.useFakeTimers()
  const fixture = host()
  let polls = 0
  const fetch = network()
  fetch.mockImplementation(async (input, options) => {
    if (String(input).endsWith('/context')) {
      return Response.json(context)
    }
    if (options?.method === 'POST') {
      return Response.json({ id: 'job' })
    }
    if (++polls === 1) {
      throw new TypeError('offline')
    }
    return Response.json({ status: polls > 242 ? 'succeeded' : 'running', stage: 'fetching' })
  })
  const run = fixture.session.handle({ type: 'console-sync' })
  await fixture.session.handle({ type: 'console-sync' })
  await vi.advanceTimersByTimeAsync(21 * 60000)
  await run
  expect(polls).toBe(243)
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(fixture.records.has(TASK_KEY)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('reopens an existing job without posting it again', async () => {
  const fixture = host(new Map<string, unknown>([[DEVICE_KEY, device], [TASK_KEY, { deviceId: device.deviceId, requestId: 'saved', expectedRevision: 1, jobId: 'job' }]]))
  const fetch = network()
  await fixture.session.handle({ type: 'console-status' })
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})
it('refreshes changed rules without automatically resubmitting', async () => {
  const fixture = host()
  const fetch = network()
  fetch.mockImplementation(async (_input, options) => Response.json(options?.method === 'POST' ? {} : context, { status: options?.method === 'POST' ? 409 : 200 }))
  await fixture.session.handle({ type: 'console-sync' })
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(fixture.records.has(TASK_KEY)).toBe(false)
  expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ error: true, text: expect.stringContaining('Review the refreshed preflight') }))
})
it('ignores a context response arriving after disconnect', async () => {
  const fixture = host()
  let reply!: (response: Response) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
    reply = resolve
  }))
  const connecting = fixture.session.handle({ type: 'console-status' })
  await vi.waitFor(() => expect(reply).toBeTypeOf('function'))
  await fixture.session.handle({ type: 'console-disconnect' })
  reply(Response.json(context))
  await connecting
  expect(fixture.records.has(DEVICE_KEY)).toBe(false)
  expect(fixture.post.mock.calls.at(-1)?.[0]).toMatchObject({ connected: false })
})
it('clears revoked credentials and stops polling', async () => {
  const fixture = host()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
  await fixture.session.handle({ type: 'console-status' })
  expect(fixture.records.has(DEVICE_KEY)).toBe(false)
  expect(fixture.post.mock.calls.at(-1)?.[0]).toMatchObject({ busy: false, connected: false })
})
it('reports older console context support instead of using legacy rules', async () => {
  const fixture = host()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
  await fixture.session.handle({ type: 'console-sync' })
  expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ error: true, text: expect.stringContaining('Update the console') }))
  expect(fixture.records.has(TASK_KEY)).toBe(false)
})

it('expires pairing and ignores an older pairing response after re-pairing', async () => {
  vi.useFakeTimers()
  const fixture = host()
  let pairCount = 0
  let oldReply: ((response: Response) => void) | undefined
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input)
    if (path.endsWith('/pair')) {
      return Response.json({ id: ++pairCount === 1 ? 'old' : 'new', code: 'ABCDEFGH', pollToken: 'poll', expiresAt: Date.now() + 300_000 })
    }
    if (path.endsWith('/pair/old')) {
      return new Promise<Response>((resolve) => {
        oldReply = resolve
      })
    }
    if (path.endsWith('/pair/new')) {
      return Response.json({ pending: false, deviceId: 'new-device', projectId: 'project', token: 'new-token' })
    }
    return Response.json(context)
  })
  const first = fixture.session.handle({ type: 'console-pair' })
  await vi.advanceTimersByTimeAsync(3000)
  expect(oldReply).toBeDefined()
  const second = fixture.session.handle({ type: 'console-pair' })
  await vi.advanceTimersByTimeAsync(3000)
  await second
  oldReply!(Response.json({ pending: false, deviceId: 'old-device', projectId: 'project', token: 'old-token' }))
  await first
  expect(fixture.records.get(DEVICE_KEY)).toMatchObject({ deviceId: 'new-device', token: 'new-token' })
  fetch.mockImplementation(async input => Response.json(String(input).endsWith('/pair')
    ? { id: 'expires', code: 'ABCDEFGH', pollToken: 'poll', expiresAt: Date.now() + 1000 }
    : { pending: true }))
  const expiring = fixture.session.handle({ type: 'console-pair' })
  await vi.advanceTimersByTimeAsync(3000)
  await expiring
  expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ text: 'Pairing expired. Request a new code.', error: true }))
})

it('serializes disconnect behind an in-flight intent write', async () => {
  const fixture = host()
  const fetch = network()
  let finishWrite: (() => void) | undefined
  fixture.storage.setAsync.mockImplementationOnce(async (key, value) => {
    await new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    fixture.records.set(key, value)
  })
  const submitting = fixture.session.handle({ type: 'console-sync' })
  await vi.waitFor(() => expect(finishWrite).toBeDefined())
  const disconnect = fixture.session.handle({ type: 'console-disconnect' })
  finishWrite!()
  await Promise.all([submitting, disconnect])
  expect(fixture.records.has(TASK_KEY)).toBe(false)
  expect(fixture.records.has(DEVICE_KEY)).toBe(false)
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})
it('runs the actual Figma host entry and scans with project rules', async () => {
  vi.resetModules()
  const fixture = host()
  const fakeFigma = { showUI: vi.fn(), ui: { postMessage: fixture.post, onmessage: async (_message: unknown) => { } }, clientStorage: fixture.storage, currentPage: { children: [node] }, on: vi.fn() }
  vi.stubGlobal('figma', fakeFigma)
  vi.stubGlobal('__html__', '<html></html>')
  network()
  try {
    await import('../src/code')
    await fakeFigma.ui.onmessage({ type: 'console-status' })
    expect(fakeFigma.showUI).toHaveBeenCalled()
    expect(fixture.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'preflight', items: [expect.objectContaining({ issues: [] })] }))
    await fakeFigma.ui.onmessage({ type: 'rescan', mode: 'github' })
    expect(fixture.post.mock.calls.at(-1)?.[0].items[0].issues).not.toEqual([])
  }
  finally {
    vi.unstubAllGlobals()
  }
})

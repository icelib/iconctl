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
  items?: PreflightItem[]
  json?: string
  html?: string
  format?: string
  error?: boolean
  rescan?: boolean
  reportAvailable?: boolean
  serverNamingPending?: boolean
  mode?: 'console' | 'github'
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
  const fetch = vi.fn(async () => Response.json({ projectId: 'project', name: 'Brand', revision: 7, validate: {}, namingMode: 'default' }))
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  vi.stubGlobal('fetch', fetch)
  await import('../src/code')
  const send = (message: Message) => host.ui.onmessage!(message)
  const preflight = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const result = () => messages.filter(message => message.type === 'preflight-report').at(-1)!
  const request = async (scanId = preflight().scanId!, requestId = 1, format?: string) => {
    await send({ type: 'export-report', scanId, requestId, ...(format ? { format } : {}) })
    return result()
  }
  return { host, page, otherPage, arrow, invalid, draft, variant, stored, fetch, messages, handlers, send, preflight, result, request }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('complete preflight reports through the actual Figma host', () => {
  it('exports the same captured scan as deterministic offline HTML through the actual host', async () => {
    const { page, arrow, preflight, request } = await fixture()
    const json = await request()
    const first = await request(undefined, 2, 'html')
    expect(first).toMatchObject({ type: 'preflight-report', format: 'html', scanId: preflight().scanId, requestId: 2 })
    expect(first.json).toBeUndefined()
    const data = JSON.parse(json.json!)
    expect(first.html).toContain(data.generatedAt)
    for (const item of data.items) {
      expect(first.html).toContain(item.id)
      expect(first.html).toContain(item.name)
    }
    expect(first.html).toContain('Skipped draft')
    expect(first.html).toContain('Needs fixes')
    expect(first.html).toContain('Passed local checks')
    expect(first.html).toContain('Canvas is 48×24, expected 24×24')
    page.name = 'Renamed after scan'
    arrow.name = 'Changed after scan'
    arrow.width = 96
    preflight().items![0]!.issues.push('Changed message after capture')
    expect((await request(undefined, 3, 'html')).html).toBe(first.html)
    expect((await request(undefined, 4, 'json')).json).toBe(json.json)
    expect(first.html).not.toMatch(/device-secret|github-secret|private-dispatch-name/)
  })

  it('rejects HTML from old scans, page changes, invalidation and close with the same report boundary', async () => {
    const { host, otherPage, handlers, messages, preflight, request, send } = await fixture()
    const old = preflight().scanId
    await send({ type: 'rescan' })
    expect(await request(old, 1, 'html')).toMatchObject({ format: 'html', error: true, rescan: true })
    expect((await request(undefined, 2, 'html')).html).toContain('Preflight report')
    host.currentPage = otherPage
    expect(await request(undefined, 3, 'html')).toMatchObject({ format: 'html', error: true, rescan: true })
    handlers.get('currentpagechange')!()
    expect((await request(undefined, 4, 'html')).html).toBeUndefined()
    handlers.get('close')!()
    const count = messages.length
    await request(undefined, 5, 'html')
    expect(messages).toHaveLength(count)
  })

  it('keeps project rules, provisional naming and unrestricted dimensions in HTML', async () => {
    const { fetch, send, request } = await fixture()
    fetch.mockResolvedValue(Response.json({ projectId: 'project', name: 'Brand', revision: 8, validate: {}, namingMode: 'server', token: 'context-secret' }))
    await send({ type: 'console-status' })
    const report = await request(undefined, 1, 'html')
    expect(report).toMatchObject({ format: 'html', serverNamingPending: true })
    expect(report.html).toContain('Brand')
    expect(report.html).toContain('Project revision</dt><dd>8')
    expect(report.html).toContain('Width</dt><dd>Unrestricted')
    expect(report.html).toContain('Height</dt><dd>Unrestricted')
    expect(report.html).toContain('Names are provisional until custom server naming runs.')
    expect(report.html).not.toContain('context-secret')
    await send({ type: 'console-disconnect' })
    expect(await request(report.scanId, 2, 'html')).toMatchObject({ error: true, rescan: true })
  })

  it('ignores unsupported report formats without changing the captured scan', async () => {
    const { request, messages } = await fixture()
    const initial = await request()
    const count = messages.length
    await request(undefined, 2, 'pdf')
    expect(messages).toHaveLength(count)
    expect((await request(undefined, 3)).json).toBe(initial.json)
  })

  it('captures all items, rules and the scan timestamp once, independently of later mutations', async () => {
    const { page, arrow, preflight, request } = await fixture()
    expect(preflight().reportAvailable).toBe(true)
    const first = await request()
    const report = JSON.parse(first.json!)
    expect(report).toMatchObject({
      schemaVersion: 1,
      scanId: preflight().scanId,
      scope: 'current-page',
      page: { id: 'page:1', name: 'Icons' },
      mode: 'console',
      rulesSource: 'unpaired-defaults',
      rules: { width: 24, height: 24, name: '^[a-z0-9]+(?:-[a-z0-9]+)*$', skipPrefix: ['_', '.'], namingMode: 'default' },
      serverValidationRequired: true,
      summary: { total: 4, checked: 3, skipped: 1, withIssues: 1, issueCount: 1, canSubmit: false },
      items: [
        { id: '1:1', name: 'Arrow', iconName: 'arrow', issues: [] },
        { id: '1:2', name: 'Wide', issues: ['Canvas is 48×24, expected 24×24'] },
        { id: '1:3', name: '_draft', skipped: true, iconName: null },
        { id: '1:4', name: 'Filled', iconName: 'shape-filled' },
      ],
    })
    expect(Number.isFinite(Date.parse(report.generatedAt))).toBe(true)
    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'items', 'mode', 'page', 'rules', 'rulesSource', 'scanId', 'schemaVersion', 'scope', 'serverValidationRequired', 'summary'].sort())
    for (const item of report.items) {
      expect(Object.keys(item).sort()).toEqual(['diagnostics', 'height', 'iconName', 'id', 'issues', 'name', 'skipped', 'width'])
      expect(item.diagnostics.map((diagnostic: { message: string }) => diagnostic.message)).toEqual(item.issues)
      for (const diagnostic of item.diagnostics) {
        expect(Object.keys(diagnostic).sort()).toEqual(['code', 'message'])
      }
    }
    page.name = 'Renamed after scan'
    arrow.name = 'Changed after scan'
    arrow.width = 96
    preflight().items![0]!.issues.push('Changed message after capture')
    expect((await request(undefined, 2)).json).toBe(first.json)
  })

  it('exports a successful empty scan while keeping submission ineligible', async () => {
    const { page, send, request } = await fixture()
    page.children = []
    await send({ type: 'rescan' })
    expect(JSON.parse((await request()).json!)).toMatchObject({ items: [], summary: { total: 0, checked: 0, skipped: 0, withIssues: 0, issueCount: 0, canSubmit: false } })
  })

  it('records project rules and provisional names without serializing connection, storage or arbitrary context fields', async () => {
    const { fetch, draft, send, request } = await fixture()
    draft.name = 'Draft-new'
    fetch.mockResolvedValue(Response.json({
      projectId: 'project',
      name: 'Brand',
      revision: 7,
      validate: { width: 16, name: '^project-', skipPrefix: ['Draft-'], secret: 'rule-secret' },
      namingMode: 'server',
      token: 'context-secret-token',
      device: { token: 'nested-secret' },
    }))
    await send({ type: 'load-settings' })
    await send({ type: 'console-status' })
    const message = await request()
    const report = JSON.parse(message.json!)
    expect(report).toMatchObject({
      mode: 'console',
      rulesSource: 'project',
      project: { name: 'Brand', revision: 7 },
      rules: { width: 16, name: '^project-', skipPrefix: ['Draft-'], namingMode: 'server' },
      items: [expect.any(Object), expect.any(Object), { skipped: true, name: 'Draft-new' }, expect.any(Object)],
    })
    expect(report.rules).not.toHaveProperty('height')
    expect(Object.keys(report.project).sort()).toEqual(['name', 'revision'])
    expect(Object.keys(report.rules).sort()).toEqual(['name', 'namingMode', 'skipPrefix', 'width'])
    expect(message.serverNamingPending).toBe(true)
    for (const secret of ['device-secret', 'github-secret', 'private-dispatch-name', 'context-secret', 'nested-secret', 'rule-secret']) {
      expect(message.json).not.toContain(secret)
    }
  })

  it('keeps omitted project dimensions unrestricted and identifies legacy GitHub rules separately', async () => {
    const { send, request } = await fixture()
    await send({ type: 'console-status' })
    const project = JSON.parse((await request()).json!)
    expect(project.rules).not.toHaveProperty('width')
    expect(project.rules).not.toHaveProperty('height')
    expect(project.summary.withIssues).toBe(0)
    await send({ type: 'rescan', mode: 'github' })
    const legacy = JSON.parse((await request()).json!)
    expect(legacy).toMatchObject({ mode: 'github', rulesSource: 'legacy-defaults', rules: { width: 24, height: 24 }, summary: { withIssues: 1 } })
    expect(legacy).not.toHaveProperty('project')
  })

  it('rejects stale scans after rescan and after a failed scan instead of exporting an old success', async () => {
    const { page, send, preflight, request } = await fixture()
    const firstId = preflight().scanId
    await send({ type: 'rescan' })
    expect(await request(firstId)).toMatchObject({ error: true, rescan: true })
    const currentId = preflight().scanId
    Object.defineProperty(page, 'children', {
      configurable: true,
      get() {
        throw new Error('scan secret')
      },
    })
    await send({ type: 'rescan' })
    expect(await request(currentId)).toMatchObject({ error: true, rescan: true })
    expect((await request(currentId)).json).toBeUndefined()
    Object.defineProperty(page, 'children', { value: [], configurable: true })
    await send({ type: 'rescan' })
    expect(JSON.parse((await request()).json!).items).toEqual([])
  })

  it('checks the current page even before its change event, and invalidates changing away and back', async () => {
    const { host, page, otherPage, handlers, request } = await fixture()
    host.currentPage = otherPage
    expect(await request()).toMatchObject({ error: true, rescan: true })
    handlers.get('currentpagechange')!()
    host.currentPage = page
    handlers.get('currentpagechange')!()
    expect(await request()).toMatchObject({ error: true, rescan: true })
  })

  it('invalidates project reports immediately when disconnect storage is still pending', async () => {
    const { host, send, request, preflight } = await fixture()
    await send({ type: 'console-status' })
    const projectScan = preflight().scanId
    const deletion = deferred<void>()
    host.clientStorage.deleteAsync.mockImplementationOnce(() => deletion.promise)
    const disconnect = send({ type: 'console-disconnect' })
    expect(await request(projectScan)).toMatchObject({ error: true, rescan: true })
    deletion.resolve()
    await disconnect
    expect(JSON.parse((await request()).json!)).toMatchObject({ rulesSource: 'unpaired-defaults' })
  })

  it('invalidates project reports after device revocation without discarding a legacy scan', async () => {
    const { fetch, send, request, preflight } = await fixture()
    await send({ type: 'console-status' })
    const projectScan = preflight().scanId
    fetch.mockImplementation(async () => new Response(null, { status: 401 }))
    await send({ type: 'console-status' })
    expect(await request(projectScan)).toMatchObject({ error: true, rescan: true })
    await send({ type: 'rescan', mode: 'github' })
    const legacy = await request()
    await send({ type: 'console-status' })
    expect((await request()).json).toBe(legacy.json)
  })

  it('captures only published scans when a console submission resumes after switching to GitHub', async () => {
    const { fetch, send, request } = await fixture()
    const context = deferred<Response>()
    fetch.mockImplementationOnce(() => context.promise)
    const submitting = send({ type: 'console-sync' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await send({ type: 'rescan', mode: 'github' })
    context.resolve(Response.json({ projectId: 'project', name: 'Brand', revision: 8, validate: { width: 16 }, namingMode: 'server' }))
    await submitting
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse((await request()).json!)).toMatchObject({ mode: 'github', rulesSource: 'legacy-defaults', rules: { width: 24, height: 24, namingMode: 'default' } })
  })

  it('does not revive project rules from a context response that arrives after disconnect', async () => {
    const { fetch, send, request } = await fixture()
    const context = deferred<Response>()
    fetch.mockImplementationOnce(() => context.promise)
    const connecting = send({ type: 'console-status' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await send({ type: 'console-disconnect' })
    const current = await request()
    context.resolve(Response.json({ projectId: 'project', name: 'Old project', revision: 99, validate: {}, namingMode: 'server' }))
    await connecting
    expect((await request()).json).toBe(current.json)
  })

  it('ignores malformed requests and does not post reports or late context results after close', async () => {
    const { fetch, send, request, messages, handlers } = await fixture()
    await send({ type: 'export-report' })
    expect(messages.some(message => message.type === 'preflight-report')).toBe(false)
    const context = deferred<Response>()
    fetch.mockImplementationOnce(() => context.promise)
    const connecting = send({ type: 'console-status' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    handlers.get('close')!()
    const count = messages.length
    context.resolve(Response.json({ projectId: 'project', name: 'Brand', revision: 7, validate: {}, namingMode: 'default' }))
    await connecting
    await request()
    expect(messages).toHaveLength(count)
  })
})

import type { PreflightInput, PreflightItem } from '../src/preflight'
import { canSubmit, inspectComponent, inspectComponents } from '../src/preflight'

function component(id: string, name: string, extra: Partial<PreflightInput> = {}): PreflightInput {
  return { id, name, type: 'COMPONENT', width: 24, height: 24, ...extra }
}
const pair = () => [component('1:1', 'Arrow Left'), component('1:2', 'arrow_left')]
const collisions = (item: PreflightItem) => item.issues.filter(issue => issue.startsWith('Duplicate icon name'))

describe('collection-level preflight name collisions', () => {
  it('diagnoses every component that converges on the same default name', () => {
    const items = inspectComponents(pair())
    expect(items.map(item => item.iconName)).toEqual(['arrow-left', 'arrow-left'])
    for (const item of items) {
      expect(collisions(item)).toEqual(['Duplicate icon name "arrow-left" on this page (2 components). Rename a component and rescan.'])
    }
    expect(canSubmit(items)).toBe(false)
  })

  it('retains order and other issues across multiple groups', () => {
    const inputs = [...pair(), component('1:3', 'arrow-left', { width: 48 }), component('2:1', 'user'), component('2:2', 'User'), component('3:1', 'unique')]
    const items = inspectComponents(inputs)
    expect(items.map(item => item.id)).toEqual(inputs.map(item => item.id))
    expect(items.slice(0, 3).every(item => collisions(item)[0]?.includes('(3 components)'))).toBe(true)
    expect(items.slice(3, 5).every(item => collisions(item)[0]?.includes('"user"'))).toBe(true)
    expect(items[2]!.issues).toHaveLength(2)
    expect(items[5]!.issues).toEqual([])
  })

  it('includes names derived from component sets', () => {
    const items = inspectComponents([component('1', 'Filled', { parentType: 'COMPONENT_SET', parentName: 'User' }), component('2', 'user-filled')])
    expect(items.every(item => collisions(item)[0]?.includes('"user-filled"'))).toBe(true)
  })

  it.each([undefined, ['_'], ['arrow_']])('excludes skipped drafts with prefixes %j', (skipPrefix) => {
    const items = inspectComponents([component('1', '_arrow-left'), component('2', 'arrow-left'), component('3', 'arrow_left')], skipPrefix === undefined ? undefined : { skipPrefix })
    const skipped = items.filter(item => item.skipped)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.issues).toEqual([])
    expect(items.filter(item => !item.skipped).every(item => collisions(item).length === 1)).toBe(true)
  })

  it('honors an explicit empty skip prefix list', () => {
    const items = inspectComponents([component('1', '_arrow-left'), component('2', 'arrow-left')], { skipPrefix: [] })
    expect(items.every(item => !item.skipped && collisions(item).length === 1)).toBe(true)
  })

  it('does not treat empty invalid names as a collision', () => {
    const items = inspectComponents([component('1', '箭头'), component('2', '用户'), component('3', ' ')])
    expect(items.map(item => collisions(item))).toEqual([[], [], []])
    expect(items[0]!.issues).toHaveLength(1)
    expect(items[1]!.issues).toHaveLength(1)
    expect(items[2]!.skipped).toBe(true)
  })

  it('counts distinct nodes rather than repeated host input', () => {
    const [first, second] = pair()
    expect(inspectComponents([first!, first!]).every(item => item.issues.length === 0)).toBe(true)
    expect(inspectComponents([first!, first!, second!]).every(item => collisions(item)[0]?.includes('(2 components)'))).toBe(true)
  })

  it('defers provisional names to the server hook while retaining dimension checks', () => {
    const items = inspectComponents(pair(), { namingMode: 'server', width: 16 })
    expect(items.every(item => collisions(item).length === 0 && item.issues.length === 1)).toBe(true)
    expect(canSubmit(inspectComponents(pair(), { namingMode: 'server' }))).toBe(true)
  })

  it('leaves per-component inspection and unique collection results unchanged', () => {
    const inputs = [component('1', 'constructor'), component('2', 'unique')]
    expect(inspectComponents(inputs)).toEqual(inputs.map(input => inspectComponent(input)))
    expect(inspectComponent(pair()[0]!).issues).toEqual([])
    expect(canSubmit(inspectComponents(inputs))).toBe(true)
    expect(canSubmit(inspectComponents([]))).toBe(false)
    expect(inspectComponents([component('1', 'constructor'), component('2', 'constructor')]).every(item => collisions(item).length === 1)).toBe(true)
  })

  it('does not mutate inputs or retain a conflict after a fresh scan', () => {
    const inputs = pair()
    const before = structuredClone(inputs)
    const first = inspectComponents(inputs)
    expect(inputs).toEqual(before)
    inputs[1]!.name = 'Arrow Right'
    const next = inspectComponents(inputs)
    expect(next.every(item => item.issues.length === 0)).toBe(true)
    expect(first.every(item => collisions(item).length === 1)).toBe(true)
  })
})

interface HostNode extends PreflightInput {
  children?: HostNode[]
  parent?: HostNode
  selection?: HostNode[]
}
interface Message {
  type: string
  scanId?: number
  requestId?: number
  nodeId?: string
  mode?: 'github' | 'console'
  items?: PreflightItem[]
  json?: string
  error?: boolean
  text?: string
  appliedRules?: Record<string, unknown>
}
async function hostFixture() {
  const nodes: HostNode[] = [...pair(), component('1:3', '_draft')]
  const page: HostNode = { ...component('page:1', 'Icons'), type: 'PAGE', children: nodes, selection: [] }
  for (const node of nodes) {
    node.parent = page
  }
  const messages: Message[] = []
  const handlers = new Map<string, () => void>()
  const stored = new Map<string, unknown>([['iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'device', projectId: 'project', token: 'secret-device-token' }]])
  const host = {
    currentPage: page,
    showUI: vi.fn(),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.find(node => node.id === id)),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    clientStorage: {
      getAsync: vi.fn(async (key: string) => stored.get(key)),
      setAsync: vi.fn(async (key: string, value: unknown) => { stored.set(key, value) }),
      deleteAsync: vi.fn(async (key: string) => { stored.delete(key) }),
    },
    ui: { postMessage: (message: Message) => messages.push(message), onmessage: undefined as ((message: Message) => Promise<void>) | undefined },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  }
  const context = { projectId: 'project', name: 'Brand', revision: 4, validate: {}, namingMode: 'default' }
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/context')) {
      return Response.json(context)
    }
    return Response.json(url.endsWith('/jobs') ? { id: 'job' } : { status: 'succeeded', stage: 'complete' })
  })
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  vi.stubGlobal('fetch', fetch)
  await import('../src/code')
  const send = (message: Message) => host.ui.onmessage!(message)
  const scan = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const report = async (scanId = scan().scanId!) => {
    await send({ type: 'export-report', scanId, requestId: 1 })
    return messages.filter(message => message.type === 'preflight-report').at(-1)!
  }
  return { nodes, page, host, handlers, stored, messages, context, fetch, send, scan, report }
}

describe('collision diagnostics through the actual Figma host', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('blocks a new console request before persisting a task and reports the same complete scan', async () => {
    const { send, scan, report, fetch, stored } = await hostFixture()
    await send({ type: 'console-sync' })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://iconctl.icebreaker.top/api/plugin/devices/device/context'])
    expect(stored.has('iconctl-console-task')).toBe(false)
    const result = JSON.parse((await report()).json!)
    expect(result).toMatchObject({ scope: 'current-page', ...scan().appliedRules, scanId: scan().scanId, summary: { total: 3, checked: 2, skipped: 1, withIssues: 2, issueCount: 2, canSubmit: false } })
    expect(result.items).toEqual(scan().items)
    expect(JSON.stringify(result)).not.toContain('secret-device-token')
  })

  it('keeps both colliding nodes locatable without renaming or dispatching', async () => {
    const { send, scan, nodes, host, page, fetch } = await hostFixture()
    for (const node of nodes.slice(0, 2)) {
      expect(collisions(scan().items!.find(item => item.id === node.id)!)).toHaveLength(1)
      await send({ type: 'locate', scanId: scan().scanId!, requestId: 1, nodeId: node.id })
      expect(page.selection).toEqual([node])
      expect(host.viewport.scrollAndZoomIntoView).toHaveBeenLastCalledWith([node])
    }
    expect(nodes.map(node => node.name)).toEqual(['Arrow Left', 'arrow_left', '_draft'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('recomputes collisions after rename and isolates page and mode changes', async () => {
    const { nodes, page, host, handlers, send, scan, report } = await hostFixture()
    const oldScan = scan().scanId
    nodes[1]!.name = 'Arrow Right'
    await send({ type: 'rescan', mode: 'github' })
    expect(canSubmit(scan().items!)).toBe(true)
    expect(await report(oldScan)).toMatchObject({ error: true })
    nodes[1]!.name = 'arrow_left'
    await send({ type: 'rescan', mode: 'console' })
    expect(canSubmit(scan().items!)).toBe(false)
    host.currentPage = { ...page, id: 'page:2', name: 'Other', children: [component('2:1', 'Arrow Left')] }
    handlers.get('currentpagechange')!()
    expect(await report()).toMatchObject({ error: true })
    await send({ type: 'rescan' })
    expect(canSubmit(scan().items!)).toBe(true)
    expect(JSON.parse((await report()).json!).page.id).toBe('page:2')
  })

  it('keeps custom server naming provisional and resumes saved tasks despite current local collisions', async () => {
    const { context, send, scan, report, stored, fetch } = await hostFixture()
    context.namingMode = 'server'
    await send({ type: 'console-status' })
    expect(canSubmit(scan().items!)).toBe(true)
    expect(JSON.parse((await report()).json!)).toMatchObject({ rules: { namingMode: 'server' }, serverValidationRequired: true })
    context.namingMode = 'default'
    stored.set('iconctl-console-task', { deviceId: 'device', requestId: 'original', expectedRevision: 4, jobId: 'saved-job' })
    fetch.mockClear()
    await send({ type: 'console-status' })
    expect(canSubmit(scan().items!)).toBe(false)
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://iconctl.icebreaker.top/api/plugin/devices/device/context', 'https://iconctl.icebreaker.top/api/plugin/devices/device/jobs/saved-job'])
    expect(stored.has('iconctl-console-task')).toBe(false)
  })
})

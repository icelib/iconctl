interface TestNode {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  removed?: boolean
  children?: TestNode[]
  parent?: TestNode | null
  selection?: TestNode[]
}

interface Message {
  type: string
  scanId?: number
  requestId?: number
  nodeId?: string
  items?: { id: string, skipped: boolean }[]
  error?: boolean
  text?: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function fixture() {
  const arrow: TestNode = { id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 48, height: 24 }
  const draft: TestNode = { ...arrow, id: '1:2', name: '_draft' }
  const variant: TestNode = { ...arrow, id: '1:3', name: 'Filled', width: 24 }
  const set: TestNode = { id: '1:4', name: 'user', type: 'COMPONENT_SET', children: [variant] }
  const page: TestNode = { id: 'page:1', name: 'Icons', type: 'PAGE', children: [arrow, draft, set], selection: [] }
  const otherPage: TestNode = { ...page, id: 'page:2', name: 'Other', children: [], selection: [] }
  const nodes = new Map<string, TestNode>()
  const add = (node: TestNode, parent: TestNode | null) => {
    node.parent = parent
    nodes.set(node.id, node)
    for (const child of node.children ?? []) {
      add(child, node)
    }
  }
  add(page, null)
  const messages: Message[] = []
  const handlers = new Map<string, () => void>()
  const host = {
    currentPage: page,
    showUI: vi.fn(),
    getNodeByIdAsync: vi.fn(async (id: string): Promise<TestNode | null> => nodes.get(id) ?? null),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    clientStorage: { getAsync: vi.fn(async () => undefined), setAsync: vi.fn(), deleteAsync: vi.fn() },
    ui: { postMessage: (message: Message) => messages.push(message), onmessage: undefined as ((message: Message) => Promise<void>) | undefined },
    on: (event: string, handler: () => void) => handlers.set(event, handler),
  }
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  await import('../src/code')
  const preflight = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const locate = (nodeId = arrow.id, requestId = 1, scanId = preflight().scanId!) => host.ui.onmessage!({ type: 'locate', nodeId, requestId, scanId })
  const result = () => messages.filter(message => message.type === 'navigation-result').at(-1)
  return { host, arrow, draft, variant, page, otherPage, messages, handlers, locate, result, preflight }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('Figma preflight navigation through the plugin host', () => {
  it('selects and frames a reported component and a nested variant without changing the scan', async () => {
    const { host, arrow, variant, page, locate, preflight, result } = await fixture()
    const before = preflight()
    await locate()
    expect(page.selection).toEqual([arrow])
    expect(host.viewport.scrollAndZoomIntoView).toHaveBeenLastCalledWith([arrow])
    expect(result()).toMatchObject({ type: 'navigation-result', error: false, text: 'Located Arrow', requestId: 1, scanId: before.scanId })
    await locate(variant.id, 2)
    expect(page.selection).toEqual([variant])
    expect(host.viewport.scrollAndZoomIntoView).toHaveBeenLastCalledWith([variant])
    expect(preflight()).toBe(before)
    expect(arrow.width).toBe(48)
  })

  it('refuses skipped, arbitrary and stale IDs before looking up a node', async () => {
    const { host, arrow, draft, locate, result, page, preflight } = await fixture()
    for (const id of [draft.id, 'outside:1']) {
      await locate(id)
      expect(result()).toMatchObject({ error: true, text: expect.stringContaining('current preflight') })
    }
    await locate(arrow.id, 2, preflight().scanId! - 1)
    expect(host.getNodeByIdAsync).not.toHaveBeenCalled()
    expect(page.selection).toEqual([])
  })

  it.each(['deleted', 'removed', 'replaced', 'moved'] as const)('rejects a %s component after lookup', async (kind) => {
    const { host, arrow, otherPage, locate, result, page } = await fixture()
    if (kind === 'deleted') {
      host.getNodeByIdAsync.mockResolvedValueOnce(null)
    }
    else if (kind === 'removed') {
      arrow.removed = true
    }
    else if (kind === 'replaced') {
      host.getNodeByIdAsync.mockResolvedValueOnce({ ...arrow, type: 'FRAME' })
    }
    else {
      arrow.parent = otherPage
    }
    await locate()
    expect(result()).toMatchObject({ error: true, text: expect.stringContaining('Rescan') })
    expect(page.selection).toEqual([])
    expect(host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
  })

  it('reports lookup failure and can locate again afterward', async () => {
    const { host, locate, result } = await fixture()
    host.getNodeByIdAsync.mockRejectedValueOnce(new Error('Node lookup failed'))
    await locate()
    expect(result()).toMatchObject({ error: true, text: 'Could not read this component. Rescan and try again.' })
    await locate(undefined, 2)
    expect(result()).toMatchObject({ error: false, requestId: 2 })
  })

  it('keeps only the newest asynchronous request', async () => {
    const { host, arrow, variant, page, locate, messages, result } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = locate(arrow.id, 1)
    await locate(variant.id, 2)
    first.resolve(arrow)
    await pending
    expect(page.selection).toEqual([variant])
    expect(host.viewport.scrollAndZoomIntoView).toHaveBeenCalledTimes(1)
    expect(messages.filter(message => message.type === 'navigation-result')).toHaveLength(1)
    expect(result()).toMatchObject({ requestId: 2 })
  })

  it('discards a pending lookup when a new preflight is scanned', async () => {
    const { host, arrow, locate, preflight, result } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const scan = preflight().scanId
    const pending = locate()
    await host.ui.onmessage!({ type: 'rescan' })
    expect(preflight().scanId).not.toBe(scan)
    first.resolve(arrow)
    await pending
    expect(host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    expect(result()).toBeUndefined()
    await locate(undefined, 2)
    expect(result()).toMatchObject({ error: false })
  })

  it('invalidates a pending lookup on page changes, including changing back', async () => {
    const { host, arrow, otherPage, page, handlers, messages, locate, result } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = locate()
    host.currentPage = otherPage
    handlers.get('currentpagechange')!()
    host.currentPage = page
    handlers.get('currentpagechange')!()
    first.resolve(arrow)
    await pending
    expect(host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    expect(result()).toBeUndefined()
    expect(messages.at(-1)).toMatchObject({ type: 'navigation-invalidated', text: expect.stringContaining('Page changed') })
    await host.ui.onmessage!({ type: 'rescan' })
    await locate(undefined, 2)
    expect(result()).toMatchObject({ error: false })
  })

  it('checks the current page again even if the page-change event has not arrived', async () => {
    const { host, arrow, otherPage, locate, result } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = locate()
    host.currentPage = otherPage
    first.resolve(arrow)
    await pending
    expect(result()).toMatchObject({ error: true, text: expect.stringContaining('Page changed') })
    expect(host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
  })

  it('does not select or report after the plugin closes', async () => {
    const { host, arrow, handlers, locate, result } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = locate()
    handlers.get('close')!()
    first.resolve(arrow)
    await pending
    await locate(undefined, 2)
    expect(result()).toBeUndefined()
    expect(host.getNodeByIdAsync).toHaveBeenCalledTimes(1)
    expect(host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
  })
})

import { PreflightView } from '../src/preflight-view'
import { selectionError } from '../src/visible-selection'

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
  nodeIds?: unknown
  mode?: 'console' | 'github'
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

async function fixture(extra = 0) {
  const arrow: TestNode = { id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 48, height: 24 }
  const draft: TestNode = { ...arrow, id: '1:2', name: '_draft' }
  const variant: TestNode = { ...arrow, id: '1:3', name: 'Filled', width: 24 }
  const set: TestNode = { id: '1:4', name: 'user', type: 'COMPONENT_SET', children: [variant] }
  const page: TestNode = { id: 'page:1', name: 'Icons', type: 'PAGE', children: [arrow, draft, set], selection: [] }
  const otherPage: TestNode = { ...page, id: 'page:2', name: 'Other', children: [], selection: [] }
  page.children!.push(...Array.from({ length: extra }, (_, index) => ({ ...arrow, id: `extra:${index}`, name: `Extra ${index}` })))
  let selected: TestNode[] = []
  const selectionWrite = vi.fn((nodes: TestNode[]) => {
    selected = nodes
  })
  Object.defineProperty(page, 'selection', { get: () => [...selected], set: nodes => selectionWrite(nodes), configurable: true })
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
    on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    off: vi.fn((event: string, handler: () => void) => {
      if (handlers.get(event) === handler) {
        handlers.delete(event)
      }
    }),
  }
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '<html></html>')
  await import('../src/code')
  const preflight = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const locate = (nodeId = arrow.id, requestId = 1, scanId = preflight().scanId!) => host.ui.onmessage!({ type: 'locate', nodeId, requestId, scanId })
  const result = () => messages.filter(message => message.type === 'navigation-result').at(-1)
  const select = (nodeIds: unknown = [arrow.id, variant.id], requestId = 1, scanId = preflight().scanId!) => host.ui.onmessage!({ type: 'select-visible', nodeIds, requestId, scanId })
  const selectionResult = () => messages.filter(message => message.type === 'selection-result').at(-1)
  return {
    host,
    arrow,
    draft,
    variant,
    page,
    otherPage,
    messages,
    handlers,
    locate,
    result,
    preflight,
    select,
    selectionResult,
    selectionWrite,
    nodes,
    manual: (nodes: TestNode[]) => {
      selected = nodes
    },
  }
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

  it('cancels a hidden pending lookup while keeping this scan available for another Locate', async () => {
    const { host, arrow, variant, locate, preflight, result, page } = await fixture()
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const scanId = preflight().scanId!
    const pending = locate()
    await host.ui.onmessage!({ type: 'cancel-navigation', scanId })
    first.resolve(arrow)
    await pending
    expect(page.selection).toEqual([])
    expect(result()).toBeUndefined()
    expect(preflight().scanId).toBe(scanId)
    await locate(variant.id, 2)
    expect(page.selection).toEqual([variant])
    expect(result()).toMatchObject({ error: false })
  })

  it('does not let an old scan cancellation stop a new scan lookup', async () => {
    const { host, arrow, locate, preflight, result, page } = await fixture()
    const oldScan = preflight().scanId!
    await host.ui.onmessage!({ type: 'rescan' })
    const first = deferred<TestNode | null>()
    host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = locate()
    await host.ui.onmessage!({ type: 'cancel-navigation', scanId: oldScan })
    first.resolve(arrow)
    await pending
    expect(page.selection).toEqual([arrow])
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

describe('visible component selection through the actual plugin host', () => {
  it('selects every requested non-draft once, including invalid icons and variants, without zooming or rescanning', async () => {
    const f = await fixture()
    const before = f.preflight()
    const view = new PreflightView()
    view.capture([
      { id: f.arrow.id, name: 'Arrow', iconName: null, skipped: false, width: 48, height: 24, issues: ['size'], diagnostics: [{ code: 'canvas-size', message: 'size' }] },
      { id: f.variant.id, name: 'Filled', iconName: 'user-filled', skipped: false, width: 24, height: 24, issues: [] },
      { id: f.draft.id, name: '_draft', iconName: null, skipped: true, width: 24, height: 24, issues: [] },
    ])
    const filtered = view.visible({ search: 'arrow', problemsOnly: true, issueType: 'canvas-size' }).map(item => item.id)
    expect(filtered).toEqual([f.arrow.id])
    await f.select(filtered)
    expect(f.selectionWrite).toHaveBeenCalledExactlyOnceWith([f.arrow])
    await f.select(view.visible({ search: '', problemsOnly: false, issueType: 'all' }).map(item => item.id), 2)
    expect(f.selectionWrite).toHaveBeenLastCalledWith([f.arrow, f.variant])
    expect(f.page.selection).toEqual([f.arrow, f.variant])
    expect(f.selectionResult()).toMatchObject({ scanId: before.scanId, requestId: 2, error: false, text: 'Selected 2 visible components. Canvas zoom is unchanged.' })
    expect(f.host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    expect(f.preflight()).toBe(before)
    expect(f.host.clientStorage.setAsync).not.toHaveBeenCalled()
    expect(f.handlers.has('selectionchange')).toBe(false)
    expect(f.arrow.width).toBe(48)
  })

  it.each([undefined, null, {}, '1:1', [], [''], [' '], [null], [1], Array.from({ length: 1 }), ['1:1', '1:1'], Array.from({ length: 501 }, (_, index) => `${index}:1`)])('refuses malformed or oversized input without reading nodes: %j', async (ids) => {
    const f = await fixture()
    expect(selectionError(ids)).toBeTypeOf('string')
    await f.host.ui.onmessage!({ type: 'select-visible', nodeIds: ids, requestId: 1, scanId: f.preflight().scanId! })
    expect(f.selectionResult()?.error).toBe(true)
    expect(f.host.getNodeByIdAsync).not.toHaveBeenCalled()
    expect(f.selectionWrite).not.toHaveBeenCalled()
    expect(f.handlers.has('selectionchange')).toBe(false)
  })

  it('rejects sparse, skipped, arbitrary, stale and invalid scan/request IDs; exactly 500 is accepted', async () => {
    const f = await fixture(498)
    expect(selectionError(Array.from({ length: 2 }))).toContain('missing')
    for (const ids of [[f.draft.id], ['outside:1']]) {
      await f.select(ids)
      expect(f.selectionResult()?.text).toContain('current preflight')
    }
    await f.select([f.arrow.id], 1, f.preflight().scanId! - 1)
    await f.select([f.arrow.id], Number.NaN)
    await f.select([f.arrow.id], 1, Number.NaN)
    expect(f.host.getNodeByIdAsync).not.toHaveBeenCalled()
    const ids = f.preflight().items!.filter(item => !item.skipped).map(item => item.id)
    expect(ids).toHaveLength(500)
    await f.select(ids, 2)
    expect(f.selectionWrite).toHaveBeenCalledTimes(1)
    expect(f.page.selection).toHaveLength(500)
  })

  it('captures IDs before the first await, reads serially and commits only after the final lookup', async () => {
    const f = await fixture()
    const first = deferred<TestNode | null>()
    const second = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const ids = [f.arrow.id, f.variant.id]
    const pending = f.select(ids)
    ids[1] = f.draft.id
    expect(f.host.getNodeByIdAsync).toHaveBeenCalledExactlyOnceWith(f.arrow.id)
    first.resolve(f.arrow)
    await vi.waitFor(() => expect(f.host.getNodeByIdAsync).toHaveBeenCalledTimes(2))
    expect(f.host.getNodeByIdAsync).toHaveBeenLastCalledWith(f.variant.id)
    expect(f.selectionWrite).not.toHaveBeenCalled()
    second.resolve(f.variant)
    await pending
    expect(f.selectionWrite).toHaveBeenCalledExactlyOnceWith([f.arrow, f.variant])
  })

  it.each(['throw', 'null', 'removed', 'type', 'id', 'page'] as const)('keeps the old selection when the second lookup fails: %s', async (failure) => {
    const f = await fixture(1)
    f.manual([f.draft])
    f.host.getNodeByIdAsync.mockResolvedValueOnce(f.arrow)
    if (failure === 'throw') {
      f.host.getNodeByIdAsync.mockRejectedValueOnce(new Error('failed'))
    }
    else {
      const found = failure === 'null'
        ? null
        : { ...f.variant, ...(failure === 'removed' ? { removed: true } : {}), ...(failure === 'type' ? { type: 'FRAME' } : {}), ...(failure === 'id' ? { id: 'other:1' } : {}), ...(failure === 'page' ? { parent: f.otherPage } : {}) }
      f.host.getNodeByIdAsync.mockResolvedValueOnce(found)
    }
    await f.select([f.arrow.id, f.variant.id, 'extra:0'])
    expect(f.selectionResult()?.error).toBe(true)
    expect(f.page.selection).toEqual([f.draft])
    expect(f.selectionWrite).not.toHaveBeenCalled()
    expect(f.host.getNodeByIdAsync).toHaveBeenCalledTimes(2)
    expect(f.handlers.has('selectionchange')).toBe(false)
    await f.select(undefined, 2)
    expect(f.selectionResult()).toMatchObject({ error: false, requestId: 2 })
  })

  it.each(['removed', 'moved', 'ancestor', 'type'] as const)('rechecks earlier nodes after the last await to reject %s changes', async (change) => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockResolvedValueOnce(f.arrow).mockReturnValueOnce(gate.promise)
    const pending = f.select()
    await vi.waitFor(() => expect(f.host.getNodeByIdAsync).toHaveBeenCalledTimes(2))
    if (change === 'removed') {
      f.arrow.removed = true
    }
    else if (change === 'moved') {
      f.arrow.parent = f.otherPage
    }
    else if (change === 'ancestor') {
      f.arrow.parent = f.variant
    }
    else {
      f.arrow.type = 'FRAME'
    }
    gate.resolve(f.variant)
    await pending
    expect(f.selectionResult()?.error).toBe(true)
    expect(f.selectionWrite).not.toHaveBeenCalled()
  })

  it.each(['locate', 'select'] as const)('shares request ownership with newer %s operations and ignores detached listener callbacks', async (newest) => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = newest === 'locate' ? f.select() : f.locate()
    const oldCallback = f.handlers.get('selectionchange')
    if (newest === 'locate') {
      await f.locate(f.variant.id, 2)
      expect(f.page.selection).toEqual([f.variant])
    }
    else {
      await f.select(undefined, 2)
      expect(f.page.selection).toEqual([f.arrow, f.variant])
    }
    oldCallback?.()
    gate.resolve(f.arrow)
    await pending
    expect(f.selectionWrite).toHaveBeenCalledTimes(1)
    expect(f.messages.filter(message => ['navigation-result', 'selection-result'].includes(message.type))).toHaveLength(1)
    expect((newest === 'locate' ? f.result() : f.selectionResult())?.requestId).toBe(2)
    expect(f.handlers.has('selectionchange')).toBe(false)
  })

  it('manual selection cancels immediately, keeps the scan valid and cannot let a queued old callback cancel a new run', async () => {
    const f = await fixture()
    const first = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(first.promise)
    const pending = f.select()
    const oldCallback = f.handlers.get('selectionchange')!
    f.manual([f.draft])
    oldCallback()
    expect(f.selectionResult()).toMatchObject({ error: true, text: 'Selection changed. Select this view again.' })
    expect(f.handlers.has('selectionchange')).toBe(false)
    const second = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(second.promise)
    const next = f.select([f.variant.id], 2)
    const newCallback = f.handlers.get('selectionchange')!
    oldCallback()
    expect(f.handlers.get('selectionchange')).toBe(newCallback)
    first.resolve(f.arrow)
    await pending
    second.resolve(f.variant)
    await next
    expect(f.selectionWrite).toHaveBeenCalledExactlyOnceWith([f.variant])
    expect(f.selectionResult()).toMatchObject({ error: false, requestId: 2 })
  })

  it('honors a delivered selection-change event even after the canvas selection returns to the original set', async () => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.manual([f.arrow])
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select()
    f.manual([f.variant])
    f.manual([f.arrow])
    f.handlers.get('selectionchange')!()
    gate.reject(new Error('late read failure'))
    await pending
    expect(f.selectionWrite).not.toHaveBeenCalled()
    expect(f.selectionResult()).toMatchObject({ error: true, text: 'Selection changed. Select this view again.' })
    expect(f.messages.filter(message => message.type === 'selection-result')).toHaveLength(1)
    expect(f.handlers.has('selectionchange')).toBe(false)
  })

  it('ignores a late lookup failure after newer single-node navigation has succeeded', async () => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select()
    await f.locate(f.variant.id, 2)
    gate.reject(new Error('late failure'))
    await pending
    expect(f.page.selection).toEqual([f.variant])
    expect(f.selectionResult()).toBeUndefined()
    expect(f.result()).toMatchObject({ error: false, requestId: 2 })
    expect(f.selectionWrite).toHaveBeenCalledTimes(1)
  })

  it('checks the original selection set when the manual change event has not arrived, ignoring order only', async () => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.manual([f.arrow, f.draft])
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select()
    f.manual([f.variant])
    gate.resolve(f.arrow)
    await pending
    expect(f.selectionResult()?.text).toContain('Selection changed')
    expect(f.selectionWrite).not.toHaveBeenCalled()
    const reordered = deferred<TestNode | null>()
    f.manual([f.arrow, f.draft])
    f.host.getNodeByIdAsync.mockReturnValueOnce(reordered.promise)
    const retry = f.select(undefined, 2)
    f.manual([f.draft, f.arrow])
    reordered.resolve(f.arrow)
    await retry
    expect(f.selectionResult()).toMatchObject({ error: false, requestId: 2 })
  })

  it.each(['rescan', 'mode', 'cancel', 'page-aba', 'close'] as const)('cancels pending selection and detaches its observer on %s', async (change) => {
    const f = await fixture()
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select()
    if (change === 'rescan' || change === 'mode') {
      await f.host.ui.onmessage!({ type: 'rescan', ...(change === 'mode' ? { mode: 'github' } : {}) })
    }
    else if (change === 'cancel') {
      await f.host.ui.onmessage!({ type: 'cancel-navigation', scanId: f.preflight().scanId! })
    }
    else if (change === 'page-aba') {
      f.host.currentPage = f.otherPage
      f.handlers.get('currentpagechange')!()
      f.host.currentPage = f.page
      f.handlers.get('currentpagechange')!()
    }
    else {
      f.handlers.get('close')!()
    }
    expect(f.handlers.has('selectionchange')).toBe(false)
    gate.resolve(f.arrow)
    await pending
    expect(f.selectionWrite).not.toHaveBeenCalled()
    expect(f.selectionResult()).toBeUndefined()
    expect(f.host.getNodeByIdAsync).toHaveBeenCalledTimes(1)
  })

  it('does not let an old-scan cancel stop a new selection, and checks a missed current-page event', async () => {
    const f = await fixture()
    const old = f.preflight().scanId!
    await f.host.ui.onmessage!({ type: 'rescan' })
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select()
    await f.host.ui.onmessage!({ type: 'cancel-navigation', scanId: old })
    gate.resolve(f.arrow)
    await pending
    expect(f.selectionResult()?.error).toBe(false)
    f.selectionWrite.mockClear()
    const later = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(later.promise)
    const missed = f.select(undefined, 2)
    f.host.currentPage = f.otherPage
    later.resolve(f.arrow)
    await missed
    expect(f.selectionResult()?.text).toContain('Page changed')
    expect(f.selectionWrite).not.toHaveBeenCalled()
  })

  it('rejects delayed old-scan and invalid navigation without cancelling a valid new-scan selection', async () => {
    const f = await fixture()
    const old = f.preflight().scanId!
    await f.host.ui.onmessage!({ type: 'rescan' })
    const gate = deferred<TestNode | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const pending = f.select(undefined, 10)
    const observer = f.handlers.get('selectionchange')
    await f.select([f.arrow.id], 1, old)
    await f.locate(f.arrow.id, 2, old)
    await f.select([f.draft.id], 3)
    await f.locate(f.draft.id, 4)
    await f.select([], 5)
    expect(f.handlers.get('selectionchange')).toBe(observer)
    expect(f.host.getNodeByIdAsync).toHaveBeenCalledTimes(1)
    gate.resolve(f.arrow)
    await pending
    expect(f.selectionResult()).toMatchObject({ error: false, requestId: 10 })
    expect(f.selectionWrite).toHaveBeenCalledExactlyOnceWith([f.arrow, f.variant])
  })

  it.each(['throw', 'partial', 'throw-after-write'] as const)('reports native %s failure with one attempt and no rollback claim', async (failure) => {
    const f = await fixture()
    f.selectionWrite.mockImplementation((nodes) => {
      expect(f.handlers.has('selectionchange')).toBe(false)
      if (failure !== 'throw') {
        f.manual([nodes[0]!])
      }
      if (failure !== 'partial') {
        throw new Error('native assignment failed')
      }
    })
    await f.select()
    expect(f.selectionWrite).toHaveBeenCalledTimes(1)
    expect(f.selectionResult()).toMatchObject({ error: true, text: 'Figma could not confirm the complete selection. Check the canvas selection before trying again.' })
    expect(f.host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
    expect(f.handlers.has('selectionchange')).toBe(false)
  })

  it('accepts a native selection with different ordering and no focus mutation', async () => {
    const f = await fixture()
    f.selectionWrite.mockImplementation(nodes => f.manual([...nodes].reverse()))
    await f.select()
    expect(f.selectionResult()?.error).toBe(false)
    expect(f.page.selection).toEqual([f.variant, f.arrow])
    expect(f.selectionWrite).toHaveBeenCalledTimes(1)
    expect(f.host.viewport.scrollAndZoomIntoView).not.toHaveBeenCalled()
  })
})

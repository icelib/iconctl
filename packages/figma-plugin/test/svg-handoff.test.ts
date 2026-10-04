import type { PreflightItem } from '../src/preflight'
import type { AppliedRules } from '../src/report'
import type { HandoffFile } from '../src/svg-handoff-format'
import { strFromU8, unzipSync } from 'fflate/browser'
import { HANDOFF_EXPORT_SETTINGS, SvgHandoff } from '../src/svg-handoff'
import { SvgHandoffUI } from '../src/svg-handoff-ui'
import { createHandoffZip } from '../src/svg-handoff-zip'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/><title>中文🙂</title></svg>'
interface Node {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  removed?: boolean
  parent?: Node
  children?: Node[]
  exportAsync?: ReturnType<typeof vi.fn<(_options: unknown) => Promise<string>>>
}
interface Message {
  type: string
  requestId?: number
  scanId?: number
  state?: string
  text?: string
  busy?: boolean
  enabled?: boolean
  mode?: 'console' | 'github'
  nodeId?: string
  items?: PreflightItem[]
  appliedRules?: AppliedRules
  files?: HandoffFile[]
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function makePage(id: string) {
  const listeners = new Set<(event: { nodeChanges: unknown[] }) => void>()
  return {
    id,
    name: id,
    type: 'PAGE',
    children: [] as Node[],
    listeners,
    on: vi.fn((_type: string, fn: (event: { nodeChanges: unknown[] }) => void) => {
      listeners.add(fn)
    }),
    off: vi.fn((_type: string, fn: (event: { nodeChanges: unknown[] }) => void) => {
      listeners.delete(fn)
    }),
    emit() {
      for (const fn of listeners) {
        fn({ nodeChanges: [{ type: 'PROPERTY_CHANGE', origin: 'REMOTE', properties: ['fills'] }] })
      }
    },
  }
}
const disposals: (() => void)[] = []
async function fixture() {
  const page = makePage('page:1')
  const other = makePage('page:2')
  const component = (id: string, name: string, parent: Node = page): Node => ({ id, name, type: 'COMPONENT', width: 24, height: 24, parent, exportAsync: vi.fn(async () => svg) })
  const arrow = component('1:1', 'Arrow')
  const group: Node = { id: '2:0', name: 'Actions', type: 'COMPONENT_SET', parent: page, children: [] }
  const variant = component('2:1', 'Filled', group)
  const draft = component('3:1', '_draft')
  group.children = [variant]
  page.children = [arrow, group, draft]
  const messages: Message[] = []
  const handlers = new Map<string, () => void>()
  const stored = new Map<string, unknown>()
  const context = { projectId: 'project', name: 'Project', revision: 1, validate: {}, namingMode: 'default' }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(context))
  let receive: ((message: Message) => void) | undefined
  const host = {
    currentPage: page,
    showUI: vi.fn(),
    getNodeByIdAsync: vi.fn(async (id: string): Promise<Node | null> => [arrow, variant, draft].find(node => node.id === id) ?? null),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    clientStorage: {
      getAsync: vi.fn(async (key: string) => stored.get(key)),
      setAsync: vi.fn(async (key: string, value: unknown) => {
        stored.set(key, value)
      }),
      deleteAsync: vi.fn(async (key: string) => {
        stored.delete(key)
      }),
    },
    ui: {
      onmessage: undefined as ((message: Message) => Promise<void>) | undefined,
      postMessage(message: Message) {
        messages.push(message)
        receive?.(message)
      },
    },
    on: (name: string, callback: () => void) => handlers.set(name, callback),
  }
  vi.stubGlobal('figma', host)
  vi.stubGlobal('__html__', '')
  vi.stubGlobal('fetch', fetch)
  await import('../src/code')
  disposals.push(() => handlers.get('close')!())
  const send = (message: Message) => host.ui.onmessage!(message)
  const status = () => messages.filter(message => message.type === 'svg-handoff-status').at(-1)!
  const preflight = () => messages.filter(message => message.type === 'preflight').at(-1)!
  const files = () => messages.filter(message => message.type === 'svg-handoff-files')
  const deliver = async (requestId = 1, scanId = preflight().scanId!) => {
    await send({ type: 'download-svg-handoff', requestId, scanId })
    return files().at(-1)!
  }
  const connect = async () => {
    stored.set('iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'device', projectId: 'project', token: 'secret' })
    await send({ type: 'console-status' })
  }
  return { page, other, arrow, variant, draft, group, host, context, fetch, stored, messages, handlers, send, status, preflight, files, deliver, connect, subscribe: (fn: (message: Message) => void) => {
    receive = fn
  } }
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SVG handoff through the actual Figma entry', () => {
  it('exports the complete page once with safe variant names and fixed native settings, without host browser globals', async () => {
    const f = await fixture()
    vi.stubGlobal('TextEncoder', undefined)
    vi.stubGlobal('TextDecoder', undefined)
    vi.stubGlobal('Buffer', undefined)
    const old = f.preflight().scanId
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.status()).toMatchObject({ state: 'ready', busy: true })
    expect(f.preflight().scanId).not.toBe(old)
    expect(f.page.listeners.size).toBe(1)
    expect(f.arrow.exportAsync).toHaveBeenCalledWith(HANDOFF_EXPORT_SETTINGS)
    expect(f.variant.exportAsync).toHaveBeenCalledWith(HANDOFF_EXPORT_SETTINGS)
    expect(f.draft.exportAsync).not.toHaveBeenCalled()
    expect(f.files()).toEqual([])
    const result = await f.deliver()
    expect(result.files!.map(file => file.path)).toEqual(['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg'])
    expect(result.files!.every(file => file.svg === svg && file.bytes === 119)).toBe(true)
    await f.deliver()
    expect(f.files()).toHaveLength(1)
    await f.send({ type: 'finish-svg-handoff', requestId: 1, scanId: result.scanId! - 1 })
    expect(f.page.listeners.size).toBe(1)
    await f.send({ type: 'finish-svg-handoff', requestId: 1, scanId: result.scanId! })
    expect(f.page.listeners.size).toBe(0)
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.arrow.exportAsync).toHaveBeenCalledOnce()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.host.clientStorage.getAsync).not.toHaveBeenCalled()
    expect(f.host.clientStorage.setAsync).not.toHaveBeenCalled()
  })

  it.each(['server', 'duplicate', 'empty', 'size', 'reserved', 'long'])('blocks %s preflight before native export', async (kind) => {
    const f = await fixture()
    if (kind === 'server') {
      f.context.namingMode = 'server'
      await f.connect()
    }
    else if (kind === 'duplicate') {
      f.group.type = 'FRAME'
      f.variant.name = 'Arrow'
    }
    else if (kind === 'empty') {
      f.page.children = []
    }
    else if (kind === 'size') {
      f.arrow.width = 48
    }
    else if (kind === 'reserved') {
      f.arrow.name = 'CON'
    }
    else {
      f.arrow.name = 'a'.repeat(229)
    }
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.status()).toMatchObject({ state: 'error', busy: false })
    expect(f.arrow.exportAsync).not.toHaveBeenCalled()
    expect(f.variant.exportAsync).not.toHaveBeenCalled()
    expect(f.page.listeners.size).toBe(0)
    expect(f.files()).toEqual([])
    if (kind === 'server') {
      expect(f.status().text).toContain('Custom names require a console sync')
    }
  })

  it.each(['lookup', 'native', 'unicode', 'empty', 'oversize'])('fails the whole package on %s failure without delivering partial files', async (kind) => {
    const f = await fixture()
    if (kind === 'lookup') {
      f.host.getNodeByIdAsync.mockResolvedValueOnce(null)
    }
    else if (kind === 'native') {
      f.arrow.exportAsync!.mockRejectedValueOnce(new Error('Figma export failed'))
    }
    else if (kind === 'unicode') {
      f.arrow.exportAsync!.mockResolvedValueOnce('<svg>\uD800</svg>')
    }
    else if (kind === 'empty') {
      f.arrow.exportAsync!.mockResolvedValueOnce('')
    }
    else { f.arrow.exportAsync!.mockResolvedValueOnce(`<svg>${'x'.repeat(1024 * 1024)}</svg>`) }
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.status()).toMatchObject({ state: 'error', busy: false, nodeId: expect.any(String) })
    expect(f.files()).toEqual([])
    expect(f.page.listeners.size).toBe(0)
    await f.send({ type: 'export-svg-handoff', requestId: 2 })
    expect(f.status().state).toBe('ready')
  })

  it.each(['edit', 'page', 'mode', 'rescan', 'rules', 'disconnect', 'close', 'cancel'])('discards an in-flight export after %s and rejects immediate retry until native settles', async (reason) => {
    const f = await fixture()
    await f.connect()
    const gate = deferred<string>()
    f.variant.exportAsync!.mockReturnValueOnce(gate.promise)
    const running = f.send({ type: 'export-svg-handoff', requestId: 1 })
    await vi.waitFor(() => expect(f.variant.exportAsync).toHaveBeenCalledOnce())
    const callback = [...f.page.listeners][0]!
    if (reason === 'edit') {
      f.page.emit()
    }
    else if (reason === 'page') {
      f.host.currentPage = f.other
      f.handlers.get('currentpagechange')!()
      f.host.currentPage = f.page
      f.handlers.get('currentpagechange')!()
    }
    else if (reason === 'mode') {
      await f.send({ type: 'rescan', mode: 'github' })
    }
    else if (reason === 'rescan') {
      await f.send({ type: 'rescan' })
    }
    else if (reason === 'rules') {
      await f.send({ type: 'console-refresh-rules', requestId: 99 })
    }
    else if (reason === 'disconnect') {
      await f.send({ type: 'console-disconnect' })
    }
    else if (reason === 'close') {
      f.handlers.get('close')!()
    }
    else {
      await f.send({ type: 'cancel-svg-handoff', requestId: 1 })
    }
    expect(f.page.listeners.size).toBe(0)
    await f.send({ type: 'export-svg-handoff', requestId: 2 })
    expect(f.variant.exportAsync).toHaveBeenCalledOnce()
    gate.resolve(svg)
    await running
    const count = f.messages.length
    callback({ nodeChanges: [{}] })
    expect(f.messages).toHaveLength(count)
    expect(f.files()).toEqual([])
    expect(f.arrow.exportAsync).not.toHaveBeenCalled()
    if (reason !== 'close') {
      expect(f.status()).toMatchObject({ requestId: 1, state: 'cancelled', busy: false })
      f.host.currentPage = f.page
      await f.send({ type: 'rescan' })
      await f.send({ type: 'export-svg-handoff', requestId: 3 })
      expect(f.status().state).toBe('ready')
    }
  })

  it('rejects delayed delivery after edits and never removes the live listener it does not own', async () => {
    const f = await fixture()
    await f.send({ type: 'set-live-preflight', enabled: true, requestId: 1 })
    const live = [...f.page.listeners][0]!
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.page.listeners.size).toBe(2)
    const scanId = f.preflight().scanId!
    f.page.emit()
    expect(f.page.listeners.size).toBe(1)
    expect(f.page.listeners.has(live)).toBe(true)
    await f.deliver(1, scanId)
    expect(f.files()).toEqual([])
  })

  it('rechecks node and whole-page membership even before a page event is delivered', async () => {
    const f = await fixture()
    const gate = deferred<string>()
    f.variant.exportAsync!.mockReturnValueOnce(gate.promise)
    const running = f.send({ type: 'export-svg-handoff', requestId: 1 })
    await vi.waitFor(() => expect(f.variant.exportAsync).toHaveBeenCalledOnce())
    f.arrow.name = 'Edited elsewhere'
    gate.resolve(svg)
    await running
    expect(f.files()).toEqual([])
    expect(f.page.listeners.size).toBe(0)
    expect(f.status().state).toBe('cancelled')
  })

  it('waits for a cancelled lookup, stops before native export, and permits a fresh request after settlement', async () => {
    const f = await fixture()
    const gate = deferred<Node | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const running = f.send({ type: 'export-svg-handoff', requestId: 1 })
    await vi.waitFor(() => expect(f.host.getNodeByIdAsync).toHaveBeenCalledOnce())
    await f.send({ type: 'cancel-svg-handoff', requestId: 1 })
    expect(f.status()).toMatchObject({ state: 'cancelling', busy: true })
    await f.send({ type: 'export-svg-handoff', requestId: 2 })
    expect(f.host.getNodeByIdAsync).toHaveBeenCalledOnce()
    gate.resolve(f.variant)
    await running
    expect(f.variant.exportAsync).not.toHaveBeenCalled()
    expect(f.status()).toMatchObject({ requestId: 1, state: 'cancelled', busy: false })
    await f.send({ type: 'export-svg-handoff', requestId: 3 })
    expect(f.status().state).toBe('ready')
  })

  it.each(['deleted', 'moved', 'type'])('rejects a %s component returned by a pending lookup', async (reason) => {
    const f = await fixture()
    const gate = deferred<Node | null>()
    f.host.getNodeByIdAsync.mockReturnValueOnce(gate.promise)
    const running = f.send({ type: 'export-svg-handoff', requestId: 1 })
    await vi.waitFor(() => expect(f.host.getNodeByIdAsync).toHaveBeenCalledOnce())
    if (reason === 'deleted') {
      f.variant.removed = true
    }
    else if (reason === 'moved') {
      f.variant.parent = f.other
    }
    else {
      f.variant.type = 'FRAME'
    }
    gate.resolve(f.variant)
    await running
    expect(f.status()).toMatchObject({ state: 'error', busy: false, nodeId: '2:1' })
    expect(f.variant.exportAsync).not.toHaveBeenCalled()
    expect(f.page.listeners.size).toBe(0)
    expect(f.files()).toEqual([])
  })

  it.each(['ready', 'delivery'])('rechecks complete page membership at %s before any download', async (phase) => {
    const f = await fixture()
    const gate = deferred<string>()
    if (phase === 'ready') {
      f.arrow.exportAsync!.mockReturnValueOnce(gate.promise)
    }
    const running = f.send({ type: 'export-svg-handoff', requestId: 1 })
    if (phase === 'ready') {
      await vi.waitFor(() => expect(f.arrow.exportAsync).toHaveBeenCalledOnce())
    }
    else {
      await running
    }
    f.page.children = f.page.children.filter(node => node.id !== f.draft.id)
    gate.resolve(svg)
    await running
    await f.deliver()
    expect(f.files()).toEqual([])
    expect(f.status().state).toBe('cancelled')
    expect(f.page.listeners.size).toBe(0)
  })

  it('keeps a new delivery owned when an older acknowledgement or cancellation is replayed', async () => {
    const f = await fixture()
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    const first = await f.deliver()
    await f.send({ type: 'finish-svg-handoff', requestId: 1, scanId: first.scanId! })
    await f.send({ type: 'export-svg-handoff', requestId: 2 })
    const second = await f.deliver(2)
    await f.send({ type: 'finish-svg-handoff', requestId: 1, scanId: first.scanId! })
    await f.send({ type: 'cancel-svg-handoff', requestId: 1 })
    await f.send({ type: 'finish-svg-handoff', requestId: 2, scanId: first.scanId! })
    expect(f.page.listeners.size).toBe(1)
    await f.send({ type: 'finish-svg-handoff', requestId: 2, scanId: second.scanId! })
    expect(f.page.listeners.size).toBe(0)
  })

  it('supports loaded project dimensions without changing console feedback or using network/storage', async () => {
    const f = await fixture()
    f.context.validate = { width: 32, height: 16 }
    f.arrow.width = f.variant.width = 32
    f.arrow.height = f.variant.height = 16
    await f.connect()
    const network = f.fetch.mock.calls.length
    const storage = f.host.clientStorage.setAsync.mock.calls.length
    const workflow = f.messages.filter(message => message.type.startsWith('console-'))
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.status().state).toBe('ready')
    expect(f.fetch).toHaveBeenCalledTimes(network)
    expect(f.host.clientStorage.setAsync).toHaveBeenCalledTimes(storage)
    expect(f.messages.filter(message => message.type.startsWith('console-'))).toEqual(workflow)
  })

  it('exports while an existing console poll is pending and lets that same task finish', async () => {
    const f = await fixture()
    await f.connect()
    const poll = deferred<Response>()
    f.fetch.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/context')) {
        return Response.json(f.context)
      }
      return options?.method === 'POST' ? Response.json({ id: 'job-existing' }) : poll.promise
    })
    const task = f.send({ type: 'console-sync' })
    await vi.waitFor(() => expect(f.messages.some(message => message.type === 'console-status' && message.busy === true)).toBe(true))
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([input]) => String(input).includes('job-existing'))).toBe(true))
    const network = f.fetch.mock.calls.length
    const storage = f.host.clientStorage.setAsync.mock.calls.length
    const workflow = f.messages.filter(message => message.type.startsWith('console-'))
    const intent = structuredClone(f.stored.get('iconctl-console-task'))
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    const files = await f.deliver()
    await f.send({ type: 'finish-svg-handoff', requestId: 1, scanId: files.scanId! })
    expect(f.status().state).toBe('ready')
    expect(f.fetch).toHaveBeenCalledTimes(network)
    expect(f.host.clientStorage.setAsync).toHaveBeenCalledTimes(storage)
    expect(f.messages.filter(message => message.type.startsWith('console-'))).toEqual(workflow)
    expect(f.stored.get('iconctl-console-task')).toEqual(intent)
    poll.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await task
    expect(f.stored.has('iconctl-console-task')).toBe(false)
    expect(f.messages.filter(message => message.type === 'console-status').at(-1)).toMatchObject({ text: 'succeeded · complete' })
    expect(f.messages.filter(message => message.type === 'console-state').at(-1)).toMatchObject({ busy: false })
  })

  it('keeps restored devices without confirmed rules unavailable and exports only after explicit recovery', async () => {
    const f = await fixture()
    f.host.clientStorage.getAsync.mockImplementation(async key => key === 'iconctl-console-task' ? Promise.reject(new Error('storage')) : f.stored.get(key))
    await f.connect()
    await f.send({ type: 'export-svg-handoff', requestId: 1 })
    expect(f.status()).toMatchObject({ state: 'error' })
    expect(f.variant.exportAsync).not.toHaveBeenCalled()
    await f.send({ type: 'console-refresh-rules', requestId: 99 })
    await f.send({ type: 'export-svg-handoff', requestId: 2 })
    expect(f.status().state).toBe('ready')
  })
})

function element() {
  const handlers = new Map<string, () => void>()
  return { disabled: false, textContent: '', className: '', addEventListener: (event: string, callback: () => void) => handlers.set(event, callback), click: () => handlers.get('click')?.() }
}

function connectUi(f: Awaited<ReturnType<typeof fixture>>) {
  const button = element()
  const cancel = element()
  const help = element()
  const status = element()
  const blobs: Blob[] = []
  const anchorClick = vi.fn()
  const remove = vi.fn()
  vi.stubGlobal('document', { createElement: () => ({ click: anchorClick, remove }), body: { appendChild: vi.fn() } })
  const parse = vi.fn(() => ({ querySelector: () => null as unknown, documentElement: { localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg' } }))
  vi.stubGlobal('DOMParser', class {
    parseFromString() {
      return parse()
    }
  })
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const urls = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return `blob:handoff-${blobs.length}`
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let current = true
  const operations: Promise<void>[] = []
  const outgoing: Record<string, unknown>[] = []
  const ui = new SvgHandoffUI({
    current: () => ({ active: true, current, scanId: f.preflight().scanId, items: f.preflight().items!, rules: f.preflight().appliedRules }),
    send(message) {
      outgoing.push(message)
      operations.push(f.send(message as unknown as Message))
    },
    button: button as unknown as HTMLButtonElement,
    cancel: cancel as unknown as HTMLButtonElement,
    help: help as unknown as HTMLElement,
    status: status as unknown as HTMLElement,
  })
  disposals.push(() => ui.dispose())
  let transform = (message: Message) => message
  f.subscribe((message) => {
    if (message.type === 'navigation-invalidated') {
      current = false
    }
    if (message.type === 'preflight') {
      current = true
    }
    ui.update()
    ui.receive(transform(message))
  })
  return { button, cancel, status, ui, blobs, anchorClick, remove, urls, revoke, parse, operations, outgoing, transform: (fn: typeof transform) => {
    transform = fn
  } }
}

it.each(['encoding', 'xml', 'zip', 'blob', 'url', 'anchor'])('releases host ownership on a UI %s failure, retries, and consumes delivery only once', async (failure) => {
  vi.useFakeTimers()
  const f = await fixture()
  const u = connectUi(f)
  if (failure === 'encoding') {
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => {
      throw new Error('Encoding failed')
    })
  }
  else if (failure === 'xml') {
    u.parse.mockReturnValueOnce({ querySelector: () => ({}), documentElement: { localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg' } })
  }
  else if (failure === 'zip') {
    u.transform(message => message.type === 'svg-handoff-files' && message.requestId === 1
      ? { ...message, files: message.files!.map(file => ({ ...file, bytes: file.bytes + 1 })) }
      : message)
  }
  else if (failure === 'blob') {
    const NativeBlob = Blob
    let first = true
    vi.stubGlobal('Blob', class extends NativeBlob {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        if (first) {
          first = false
          throw new Error('Blob allocation failed')
        }
        super(parts, options)
      }
    })
  }
  else if (failure === 'url') {
    u.urls.mockImplementationOnce(() => {
      throw new Error('Object URL failed')
    })
  }
  else {
    u.anchorClick.mockImplementationOnce(() => {
      throw new Error('Download click failed')
    })
  }
  u.button.click()
  await vi.waitFor(() => expect(u.status.className).toBe('err'))
  await Promise.all(u.operations)
  expect(f.page.listeners.size).toBe(0)
  expect(u.button.disabled).toBe(false)
  expect(u.outgoing.filter(message => message['type'] === 'finish-svg-handoff')).toHaveLength(1)
  u.button.click()
  await vi.waitFor(() => expect(u.status.textContent).toContain('Download started for 2 raw SVGs'))
  await Promise.all(u.operations)
  expect(f.page.listeners.size).toBe(0)
  expect(u.anchorClick).toHaveBeenCalledTimes(failure === 'anchor' ? 2 : 1)
  u.ui.receive(f.files().at(-1)!)
  expect(u.anchorClick).toHaveBeenCalledTimes(failure === 'anchor' ? 2 : 1)
  const blob = u.blobs.at(-1)!
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  expect(Object.keys(archive)).toEqual(['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg'])
  expect(strFromU8(archive['raw-svg/arrow.svg']!)).toBe(svg)
  await vi.runOnlyPendingTimersAsync()
  expect(u.revoke).toHaveBeenCalledTimes(u.blobs.length)
  expect(u.remove).toHaveBeenCalledTimes(failure === 'anchor' ? 2 : 1)
  expect(createHandoffZip(f.files().at(-1)!.files!)).toEqual(new Uint8Array(await blob.arrayBuffer()))
})

it('keeps the UI disabled after Cancel until the pending native operation settles', async () => {
  const f = await fixture()
  const u = connectUi(f)
  const gate = deferred<string>()
  f.variant.exportAsync!.mockReturnValueOnce(gate.promise)
  u.button.click()
  await vi.waitFor(() => expect(f.variant.exportAsync).toHaveBeenCalledOnce())
  u.cancel.click()
  expect(u.button.disabled).toBe(true)
  expect(u.cancel.disabled).toBe(true)
  expect(u.status.textContent).toContain('Waiting for the current Figma operation')
  u.button.click()
  expect(u.outgoing.filter(message => message['type'] === 'export-svg-handoff')).toHaveLength(1)
  gate.resolve(svg)
  await Promise.all(u.operations)
  expect(u.button.disabled).toBe(false)
  expect(u.blobs).toHaveLength(0)
  u.button.click()
  await vi.waitFor(() => expect(u.status.textContent).toContain('Download started for 2 raw SVGs'))
  expect(u.anchorClick).toHaveBeenCalledOnce()
})

it('cancels ready UI ownership on disposal and ignores a delayed files message', async () => {
  const f = await fixture()
  const u = connectUi(f)
  let delayed: Message | undefined
  u.transform((message) => {
    if (message.type === 'svg-handoff-files') {
      delayed = message
      return { type: 'ignored' }
    }
    return message
  })
  u.button.click()
  await vi.waitFor(() => expect(delayed).toBeDefined())
  expect(f.page.listeners.size).toBe(1)
  u.ui.dispose()
  await Promise.all(u.operations)
  expect(f.page.listeners.size).toBe(0)
  u.ui.receive(delayed!)
  expect(u.anchorClick).not.toHaveBeenCalled()
  expect(u.blobs).toHaveLength(0)
})

it('validates each captured scan once instead of sorting the full page on every progress event', async () => {
  const f = await fixture()
  let filters = 0
  const original = Array.from({ length: 5000 }, (_, index) => ({ ...f.preflight().items![0]!, id: `1:${index}`, iconName: `icon-${index}` }))
  const items = new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'filter') {
        filters++
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const button = element()
  let scanId = 1
  const ui = new SvgHandoffUI({
    current: () => ({ active: true, current: true, scanId, items, rules: f.preflight().appliedRules }),
    send: vi.fn(),
    button: button as unknown as HTMLButtonElement,
    cancel: element() as unknown as HTMLButtonElement,
    help: element() as unknown as HTMLElement,
    status: element() as unknown as HTMLElement,
  })
  disposals.push(() => ui.dispose())
  button.click()
  const checked = filters
  expect(checked).toBeGreaterThan(0)
  for (let index = 0; index < 5000; index++) {
    ui.receive({ type: 'svg-handoff-status', requestId: 1, state: 'exporting', busy: true })
  }
  expect(filters).toBe(checked)
  scanId++
  ui.update()
  expect(filters).toBe(checked * 2)
})

it('checks whole-page membership only at capture, ready and delivery for the maximum page size', async () => {
  const f = await fixture()
  const items = Array.from({ length: 5000 }, (_, index) => ({ ...f.preflight().items![0]!, id: `1:${index}`, name: `Icon ${index}`, iconName: `icon-${index}` }))
  const nodes = new Map(items.map(item => [item.id, { ...f.arrow, id: item.id, name: item.name }]))
  const inspect = vi.fn(() => items)
  const scan = vi.fn(() => ({ items, metadata: { mode: 'github' as const, rulesSource: 'legacy-defaults' as const }, scanId: 1 }))
  const host = new SvgHandoff({
    currentPage: () => f.page as unknown as PageNode,
    state: () => 'ready',
    scan,
    inspect,
    lookup: async id => nodes.get(id) as unknown as ComponentNode,
    invalidate: vi.fn(),
    post: vi.fn(),
  })
  await host.start(1)
  expect(scan).toHaveBeenCalledOnce()
  expect(inspect).toHaveBeenCalledOnce()
  expect(f.arrow.exportAsync).toHaveBeenCalledTimes(5000)
  host.deliver(1, 1)
  expect(inspect).toHaveBeenCalledTimes(2)
  host.finish(1, 1)
  expect(f.page.listeners.size).toBe(0)
})

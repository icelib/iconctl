import type { Page, TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect } from '@playwright/test'

export interface Message {
  type: string
  requestId?: number
  scanId?: number
  state?: string
  text?: string
  files?: { path: string, svg: string, bytes: number }[]
  [key: string]: unknown
}
export interface DesignNode {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  removed?: boolean
  children?: DesignNode[]
  parent?: DesignNode
  exportAsync?: (settings: unknown) => Promise<string>
}
type Change = (event: { nodeChanges: { type: string, properties: string[], origin: string }[] }) => void
function designPage(id: string) {
  const listeners = new Set<Change>()
  const attached: Change[] = []
  const detached: Change[] = []
  let selected: DesignNode[] = []
  const selectionWrites: string[][] = []
  const selectionControl = { mode: 'normal' as 'normal' | 'throw' | 'partial', beforeWrite: () => {} }
  return {
    id,
    name: id,
    type: 'PAGE',
    children: [] as DesignNode[],
    get selection() { return [...selected] },
    set selection(nodes: DesignNode[]) {
      selectionControl.beforeWrite()
      selectionWrites.push(nodes.map(node => node.id))
      if (selectionControl.mode === 'throw') {
        throw new Error('Controlled native selection setter failure')
      }
      selected = selectionControl.mode === 'partial' ? nodes.slice(0, 1) : [...nodes]
    },
    selectionWrites,
    selectionControl,
    manualSelection: (nodes: DesignNode[]) => { selected = [...nodes] },
    listeners,
    attached,
    detached,
    on(event: string, callback: Change) {
      expect(event).toBe('nodechange')
      listeners.add(callback)
      attached.push(callback)
    },
    off(event: string, callback: Change) {
      expect(event).toBe('nodechange')
      expect(listeners.delete(callback)).toBe(true)
      detached.push(callback)
    },
    emit(type = 'PROPERTY_CHANGE', properties = ['fills']) {
      for (const callback of [...listeners]) {
        callback({ nodeChanges: [{ type, properties, origin: 'REMOTE' }] })
      }
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject, started: false }
}
export const rawSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><defs><linearGradient id="g"><stop stop-color="#16824b"/></linearGradient><mask id="m"><path fill="white" d="M0 0h32v16H0z"/></mask></defs><path d="M4 4h8v8H4z" fill="url(#g)" mask="url(#m)"/><title>中文🙂</title></svg>'
export const settings = { format: 'SVG_STRING', contentsOnly: true, useAbsoluteBounds: true, svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true, colorProfile: 'DOCUMENT' }
export interface BrowserResources { created: string[], revoked: string[], active: string[], clicks: string[] }

/** Actual shipped code/UI, with adapters only at Figma and network boundaries. */
export async function mountSvg(page: Page, info: TestInfo, options: { restoredTask?: boolean, pendingContext?: boolean, clipboardDocument?: { url: string, deny: boolean } } = {}) {
  const first = designPage('page:svg')
  const second = designPage('page:other')
  const nodes = new Map<string, DesignNode>()
  const lookupGates: ReturnType<typeof deferred<DesignNode | null>>[] = []
  const exportGates: ReturnType<typeof deferred<string>>[] = []
  const networkGates: { kind: 'context' | 'job', gate: ReturnType<typeof deferred<Response>> }[] = []
  const requests: Message[] = []
  const responses: Message[] = []
  const network: { url: string, method: string }[] = []
  const writes: string[] = []
  const errors: string[] = []
  const downloads: string[] = []
  const exports: { id: string, settings: unknown }[] = []
  let inFlight = 0
  let peak = 0
  let active = false
  let closed = false
  let deliveries = Promise.resolve()
  const running = new Set<Promise<void>>()
  const handlers = new Map<string, Set<() => void>>()
  const selectionObservers = { attached: [] as (() => void)[], detached: [] as (() => void)[], atWrite: [] as number[] }
  const emit = (event: string) => {
    for (const callback of [...(handlers.get(event) ?? [])]) {
      callback()
    }
  }
  for (const design of [first, second]) {
    design.selectionControl.beforeWrite = () => selectionObservers.atWrite.push(handlers.get('selectionchange')?.size ?? 0)
  }
  const lookups: string[] = []
  let lookupActive = 0
  let lookupPeak = 0
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let timerId = 0
  let context = { projectId: 'svg-project', name: 'SVG project', revision: 7, validate: { width: 32, height: 16, skipPrefix: ['_', '.'] } as { width?: number, height?: number, name?: string, skipPrefix?: string[] }, namingMode: 'default' }
  const stored = new Map<string, unknown>([
    ['iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'svg-device', projectId: 'svg-project', token: 'fixture-device-token' }],
    ['iconctl-settings', { repo: 'fixture/icons', token: 'fixture-github-token', eventType: 'fixture-dispatch' }],
  ])
  if (options.restoredTask) {
    stored.set('iconctl-console-task', { deviceId: 'svg-device', requestId: 'saved-svg-task', expectedRevision: 7, jobId: 'running-task' })
  }
  const holdNetwork = (kind: 'context' | 'job') => {
    const gate = deferred<Response>()
    networkGates.push({ kind, gate })
    return gate
  }
  const initialContext = options.pendingContext ? holdNetwork('context') : undefined
  const job = options.restoredTask ? holdNetwork('job') : undefined
  function component(id: string, name: string, parent: DesignNode = first): DesignNode {
    const node: DesignNode = {
      id,
      name,
      type: 'COMPONENT',
      width: 32,
      height: 16,
      parent,
      async exportAsync(received) {
        exports.push({ id, settings: structuredClone(received) })
        expect(received).toEqual(settings)
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          const gate = exportGates.find(gate => !gate.started)
          if (gate) {
            gate.started = true
            return await gate.promise
          }
          return rawSvg
        }
        finally { inFlight-- }
      },
    }
    nodes.set(id, node)
    return node
  }
  const arrow = component('1:1', 'Arrow')
  const set: DesignNode = { id: '2:0', name: 'Actions', type: 'COMPONENT_SET', parent: first }
  const variant = component('2:1', 'Filled', set)
  set.children = [variant]
  const group: DesignNode = { id: '3:0', name: 'Nested', type: 'GROUP', parent: first }
  const nested = component('3:1', 'Nested Icon', group)
  group.children = [nested]
  const draft = component('4:1', '_Draft')
  arrow.children = [component('5:1', 'Embedded child', arrow)]
  first.children = [arrow, set, group, draft]
  const send = (message: Message) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const host = {
    currentPage: first,
    showUI() {},
    ui: {
      onmessage: undefined as ((message: Message) => Promise<void>) | undefined,
      postMessage(message: Message) {
        responses.push(structuredClone(message))
        if (active) {
          deliveries = deliveries.then(async () => {
            if (active) {
              await send(message)
            }
          }).catch((error) => { errors.push(String(error)) })
        }
      },
    },
    on(event: string, callback: () => void) {
      const listeners = handlers.get(event) ?? new Set<() => void>()
      listeners.add(callback)
      handlers.set(event, listeners)
      if (event === 'selectionchange') {
        selectionObservers.attached.push(callback)
      }
    },
    off(event: string, callback: () => void) {
      expect(handlers.get(event)?.delete(callback)).toBe(true)
      if (event === 'selectionchange') {
        selectionObservers.detached.push(callback)
      }
    },
    clientStorage: {
      getAsync: async (key: string) => stored.get(key),
      setAsync: async (key: string, value: unknown) => {
        writes.push(key)
        stored.set(key, value)
      },
      deleteAsync: async (key: string) => {
        writes.push(key)
        stored.delete(key)
      },
    },
    getNodeByIdAsync: async (id: string) => {
      lookups.push(id)
      lookupActive++
      lookupPeak = Math.max(lookupPeak, lookupActive)
      try {
        const gate = lookupGates.find(gate => !gate.started)
        if (gate) {
          gate.started = true
          return await gate.promise
        }
        return nodes.get(id) ?? null
      }
      finally { lookupActive-- }
    },
    viewport: { zoom: 1.25, center: { x: 120, y: 240 }, scrolls: [] as string[][], scrollAndZoomIntoView(nodes: DesignNode[] = []) { this.scrolls.push(nodes.map(node => node.id)) } },
  }
  const sandbox = {
    figma: host,
    __html__: '',
    URL,
    Response,
    Error,
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerId
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        callback()
      }, delay))
      return id
    },
    clearTimeout(id: number) {
      clearTimeout(timers.get(id))
      timers.delete(id)
    },
    fetch: async (url: string, init?: RequestInit) => {
      network.push({ url, method: init?.method ?? 'GET' })
      const kind = url.endsWith('/context') ? 'context' : 'job'
      expect(url).toBe(`https://iconctl.icebreaker.top/api/plugin/devices/svg-device/${kind === 'context' ? 'context' : 'jobs/running-task'}`)
      expect(init?.method ?? 'GET').toBe('GET')
      const gate = networkGates.find(item => item.kind === kind && !item.gate.started)?.gate
      if (gate) {
        gate.started = true
        return gate.promise
      }
      return Response.json(kind === 'context' ? context : { status: 'succeeded', stage: 'complete' })
    },
  }
  expect(runInNewContext('[typeof TextEncoder, typeof TextDecoder, typeof Buffer]', sandbox)).toEqual(['undefined', 'undefined', 'undefined'])
  runInNewContext(await readFile('../../packages/figma-plugin/dist/code.js', 'utf8'), sandbox)
  const dispatch = (message: Message) => {
    const operation = host.ui.onmessage!(message)
    running.add(operation)
    void operation.then(() => running.delete(operation), (error) => {
      running.delete(operation)
      errors.push(String(error))
    })
    return operation
  }
  const closeHost = () => {
    active = false
    if (!closed) {
      closed = true
      emit('close')
    }
  }
  const close = async () => {
    closeHost()
    lookupGates.forEach(gate => gate.resolve(null))
    exportGates.forEach(gate => gate.resolve(rawSvg))
    networkGates.forEach(({ gate }) => gate.resolve(new Response(null, { status: 403 })))
    await Promise.all(running)
    await deliveries
    const body = page.frameLocator('iframe').locator('body')
    const resources = await body.count()
      ? await body.evaluate(() => {
          window.dispatchEvent(new Event('pagehide'))
          return (window as unknown as { svgResources: BrowserResources }).svgResources
        })
      : undefined
    await writeFile(info.outputPath('svg-handoff-evidence.json'), JSON.stringify({ requests, responses: responses.map(({ files, ...rest }) => ({ ...rest, ...(files ? { files: files.map(({ path, bytes }) => ({ path, bytes })) } : {}) })), network, writes, errors, exports, peak, inFlight, downloads, resources, firstListeners: first.listeners.size, secondListeners: second.listeners.size, attached: first.attached.length + second.attached.length, detached: first.detached.length + second.detached.length, timers: timers.size, hostHasEncoder: false, selection: { writes: [...first.selectionWrites, ...second.selectionWrites], atWrite: selectionObservers.atWrite, attached: selectionObservers.attached.length, detached: selectionObservers.detached.length, active: handlers.get('selectionchange')?.size ?? 0 }, lookups, lookupActive, lookupPeak }, null, 2))
    expect(first.listeners.size + second.listeners.size).toBe(0)
    expect(first.attached.length + second.attached.length).toBe(first.detached.length + second.detached.length)
    expect(handlers.get('selectionchange')?.size ?? 0).toBe(0)
    expect(selectionObservers.attached).toHaveLength(selectionObservers.detached.length)
    expect(new Set(selectionObservers.detached).size).toBe(selectionObservers.detached.length)
    expect(lookupActive).toBe(0)
    expect(timers.size).toBe(0)
    expect(inFlight).toBe(0)
    expect(errors).toEqual([])
    if (resources) {
      expect(resources.active).toEqual([])
    }
  }
  try {
    await page.exposeFunction('svgPluginMessage', (message: Message) => {
      requests.push(structuredClone(message))
      void dispatch(message)
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', async (dialog) => {
      errors.push(`Unexpected dialog: ${dialog.message()}`)
      await dialog.dismiss()
    })
    page.on('download', download => downloads.push(download.suggestedFilename()))
    const frameDocument = '<!doctype html><link rel="icon" href="data:,"><iframe title="Figma plugin" allow="clipboard-write; clipboard-read" style="width:420px;height:560px"></iframe>'
    await page.route(/^https?:/, (route) => {
      if (options.clipboardDocument && route.request().url() === options.clipboardDocument.url && route.request().isNavigationRequest()) {
        return route.fulfill({ contentType: 'text/html', headers: { 'Permissions-Policy': options.clipboardDocument.deny ? 'clipboard-write=(), clipboard-read=()' : 'clipboard-write=(self), clipboard-read=(self)' }, body: frameDocument })
      }
      errors.push(`Unexpected browser request: ${route.request().url()}`)
      return route.abort()
    })
    if (options.clipboardDocument) {
      await page.goto(options.clipboardDocument.url)
    }
    else {
      await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
    }
    active = true
    const instrumentation = `<script>window.svgResources={created:[],revoked:[],active:[],clicks:[]};const c=URL.createObjectURL.bind(URL),r=URL.revokeObjectURL.bind(URL),a=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(b){const u=c(b);svgResources.created.push(u);svgResources.active.push(u);return u};URL.revokeObjectURL=function(u){svgResources.revoked.push(u);svgResources.active=svgResources.active.filter(x=>x!==u);return r(u)};HTMLAnchorElement.prototype.click=function(){svgResources.clicks.push(this.download);return a.call(this)}</script>`
    const html = (await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')).replace('<head>', `<head>${instrumentation}`)
    await page.evaluate((html) => {
      const frame = document.querySelector('iframe')!
      window.addEventListener('message', (event) => {
        if (event.source === frame.contentWindow && event.data.pluginMessage) {
          void (window as unknown as { svgPluginMessage: (message: Message) => Promise<void> }).svgPluginMessage(event.data.pluginMessage)
        }
      })
      frame.srcdoc = html
    }, html)
    const ui = page.frameLocator('iframe')
    if (initialContext) {
      await expect.poll(() => initialContext.started).toBe(true)
    }
    else { await expect(ui.locator('#console-status')).toContainText('Connected to SVG project') }
    await expect(ui.locator('#list > li')).toHaveCount(3)
    return {
      ui,
      first,
      second,
      nodes,
      arrow,
      variant,
      nested,
      draft,
      host,
      lookups,
      lookupActive: () => lookupActive,
      lookupPeak: () => lookupPeak,
      selectionObservers,
      selectionListeners: () => [...(handlers.get('selectionchange') ?? [])],
      emitSelection: () => emit('selectionchange'),
      exports,
      downloads,
      errors,
      requests,
      responses,
      network,
      writes,
      stored,
      timers,
      initialContext,
      job,
      context: () => structuredClone(context),
      setContext: (next: Partial<typeof context>) => { context = { ...context, ...next } },
      holdNetwork,
      holdExport: () => {
        const gate = deferred<string>()
        exportGates.push(gate)
        return gate
      },
      holdLookup: () => {
        const gate = deferred<DesignNode | null>()
        lookupGates.push(gate)
        return gate
      },
      changePage: (next = second) => {
        host.currentPage = next
        emit('currentpagechange')
      },
      flush: () => deliveries,
      settleHost: () => Promise.all(running),
      peak: () => peak,
      inFlight: () => inFlight,
      dispatch,
      send,
      closeHost,
      close,
    }
  }
  catch (error) {
    await close()
    throw error
  }
}
export type SvgFixture = Awaited<ReturnType<typeof mountSvg>>

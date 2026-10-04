import type { Page, TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test as base, expect } from '@playwright/test'

interface Message {
  type: string
  scanId?: number
  requestId?: number
  nodeId?: string
  items?: { id: string, name: string, iconName: string | null, skipped: boolean, issues: string[] }[]
  [key: string]: unknown
}
interface Node {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  children?: Node[]
  parent?: Node
}
type ChangeHandler = (event: { nodeChanges: { type: string, properties?: string[], origin?: string }[] }) => void
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve, started: false }
}
function designPage(id: string) {
  const listeners = new Set<ChangeHandler>()
  const attached: ChangeHandler[] = []
  const detached: ChangeHandler[] = []
  return {
    id,
    name: id,
    type: 'PAGE',
    children: [] as Node[],
    selection: [] as Node[],
    listeners,
    attached,
    detached,
    on(event: string, callback: ChangeHandler) {
      expect(event).toBe('nodechange')
      listeners.add(callback)
      attached.push(callback)
    },
    off(event: string, callback: ChangeHandler) {
      expect(event).toBe('nodechange')
      expect(listeners.delete(callback)).toBe(true)
      detached.push(callback)
    },
    emit(type = 'PROPERTY_CHANGE', properties = ['name']) {
      for (const callback of listeners) {
        callback({ nodeChanges: [{ type, properties, origin: 'REMOTE' }] })
      }
    },
  }
}

// Execute shipped host/UI. Adapt only Figma nodes, storage and network. The
// optional timer hold lets assertions observe the dirty interval without races.
async function mount(page: Page, options: { pendingContext?: boolean, restoredTask?: boolean, failTaskStorage?: boolean } = {}) {
  const first = designPage('page:live')
  const second = designPage('page:other')
  const arrow: Node = { id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 24, height: 24, parent: first }
  first.children = [arrow]
  const stored = new Map<string, unknown>([
    ['iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'live-device', projectId: 'project', token: 'live-fixture-secret' }],
    ['iconctl-settings', { repo: 'fixture/icons', token: 'fixture-github-secret', eventType: 'fixture-dispatch' }],
  ])
  if (options.restoredTask) {
    stored.set('iconctl-console-task', { deviceId: 'live-device', requestId: 'saved-live-task', expectedRevision: 6, jobId: 'running-task' })
  }
  const requests: Message[] = []
  const responses: Message[] = []
  const writes: { key: string, operation: string }[] = []
  const network: { url: string, method: string }[] = []
  const focused: string[] = []
  const errors: string[] = []
  const events: Record<string, unknown>[] = []
  const handlers = new Map<string, () => void>()
  const running = new Set<Promise<void>>()
  const gates: { kind: 'context' | 'job', gate: ReturnType<typeof deferred<Response>> }[] = []
  const lookupGates: ReturnType<typeof deferred<Node | null>>[] = []
  const timers = new Map<number, { handle?: ReturnType<typeof setTimeout>, callback: () => void, delay: number }>()
  let nextTimer = 0
  let holdDebounce = false
  let failedTaskStorage = false
  let active = false
  let closed = false
  let deliveries = Promise.resolve()
  let context = { projectId: 'project', name: 'Live project', revision: 7, validate: { width: 24, height: 24 } as { width?: number, height?: number, name?: string, skipPrefix?: string[] }, namingMode: 'default' }
  const hold = (kind: 'context' | 'job') => {
    const gate = deferred<Response>()
    gates.push({ kind, gate })
    return gate
  }
  const initialContext = options.pendingContext ? hold('context') : undefined
  const job = options.restoredTask ? hold('job') : undefined
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
        events.push({ kind: 'response', type: message.type, scanId: message.scanId, time: Date.now() })
        if (active) {
          deliveries = deliveries.then(async () => {
            if (active) {
              await send(message)
            }
          }).catch((error) => {
            errors.push(String(error))
          })
        }
      },
    },
    on: (name: string, callback: () => void) => handlers.set(name, callback),
    clientStorage: {
      getAsync: async (key: string) => {
        if (key === 'iconctl-console-task' && options.failTaskStorage && !failedTaskStorage) {
          failedTaskStorage = true
          throw new Error('Task storage unavailable')
        }
        return stored.get(key)
      },
      setAsync: async (key: string, value: unknown) => {
        writes.push({ key, operation: 'set' })
        stored.set(key, value)
      },
      deleteAsync: async (key: string) => {
        writes.push({ key, operation: 'delete' })
        stored.delete(key)
      },
    },
    getNodeByIdAsync: async (id: string) => {
      const gate = lookupGates.find(gate => !gate.started)
      if (gate) {
        gate.started = true
        return gate.promise
      }
      return id === arrow.id ? arrow : null
    },
    viewport: { scrollAndZoomIntoView: (nodes: Node[]) => focused.push(...nodes.map(node => node.id)) },
  }
  runInNewContext(await readFile('../../packages/figma-plugin/dist/code.js', 'utf8'), {
    figma: host,
    __html__: '',
    URL,
    Response,
    Error,
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer
      const run = () => {
        timers.delete(id)
        callback()
      }
      timers.set(id, { callback: run, delay, ...(!(holdDebounce && delay === 150) ? { handle: setTimeout(run, delay) } : {}) })
      events.push({ kind: 'timer', delay, time: Date.now() })
      return id
    },
    clearTimeout(id: number) {
      clearTimeout(timers.get(id)?.handle)
      timers.delete(id)
    },
    fetch: async (input: string, init?: RequestInit) => {
      network.push({ url: input, method: init?.method ?? 'GET' })
      const kind = input.endsWith('/context') ? 'context' : 'job'
      expect(input).toBe(`https://iconctl.icebreaker.top/api/plugin/devices/live-device/${kind === 'context' ? 'context' : 'jobs/running-task'}`)
      expect(init?.method ?? 'GET').toBe('GET')
      const held = gates.find(value => value.kind === kind && !value.gate.started)?.gate
      if (held) {
        held.started = true
        return held.promise
      }
      return Response.json(kind === 'context' ? context : { status: 'succeeded', stage: 'complete' })
    },
  })
  const dispatch = (message: Message) => {
    const operation = host.ui.onmessage!(message)
    running.add(operation)
    void operation.then(() => running.delete(operation), (error) => {
      errors.push(String(error))
      running.delete(operation)
    })
    return operation
  }
  await page.exposeFunction('livePluginMessage', (message: Message) => {
    requests.push(structuredClone(message))
    void dispatch(message)
  })
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  page.on('pageerror', error => errors.push(error.message))
  active = true
  await page.evaluate((html) => {
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data.pluginMessage) {
        void (window as unknown as { livePluginMessage: (message: Message) => Promise<void> }).livePluginMessage(event.data.pluginMessage)
      }
    })
    frame.srcdoc = html
  }, await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8'))
  const ui = page.frameLocator('iframe')
  try {
    if (initialContext) {
      await expect.poll(() => initialContext.started).toBe(true)
    }
    else if (options.failTaskStorage) {
      await expect(ui.locator('#console-status')).toContainText('Task storage unavailable')
    }
    else {
      await expect(ui.locator('#console-status')).toContainText('Connected to Live project')
    }
    await expect(ui.locator('#list > li')).toHaveCount(1)
  }
  catch (error) {
    active = false
    closed = true
    handlers.get('close')!()
    for (const { gate } of gates) {
      gate.resolve(new Response(null, { status: 403 }))
    }
    for (const gate of lookupGates) {
      gate.resolve(null)
    }
    await Promise.all(running)
    await deliveries
    throw error
  }
  const scans = () => responses.filter(message => message.type === 'preflight')
  const flush = () => deliveries
  const waitScan = async (before: number) => {
    await expect.poll(() => scans().length).toBeGreaterThan(before)
    await flush()
  }
  const closeHost = () => {
    active = false
    if (!closed) {
      closed = true
      handlers.get('close')!()
    }
  }
  return {
    ui,
    first,
    second,
    arrow,
    host,
    stored,
    writes,
    requests,
    responses,
    network,
    focused,
    errors,
    events,
    timers,
    initialContext,
    job,
    scans,
    flush,
    send,
    dispatch,
    waitScan,
    hold,
    closeHost,
    current: () => scans().at(-1)!,
    settleHost: () => Promise.all(running),
    context: () => structuredClone(context),
    setContext: (next: Partial<typeof context>) => {
      context = { ...context, ...next }
    },
    enable: async () => {
      await ui.getByLabel('Live preflight', { exact: true }).check()
      await expect(ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
    },
    pauseEdits: () => {
      holdDebounce = true
    },
    finishEdits: () => {
      holdDebounce = false
      for (const timer of [...timers.values()]) {
        if (timer.delay === 150 && !timer.handle) {
          timer.callback()
        }
      }
    },
    changePage: (next = second) => {
      host.currentPage = next
      handlers.get('currentpagechange')!()
    },
    holdLookup: () => {
      const gate = deferred<Node | null>()
      lookupGates.push(gate)
      return gate
    },
    async close(info: TestInfo) {
      closeHost()
      for (const { gate } of gates) {
        gate.resolve(new Response(null, { status: 403 }))
      }
      for (const gate of lookupGates) {
        gate.resolve(null)
      }
      await Promise.all(running)
      await deliveries
      await writeFile(info.outputPath('live-preflight-evidence.json'), JSON.stringify({ requests, responses, writes, network, focused, errors, events, firstListeners: first.listeners.size, secondListeners: second.listeners.size, timers: timers.size, attached: first.attached.length + second.attached.length, detached: first.detached.length + second.detached.length }, null, 2))
      expect(first.listeners.size + second.listeners.size).toBe(0)
      expect(timers.size).toBe(0)
      expect(errors).toEqual([])
    },
  }
}
type Live = Awaited<ReturnType<typeof mount>>
const test = base.extend<{ live: Live }>({
  live: async ({ page }, use, info) => {
    const live = await mount(page)
    try {
      await use(live)
    }
    finally {
      await live.close(info)
    }
  },
})
const liveStatus = (live: Live) => live.ui.locator('#live-preflight-status')
const rows = (live: Live) => live.ui.locator('#list > li')
async function edited(live: Live, mutate: () => void, type = 'PROPERTY_CHANGE') {
  const count = live.scans().length
  mutate()
  live.host.currentPage.emit(type)
  await live.waitScan(count)
  await expect(liveStatus(live)).toContainText('Live preflight is on')
}
function noAutomaticSubmission(live: Live) {
  expect(live.requests.filter(message => ['console-sync', 'dispatch', 'save-settings', 'console-pair'].includes(message.type))).toEqual([])
  expect(live.writes.filter(write => write.operation === 'set' && write.key !== 'iconctl-preflight-preferences')).toEqual([])
}

test('opts in per session, coalesces edits and revokes stale Locate/report actions before publishing the final page state', async ({ page, live }, info) => {
  await expect(live.ui.getByLabel('Live preflight', { exact: true })).not.toBeChecked()
  expect(live.first.listeners.size).toBe(0)
  live.arrow.name = 'Edited while off'
  live.first.emit()
  await live.ui.getByLabel('Live preflight', { exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(liveStatus(live)).toContainText('Live preflight is on')
  await expect(rows(live)).toContainText('Edited while off')
  expect(live.first.listeners.size).toBe(1)
  const scan = live.current().scanId!
  const lookup = live.holdLookup()
  await live.ui.getByRole('button', { name: 'Locate Edited while off', exact: true }).click()
  await expect.poll(() => lookup.started).toBe(true)
  const before = live.scans().length
  live.pauseEdits()
  live.arrow.width = 48
  live.first.emit('PROPERTY_CHANGE', ['width'])
  live.arrow.name = 'Final Arrow'
  live.first.emit('PROPERTY_CHANGE', ['name'])
  live.arrow.width = 24
  live.first.emit('PROPERTY_CHANGE', ['width'])
  await live.flush()
  await expect(liveStatus(live)).toHaveText('Updating preflight…')
  await expect(live.ui.getByRole('button', { name: 'Export JSON report', exact: true })).toBeDisabled()
  await expect(live.ui.getByRole('button', { name: 'Locate Edited while off', exact: true })).toBeDisabled()
  await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await live.dispatch({ type: 'export-report', scanId: scan, requestId: 999 })
  expect(live.responses.filter(message => message.type === 'preflight-report').at(-1)).toMatchObject({ error: true })
  lookup.resolve(live.arrow)
  await live.settleHost()
  await expect.poll(() => live.responses.filter(message => message.type === 'navigation-result').length).toBe(0)
  expect(live.focused).toEqual([])
  expect(live.scans()).toHaveLength(before)
  expect([...live.timers.values()].map(timer => timer.delay)).toEqual([150])
  live.finishEdits()
  await live.waitScan(before)
  expect(live.scans()).toHaveLength(before + 1)
  await expect(rows(live)).toContainText('Final Arrow')
  await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  expect(live.network).toHaveLength(1)
  noAutomaticSubmission(live)
  const download = page.waitForEvent('download')
  await live.ui.getByRole('button', { name: 'Export JSON report', exact: true }).click()
  const artifact = await download
  expect(await artifact.failure()).toBeNull()
  const file = info.outputPath('live-current-report.json')
  await artifact.saveAs(file)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ scanId: live.current().scanId, items: [{ name: 'Final Arrow', issues: [] }] })
  await page.locator('iframe').screenshot({ path: info.outputPath('live-ready-keyboard.png') })
})

test('rescans nested creation, parent names, duplicate names, skips and deletion while preserving review filters', async ({ live }) => {
  await live.enable()
  const nested: Node = { ...live.arrow, id: '2:1', parent: undefined }
  const group: Node = { id: '2:0', name: 'Group', type: 'FRAME', children: [nested], parent: live.first }
  nested.parent = group
  await edited(live, () => live.first.children.push(group), 'CREATE')
  await expect(rows(live)).toHaveCount(2)
  await expect(live.ui.locator('#status')).toHaveText('2 of 2 icons need fixes')
  await expect(rows(live).first()).toContainText('Duplicate icon name')
  await live.ui.getByLabel('Search preflight', { exact: true }).fill('arrow')
  await live.ui.getByLabel('Problems only', { exact: true }).check()
  await edited(live, () => {
    group.type = 'COMPONENT_SET'
    group.name = 'Actions'
  })
  await expect(rows(live)).toHaveCount(0)
  await expect(live.ui.getByLabel('Search preflight', { exact: true })).toHaveValue('arrow')
  await expect(live.ui.getByLabel('Problems only', { exact: true })).toBeChecked()
  expect(live.current().items?.map(item => item.iconName)).toEqual(['arrow', 'actions-arrow'])
  await live.ui.getByLabel('Problems only', { exact: true }).uncheck()
  await edited(live, () => {
    nested.name = '_draft'
  })
  await expect(rows(live)).toHaveCount(1)
  await expect(live.ui.locator('#status')).toHaveText('1 icons ready · 1 drafts skipped')
  await edited(live, () => {
    live.first.children = [group]
  }, 'DELETE')
  await expect(rows(live)).toHaveCount(0)
  await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  expect(live.network).toHaveLength(1)
  noAutomaticSubmission(live)
})

test('waits for explicit rule refresh, recovers a stale failure, and uses custom then server naming without background requests', async ({ live }) => {
  await live.enable()
  await live.ui.getByText('Applied rules', { exact: true }).click()
  const refresh = live.ui.getByRole('button', { name: 'Refresh project rules', exact: true })
  const gate = live.hold('context')
  await refresh.click()
  await expect.poll(() => gate.started).toBe(true)
  const before = live.scans().length
  live.arrow.name = 'ui-arrow'
  live.arrow.width = 32
  live.first.emit()
  await live.flush()
  await expect(liveStatus(live)).toHaveText('Waiting for project rules…')
  expect(live.timers.size).toBe(0)
  expect(live.scans()).toHaveLength(before)
  live.setContext({ revision: 8, validate: { width: 32, name: '^ui-', skipPrefix: ['draft-'] } })
  gate.resolve(Response.json(live.context()))
  await live.waitScan(before)
  await expect(live.ui.locator('#rules-status')).toContainText('revision 8')
  await expect(live.ui.locator('#status')).toHaveText('1 icons ready')
  await edited(live, () => {
    live.arrow.name = 'Bad'
    live.arrow.height = 48
  })
  await expect(rows(live)).toContainText('does not match the naming rule')
  expect(live.current().items![0]!.issues).toHaveLength(1)
  await edited(live, () => {
    live.arrow.name = 'draft-hidden'
  })
  await expect(rows(live)).toHaveCount(0)

  const failure = live.hold('context')
  await refresh.click()
  await expect.poll(() => failure.started).toBe(true)
  failure.resolve(new Response(null, { status: 502 }))
  await expect(liveStatus(live)).toHaveText('Refresh project rules to resume live preflight.')
  const staleCount = live.scans().length
  live.arrow.name = '!!'
  live.first.emit()
  await live.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await live.flush()
  expect(live.scans()).toHaveLength(staleCount)
  expect(live.timers.size).toBe(0)
  live.setContext({ revision: 9, validate: {}, namingMode: 'server' })
  await refresh.click()
  await expect(live.ui.locator('#rules-status')).toContainText('revision 9')
  await expect(live.ui.locator('#status')).toHaveText('1 icons ready')
  await edited(live, () => live.first.children.push({ ...live.arrow, id: '3:3', name: '!!' }), 'CREATE')
  expect(live.current().items?.every(item => item.issues.length === 0)).toBe(true)
  await expect(live.ui.getByText('Provisional — custom naming is validated by the server.', { exact: true })).toBeVisible()
  expect(live.network).toHaveLength(4)
  noAutomaticSubmission(live)
})

test('isolates old page callbacks across disable and A to B to A and keeps GitHub progress owned during live scans', async ({ page, live }, info) => {
  await live.enable()
  const stale = live.first.attached[0]!
  await live.ui.getByLabel('Live preflight', { exact: true }).uncheck()
  await expect.poll(() => live.first.listeners.size).toBe(0)
  const disabledCount = live.scans().length
  stale({ nodeChanges: [{ type: 'CREATE' }] })
  expect(live.scans()).toHaveLength(disabledCount)
  await live.enable()
  const beforePage = live.scans().length
  live.changePage()
  await live.waitScan(beforePage)
  await expect(rows(live)).toHaveCount(0)
  expect(live.first.listeners.size).toBe(0)
  expect(live.second.listeners.size).toBe(1)
  live.changePage(live.first)
  await live.waitScan(beforePage + 1)
  stale({ nodeChanges: [{ type: 'CREATE' }] })
  expect(live.timers.size).toBe(0)
  expect(live.first.listeners.size).toBe(1)
  expect(live.second.listeners.size).toBe(0)

  await live.ui.getByLabel('Connection mode').selectOption('github')
  await expect(live.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
  const release = deferred<void>()
  let dispatches = 0
  await page.route('https://api.github.com/**', async (route) => {
    expect(route.request().url()).toBe('https://api.github.com/repos/fixture/icons/dispatches')
    expect(route.request().postDataJSON()).toEqual({ event_type: 'fixture-dispatch' })
    dispatches++
    await release.promise
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
  })
  try {
    await live.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true }).click()
    await expect.poll(() => dispatches).toBe(1)
    await expect(live.ui.locator('#github-status')).toHaveText('Dispatching GitHub Action…')
    await edited(live, () => {
      live.arrow.width = 48
      live.arrow.name = '!!'
    })
    await expect(live.ui.locator('#status')).toHaveText('1 of 1 icons need fixes')
    expect(live.current().items![0]!.issues).toHaveLength(2)
    await expect(live.ui.locator('#github-status')).toHaveText('Dispatching GitHub Action…')
    release.resolve()
    await expect(live.ui.locator('#github-status')).toHaveText('Workflow started. https://github.com/fixture/icons/actions')
    await edited(live, () => {
      live.arrow.width = 24
      live.arrow.name = 'Repaired'
    })
    await expect(live.ui.locator('#github-status')).toContainText('Workflow started.')
    await page.locator('iframe').screenshot({ path: info.outputPath('live-github-progress.png') })
  }
  finally {
    release.resolve()
  }
  expect(dispatches).toBe(1)
  expect(live.network).toHaveLength(1)
})

for (const cause of ['disconnect', 'revoke', 'pagehide', 'host-close'] as const) {
  test(`detaches exact listeners on ${cause} and ignores already queued page changes`, async ({ page, live }) => {
    await live.enable()
    const stale = live.first.attached[0]!
    live.pauseEdits()
    live.arrow.name = 'Late edit'
    live.first.emit()
    if (cause === 'disconnect') {
      await live.ui.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(live.ui.locator('#console-status')).toContainText('Local connection removed')
    }
    else if (cause === 'revoke') {
      const gate = live.hold('context')
      await live.ui.getByText('Applied rules', { exact: true }).click()
      await live.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
      await expect.poll(() => gate.started).toBe(true)
      gate.resolve(new Response(null, { status: 401 }))
      await expect(live.ui.locator('#rules-status')).toContainText('401')
      await expect(live.ui.getByLabel('Live preflight', { exact: true })).not.toBeChecked()
    }
    else if (cause === 'pagehide') {
      await live.ui.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await expect.poll(() => live.first.listeners.size).toBe(0)
    }
    else {
      live.closeHost()
      await page.locator('iframe').evaluate(element => element.remove())
    }
    expect(live.first.detached).toContain(stale)
    expect(live.first.listeners.size).toBe(0)
    expect(live.timers.size).toBe(0)
    const count = live.responses.length
    stale({ nodeChanges: [{ type: 'PROPERTY_CHANGE', properties: ['name'] }] })
    live.finishEdits()
    await live.flush()
    expect(live.responses).toHaveLength(count)
    noAutomaticSubmission(live)
  })
}

test('waits for pending context but continues cached-rule preflight while the restored task is polling', async ({ page }, info) => {
  const live = await mount(page, { pendingContext: true, restoredTask: true })
  try {
    await live.ui.getByLabel('Live preflight', { exact: true }).check()
    await expect(liveStatus(live)).toHaveText('Waiting for project rules…')
    const count = live.scans().length
    live.arrow.width = 32
    live.arrow.name = 'Waiting edit'
    live.first.emit()
    await live.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
    await live.flush()
    expect(live.scans()).toHaveLength(count)
    expect(live.timers.size).toBe(0)
    live.setContext({ revision: 10, validate: { width: 32 } })
    live.initialContext!.resolve(Response.json(live.context()))
    await expect.poll(() => live.job!.started).toBe(true)
    await expect(liveStatus(live)).toContainText('Live preflight is on')
    await expect(rows(live)).toContainText('Waiting edit')
    const network = live.network.length
    await edited(live, () => {
      live.arrow.name = 'While task polls'
      live.arrow.height = 99
    })
    await expect(rows(live)).toContainText('While task polls')
    await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
    expect(live.network).toHaveLength(network)
    noAutomaticSubmission(live)
    live.job!.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await expect(live.ui.locator('#console-status')).toContainText('succeeded · complete')
    await edited(live, () => {
      live.arrow.name = 'After task complete'
    })
    await expect(live.ui.locator('#console-status')).toContainText('succeeded · complete')
    await expect(live.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=running-task')
    expect(live.network).toHaveLength(2)
    expect(live.writes.filter(write => write.key === 'iconctl-console-task')).toEqual([{ key: 'iconctl-console-task', operation: 'delete' }])
  }
  finally {
    await live.close(info)
  }
})

test('keeps a late GitHub dispatch failure in its own status after switching back to Console and rescanning', async ({ page, live }) => {
  await live.enable()
  await live.ui.getByLabel('Connection mode').selectOption('github')
  await expect(live.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
  const release = deferred<void>()
  let dispatches = 0
  await page.route('https://api.github.com/**', async (route) => {
    dispatches++
    await release.promise
    await route.fulfill({ status: 403, json: { message: 'Fixture permission failure' }, headers: { 'access-control-allow-origin': '*' } })
  })
  try {
    await live.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true }).click()
    await expect.poll(() => dispatches).toBe(1)
    await live.ui.getByLabel('Connection mode').selectOption('console')
    await expect(live.ui.locator('#console-status')).toContainText('Connected to Live project')
    await edited(live, () => {
      live.arrow.name = 'Current console icon'
    })
    const consoleStatus = await live.ui.locator('#console-status').textContent()
    release.resolve()
    await expect(live.ui.locator('#github-status')).toHaveText('GitHub dispatch failed (403). Check repository access and Contents: write permission.')
    await expect(live.ui.locator('#console-status')).toHaveText(consoleStatus!)
    await expect(live.ui.locator('#status')).toHaveText('1 icons ready')
    await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
    expect(dispatches).toBe(1)
  }
  finally {
    release.resolve()
  }
})

test('keeps an initially paired project stale after task storage fails and recovers only with explicit project rules', async ({ page }, info) => {
  const live = await mount(page, { failTaskStorage: true })
  try {
    await live.ui.getByLabel('Live preflight', { exact: true }).check()
    await expect(liveStatus(live)).toHaveText('Refresh project rules to resume live preflight.')
    const before = live.scans().length
    live.arrow.width = 99
    live.first.emit()
    await live.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
    await live.flush()
    expect(live.scans()).toHaveLength(before)
    expect(live.timers.size).toBe(0)
    expect(live.network).toEqual([])
    await expect(live.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
    await expect(live.ui.getByRole('button', { name: 'Export JSON report', exact: true })).toBeDisabled()
    live.setContext({ revision: 11, validate: { width: 99 }, namingMode: 'default' })
    await live.ui.getByText('Applied rules', { exact: true }).click()
    await live.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
    await expect(live.ui.locator('#rules-status')).toContainText('revision 11')
    await expect(liveStatus(live)).toContainText('Live preflight is on')
    await expect(live.ui.locator('#status')).toHaveText('1 icons ready')
    expect(live.current()).toMatchObject({ appliedRules: { rulesSource: 'project', project: { revision: 11 } } })
    expect(live.network).toHaveLength(1)
    noAutomaticSubmission(live)
  }
  finally {
    await live.close(info)
  }
})

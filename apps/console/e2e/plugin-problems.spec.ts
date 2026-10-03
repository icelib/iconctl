import type { Page, TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test as base, expect } from '@playwright/test'

interface Message {
  type: string
  nodeId?: string
  scanId?: number
  requestId?: number
  items?: { id: string, name: string, issues: string[], skipped: boolean }[]
  json?: string
  html?: string
  text?: string
  [key: string]: unknown
}
interface Node {
  id: string
  name: string
  type: string
  width?: number
  height?: number
  removed?: boolean
  parent?: Node
  children?: Node[]
  selection?: Node[]
}
interface Gate {
  id: string
  started: boolean
  promise: Promise<Node | null>
  resolve: (node: Node | null) => void
}
const hostileId = 'NÖDE[3].*\'\"><img data-injected="problem" src="https://invalid.example/id">'

// Real built host + built iframe UI, with only Figma APIs/storage/context adapted.
// A controlled lookup queue exposes ordering without replacing the navigator.
async function plugin(page: Page) {
  const hostPage: Node = { id: 'page:problems', name: 'Problem review', type: 'PAGE', children: [], selection: [] }
  const component = (id: string, name: string, width = 24, height = 24): Node => ({ id, name, type: 'COMPONENT', width, height, parent: hostPage })
  const healthy = component('10:0', 'Arrow')
  const wide = component('11:1', 'Wide', 48)
  const invalid = component('12:2', '!!', 48, 32)
  const tall = component(hostileId, 'Tall', 24, 48)
  const draft = component('14:4', '_draft', 99)
  const nodes = [healthy, wide, invalid, tall, draft]
  hostPage.children = nodes
  const stored = new Map<string, unknown>([
    ['iconctl-console-device', { origin: 'https://iconctl.icebreaker.top', deviceId: 'problem-device', projectId: 'project', token: 'problem-device-secret' }],
    ['iconctl-settings', { repo: 'fixture/icons', token: 'problem-github-secret', eventType: 'fixture-dispatch' }],
  ])
  const writes: { key: string, value?: unknown }[] = []
  const requests: Message[] = []
  const responses: Message[] = []
  const lookups: string[] = []
  const focused: string[] = []
  const gates: Gate[] = []
  const handlers = new Map<string, () => void>()
  const errors: string[] = []
  const network: string[] = []
  const timeline: Record<string, unknown>[] = []
  const running = new Set<Promise<void>>()
  const navigationOperations = new Map<number, Promise<void>>()
  let activeFrame = false
  let hostClosed = false
  let deliveries = Promise.resolve()
  const send = (message: Message) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const figma = {
    currentPage: hostPage,
    showUI: () => {},
    ui: {
      onmessage: undefined as ((message: Message) => Promise<void>) | undefined,
      postMessage(message: Message) {
        responses.push(structuredClone(message))
        if (activeFrame) {
          deliveries = deliveries.then(async () => {
            if (activeFrame) {
              await send(message)
            }
          }).catch((error) => { errors.push(String(error)) })
        }
      },
    },
    clientStorage: {
      getAsync: async (key: string) => stored.get(key),
      setAsync: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) })
        stored.set(key, value)
      },
      deleteAsync: async (key: string) => {
        writes.push({ key })
        stored.delete(key)
      },
    },
    on: (event: string, callback: () => void) => handlers.set(event, callback),
    getNodeByIdAsync: async (id: string) => {
      lookups.push(id)
      timeline.push({ event: 'lookup', id })
      const gate = gates.find(gate => gate.id === id && !gate.started)
      if (gate) {
        gate.started = true
        return gate.promise
      }
      return nodes.find(node => node.id === id) ?? null
    },
    viewport: { scrollAndZoomIntoView: (nodes: Node[]) => {
      focused.push(...nodes.map(node => node.id))
      timeline.push({ event: 'focus', ids: nodes.map(node => node.id) })
    } },
  }
  let projectContext = { projectId: 'project', name: 'Problem project', revision: 7, validate: { width: 24, height: 24 }, namingMode: 'default' }
  runInNewContext(await readFile('../../packages/figma-plugin/dist/code.js', 'utf8'), {
    figma,
    __html__: '',
    URL,
    Response,
    setTimeout,
    clearTimeout,
    fetch: async (input: string) => {
      network.push(input)
      expect(input).toBe('https://iconctl.icebreaker.top/api/plugin/devices/problem-device/context')
      return Response.json(projectContext)
    },
  })
  const dispatch = (message: Message) => {
    const operation = figma.ui.onmessage!(message)
    if (message.type === 'locate' && message.requestId !== undefined) {
      navigationOperations.set(message.requestId, operation)
    }
    running.add(operation)
    void operation.then(() => running.delete(operation), (error) => {
      errors.push(String(error))
      running.delete(operation)
    })
    return operation
  }
  await page.exposeFunction('problemPluginMessage', (message: Message) => {
    requests.push(structuredClone(message))
    timeline.push({ event: 'host-received', message: structuredClone(message) })
    void dispatch(message)
  })
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  page.on('pageerror', error => errors.push(error.message))
  activeFrame = true
  await page.evaluate((html) => {
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data.pluginMessage) {
        void (window as unknown as { problemPluginMessage: (message: Message) => Promise<void> }).problemPluginMessage(event.data.pluginMessage)
      }
    })
    frame.srcdoc = html
  }, await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8'))
  const ui = page.frameLocator('iframe')
  await expect(ui.locator('#console-status')).toContainText('Connected to Problem project')
  await expect(ui.locator('#list > li')).toHaveCount(4)
  const hold = (node: Node) => {
    let resolve!: (node: Node | null) => void
    const gate: Gate = {
      id: node.id,
      started: false,
      promise: new Promise((done) => {
        resolve = done
      }),
      resolve: (node) => {
        timeline.push({ event: 'lookup-resolved', id: gate.id, found: node?.id })
        resolve(node)
      },
    }
    gates.push(gate)
    return gate
  }
  const rescan = async () => {
    const previous = responses.filter(message => message.type === 'preflight').at(-1)?.scanId
    await ui.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect.poll(() => responses.filter(message => message.type === 'preflight').at(-1)?.scanId).not.toBe(previous)
    await deliveries
  }
  const closeHost = () => {
    activeFrame = false
    if (!hostClosed) {
      hostClosed = true
      handlers.get('close')!()
    }
  }
  const close = async () => {
    closeHost()
    for (const gate of gates) {
      gate.resolve(null)
    }
    await Promise.all([...running])
    await deliveries
  }
  return {
    ui,
    hostPage,
    figma,
    nodes,
    healthy,
    wide,
    invalid,
    tall,
    draft,
    requests,
    responses,
    lookups,
    focused,
    writes,
    network,
    errors,
    timeline,
    gates,
    send,
    dispatch,
    hold,
    rescan,
    close,
    closeHost,
    flush: () => deliveries,
    settle: async (request: Message) => {
      await navigationOperations.get(request.requestId!)
      await deliveries
    },
    locates: () => requests.filter(message => message.type === 'locate'),
    currentScan: () => responses.filter(message => message.type === 'preflight').at(-1)!,
    changePage: () => {
      figma.currentPage = { id: 'page:other', name: 'Other page', type: 'PAGE', children: [], selection: [] }
      handlers.get('currentpagechange')!()
    },
    useServerNaming: async () => {
      projectContext = { ...projectContext, revision: 8, namingMode: 'server' }
      await dispatch({ type: 'console-status' })
      await deliveries
    },
  }
}
type Plugin = Awaited<ReturnType<typeof plugin>>
const test = base.extend<{ plugin: Plugin }>({
  plugin: async ({ page }, use, info) => {
    const instance = await plugin(page)
    try {
      await use(instance)
      expect(instance.errors).toEqual([])
      expect(instance.requests.filter(message => ['console-sync', 'dispatch', 'save-settings', 'console-pair'].includes(message.type))).toEqual([])
      expect(instance.writes.filter(write => write.key !== 'iconctl-preflight-preferences' && write.value !== undefined)).toEqual([])
    }
    finally {
      await instance.close()
      await writeFile(info.outputPath('problem-navigation-evidence.json'), JSON.stringify({ requests: instance.requests, responses: instance.responses, lookupIds: instance.lookups, focusedIds: instance.focused, selectionIds: instance.figma.currentPage.selection?.map(node => node.id), writes: instance.writes, network: instance.network, errors: instance.errors, timeline: instance.timeline }, null, 2))
    }
  },
})
const next = (plugin: Plugin) => plugin.ui.getByRole('button', { name: 'Next problem', exact: true })
const previous = (plugin: Plugin) => plugin.ui.getByRole('button', { name: 'Previous problem', exact: true })
const position = (plugin: Plugin) => plugin.ui.locator('#problem-position')
const navigation = (plugin: Plugin) => plugin.ui.getByRole('status', { name: 'Navigation status', exact: true })
const row = (plugin: Plugin, node: Node) => plugin.ui.locator('#list > li').filter({ has: plugin.ui.getByRole('button', { name: `Locate ${node.name}`, exact: true }) })

async function located(plugin: Plugin, node: Node, index: number, total = 3) {
  await expect(navigation(plugin)).toHaveText(`Located ${node.name}`)
  await expect(position(plugin)).toContainText(`${index} of ${total}`)
  await expect(row(plugin, node)).toHaveAttribute('aria-current', 'true')
  expect(plugin.focused.at(-1)).toBe(node.id)
  expect(plugin.hostPage.selection?.map(node => node.id)).toEqual([node.id])
}

test('walks components in scan order, counts multiple issues once, wraps and shares its cursor with row Locate', async ({ plugin }) => {
  expect(plugin.currentScan().items?.find(item => item.id === plugin.invalid.id)?.issues).toHaveLength(2)
  await expect(position(plugin)).toContainText('3')
  await expect(plugin.ui.locator('#list > li[aria-current="true"]')).toHaveCount(0)
  await next(plugin).click()
  await located(plugin, plugin.wide, 1)
  await next(plugin).click()
  await located(plugin, plugin.invalid, 2)
  await next(plugin).click()
  await located(plugin, plugin.tall, 3)
  await next(plugin).click()
  await located(plugin, plugin.wide, 1)
  await previous(plugin).click()
  await located(plugin, plugin.tall, 3)
  await row(plugin, plugin.wide).getByRole('button').click()
  await located(plugin, plugin.wide, 1)
  await next(plugin).click()
  await located(plugin, plugin.invalid, 2)
  await row(plugin, plugin.healthy).getByRole('button').click()
  await expect(navigation(plugin)).toHaveText('Located Arrow')
  await expect(plugin.ui.locator('#list > li[aria-current="true"]')).toHaveCount(0)
  await previous(plugin).click()
  await located(plugin, plugin.tall, 3)
  expect(plugin.lookups).not.toContain(plugin.draft.id)
  await expect(plugin.ui.locator('#status')).toHaveText('3 of 4 icons need fixes · 1 drafts skipped')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
})

test('searches real JSON and HTML report node IDs literally and intersects the visible problem set', async ({ page, plugin }, info) => {
  const downloaded = async (format: 'JSON' | 'HTML') => {
    const pending = page.waitForEvent('download')
    await plugin.ui.getByRole('button', { name: `Export ${format} report`, exact: true }).click()
    const download = await pending
    expect(await download.failure()).toBeNull()
    const path = info.outputPath(`problem-source.${format.toLowerCase()}`)
    await download.saveAs(path)
    return readFile(path, 'utf8')
  }
  const json = JSON.parse(await downloaded('JSON')) as { scanId: number, items: { id: string, skipped: boolean }[] }
  const html = await downloaded('HTML')
  const htmlIds = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    return [...document.querySelectorAll('article')].map(article => [...article.querySelectorAll('dt')].find(term => term.textContent === 'Node ID')?.nextElementSibling?.textContent)
  }, html)
  expect(htmlIds).toEqual(json.items.map(item => item.id))
  const id = json.items.find(item => item.id === hostileId)!.id
  expect(htmlIds).toContain(id)
  const search = plugin.ui.getByLabel('Search preflight', { exact: true })
  await search.fill(`  ${id.toLowerCase()}  `)
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  await expect(plugin.ui.locator('.node-id')).toHaveText(`ID: ${id}`)
  await expect(plugin.ui.locator('#list [data-injected], #list img')).toHaveCount(0)
  await next(plugin).click()
  await located(plugin, plugin.tall, 1, 1)
  await next(plugin).click()
  await located(plugin, plugin.tall, 1, 1)
  await previous(plugin).click()
  await located(plugin, plugin.tall, 1, 1)
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  await expect(plugin.ui.locator('#list > li[aria-current="true"]')).toHaveCount(0)
  await search.fill(plugin.healthy.id)
  await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
  await expect(next(plugin)).toBeDisabled()
  await expect(position(plugin)).toContainText(/match|filter/i)
  await plugin.ui.getByLabel('Problems only', { exact: true }).uncheck()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  await expect(next(plugin)).toBeDisabled()
  await row(plugin, plugin.healthy).getByRole('button').click()
  await expect(navigation(plugin)).toHaveText('Located Arrow')
  await search.fill(plugin.draft.id)
  await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
  await search.fill('.*')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  await expect(plugin.ui.locator('.node-id')).toHaveText(`ID: ${id}`)
  await search.fill('Canvas is 48')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(2)
  await previous(plugin).click()
  await located(plugin, plugin.invalid, 2, 2)
  await next(plugin).click()
  await located(plugin, plugin.wide, 1, 2)
  await expect(plugin.ui.locator('#status')).toHaveText('3 of 4 icons need fixes · 1 drafts skipped')
  expect(plugin.currentScan().scanId).toBe(json.scanId)
})

test('distinguishes no problems, one problem, empty scans and an invalid scan without changing submission eligibility', async ({ plugin }) => {
  plugin.hostPage.children = [plugin.healthy, plugin.draft]
  await plugin.rescan()
  await expect(next(plugin)).toBeDisabled()
  await expect(previous(plugin)).toBeDisabled()
  await expect(position(plugin)).toContainText(/no.*problem/i)
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  plugin.hostPage.children = [plugin.wide, plugin.draft]
  await plugin.rescan()
  await previous(plugin).click()
  await located(plugin, plugin.wide, 1, 1)
  await next(plugin).click()
  await located(plugin, plugin.wide, 1, 1)
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  plugin.hostPage.children = []
  await plugin.rescan()
  await expect(position(plugin)).toContainText(/no.*problem/i)
  await expect(next(plugin)).toBeDisabled()
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  plugin.changePage()
  await plugin.flush()
  await expect(position(plugin)).toContainText(/rescan|out of date|unavailable/i)
  await expect(next(plugin)).toBeDisabled()
})

test('only the last rapid next and previous intent can focus a node or finish the current request', async ({ plugin }) => {
  const first = plugin.hold(plugin.wide)
  const second = plugin.hold(plugin.invalid)
  const latest = plugin.hold(plugin.wide)
  await next(plugin).click()
  await expect.poll(() => first.started).toBe(true)
  await expect(position(plugin)).toContainText('1 of 3')
  await expect(next(plugin)).toBeEnabled()
  await expect(previous(plugin)).toBeEnabled()
  await next(plugin).click()
  await expect.poll(() => second.started).toBe(true)
  await expect(position(plugin)).toContainText('2 of 3')
  await previous(plugin).click()
  await expect.poll(() => latest.started).toBe(true)
  const request = plugin.locates().at(-1)!
  await plugin.send({ ...request, type: 'navigation-result', nodeId: plugin.tall.id, text: 'Wrong node', error: true })
  await expect(navigation(plugin)).toHaveText('Locating component…')
  latest.resolve(plugin.wide)
  await located(plugin, plugin.wide, 1)
  const response = plugin.responses.filter(message => message.type === 'navigation-result').at(-1)!
  await plugin.send({ ...response, text: 'Replayed failure', error: true })
  await expect(navigation(plugin)).toHaveText('Located Wide')
  first.resolve(plugin.wide)
  second.resolve(plugin.invalid)
  await Promise.all(plugin.locates().map(request => plugin.settle(request)))
  await expect.poll(() => plugin.focused).toEqual([plugin.wide.id])
  await plugin.flush()
  expect(plugin.responses.filter(message => message.type === 'navigation-result')).toHaveLength(1)
  expect(plugin.locates().map(message => message.nodeId)).toEqual([plugin.wide.id, plugin.invalid.id, plugin.wide.id])
})

for (const invalid of ['deleted', 'moved'] as const) {
  test(`keeps a ${invalid} node attempt in position and allows the next problem without stale selection`, async ({ plugin }) => {
    const gate = plugin.hold(plugin.wide)
    await next(plugin).click()
    await expect.poll(() => gate.started).toBe(true)
    if (invalid === 'deleted') {
      plugin.wide.removed = true
    }
    else {
      plugin.wide.parent = { id: 'page:elsewhere', name: 'Elsewhere', type: 'PAGE' }
    }
    gate.resolve(plugin.wide)
    await expect(navigation(plugin)).toContainText(invalid === 'deleted' ? 'no longer available' : 'moved to another page')
    await expect(position(plugin)).toContainText('1 of 3')
    await expect(row(plugin, plugin.wide)).toHaveAttribute('aria-current', 'true')
    expect(plugin.focused).toEqual([])
    await next(plugin).click()
    await located(plugin, plugin.invalid, 2)
  })
}

for (const trigger of ['filter', 'problems-only', 'rescan', 'rules', 'mode', 'page', 'disconnect', 'pagehide'] as const) {
  test(`invalidates an attempted problem and pending host lookup on ${trigger}`, async ({ plugin }) => {
    const gate = plugin.hold(plugin.wide)
    await next(plugin).click()
    await expect.poll(() => gate.started).toBe(true)
    const request = plugin.locates().at(-1)!
    const cancellations = plugin.requests.filter(message => message.type === 'cancel-navigation').length
    if (trigger === 'filter') {
      await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('Tall')
    }
    else if (trigger === 'problems-only') {
      await plugin.ui.getByLabel('Problems only', { exact: true }).check()
    }
    else if (trigger === 'rescan') {
      await plugin.rescan()
    }
    else if (trigger === 'rules') {
      await plugin.ui.getByText('Applied rules', { exact: true }).click()
      await plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
      await expect(plugin.ui.locator('#rules-status')).toContainText('Project rules applied')
    }
    else if (trigger === 'mode') {
      await plugin.ui.getByLabel('Connection mode').selectOption('github')
      await expect.poll(() => plugin.currentScan().appliedRules).toMatchObject({ mode: 'github' })
      await plugin.flush()
    }
    else if (trigger === 'page') {
      plugin.changePage()
      await plugin.flush()
    }
    else if (trigger === 'disconnect') {
      await plugin.ui.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(plugin.ui.locator('#console-status')).toContainText('Local connection removed')
    }
    else {
      await plugin.ui.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')))
    }
    await expect(plugin.ui.locator('#list > li[aria-current="true"]')).toHaveCount(0)
    if (trigger === 'filter' || trigger === 'problems-only' || trigger === 'pagehide') {
      // A late lookup must finish after cancellation crosses the iframe/host
      // bridge; a DOM update alone does not acknowledge postMessage delivery.
      await expect.poll(() => plugin.requests.filter(message => message.type === 'cancel-navigation').length).toBeGreaterThan(cancellations)
    }
    const text = await navigation(plugin).textContent()
    const cursor = await position(plugin).textContent()
    gate.resolve(plugin.wide)
    await plugin.settle(request)
    await plugin.send({ ...request, type: 'navigation-result', text: 'Late old component', error: false })
    await expect(navigation(plugin)).toHaveText(text!)
    await expect(position(plugin)).toHaveText(cursor!)
    expect(plugin.focused).toEqual([])
    if (trigger === 'page' || trigger === 'pagehide') {
      await expect(next(plugin)).toBeDisabled()
    }
    else {
      await expect(next(plugin)).toBeEnabled()
      await next(plugin).click()
      await located(plugin, trigger === 'filter' ? plugin.tall : plugin.wide, 1, trigger === 'filter' ? 1 : 3)
    }
  })
}

test('closes the actual host while a node lookup is pending without late focus or delivery', async ({ page, plugin }) => {
  const gate = plugin.hold(plugin.wide)
  await next(plugin).click()
  await expect.poll(() => gate.started).toBe(true)
  const request = plugin.locates().at(-1)!
  plugin.closeHost()
  await page.locator('iframe').evaluate(frame => frame.remove())
  gate.resolve(plugin.wide)
  await plugin.settle(request)
  expect(plugin.focused).toEqual([])
  expect(plugin.responses.filter(message => message.type === 'navigation-result')).toEqual([])
})

test('keeps server naming provisional and ongoing task state intact while navigating by keyboard at 420 by 560', async ({ page, plugin }, info: TestInfo) => {
  await plugin.useServerNaming()
  await plugin.send({ type: 'console-status', text: 'running · fetching', busy: true, connected: true, url: 'https://iconctl.icebreaker.top/app/?job=problem-task' })
  await previous(plugin).focus()
  await page.keyboard.press('Tab')
  await expect(next(plugin)).toBeFocused()
  await page.keyboard.press('Enter')
  await located(plugin, plugin.wide, 1)
  await expect(next(plugin)).toBeFocused()
  await page.keyboard.press('Space')
  await located(plugin, plugin.invalid, 2)
  await expect(next(plugin)).toBeFocused()
  await expect(plugin.ui.locator('#console-status')).toContainText('running · fetching')
  await expect(plugin.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=problem-task')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await expect(plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })).toBeEnabled()
  await expect(plugin.ui.getByRole('button', { name: 'Export HTML report', exact: true })).toBeEnabled()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await next(plugin).scrollIntoViewIfNeeded()
  await expect(next(plugin)).toBeInViewport()
  await expect(previous(plugin)).toBeInViewport()
  await page.locator('iframe').screenshot({ path: info.outputPath('problem-navigation-keyboard.png') })
  await row(plugin, plugin.tall).scrollIntoViewIfNeeded()
  await expect(row(plugin, plugin.tall).locator('.node-id')).toHaveText(`ID: ${hostileId}`)
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('problem-navigation-long-id.png') })
})

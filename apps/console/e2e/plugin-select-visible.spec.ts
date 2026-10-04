import type { Message, SvgFixture } from './plugin-svg-fixture'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import { installClipboard } from './clipboard-fixture'
import { mountSvg, rawSvg } from './plugin-svg-fixture'

const test = base.extend<{ plugin: SvgFixture, restoredTask: boolean }>({
  restoredTask: [false, { option: true }],
  plugin: async ({ page, restoredTask }, use, info) => {
    const fixture = await mountSvg(page, info, { restoredTask })
    try {
      await use(fixture)
    }
    finally { await fixture.close() }
  },
})
const select = (f: SvgFixture) => f.ui.getByRole('button', { name: 'Select visible components', exact: true })
const status = (f: SvgFixture) => f.ui.getByRole('status', { name: 'Navigation status', exact: true })
const search = (f: SvgFixture) => f.ui.getByLabel('Search preflight', { exact: true })
const category = (f: SvgFixture) => f.ui.getByRole('combobox', { name: 'Issue type', exact: true })
const ids = (f: SvgFixture) => f.first.selection.map(node => node.id).sort()
const latest = (f: SvgFixture) => f.responses.filter(message => message.type === 'preflight').at(-1)!
const selections = (f: SvgFixture) => f.requests.filter(message => message.type === 'select-visible')
async function settled(f: SvgFixture) {
  await f.settleHost()
  await f.flush()
}
async function mixed(f: SvgFixture) {
  f.arrow.name = 'Arrow Left'
  f.arrow.width = 64
  f.variant.parent!.name = 'Arrow'
  f.variant.name = 'Left'
  f.nested.name = 'brand-valid'
  f.setContext({ revision: 8, validate: { width: 32, height: 16, name: '^brand-', skipPrefix: ['_', '.'] } })
  await f.ui.locator('#applied-rules summary').click()
  await f.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
  await expect(f.ui.locator('#status')).toHaveText('2 of 3 icons need fixes · 1 drafts skipped')
  await settled(f)
}
async function selected(f: SvgFixture, expected: string[]) {
  await select(f).click()
  await expect(status(f)).toContainText(`Selected ${expected.length} visible`)
  expect(ids(f)).toEqual([...expected].sort())
  expect(f.selectionListeners()).toHaveLength(0)
  expect(f.selectionObservers.atWrite.every(count => count === 0)).toBe(true)
}
function holdMessages(f: SvgFixture, predicate: (message: Message) => boolean) {
  const original = f.host.ui.postMessage
  const held: Message[] = []
  f.host.ui.postMessage = (message) => {
    if (predicate(message)) {
      held.push(structuredClone(message))
    }
    else { original(message) }
  }
  return { held, release: () => original(held.shift()!), restore: () => {
    f.host.ui.postMessage = original
    for (const message of held.splice(0)) {
      original(message)
    }
  } }
}

test('selects the exact filtered component IDs once without zoom, mutation, network, storage or rescan', async ({ page, plugin: f }, info) => {
  await mixed(f)
  f.first.manualSelection([f.draft])
  await category(f).selectOption('duplicate-name')
  await f.ui.getByLabel('Problems only', { exact: true }).check()
  await search(f).fill('arrow-left')
  await expect(f.ui.locator('#list > li')).toHaveCount(2)
  const baseline = { network: [...f.network], writes: [...f.writes], scan: structuredClone(latest(f)), zoom: f.host.viewport.zoom, center: { ...f.host.viewport.center } }
  await select(f).focus()
  await page.keyboard.press('Enter')
  await expect(status(f)).toHaveText('Selected 2 visible components. Canvas zoom is unchanged.')
  expect(ids(f)).toEqual(['1:1', '2:1'])
  expect(f.first.selectionWrites).toEqual([['1:1', '2:1']])
  expect(selections(f)[0]).toMatchObject({ nodeIds: ['1:1', '2:1'], scanId: baseline.scan.scanId })
  expect(f.host.viewport.scrolls).toEqual([])
  expect({ network: f.network, writes: f.writes, scan: latest(f), zoom: f.host.viewport.zoom, center: f.host.viewport.center }).toEqual(baseline)
  await expect(f.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await expect(f.ui.getByRole('group', { name: 'Navigate visible components', exact: true })).toBeVisible()
  await expect(f.ui.locator('#selection-scope')).toHaveText('Current filtered list · Replaces canvas selection · Keeps zoom')
  await search(f).fill('no-match')
  await expect(select(f)).toBeDisabled()
  await select(f).dispatchEvent('click')
  expect(f.first.selectionWrites).toHaveLength(1)
  await f.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await selected(f, ['1:1', '2:1', '3:1'])
  expect(f.first.selectionWrites).toHaveLength(2)
  expect(f.host.viewport.scrolls).toEqual([])
  expect(await f.ui.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('visible-selection-420.png') })
})

test('validates serial lookups without partial writes and rejects a prior node reparented before commit', async ({ plugin: f }) => {
  f.first.manualSelection([f.draft])
  const first = f.holdLookup()
  const second = f.holdLookup()
  await select(f).click()
  await expect.poll(() => first.started).toBe(true)
  expect(second.started).toBe(false)
  expect(f.lookups).toEqual(['1:1'])
  first.resolve(f.arrow)
  await expect.poll(() => second.started).toBe(true)
  expect(f.first.selectionWrites).toEqual([])
  f.arrow.parent = f.variant
  second.resolve(f.variant)
  await expect(status(f)).toContainText('ancestor and its child')
  expect(f.first.selectionWrites).toEqual([])
  expect(ids(f)).toEqual([f.draft.id])
  expect(f.lookupPeak()).toBe(1)
  f.arrow.parent = f.first
  await selected(f, ['1:1', '2:1', '3:1'])
})

test('stops at an unavailable middle node with zero selection writes and recovers explicitly', async ({ plugin: f }) => {
  f.first.manualSelection([f.draft])
  const first = f.holdLookup()
  const second = f.holdLookup()
  await select(f).click()
  await expect.poll(() => first.started).toBe(true)
  first.resolve(f.arrow)
  await expect.poll(() => second.started).toBe(true)
  second.resolve(null)
  await expect(status(f)).toContainText('no longer available')
  expect(f.lookups).toEqual(['1:1', '2:1'])
  expect(f.first.selectionWrites).toEqual([])
  expect(ids(f)).toEqual([f.draft.id])
  await selected(f, ['1:1', '2:1', '3:1'])
})

for (const newest of ['Locate', 'Next problem'] as const) {
  test(`a newer ${newest} supersedes pending batch selection without waiting for its native lookup`, async ({ plugin: f }) => {
    await mixed(f)
    const pending = f.holdLookup()
    await select(f).click()
    await expect.poll(() => pending.started).toBe(true)
    await select(f).dispatchEvent('click')
    expect(selections(f)).toHaveLength(1)
    const queued = f.selectionListeners()[0]!
    if (newest === 'Locate') {
      await f.ui.getByRole('button', { name: /^Locate / }).last().click()
    }
    else { await f.ui.getByRole('button', { name: newest, exact: true }).click() }
    await expect(status(f)).toContainText('Located')
    const before = { selection: ids(f), writes: [...f.first.selectionWrites], zooms: [...f.host.viewport.scrolls], status: await status(f).textContent(), lookups: [...f.lookups] }
    queued()
    pending.resolve(f.arrow)
    await settled(f)
    expect({ selection: ids(f), writes: f.first.selectionWrites, zooms: f.host.viewport.scrolls, status: await status(f).textContent(), lookups: f.lookups }).toEqual(before)
    expect(f.selectionListeners()).toHaveLength(0)
  })
}

test('a new batch supersedes pending Locate and rejects mismatched result operations', async ({ plugin: f }) => {
  const pending = f.holdLookup()
  await f.ui.getByRole('button', { name: /^Locate / }).first().click()
  await expect.poll(() => pending.started).toBe(true)
  const next = f.holdLookup()
  await select(f).click()
  await expect.poll(() => next.started).toBe(true)
  const message = selections(f).at(-1)!
  await f.send({ type: 'navigation-result', nodeId: f.arrow.id, scanId: message.scanId, requestId: message.requestId, text: 'Wrong operation', error: false })
  await expect(status(f)).toContainText('Checking')
  next.resolve(f.arrow)
  await expect(status(f)).toContainText('Selected 3 visible')
  pending.resolve(f.arrow)
  await settled(f)
  expect(f.first.selectionWrites).toEqual([['1:1', '2:1', '3:1']])
  expect(f.host.viewport.scrolls).toEqual([])
  await expect(status(f)).not.toContainText('Wrong operation')
})

for (const delivered of [true, false]) {
  test(`preserves manual canvas selection ${delivered ? 'with selectionchange cancellation' : 'before its event arrives'}`, async ({ plugin: f }) => {
    f.first.manualSelection([f.draft])
    const pending = f.holdLookup()
    await select(f).click()
    await expect.poll(() => pending.started).toBe(true)
    f.first.manualSelection([f.nested])
    if (delivered) {
      f.emitSelection()
    }
    pending.resolve(f.arrow)
    await expect(status(f)).toContainText('Selection changed. Select this view again.')
    expect(f.first.selectionWrites).toEqual([])
    expect(ids(f)).toEqual([f.nested.id])
    expect(f.selectionListeners()).toHaveLength(0)
    await selected(f, ['1:1', '2:1', '3:1'])
    expect(f.selectionObservers.atWrite).toEqual([0])
  })
}

test('compares selection as sets and prevents queued old observers from cancelling a newer selection', async ({ plugin: f }) => {
  f.first.manualSelection([f.arrow, f.nested])
  const old = f.holdLookup()
  await select(f).click()
  await expect.poll(() => old.started).toBe(true)
  const queued = f.selectionListeners()[0]!
  await search(f).fill('arrow')
  const current = f.holdLookup()
  await select(f).click()
  await expect.poll(() => current.started).toBe(true)
  f.first.manualSelection([f.nested, f.arrow])
  queued()
  expect(f.selectionListeners()).toHaveLength(1)
  current.resolve(f.arrow)
  await expect(status(f)).toContainText('Selected 1 visible')
  old.resolve(f.arrow)
  await settled(f)
  expect(f.first.selectionWrites).toEqual([[f.arrow.id]])
  expect(f.selectionListeners()).toHaveLength(0)
  await expect(status(f)).toContainText('Selected 1 visible')
})

for (const failure of ['throw', 'partial'] as const) {
  test(`reports native setter ${failure} without rollback or automatic retry`, async ({ plugin: f }) => {
    f.first.manualSelection([f.draft])
    f.first.selectionControl.mode = failure
    await select(f).click()
    await expect(status(f)).toHaveText('Figma could not confirm the complete selection. Check the canvas selection before trying again.')
    expect(f.first.selectionWrites).toHaveLength(1)
    expect(ids(f)).toEqual(failure === 'throw' ? [f.draft.id] : [f.arrow.id])
    expect(f.host.viewport.scrolls).toEqual([])
    expect(f.selectionListeners()).toHaveLength(0)
    f.first.selectionControl.mode = 'normal'
    await selected(f, ['1:1', '2:1', '3:1'])
    expect(f.first.selectionWrites).toHaveLength(2)
  })
}

test('late restored preferences cancel the old batch while keeping its accepted scan usable', async ({ plugin: f }) => {
  await mixed(f)
  const original = f.host.clientStorage.getAsync
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.clientStorage.getAsync = async (key) => {
    if (key === 'iconctl-preflight-preferences') {
      await gate
      return { problemsOnly: true }
    }
    return original(key)
  }
  const restore = f.dispatch({ type: 'load-settings' })
  try {
    const pending = f.holdLookup()
    await select(f).click()
    await expect.poll(() => pending.started).toBe(true)
    release()
    await restore
    await expect(f.ui.getByLabel('Problems only', { exact: true })).toBeChecked()
    await expect(f.ui.locator('#list > li')).toHaveCount(2)
    pending.resolve(f.arrow)
    await settled(f)
    expect(f.first.selectionWrites).toEqual([])
    await expect(status(f)).toBeEmpty()
    await selected(f, ['1:1', '2:1'])
  }
  finally {
    release()
    await restore
    f.host.clientStorage.getAsync = original
  }
})

test('page A to B to A and failed rules never revive a cancelled batch before a fresh accepted scan', async ({ plugin: f }) => {
  const pending = f.holdLookup()
  await select(f).click()
  await expect.poll(() => pending.started).toBe(true)
  f.changePage()
  f.changePage(f.first)
  await f.flush()
  await expect(select(f)).toBeDisabled()
  pending.resolve(f.arrow)
  await settled(f)
  expect(f.first.selectionWrites).toEqual([])
  await f.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(select(f)).toBeEnabled()
  await f.ui.locator('#applied-rules summary').click()
  const context = f.holdNetwork('context')
  const refresh = f.ui.getByRole('button', { name: 'Refresh project rules', exact: true })
  await refresh.click()
  await expect.poll(() => context.started).toBe(true)
  await expect(select(f)).toBeDisabled()
  context.resolve(new Response('Unavailable', { status: 503 }))
  await expect(refresh).toBeEnabled()
  await expect(select(f)).toBeDisabled()
  await refresh.click()
  await expect(select(f)).toBeEnabled()
  await selected(f, ['1:1', '2:1', '3:1'])
})

for (const closes of ['pagehide', 'host-close'] as const) {
  test(`cleans temporary observers and ignores late lookup after ${closes}`, async ({ plugin: f }) => {
    const pending = f.holdLookup()
    await select(f).click()
    await expect.poll(() => pending.started).toBe(true)
    await search(f).focus()
    if (closes === 'pagehide') {
      await f.ui.locator('body').evaluate(() => dispatchEvent(new Event('pagehide')))
      await expect.poll(() => f.selectionListeners().length).toBe(0)
    }
    else { f.closeHost() }
    await f.ui.locator('body').evaluate(() => {
      const data = { mutations: 0, focused: document.activeElement }
      new MutationObserver(records => data.mutations += records.length).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      Object.assign(window, { selectionDisposed: data })
    })
    pending.resolve(f.arrow)
    await settled(f)
    expect(f.first.selectionWrites).toEqual([])
    expect(f.selectionListeners()).toHaveLength(0)
    expect(await f.ui.locator('body').evaluate(() => {
      const data = (window as unknown as { selectionDisposed: { mutations: number, focused: Element | null } }).selectionDisposed
      return { mutations: data.mutations, focus: data.focused === document.activeElement }
    })).toEqual({ mutations: 0, focus: true })
  })
}

test('selection keeps a pending names write and complete JSON and HTML reports independent', async ({ page, plugin: f }, info) => {
  await mixed(f)
  await category(f).selectOption('canvas-size')
  const copy = await installClipboard(f.ui.locator('body'), 'pending')
  try {
    await f.ui.getByRole('button', { name: 'Copy visible names JSON', exact: true }).click()
    const scan = structuredClone(latest(f))
    const network = [...f.network]
    const writes = [...f.writes]
    for (const format of ['json', 'html'] as const) {
      const gate = holdMessages(f, message => message.type === 'preflight-report')
      try {
        await f.ui.getByRole('button', { name: `Export ${format.toUpperCase()} report`, exact: true }).click()
        await expect.poll(() => gate.held.length).toBe(1)
        await selected(f, [f.arrow.id])
        expect((await copy.evidence()).active).toBe(1)
        const next = page.waitForEvent('download')
        gate.release()
        const download = await next
        expect(await download.failure()).toBeNull()
        const path = info.outputPath(`selection-full-report.${format}`)
        await download.saveAs(path)
        const content = await readFile(path, 'utf8')
        if (format === 'json') {
          const report = JSON.parse(content)
          expect(report.items).toEqual(scan.items)
          expect(report.summary).toMatchObject({ total: 4, issueCount: 5 })
        }
        else {
          expect(content).toMatch(/brand-valid/)
          expect(content).toMatch(/_Draft/)
        }
      }
      finally { gate.restore() }
    }
    expect(latest(f)).toEqual(scan)
    expect(f.network).toEqual(network)
    expect(f.writes).toEqual(writes)
    await copy.settle(0, true)
    await expect(f.ui.getByLabel('Names copy status', { exact: true })).toContainText('Copied 1 unique local names')
  }
  finally {
    await copy.releaseAll()
    await writeFile(info.outputPath('selection-clipboard-evidence.json'), JSON.stringify(await copy.evidence(), null, 2))
  }
})

test('actual whole-page SVG export accepts a new scan and remains complete after selecting a subset', async ({ page, plugin: f }, info) => {
  await search(f).fill('arrow')
  const lookup = f.holdLookup()
  await select(f).click()
  await expect.poll(() => lookup.started).toBe(true)
  const native = f.holdExport()
  const next = page.waitForEvent('download')
  await f.ui.getByRole('button', { name: 'Export SVG ZIP', exact: true }).click()
  await expect.poll(() => native.started).toBe(true)
  lookup.resolve(f.arrow)
  await expect(select(f)).toBeEnabled()
  expect(f.first.selectionWrites).toEqual([])
  await selected(f, [f.arrow.id])
  native.resolve(rawSvg)
  const download = await next
  expect(await download.failure()).toBeNull()
  const path = info.outputPath('selection-full-svg.zip')
  await download.saveAs(path)
  const exec = promisify(execFile)
  expect((await exec('unzip', ['-Z1', path])).stdout.trim().split('\n')).toEqual(['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg', 'raw-svg/nested-icon.svg'])
  expect((await exec('unzip', ['-t', path])).stdout).toContain('No errors detected')
  expect(f.exports).toHaveLength(3)
  expect(f.peak()).toBe(1)
})

test.describe('restored task', () => {
  test.use({ restoredTask: true })
  test('selection preserves a single active poll and terminal task tracking', async ({ plugin: f }) => {
    await expect.poll(() => f.job?.started).toBe(true)
    const before = [...f.network]
    await selected(f, ['1:1', '2:1', '3:1'])
    expect(f.network).toEqual(before)
    f.job!.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await expect(f.ui.locator('#console-status')).toContainText('succeeded · complete')
    expect(f.network.filter(request => request.url.endsWith('/jobs/running-task'))).toHaveLength(1)
    await expect(f.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toBeVisible()
  })
})

test('rejects an oversized visible view in the UI and recovers by narrowing its actual scan', async ({ plugin: f }) => {
  for (let index = 0; index < 498; index++) {
    const node = { id: `limit:${index}`, name: `Limit ${index}`, type: 'COMPONENT', width: 32, height: 16, parent: f.first }
    f.nodes.set(node.id, node)
    f.first.children.push(node)
  }
  await f.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(f.ui.locator('#list > li')).toHaveCount(501)
  await expect(select(f)).toBeDisabled()
  await expect(f.ui.locator('#selection-help')).toHaveText('This view exceeds 500 components. Narrow the filters before selecting.')
  await select(f).dispatchEvent('click')
  expect(selections(f)).toHaveLength(0)
  expect(f.first.selectionWrites).toEqual([])
  expect(await f.ui.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await search(f).fill('arrow')
  await selected(f, [f.arrow.id])
})

for (const invalidation of ['live edit', 'connection mode'] as const) {
  test(`invalidates a pending batch through ${invalidation} and accepts only its new scan`, async ({ plugin: f }) => {
    if (invalidation === 'live edit') {
      await f.ui.getByLabel('Live preflight', { exact: true }).check()
      await expect(f.ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
    }
    const pending = f.holdLookup()
    await select(f).click()
    await expect.poll(() => pending.started).toBe(true)
    const scanId = latest(f).scanId!
    if (invalidation === 'live edit') {
      f.arrow.name = 'Renamed Arrow'
      f.first.emit('PROPERTY_CHANGE', ['name'])
    }
    else {
      await f.ui.getByRole('combobox', { name: 'Connection mode', exact: true }).selectOption('github')
    }
    await expect.poll(() => latest(f).scanId!).toBeGreaterThan(scanId)
    await expect(select(f)).toBeEnabled()
    expect(f.selectionListeners()).toHaveLength(0)
    pending.resolve(f.arrow)
    await settled(f)
    expect(f.first.selectionWrites).toEqual([])
    await selected(f, ['1:1', '2:1', '3:1'])
    expect(f.host.viewport.scrolls).toEqual([])
  })
}

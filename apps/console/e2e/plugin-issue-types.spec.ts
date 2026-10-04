import type { inspectComponents } from '@iconctl/figma-plugin'
import type { Message, SvgFixture } from './plugin-svg-fixture'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import { mountSvg, rawSvg } from './plugin-svg-fixture'

type PreflightItem = ReturnType<typeof inspectComponents>[number]

const test = base.extend<{ plugin: SvgFixture }>({
  plugin: async ({ page }, use, info) => {
    const fixture = await mountSvg(page, info)
    try {
      await use(fixture)
    }
    finally {
      await fixture.close()
    }
  },
})

const category = (f: SvgFixture) => f.ui.getByRole('combobox', { name: 'Issue type', exact: true })
const search = (f: SvgFixture) => f.ui.getByLabel('Search preflight', { exact: true })
const problems = (f: SvgFixture) => f.ui.getByLabel('Problems only', { exact: true })
const svgButton = (f: SvgFixture) => f.ui.getByRole('button', { name: 'Export SVG ZIP', exact: true })
const reportButton = (f: SvgFixture, format: 'json' | 'html') => f.ui.getByRole('button', { name: format === 'json' ? 'Export JSON report' : 'Export HTML report', exact: true })
const latest = (f: SvgFixture) => f.responses.filter(message => message.type === 'preflight').at(-1)! as Message & { items: PreflightItem[] }
const rows = (f: SvgFixture) => f.ui.locator('#list > li')
const rowNames = (f: SvgFixture) => f.ui.locator('#list > li > strong')
const options = (f: SvgFixture) => category(f).locator('option')

async function mixed(f: SvgFixture) {
  f.arrow.name = 'Arrow Left'
  f.arrow.width = 64
  f.variant.parent!.name = 'Arrow'
  f.variant.name = 'Left'
  f.nested.name = 'brand-valid'
  f.draft.width = 999
  f.setContext({ revision: 8, validate: { width: 32, height: 16, name: '^brand-', skipPrefix: ['_', '.'] } })
  await f.ui.locator('#applied-rules summary').click()
  await f.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
  await expect(options(f)).toHaveText(['All issue types', 'Naming (2 components)', 'Canvas size (1 component)', 'Duplicate names (2 components)'])
  await expect(f.ui.locator('#status')).toHaveText('2 of 3 icons need fixes · 1 drafts skipped')
  await f.flush()
  const items = latest(f).items
  expect(items.map(item => item.diagnostics?.map(diagnostic => diagnostic.code))).toEqual([
    ['name-rule', 'canvas-size', 'duplicate-name'],
    ['name-rule', 'duplicate-name'],
    [],
    [],
  ])
  expect(items.every(item => JSON.stringify(item.issues) === JSON.stringify(item.diagnostics?.map(diagnostic => diagnostic.message)))).toBe(true)
  return structuredClone(latest(f))
}

function holdResponses(f: SvgFixture, predicate: (message: Message) => boolean) {
  const original = f.host.ui.postMessage
  const held: Message[] = []
  f.host.ui.postMessage = (message) => {
    if (predicate(message)) {
      held.push(structuredClone(message))
    }
    else {
      original(message)
    }
  }
  return {
    held,
    release() {
      const message = held.shift()
      expect(message).toBeDefined()
      original(message!)
    },
    restore() {
      f.host.ui.postMessage = original
      for (const message of held.splice(0)) {
        original(message)
      }
    },
  }
}

test('intersects actual naming, canvas and duplicate categories without changing whole-page counts or eligibility', async ({ plugin }, info) => {
  const scan = await mixed(plugin)
  const before = { requests: plugin.requests.length, network: [...plugin.network], writes: [...plugin.writes] }
  await category(plugin).selectOption('duplicate-name')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left', 'Left'])
  await search(plugin).fill('  ARROW-LEFT  ')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left', 'Left'])
  await category(plugin).selectOption('canvas-size')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left'])
  await search(plugin).fill('2:1')
  await expect(rows(plugin)).toHaveCount(0)
  await expect(plugin.ui.locator('#view-count')).toHaveText('Showing 0 of 3 icons')
  await expect(plugin.ui.locator('#problem-position')).toHaveText('No problems match these filters.')
  await expect(options(plugin)).toHaveText(['All issue types', 'Naming (2 components)', 'Canvas size (1 component)', 'Duplicate names (2 components)'])
  expect(plugin.network).toEqual(before.network)
  expect(plugin.writes).toEqual(before.writes)
  expect(plugin.requests.slice(before.requests).every(message => message.type === 'cancel-navigation')).toBe(true)
  expect(latest(plugin)).toEqual(scan)

  await problems(plugin).check()
  await category(plugin).selectOption('name-rule')
  await search(plugin).fill('64×16')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left'])
  await search(plugin).fill('name-rule')
  await expect(rows(plugin)).toHaveCount(0)
  await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(category(plugin)).toHaveValue('all')
  await expect(problems(plugin)).not.toBeChecked()
  await expect(search(plugin)).toHaveValue('')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left', 'Left', 'brand-valid'])
  await search(plugin).fill('brand-valid')
  await expect(rowNames(plugin)).toHaveText(['brand-valid'])
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await expect(svgButton(plugin)).toBeDisabled()
  await expect(reportButton(plugin, 'json')).toBeEnabled()
  await expect(reportButton(plugin, 'html')).toBeEnabled()
  await writeFile(info.outputPath('issue-types-native-scan.json'), JSON.stringify(scan, null, 2))
})

test('uses actual server naming rules without inventing local naming or duplicate failures', async ({ plugin }) => {
  await mixed(plugin)
  await category(plugin).selectOption('duplicate-name')
  plugin.setContext({ revision: 9, namingMode: 'server' })
  await plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
  await expect(options(plugin)).toHaveText(['All issue types', 'Naming (0 components)', 'Canvas size (1 component)', 'Duplicate names (0 components)'])
  await expect(category(plugin)).toHaveValue('duplicate-name')
  await expect(rows(plugin)).toHaveCount(0)
  expect(latest(plugin).items.map(item => item.diagnostics?.map(diagnostic => diagnostic.code))).toEqual([['canvas-size'], [], [], []])
  plugin.arrow.width = 32
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(plugin.ui.locator('#status')).toHaveText('3 icons ready · 1 drafts skipped')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  await expect(svgButton(plugin)).toBeDisabled()
  await expect(plugin.ui.locator('#svg-handoff-help')).toContainText('Custom names require a console sync.')
  await expect(rows(plugin)).toHaveCount(0)
})

test('maps legacy and unknown metadata to Other and retains Other with zero matches through real rescan and live updates', async ({ plugin }, info) => {
  const scan = await mixed(plugin)
  // Compatibility messages deliberately represent older or newer hosts. All
  // ordinary category coverage above comes from this shipped host's real scan.
  const compatibility = structuredClone(scan)
  delete compatibility.rulesRequestId
  delete compatibility.items[0]!.diagnostics
  compatibility.items[1]!.diagnostics![0]!.code = 'future-rule'
  compatibility.items[2]!.diagnostics = [{ code: 'future-rule', message: 'Metadata must not invent an issue' }]
  await plugin.send(compatibility)
  await expect(options(plugin)).toHaveText(['All issue types', 'Naming (0 components)', 'Canvas size (0 components)', 'Duplicate names (1 component)', 'Other (2 components)'])
  await category(plugin).selectOption('other')
  await expect(rowNames(plugin)).toHaveText(['Arrow Left', 'Left'])
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(category(plugin)).toHaveValue('other')
  await expect(options(plugin)).toContainText(['Other (0 components)'])
  await expect(rows(plugin)).toHaveCount(0)
  await expect(plugin.ui.getByRole('button', { name: 'Clear filters', exact: true })).toBeEnabled()
  await plugin.ui.getByLabel('Live preflight', { exact: true }).check()
  await expect(plugin.ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
  const prior = latest(plugin).scanId!
  plugin.arrow.width = 32
  plugin.first.emit('PROPERTY_CHANGE', ['width'])
  await expect.poll(() => latest(plugin).scanId!).toBeGreaterThan(prior)
  await plugin.flush()
  await expect(category(plugin)).toHaveValue('other')
  await expect(options(plugin)).toContainText(['Other (0 components)'])
  await expect(rows(plugin)).toHaveCount(0)
  await writeFile(info.outputPath('issue-types-compatibility.json'), JSON.stringify({ compatibility, restored: latest(plugin) }, null, 2))
  await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(category(plugin)).toHaveValue('all')
  await expect(category(plugin).locator('option[value="other"]')).toHaveCount(0)
  await expect(rowNames(plugin)).toHaveText(['Arrow Left', 'Left', 'brand-valid'])
})

test('keeps a session category while a real delayed storage restore still applies Problems only', async ({ plugin }) => {
  await mixed(plugin)
  const get = plugin.host.clientStorage.getAsync
  let release!: (value: unknown) => void
  const held = new Promise<unknown>((resolve) => {
    release = resolve
  })
  let entered = false
  plugin.host.clientStorage.getAsync = async (key) => {
    if (key === 'iconctl-preflight-preferences') {
      entered = true
      return held
    }
    return get(key)
  }
  const loading = plugin.dispatch({ type: 'load-settings' })
  try {
    await expect.poll(() => entered).toBe(true)
    const writes = [...plugin.writes]
    const network = [...plugin.network]
    await category(plugin).selectOption('canvas-size')
    release({ problemsOnly: true, issueType: 'duplicate-name' })
    await loading
    await plugin.flush()
    await expect(problems(plugin)).toBeChecked()
    await expect(category(plugin)).toHaveValue('canvas-size')
    await expect(rowNames(plugin)).toHaveText(['Arrow Left'])
    expect(plugin.writes).toEqual(writes)
    expect(plugin.network).toEqual(network)
    await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect.poll(() => plugin.stored.get('iconctl-preflight-preferences')).toEqual({ problemsOnly: false })
    await expect(category(plugin)).toHaveValue('all')
  }
  finally {
    release({ problemsOnly: false })
    plugin.host.clientStorage.getAsync = get
    await loading
  }
})

test('restricts previous and next to the category and cancels a pending Locate before its native lookup can focus', async ({ plugin }) => {
  await mixed(plugin)
  const focused: string[][] = []
  plugin.host.viewport.scrollAndZoomIntoView = () => focused.push(plugin.first.selection.map(node => node.id))
  const previous = plugin.ui.getByRole('button', { name: 'Previous problem', exact: true })
  const next = plugin.ui.getByRole('button', { name: 'Next problem', exact: true })
  await category(plugin).selectOption('duplicate-name')
  await previous.click()
  await expect.poll(() => plugin.first.selection.map(node => node.id)).toEqual([plugin.variant.id])
  await expect(plugin.ui.locator('#problem-position')).toHaveText('Problem 2 of 2')
  const pending = plugin.holdLookup()
  await next.click()
  await expect.poll(() => pending.started).toBe(true)
  await category(plugin).selectOption('canvas-size')
  await expect(plugin.ui.locator('#navigation-status')).toHaveText('')
  pending.resolve(plugin.arrow)
  await plugin.settleHost()
  await plugin.flush()
  expect(focused).toEqual([[plugin.variant.id]])
  expect(plugin.first.selection.map(node => node.id)).toEqual([plugin.variant.id])
  await expect(plugin.ui.locator('#navigation-status')).toHaveText('')
  await next.click()
  await expect.poll(() => focused).toEqual([[plugin.variant.id], [plugin.arrow.id]])
  await expect(plugin.ui.locator('#problem-position')).toHaveText('Problem 1 of 1')
  await previous.click()
  await expect.poll(() => focused).toHaveLength(3)
  expect(focused.at(-1)).toEqual([plugin.arrow.id])
})

for (const format of ['json', 'html'] as const) {
  test(`preserves the complete immutable ${format} report while categories change during its response`, async ({ page, plugin }, info) => {
    const scan = await mixed(plugin)
    const gate = holdResponses(plugin, message => message.type === 'preflight-report')
    try {
      await category(plugin).selectOption('name-rule')
      const writes = [...plugin.writes]
      const network = [...plugin.network]
      await reportButton(plugin, format).click()
      await expect.poll(() => gate.held.length).toBe(1)
      const original = structuredClone(gate.held[0]!)
      await category(plugin).selectOption('canvas-size')
      await search(plugin).fill('cannot-match')
      await expect(rows(plugin)).toHaveCount(0)
      await expect(reportButton(plugin, 'json')).toBeDisabled()
      await expect(reportButton(plugin, 'html')).toBeDisabled()
      plugin.arrow.name = 'Changed after captured scan'
      const pending = page.waitForEvent('download')
      gate.release()
      const download = await pending
      const file = info.outputPath(`complete-categories.${format}`)
      await download.saveAs(file)
      expect(await download.failure()).toBeNull()
      const text = await readFile(file, 'utf8')
      expect(text).not.toMatch(/Changed after captured scan|fixture-device-token|fixture-github-token/)
      expect(text).toBe(`${format === 'json' ? original.json : original.html}\n`)
      if (format === 'json') {
        const report = JSON.parse(text) as { schemaVersion: number, summary: Record<string, number | boolean>, items: PreflightItem[] }
        expect(report.schemaVersion).toBe(1)
        expect(report.summary).toEqual({ total: 4, checked: 3, skipped: 1, withIssues: 2, issueCount: 5, canSubmit: false })
        expect(report.items).toEqual(scan.items)
        for (const item of report.items) {
          expect(item.diagnostics?.map(diagnostic => diagnostic.message)).toEqual(item.issues)
          for (const diagnostic of item.diagnostics ?? []) {
            expect(Object.keys(diagnostic).sort()).toEqual(['code', 'message'])
          }
        }
      }
      else {
        expect(text).toContain('Arrow Left')
        expect(text).toContain('brand-valid')
        expect(text).toContain('_Draft')
        expect(text).toContain('64×16')
        expect(text).not.toContain('name-rule')
        expect(text).not.toContain('duplicate-name')
      }
      await expect.poll(async () => plugin.ui.locator('body').evaluate(() => (window as unknown as { svgResources: { active: string[] } }).svgResources.active)).toEqual([])
      await expect(plugin.ui.locator('a[download]')).toHaveCount(0)
      expect(plugin.writes).toEqual(writes)
      expect(plugin.network).toEqual(network)
      expect(plugin.requests.filter(message => message.type === 'export-report')).toHaveLength(1)
    }
    finally {
      gate.restore()
    }
  })
}

test('keeps a whole-page SVG export alive across category changes during native work, ready and file delivery', async ({ page, plugin }, info) => {
  const native = plugin.holdExport()
  const gate = holdResponses(plugin, message => (message.type === 'svg-handoff-status' && message.state === 'ready') || message.type === 'svg-handoff-files')
  try {
    await category(plugin).selectOption('name-rule')
    await expect(rows(plugin)).toHaveCount(0)
    await expect(svgButton(plugin)).toBeEnabled()
    const writes = [...plugin.writes]
    const network = [...plugin.network]
    const cancelled = plugin.requests.filter(message => message.type === 'cancel-svg-handoff').length
    await svgButton(plugin).click()
    await expect.poll(() => native.started).toBe(true)
    await category(plugin).selectOption('canvas-size')
    expect(plugin.inFlight()).toBe(1)
    expect(plugin.first.listeners.size).toBe(1)
    native.resolve(rawSvg)
    await expect.poll(() => gate.held[0]?.state).toBe('ready')
    await category(plugin).selectOption('duplicate-name')
    gate.release()
    await expect.poll(() => gate.held[0]?.type).toBe('svg-handoff-files')
    await category(plugin).selectOption('all')
    await category(plugin).selectOption('canvas-size')
    const pending = page.waitForEvent('download')
    gate.release()
    const download = await pending
    const file = info.outputPath('categories-whole-page.zip')
    await download.saveAs(file)
    expect(await download.failure()).toBeNull()
    await expect(plugin.ui.getByLabel('SVG handoff status', { exact: true })).toContainText('Download started for 3 raw SVGs.')
    const exec = promisify(execFile)
    const entries = ['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg', 'raw-svg/nested-icon.svg']
    expect((await exec('unzip', ['-Z1', file])).stdout.trim().split('\n')).toEqual(entries)
    expect((await exec('unzip', ['-t', file])).stdout).toContain('No errors detected')
    for (const entry of entries) {
      expect((await exec('unzip', ['-p', file, entry])).stdout).toBe(rawSvg)
    }
    expect(plugin.requests.filter(message => message.type === 'cancel-svg-handoff')).toHaveLength(cancelled)
    expect(plugin.exports.map(item => item.id)).toEqual(['2:1', '1:1', '3:1'])
    expect(plugin.peak()).toBe(1)
    expect(plugin.writes).toEqual(writes)
    expect(plugin.network).toEqual(network)
    await expect.poll(() => plugin.first.listeners.size).toBe(0)
    await expect(rows(plugin)).toHaveCount(0)
    await expect(svgButton(plugin)).toBeEnabled()
  }
  finally {
    native.resolve(rawSvg)
    gate.restore()
  }
})

test('keeps long native diagnostic text inert and category navigation reachable by keyboard at 420px', async ({ page, plugin }, info) => {
  await mixed(plugin)
  plugin.arrow.name = `Long <img data-injected="category" src=x> ${'unbroken'.repeat(40)}`
  const previousScan = latest(plugin).scanId!
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect.poll(() => latest(plugin).scanId!).toBeGreaterThan(previousScan)
  await plugin.flush()
  await expect(options(plugin)).toContainText(['Naming (2 components)'])
  await category(plugin).focus()
  await expect(category(plugin)).toBeFocused()
  // Native select typeahead works across headless macOS and Linux Chromium.
  await page.keyboard.press('n')
  await expect(category(plugin)).toHaveValue('name-rule')
  await expect(category(plugin)).toBeFocused()
  await expect(category(plugin)).toBeInViewport()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('issue-types-keyboard.png') })
  const next = plugin.ui.getByRole('button', { name: 'Next problem', exact: true })
  await next.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => plugin.first.selection.map(node => node.id)).toEqual([plugin.arrow.id])
  await expect(next).toBeFocused()
  await expect(plugin.ui.locator('#list [data-injected], #list img, #list script')).toHaveCount(0)
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('issue-types-long-diagnostic.png') })
})

test('preserves a restored task and its one pending poll while category filters change', async ({ page }, info) => {
  const plugin = await mountSvg(page, info, { restoredTask: true })
  try {
    await expect.poll(() => plugin.job?.started).toBe(true)
    const network = [...plugin.network]
    const writes = [...plugin.writes]
    const status = await plugin.ui.locator('#console-status').textContent()
    await category(plugin).selectOption('name-rule')
    await category(plugin).selectOption('canvas-size')
    await expect(plugin.ui.locator('#console-status')).toHaveText(status!)
    expect(plugin.network).toEqual(network)
    expect(plugin.writes).toEqual(writes)
    plugin.job!.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await expect(plugin.ui.locator('#console-status')).toContainText('succeeded · complete')
    await expect(plugin.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toBeVisible()
    await expect(category(plugin)).toHaveValue('canvas-size')
    expect(plugin.network.filter(request => request.url.endsWith('/jobs/running-task'))).toHaveLength(1)
  }
  finally {
    await plugin.close()
  }
})

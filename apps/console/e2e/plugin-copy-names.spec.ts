import type { inspectComponents } from '@iconctl/figma-plugin'
import type { Page, TestInfo } from '@playwright/test'
import type { ClipboardFixture, ClipboardMode } from './clipboard-fixture'
import type { Message, SvgFixture } from './plugin-svg-fixture'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import { installClipboard } from './clipboard-fixture'
import { mountSvg, rawSvg } from './plugin-svg-fixture'

type Item = ReturnType<typeof inspectComponents>[number]
interface Plugin { host: SvgFixture, clipboard: ClipboardFixture }
const test = base.extend<{ plugin: Plugin, clipboardMode: ClipboardMode, clipboardPolicy: 'legacy' | 'allow' | 'deny', restoredTask: boolean }>({
  clipboardMode: ['success', { option: true }],
  clipboardPolicy: ['legacy', { option: true }],
  restoredTask: [false, { option: true }],
  plugin: async ({ page, context, clipboardMode, clipboardPolicy, restoredTask }, use, info) => {
    const url = new URL('/__fixtures/plugin-clipboard', info.project.use.baseURL).href
    if (clipboardPolicy === 'allow') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin })
    }
    const host = await mountSvg(page, info, { restoredTask, ...(clipboardPolicy === 'legacy' ? {} : { clipboardDocument: { url, deny: clipboardPolicy === 'deny' } }) })
    await host.flush()
    const clipboard = await installClipboard(host.ui.locator('body'), clipboardMode)
    try {
      await use({ host, clipboard })
    }
    finally {
      await clipboard.releaseAll()
      const evidence = await clipboard.evidence()
      await writeFile(info.outputPath('names-clipboard-evidence.json'), JSON.stringify({ ...evidence, browserVersion: context.browser()?.version(), permissionGrant: clipboardPolicy === 'allow' ? ['clipboard-read', 'clipboard-write'] : [] }, null, 2))
      await host.close()
      expect(evidence.active).toBe(0)
      expect(evidence.peak).toBeLessThanOrEqual(1)
      expect([evidence.readCalls, evidence.permissionCalls, evidence.execCalls]).toEqual([0, 0, 0])
    }
  },
})
const button = (p: Plugin) => p.host.ui.getByRole('button', { name: 'Copy visible names JSON', exact: true })
const status = (p: Plugin) => p.host.ui.getByLabel('Names copy status', { exact: true })
const text = (p: Plugin) => p.host.ui.getByLabel('Visible local names JSON', { exact: true })
const selectText = (p: Plugin) => p.host.ui.getByRole('button', { name: 'Select JSON', exact: true })
const search = (p: Plugin) => p.host.ui.getByLabel('Search preflight', { exact: true })
const category = (p: Plugin) => p.host.ui.getByRole('combobox', { name: 'Issue type', exact: true })
const latest = (p: Plugin) => p.host.responses.filter(message => message.type === 'preflight').at(-1)! as Message & { items: Item[] }
const json = (names: string[]) => `${JSON.stringify(names, null, 2)}\n`

async function mixed(p: Plugin) {
  const f = p.host
  f.arrow.name = 'Arrow Left'
  f.arrow.width = 64
  f.variant.parent!.name = 'Arrow'
  f.variant.name = 'Left'
  f.nested.name = 'brand-valid'
  f.setContext({ revision: 8, validate: { width: 32, height: 16, name: '^brand-', skipPrefix: ['_', '.'] } })
  await f.ui.locator('#applied-rules summary').click()
  await f.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
  await expect(f.ui.locator('#status')).toHaveText('2 of 3 icons need fixes · 1 drafts skipped')
  await expect(f.ui.locator('#copy-names-summary')).toHaveText('3 visible components → 2 unique local names. 1 duplicate name entry merged.')
  await f.settleHost()
  await f.flush()
}
function activity(p: Plugin) {
  return { requests: structuredClone(p.host.requests), writes: [...p.host.writes], network: structuredClone(p.host.network), selection: p.host.first.selection.map(node => node.id), scan: structuredClone(latest(p)) }
}
async function copy(p: Plugin, names: string[]) {
  const before = activity(p)
  await button(p).click()
  await expect(button(p)).toBeEnabled()
  expect((await p.clipboard.evidence()).writes.at(-1)!.value).toBe(json(names))
  expect(activity(p)).toEqual(before)
}
function hold(p: Plugin, predicate: (message: Message) => boolean) {
  const original = p.host.host.ui.postMessage
  const held: Message[] = []
  p.host.host.ui.postMessage = (message) => {
    if (predicate(message)) {
      held.push(structuredClone(message))
    }
    else {
      original(message)
    }
  }
  return { held, release: () => original(held.shift()!), restore: () => {
    p.host.host.ui.postMessage = original
    for (const message of held.splice(0)) {
      original(message)
    }
  } }
}
async function download(page: Page, info: TestInfo, name: string, release: () => void) {
  const pending = page.waitForEvent('download')
  release()
  const file = await pending
  expect(await file.failure()).toBeNull()
  const path = info.outputPath(name)
  await file.saveAs(path)
  return path
}

test.describe('native Clipboard API', () => {
  test.use({ clipboardPolicy: 'allow', clipboardMode: 'native' })
  test('writes the exact deduplicated visible names from actual host diagnostics without changing workflows', async ({ plugin }, info) => {
    await mixed(plugin)
    const environment = (await plugin.clipboard.evidence()).environment
    expect(environment).toMatchObject({ secure: true, nativeApi: true, writeAllowed: true, readAllowed: true })
    await copy(plugin, ['arrow-left', 'brand-valid'])
    await expect(status(plugin)).toHaveText('Copied 2 unique local names from 3 visible components.')
    expect(await plugin.clipboard.readOwnNativeWrite()).toBe(json(['arrow-left', 'brand-valid']))
    await category(plugin).selectOption('duplicate-name')
    await plugin.host.ui.getByLabel('Problems only', { exact: true }).check()
    await search(plugin).fill('arrow-left')
    await plugin.host.flush()
    await copy(plugin, ['arrow-left'])
    expect(await plugin.clipboard.readOwnNativeWrite()).toBe(json(['arrow-left']))
    await expect(plugin.host.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
    await expect(plugin.host.ui.getByRole('button', { name: 'Export SVG ZIP', exact: true })).toBeDisabled()
    expect((await plugin.clipboard.evidence()).writes.every(write => write.activation && write.settled === 'success')).toBe(true)
    await writeFile(info.outputPath('accepted-scan.json'), JSON.stringify(latest(plugin), null, 2))
  })
})

test.describe('real iframe Permissions Policy', () => {
  test.use({ clipboardPolicy: 'deny', clipboardMode: 'native' })
  test('uses readonly fallback after a real policy-denied write and selects only on explicit keyboard action', async ({ page, plugin }, info) => {
    expect((await plugin.clipboard.evidence()).environment).toMatchObject({ secure: true, nativeApi: true, writeAllowed: false, readAllowed: false })
    const before = activity(plugin)
    await button(plugin).click()
    await expect(status(plugin)).toHaveText('Automatic copy is unavailable. Select the JSON and copy it manually.')
    const evidence = await plugin.clipboard.evidence()
    expect(evidence.writes).toHaveLength(1)
    expect(evidence.writes[0]).toMatchObject({ settled: 'failure', error: 'NotAllowedError' })
    expect(evidence.testReadCalls).toBe(0)
    expect(activity(plugin)).toEqual(before)
    await expect(text(plugin)).toHaveValue(json(['actions-filled', 'arrow', 'nested-icon']))
    await expect(text(plugin)).toHaveAttribute('readonly', '')
    await expect(button(plugin)).toBeFocused()
    await selectText(plugin).focus()
    await page.keyboard.press('Enter')
    await expect(text(plugin)).toBeFocused()
    expect(await text(plugin).evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([0, json(['actions-filled', 'arrow', 'nested-icon']).length])
    await page.locator('iframe').screenshot({ path: info.outputPath('policy-denied-manual-selection.png') })
    expect((await plugin.clipboard.evidence()).writes).toHaveLength(1)
  })
})

for (const mode of ['missing', 'throw', 'reject'] as const) {
  test(`provides inert complete JSON for ${mode} capability with long provisional names and explicit selection`, async ({ page, plugin }, info) => {
    plugin.host.setContext({ namingMode: 'server' })
    await plugin.host.dispatch({ type: 'console-status' })
    await plugin.host.flush()
    const legacy = structuredClone(latest(plugin))
    delete legacy.rulesRequestId
    const hostile = `<img data-injected="names" src=x> \"设计\n${'long'.repeat(100)}`
    legacy.items[0]!.iconName = hostile
    legacy.items[0]!.name = hostile
    await plugin.host.send(legacy)
    await search(plugin).fill('data-injected')
    await plugin.clipboard.setMode(mode)
    await button(plugin).click()
    await expect(text(plugin)).toHaveValue(json([hostile]))
    await expect(plugin.host.ui.locator('#copy-names-warning')).toContainText('These names are provisional.')
    await expect(plugin.host.ui.locator('#copy-names-scope')).toHaveText('Local preflight names · Current filtered view · Not a sync result')
    await expect(plugin.host.ui.locator('[data-injected], #copy-names-fallback img, #copy-names-fallback script')).toHaveCount(0)
    await selectText(plugin).focus()
    await page.keyboard.press('Enter')
    await expect(text(plugin)).toBeFocused()
    expect(await text(plugin).evaluate(element => (element as HTMLTextAreaElement).selectionEnd - (element as HTMLTextAreaElement).selectionStart)).toBe(json([hostile]).length)
    expect(await plugin.host.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.locator('iframe').screenshot({ path: info.outputPath(`${mode}-long-manual-json.png`) })
    await search(plugin).fill('absent')
    await expect(text(plugin)).toBeHidden()
    await expect(text(plugin)).toHaveValue('')
    await button(plugin).dispatchEvent('click')
    expect((await plugin.clipboard.evidence()).writes).toHaveLength(mode === 'missing' ? 0 : 1)
  })
}

test('refuses empty or partly unnamed compatibility views without writing a partial list', async ({ plugin }) => {
  await mixed(plugin)
  await search(plugin).fill('none-visible')
  await expect(button(plugin)).toBeDisabled()
  await button(plugin).dispatchEvent('click')
  expect((await plugin.clipboard.evidence()).writes).toEqual([])
  await plugin.host.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  const legacy = structuredClone(latest(plugin))
  delete legacy.rulesRequestId
  delete legacy.items[0]!.diagnostics
  legacy.items[0]!.iconName = ''
  await plugin.host.send(legacy)
  await expect(button(plugin)).toBeDisabled()
  await expect(plugin.host.ui.locator('#copy-names-help')).toContainText('1 visible component has no local name')
  await button(plugin).dispatchEvent('click')
  expect((await plugin.clipboard.evidence()).writes).toEqual([])
  await category(plugin).selectOption('other')
  await expect(button(plugin)).toBeDisabled()
  await category(plugin).selectOption('all')
  await search(plugin).fill('brand-valid')
  await copy(plugin, ['brand-valid'])
})

for (const success of [true, false]) {
  test(`holds one native write across filter changes until delayed ${success ? 'success' : 'rejection'} and leaves new feedback untouched`, async ({ plugin }) => {
    await mixed(plugin)
    await plugin.clipboard.setMode('pending')
    await button(plugin).click()
    await expect(button(plugin)).toBeDisabled()
    await button(plugin).dispatchEvent('click')
    await category(plugin).selectOption('canvas-size')
    await search(plugin).fill('arrow-left')
    await button(plugin).dispatchEvent('click')
    await expect(status(plugin)).toBeEmpty()
    await search(plugin).focus()
    expect((await plugin.clipboard.evidence()).writes).toHaveLength(1)
    await plugin.clipboard.settle(0, success)
    await expect(button(plugin)).toBeEnabled()
    await expect(status(plugin)).toBeEmpty()
    await expect(text(plugin)).toBeHidden()
    await expect(search(plugin)).toBeFocused()
    await plugin.clipboard.setMode('success')
    await copy(plugin, ['arrow-left'])
    expect((await plugin.clipboard.evidence()).writes).toHaveLength(2)
    await expect(status(plugin)).toHaveText('Copied 1 unique local names from 1 visible components.')
  })
}

test('invalidates a pending copy when actual late preference restoration changes the visible view', async ({ plugin }) => {
  await mixed(plugin)
  const original = plugin.host.host.clientStorage.getAsync
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  plugin.host.host.clientStorage.getAsync = async (key) => {
    if (key === 'iconctl-preflight-preferences') {
      await gate
      return { problemsOnly: true }
    }
    return original(key)
  }
  const pending = plugin.host.dispatch({ type: 'load-settings' })
  try {
    await plugin.clipboard.setMode('pending')
    await button(plugin).click()
    release()
    await pending
    await plugin.host.flush()
    await expect(plugin.host.ui.getByLabel('Problems only', { exact: true })).toBeChecked()
    await expect(button(plugin)).toBeDisabled()
    await expect(status(plugin)).toBeEmpty()
    await plugin.clipboard.settle(0, false)
    await expect(button(plugin)).toBeEnabled()
    await expect(text(plugin)).toBeHidden()
    await expect(status(plugin)).toBeEmpty()
    await plugin.clipboard.setMode('success')
    await copy(plugin, ['arrow-left'])
  }
  finally {
    release()
    await pending
    plugin.host.host.clientStorage.getAsync = original
  }
})

test('keeps copy unavailable through actual rule refresh failure and recovers only with an accepted scan', async ({ plugin }) => {
  await plugin.host.ui.locator('#applied-rules summary').click()
  const gate = plugin.host.holdNetwork('context')
  await plugin.clipboard.setMode('pending')
  await button(plugin).click()
  const refresh = plugin.host.ui.getByRole('button', { name: 'Refresh project rules', exact: true })
  await refresh.click()
  await expect.poll(() => gate.started).toBe(true)
  await expect(button(plugin)).toBeDisabled()
  await button(plugin).dispatchEvent('click')
  gate.resolve(new Response('Service unavailable', { status: 503 }))
  await expect(refresh).toBeEnabled()
  await expect(button(plugin)).toBeDisabled()
  await plugin.clipboard.settle(0, true)
  await expect(button(plugin)).toBeDisabled()
  await expect(status(plugin)).toBeEmpty()
  await refresh.click()
  await expect(button(plugin)).toBeEnabled()
  await plugin.clipboard.setMode('success')
  await copy(plugin, ['actions-filled', 'arrow', 'nested-icon'])
})

test('keeps the physical lock across Rescan and actual page A to B to A without restoring old success', async ({ plugin }) => {
  await plugin.clipboard.setMode('pending')
  await button(plugin).click()
  const before = latest(plugin).scanId!
  await plugin.host.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect.poll(() => latest(plugin).scanId!).toBeGreaterThan(before)
  await expect(button(plugin)).toBeDisabled()
  plugin.host.changePage()
  await plugin.host.flush()
  await expect(button(plugin)).toBeDisabled()
  await expect(plugin.host.ui.locator('#copy-names-help')).toContainText('Rescan with current rules')
  await expect(plugin.host.ui.locator('#list > li')).toHaveCount(3)
  await plugin.host.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(plugin.host.ui.locator('#list > li')).toHaveCount(0)
  await expect(button(plugin)).toBeDisabled()
  plugin.host.changePage(plugin.host.first)
  await plugin.host.flush()
  await expect(button(plugin)).toBeDisabled()
  await expect(plugin.host.ui.locator('#copy-names-help')).toContainText('Rescan with current rules')
  await plugin.host.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(plugin.host.ui.locator('#list > li')).toHaveCount(3)
  await expect(button(plugin)).toBeDisabled()
  await button(plugin).dispatchEvent('click')
  expect((await plugin.clipboard.evidence()).writes).toHaveLength(1)
  await plugin.clipboard.settle(0, true)
  await expect(button(plugin)).toBeEnabled()
  await expect(status(plugin)).toBeEmpty()
  await plugin.clipboard.setMode('success')
  await copy(plugin, ['actions-filled', 'arrow', 'nested-icon'])
})

for (const success of [true, false]) {
  test(`never mutates disposed UI or focus after pagehide and late ${success ? 'success' : 'rejection'}`, async ({ plugin }) => {
    await plugin.clipboard.setMode('pending')
    await button(plugin).click()
    await search(plugin).focus()
    await plugin.host.ui.locator('body').evaluate(() => {
      window.dispatchEvent(new Event('pagehide'))
      const writes: string[] = []
      const observer = new MutationObserver(records => writes.push(...records.map(record => record.type)))
      observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true })
      Object.assign(window, { afterHide: { writes, observer, active: document.activeElement } })
    })
    plugin.host.closeHost()
    await plugin.clipboard.settle(0, success)
    await button(plugin).dispatchEvent('click')
    const result = await plugin.host.ui.locator('body').evaluate(() => {
      const state = (window as unknown as { afterHide: { writes: string[], observer: MutationObserver, active: Element } }).afterHide
      state.observer.disconnect()
      return { writes: state.writes, sameFocus: state.active === document.activeElement }
    })
    expect(result).toEqual({ writes: [], sameFocus: true })
    expect((await plugin.clipboard.evidence()).writes).toHaveLength(1)
  })
}

test('leaves a native Locate in progress and both captured report formats complete while copying a subset', async ({ page, plugin }, info) => {
  await mixed(plugin)
  await category(plugin).selectOption('canvas-size')
  const lookup = plugin.host.holdLookup()
  await plugin.host.ui.getByRole('button', { name: 'Next problem', exact: true }).click()
  await expect.poll(() => lookup.started).toBe(true)
  const before = activity(plugin)
  await button(plugin).click()
  await expect(status(plugin)).toContainText('Copied 1 unique local names')
  expect(activity(plugin)).toEqual(before)
  lookup.resolve(plugin.host.arrow)
  await expect.poll(() => plugin.host.first.selection.map(node => node.id)).toEqual([plugin.host.arrow.id])
  const scan = structuredClone(latest(plugin))
  for (const format of ['json', 'html'] as const) {
    const gate = hold(plugin, message => message.type === 'preflight-report')
    try {
      await plugin.host.ui.getByRole('button', { name: `Export ${format.toUpperCase()} report`, exact: true }).click()
      await expect.poll(() => gate.held.length).toBe(1)
      await copy(plugin, ['arrow-left'])
      const path = await download(page, info, `subset-copy-complete-report.${format}`, gate.release)
      const content = await readFile(path, 'utf8')
      if (format === 'json') {
        const report = JSON.parse(content) as { items: Item[], summary: { total: number, issueCount: number } }
        expect(report.items).toEqual(scan.items)
        expect(report.summary).toMatchObject({ total: 4, issueCount: 5 })
      }
      else {
        expect(content).toContain('brand-valid')
        expect(content).toContain('_Draft')
        expect(content).toContain('64×16')
      }
      expect(content).not.toMatch(/fixture-device-token|fixture-github-token/)
    }
    finally {
      gate.restore()
    }
  }
})

test('keeps the complete actual native SVG export alive while a subset copy remains physically pending', async ({ page, plugin }, info) => {
  await search(plugin).fill('arrow')
  await plugin.clipboard.setMode('pending')
  await button(plugin).click()
  const copyScan = latest(plugin).scanId!
  const native = plugin.host.holdExport()
  const gate = hold(plugin, message => (message.type === 'svg-handoff-status' && message.state === 'ready') || message.type === 'svg-handoff-files')
  try {
    await plugin.host.ui.getByRole('button', { name: 'Export SVG ZIP', exact: true }).click()
    await expect.poll(() => native.started).toBe(true)
    expect(latest(plugin).scanId!).toBeGreaterThan(copyScan)
    await expect(status(plugin)).toBeEmpty()
    await expect(button(plugin)).toBeDisabled()
    expect((await plugin.clipboard.evidence()).active).toBe(1)
    native.resolve(rawSvg)
    await expect.poll(() => gate.held[0]?.state).toBe('ready')
    gate.release()
    await expect.poll(() => gate.held[0]?.type).toBe('svg-handoff-files')
    const path = await download(page, info, 'complete-svg-during-copy.zip', gate.release)
    const exec = promisify(execFile)
    const entries = ['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg', 'raw-svg/nested-icon.svg']
    expect((await exec('unzip', ['-Z1', path])).stdout.trim().split('\n')).toEqual(entries)
    expect((await exec('unzip', ['-t', path])).stdout).toContain('No errors detected')
    for (const entry of entries) {
      expect((await exec('unzip', ['-p', path, entry])).stdout).toBe(rawSvg)
    }
    expect(plugin.host.exports).toHaveLength(3)
    expect(plugin.host.peak()).toBe(1)
    await plugin.clipboard.settle(0, true)
    await expect(button(plugin)).toBeEnabled()
    await expect(status(plugin)).toBeEmpty()
    expect((await plugin.clipboard.evidence()).completedPayload).toBe(json(['arrow']))
    await plugin.clipboard.setMode('success')
    await copy(plugin, ['arrow'])
    await expect(status(plugin)).toHaveText('Copied 1 unique local names from 1 visible components.')
  }
  finally {
    native.resolve(rawSvg)
    gate.restore()
  }
})

test.describe('restored task', () => {
  test.use({ restoredTask: true })
  test('preserves its one job poll and terminal tracking while names copying is pending', async ({ plugin }) => {
    await expect.poll(() => plugin.host.job?.started).toBe(true)
    const before = activity(plugin)
    await plugin.clipboard.setMode('pending')
    await button(plugin).click()
    expect(activity(plugin)).toEqual(before)
    plugin.host.job!.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await expect(plugin.host.ui.locator('#console-status')).toContainText('succeeded · complete')
    await expect(plugin.host.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toBeVisible()
    await expect(button(plugin)).toBeDisabled()
    await plugin.clipboard.settle(0, true)
    await expect(button(plugin)).toBeEnabled()
    expect(plugin.host.network.filter(request => request.url.endsWith('/jobs/running-task'))).toHaveLength(1)
  })
})

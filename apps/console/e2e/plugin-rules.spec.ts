import type { Download, Page, TestInfo } from '@playwright/test'
import type { PreflightItem } from '../../../packages/figma-plugin/src/preflight'
import { readFile } from 'node:fs/promises'
import { test as base, expect } from '@playwright/test'

interface Message {
  type: string
  requestId?: number
  scanId?: number
  [key: string]: unknown
}
interface Effects { messages: Message[], fetches: string[], blobs: string[] }
// Public wire shape. The e2e compiler uses erasable TypeScript and must not
// include the host report class, whose constructor uses parameter properties.
interface AppliedRules {
  mode: 'console' | 'github'
  rulesSource: 'project' | 'legacy-defaults' | 'unpaired-defaults'
  project?: { name: string, revision: number }
  rules: { width?: number, height?: number, name: string, skipPrefix: string[], namingMode: 'default' | 'server' }
  serverValidationRequired: boolean
}
const clean: PreflightItem[] = [{ id: '1:1', name: 'BrandArrow', iconName: 'brand-arrow', width: 16, height: 32, skipped: false, issues: [] }]
const invalid: PreflightItem[] = [{ ...clean[0]!, issues: ['Canvas is 16×32, expected 32×32'] }]
const project: AppliedRules = {
  mode: 'console',
  rulesSource: 'project',
  project: { name: 'Brand project', revision: 7 },
  rules: { width: 16, height: 32, name: '^brand-[a-z0-9-]+$', skipPrefix: ['_', 'Draft-'], namingMode: 'server' },
  serverValidationRequired: true,
}
const legacy: AppliedRules = {
  mode: 'github',
  rulesSource: 'legacy-defaults',
  rules: { width: 24, height: 24, name: '^[a-z0-9]+(?:-[a-z0-9]+)*$', skipPrefix: ['_', '.'], namingMode: 'default' },
  serverValidationRequired: true,
}
const taskUrl = 'https://iconctl.icebreaker.top/app/?job=previous-completed-task'
const taskText = 'completed · Existing task is complete.'
const instrumentation = `<script>
  window.addEventListener('message', event => {
    if (event.source === parent && event.data.fixtureBarrier) {
      parent.postMessage({ fixtureBarrier: event.data.fixtureBarrier }, '*');
    }
  });
  window.fetch = async input => {
    parent.__rulesEffects.fetches.push(String(input));
    throw new Error('Unexpected network request from rules fixture');
  };
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const url = create(blob); parent.__rulesEffects.blobs.push(url); return url;
  };
</script>`

async function plugin(page: Page) {
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  const html = (await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')).replace('<head>', `<head>${instrumentation}`)
  await page.evaluate((html) => {
    const host = window as unknown as { __rulesEffects: Effects }
    host.__rulesEffects = { messages: [], fetches: [], blobs: [] }
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data.pluginMessage) {
        host.__rulesEffects.messages.push(event.data.pluginMessage)
      }
    })
    frame.srcdoc = html
  }, html)
  const ui = page.frameLocator('iframe')
  await expect(ui.getByLabel('Connection mode')).toBeVisible()
  let barrier = 0
  const effects = async () => {
    await page.evaluate(id => new Promise<void>((resolve) => {
      const frame = document.querySelector('iframe')!.contentWindow!
      const done = (event: MessageEvent) => {
        if (event.source === frame && event.data.fixtureBarrier === id) {
          window.removeEventListener('message', done)
          resolve()
        }
      }
      window.addEventListener('message', done)
      frame.postMessage({ fixtureBarrier: id }, '*')
    }), ++barrier)
    return page.evaluate(() => (window as unknown as { __rulesEffects: Effects }).__rulesEffects)
  }
  const send = (message: unknown) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const requests = async (type = 'console-refresh-rules') => (await effects()).messages.filter(message => message.type === type)
  const scan = (scanId = 7, appliedRules: AppliedRules = project, items = clean, rulesRequestId?: number) => send({ type: 'preflight', scanId, appliedRules, items, reportAvailable: true, ...(rulesRequestId === undefined ? {} : { rulesRequestId }) })
  const pair = async () => {
    await send({ type: 'console-state', connected: true, busy: false })
    await send({ type: 'project-rules-state', paired: true, stale: false })
  }
  const open = async () => {
    if (!await ui.locator('#applied-rules').evaluate(element => (element as HTMLDetailsElement).open)) {
      await ui.locator('#applied-rules summary').click()
    }
  }
  const refresh = async () => {
    await open()
    const before = (await requests()).length
    await ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
    const sent = await requests()
    expect(sent).toHaveLength(before + 1)
    return sent.at(-1)!.requestId!
  }
  const terminal = (requestId: number, outcome: 'success' | 'error' | 'ignored', text: string) => send({ type: 'project-rules-status', requestId, outcome, text, error: outcome === 'error' })
  const success = async (requestId: number, scanId = 8, appliedRules: AppliedRules = { ...project, project: { name: 'Brand project', revision: 8 } }, items = clean) => {
    await scan(scanId, appliedRules, items, requestId)
    await terminal(requestId, 'success', `Project rules refreshed · revision ${appliedRules.project?.revision ?? 'default'}.`)
  }
  const task = () => send({ type: 'console-status', connected: true, busy: false, text: taskText, url: taskUrl })
  const field = (name: string) => ui.locator('#rules-content dt').filter({ hasText: new RegExp(`^${name}$`) }).locator('+ dd')
  return { ui, send, effects, requests, scan, pair, open, refresh, terminal, success, task, field }
}
type Plugin = Awaited<ReturnType<typeof plugin>>
const test = base.extend<{ plugin: Plugin }>({
  plugin: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await plugin(page)
    await use(fixture)
    expect(errors).toEqual([])
    expect((await fixture.effects()).fetches).toEqual([])
  },
})

async function unchangedTask(plugin: Plugin) {
  await expect(plugin.ui.locator('#console-status')).toHaveText(`${taskText} Open task ↗`)
  await expect(plugin.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', taskUrl)
}
async function stale(plugin: Plugin) {
  await expect(plugin.ui.locator('#rules-validity')).toContainText('Scan out of date')
  for (const name of ['Sync to console', 'Export JSON report']) {
    await expect(plugin.ui.getByRole('button', { name, exact: true })).toBeDisabled()
  }
  await expect(plugin.ui.getByRole('button', { name: 'Locate BrandArrow', exact: true })).toBeDisabled()
}
async function noSubmitEffects(plugin: Plugin) {
  const before = await plugin.effects()
  for (const selector of ['#publish', '#export-report', '#list button']) {
    await plugin.ui.locator(selector).first().dispatchEvent('click')
  }
  const after = await plugin.effects()
  const mutations = (value: Effects) => value.messages.filter(message => ['console-sync', 'export-report', 'locate', 'save-settings'].includes(message.type))
  expect(mutations(after)).toEqual(mutations(before))
  expect(after.blobs).toEqual(before.blobs)
}
async function report(download: Download, info: TestInfo) {
  expect(await download.failure()).toBeNull()
  const path = info.outputPath('refreshed-rules-report.json')
  await download.saveAs(path)
  return JSON.parse(await readFile(path, 'utf8'))
}

test('shows custom project rules and supports keyboard disclosure and refresh at 420 by 560', async ({ page, plugin }, info) => {
  await plugin.pair()
  await plugin.scan()
  await plugin.task()
  const summary = plugin.ui.locator('#applied-rules summary')
  await plugin.ui.getByRole('button', { name: 'Disconnect', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(plugin.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(summary).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(plugin.ui.locator('#applied-rules')).toHaveAttribute('open', '')
  for (const [name, value] of Object.entries({ 'Source': 'Project rules', 'Project': 'Brand project · revision 7', 'Width': '16', 'Height': '32', 'Name pattern': '^brand-[a-z0-9-]+$', 'Skip prefixes': '"_", "Draft-"', 'Naming': 'Provisional — custom naming is validated by the server.' })) {
    await expect(plugin.field(name)).toHaveText(value)
  }
  await expect(plugin.ui.locator('#rules-validity')).toContainText('Server validation is still required')
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-project-expanded.png') })
  await page.keyboard.press('Tab')
  await expect(plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await plugin.requests()).toHaveLength(1)
  await stale(plugin)
  await unchangedTask(plugin)
  await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toHaveAttribute('aria-live', 'polite')
  await expect(plugin.ui.getByRole('status')).toHaveCount(1)
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-refresh-pending.png') })
})

test('keeps unrestricted dimensions and empty skip prefixes explicit', async ({ page, plugin }, info) => {
  await plugin.scan(8, { ...project, rules: { name: '.*', skipPrefix: [], namingMode: 'default' } })
  await plugin.open()
  await expect(plugin.field('Width')).toHaveText('Unrestricted')
  await expect(plugin.field('Height')).toHaveText('Unrestricted')
  await expect(plugin.field('Skip prefixes')).toHaveText('None')
  await expect(plugin.field('Naming')).toHaveText('Default local naming')
  await expect(plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true })).toBeDisabled()
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-unrestricted-empty-prefixes.png') })
})

test('renders legacy and unpaired defaults without retaining old project metadata or refreshing implicitly', async ({ page, plugin }, info) => {
  await plugin.pair()
  await plugin.scan()
  await plugin.open()
  await plugin.ui.getByLabel('Connection mode').selectOption('github')
  await plugin.scan(11, legacy)
  await expect(plugin.field('Source')).toHaveText('Legacy GitHub defaults')
  await expect(plugin.field('Project')).toHaveCount(0)
  await expect(plugin.field('Width')).toHaveText('24')
  await expect(plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true })).toBeHidden()
  await expect(plugin.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
  await expect(plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })).toBeEnabled()
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-legacy.png') })
  await plugin.ui.getByLabel('Connection mode').selectOption('console')
  await plugin.send({ type: 'console-state', connected: false, busy: false })
  await plugin.send({ type: 'project-rules-state', paired: false, stale: false })
  await plugin.scan(12, { ...legacy, mode: 'console', rulesSource: 'unpaired-defaults' })
  await expect(plugin.field('Source')).toHaveText('Unpaired defaults')
  await expect(plugin.field('Project')).toHaveCount(0)
  await expect(plugin.ui.getByRole('button', { name: 'Refresh project rules', exact: true })).toBeDisabled()
  expect(await plugin.requests()).toEqual([])
  expect((await plugin.requests('rescan')).map(message => message.mode)).toEqual(['console', 'github', 'console'])
})

test('renders hostile long rule text without injection or horizontal overflow and keeps retry reachable', async ({ page, plugin }, info) => {
  const hostile = `<img data-injected="rules" src="https://invalid.example/asset">${'long-rule'.repeat(35)}`
  await plugin.pair()
  await plugin.scan(7, { ...project, project: { name: hostile, revision: 7 }, rules: { ...project.rules, name: hostile, skipPrefix: ['', '<svg data-injected="prefix">', hostile] } })
  await plugin.task()
  await plugin.ui.locator('html').evaluate(element => element.scrollTo({ top: 0 }))
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-long-top.png') })
  await plugin.open()
  await expect(plugin.field('Name pattern')).toHaveText(hostile)
  await expect(plugin.ui.locator('[data-injected]')).toHaveCount(0)
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-long-expanded.png') })
  const request = await plugin.refresh()
  const pendingScroll = await plugin.ui.locator('html').evaluate(element => element.scrollTop)
  await plugin.terminal(request, 'error', 'Could not refresh project rules. Refresh project rules to try again.')
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollTop)).toBeGreaterThanOrEqual(pendingScroll)
  await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toBeInViewport()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-long-retry-scrolled.png') })
  // Native disabled buttons relinquish focus while pending. Returning through
  // the disclosure gives a deterministic keyboard route to the retry action.
  await plugin.ui.locator('#applied-rules summary').focus()
  await page.keyboard.press('Tab')
  await expect(plugin.ui.locator('#refresh-rules')).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await plugin.requests()).toHaveLength(2)
})

test('refresh revokes old scan actions, preserves task feedback and applies one scan to overview list and downloaded report', async ({ page, plugin }, info) => {
  await plugin.pair()
  await plugin.scan()
  await plugin.task()
  const request = await plugin.refresh()
  await plugin.send({ type: 'project-rules-status', requestId: request, outcome: 'accepted', text: 'Refreshing project rules…' })
  await stale(plugin)
  await plugin.ui.locator('#refresh-rules').dispatchEvent('click')
  expect(await plugin.requests()).toHaveLength(1)
  await noSubmitEffects(plugin)
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('BrandArrow')
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
  await unchangedTask(plugin)
  const overview: AppliedRules = { ...project, project: { name: 'Updated project', revision: 8 }, rules: { ...project.rules, width: 32 } }
  await plugin.success(request, 80, overview, invalid)
  await expect(plugin.field('Project')).toHaveText('Updated project · revision 8')
  await expect(plugin.field('Width')).toHaveText('32')
  await expect(plugin.ui.locator('#list > li')).toContainText('Canvas is 16×32, expected 32×32')
  await expect(plugin.ui.locator('#export-report')).toBeEnabled()
  await expect(plugin.ui.locator('#publish')).toBeDisabled()
  await plugin.ui.locator('#export-report').click()
  const exportRequest = (await plugin.requests('export-report')).at(-1)!
  expect(exportRequest.scanId).toBe(80)
  // Host tests own snapshot construction; this fixture verifies the complete
  // built-UI wire boundary and real download against the displayed scan.
  const captured = { schemaVersion: 1, scanId: 80, ...overview, items: invalid }
  const downloaded = page.waitForEvent('download')
  await plugin.send({ ...exportRequest, type: 'preflight-report', json: JSON.stringify(captured), serverNamingPending: true })
  expect(await report(await downloaded, info)).toEqual(captured)
  await unchangedTask(plugin)
  await plugin.ui.locator('#refresh-rules').scrollIntoViewIfNeeded()
  await page.locator('iframe').screenshot({ path: info.outputPath('rules-refresh-success-errors.png') })
  await plugin.success(await plugin.refresh(), 81, { ...overview, project: { name: 'Updated project', revision: 9 } }, [])
  await expect(plugin.ui.locator('#export-report')).toBeEnabled()
  await expect(plugin.ui.locator('#publish')).toBeDisabled()
  await plugin.success(await plugin.refresh(), 82, { ...overview, project: { name: 'Updated project', revision: 10 } })
  await expect(plugin.ui.locator('#publish')).toBeEnabled()
  expect((await plugin.effects()).messages.filter(message => ['console-sync', 'save-settings', 'console-pair', 'console-disconnect'].includes(message.type))).toEqual([])
})

test('busy state guards manual refresh and a raced ignored response clears only its own request', async ({ plugin }) => {
  await plugin.pair()
  await plugin.scan()
  await plugin.open()
  await plugin.send({ type: 'console-state', connected: true, busy: true })
  await expect(plugin.ui.locator('#refresh-rules')).toBeDisabled()
  await plugin.ui.locator('#refresh-rules').dispatchEvent('click')
  expect(await plugin.requests()).toEqual([])
  await plugin.send({ type: 'console-state', connected: true, busy: false })
  const first = await plugin.refresh()
  await plugin.send({ type: 'console-state', connected: true, busy: true })
  await plugin.terminal(first, 'ignored', 'Another console operation is active. Refresh project rules when it finishes.')
  await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toContainText('Another console operation')
  await stale(plugin)
  await plugin.send({ type: 'console-state', connected: true, busy: false })
  const second = await plugin.refresh()
  expect(second).toBeGreaterThan(first)
  await plugin.terminal(first, 'ignored', 'Obsolete ignored result')
  await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toHaveText('Refreshing project rules…')
  await expect(plugin.ui.locator('#refresh-rules')).toBeDisabled()
  await plugin.success(second)
  await expect(plugin.ui.locator('#refresh-rules')).toBeEnabled()
  await expect(plugin.ui.locator('#publish')).toBeEnabled()
})

for (const failure of ['HTTP 502', 'Network unavailable', 'HTTP 404'] as const) {
  test(`${failure} remains local and stale while explicit retry preserves the completed task`, async ({ page, plugin }, info) => {
    await plugin.pair()
    await plugin.scan()
    await plugin.task()
    const first = await plugin.refresh()
    await plugin.send({ type: 'project-rules-state', paired: true, stale: true })
    await plugin.send({ type: 'console-state', connected: false, busy: false })
    await plugin.terminal(first, 'error', `${failure}. Could not refresh project rules. Refresh project rules to try again.`)
    await stale(plugin)
    await noSubmitEffects(plugin)
    await expect(plugin.ui.locator('#refresh-rules')).toBeEnabled()
    await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toContainText(failure)
    await unchangedTask(plugin)
    await plugin.ui.locator('#refresh-rules').scrollIntoViewIfNeeded()
    await page.locator('iframe').screenshot({ path: info.outputPath(`rules-${failure.replaceAll(' ', '-')}-retry.png`) })
    const second = await plugin.refresh()
    await plugin.terminal(first, 'error', 'Obsolete failure')
    await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toHaveText('Refreshing project rules…')
    await plugin.send({ type: 'console-state', connected: true, busy: false })
    await plugin.send({ type: 'project-rules-state', paired: true, stale: false })
    await plugin.success(second)
    await expect(plugin.ui.locator('#publish')).toBeEnabled()
    await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).not.toContainText(failure)
    await unchangedTask(plugin)
    expect(await plugin.requests()).toHaveLength(2)
    expect((await plugin.effects()).messages.filter(message => ['console-pair', 'console-sync', 'console-disconnect', 'save-settings'].includes(message.type))).toEqual([])
  })
}

for (const code of [401, 403]) {
  test(`${code} revocation disables refresh until a new pairing is established`, async ({ plugin }) => {
    await plugin.pair()
    await plugin.scan()
    const request = await plugin.refresh()
    await plugin.send({ type: 'project-rules-state', paired: false, stale: false })
    await plugin.send({ type: 'console-state', connected: false, busy: false })
    await plugin.terminal(request, 'error', `HTTP ${code}. Device authorization was revoked. Connect console again.`)
    await expect(plugin.ui.locator('#refresh-rules')).toBeDisabled()
    await plugin.ui.locator('#refresh-rules').dispatchEvent('click')
    expect(await plugin.requests()).toHaveLength(1)
    await plugin.ui.getByRole('button', { name: 'Connect console', exact: true }).click()
    expect(await plugin.requests('console-pair')).toHaveLength(1)
    await plugin.pair()
    await plugin.scan(9, { ...project, project: { name: 'New pairing', revision: 9 } })
    await expect(plugin.ui.locator('#refresh-rules')).toBeEnabled()
    await expect(plugin.field('Project')).toHaveText('New pairing · revision 9')
  })
}

for (const cancellation of ['disconnect', 're-pair', 'mode', 'pagehide'] as const) {
  test(`rejects late rules preflight and terminal messages after ${cancellation}`, async ({ plugin }) => {
    await plugin.pair()
    await plugin.scan()
    const old = await plugin.refresh()
    if (cancellation === 'disconnect') {
      await plugin.ui.getByRole('button', { name: 'Disconnect', exact: true }).click()
    }
    else if (cancellation === 're-pair') {
      await plugin.ui.getByRole('button', { name: 'Connect console', exact: true }).click()
      await plugin.pair()
      await plugin.scan(20, { ...project, project: { name: 'Connection B', revision: 20 } })
    }
    else if (cancellation === 'mode') {
      await plugin.ui.getByLabel('Connection mode').selectOption('github')
      await plugin.scan(21, legacy)
    }
    else {
      await plugin.ui.locator('body').evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    }
    const before = {
      rules: await plugin.ui.locator('#rules-content').textContent(),
      validity: await plugin.ui.locator('#rules-validity').textContent(),
      status: await plugin.ui.locator('#rules-status').textContent(),
      items: await plugin.ui.locator('#list').textContent(),
      effects: await plugin.effects(),
    }
    await plugin.scan(99, { ...project, project: { name: 'OBSOLETE A', revision: 99 } }, invalid, old)
    await plugin.terminal(old, 'success', 'OBSOLETE SUCCESS')
    await plugin.terminal(old, 'error', 'OBSOLETE ERROR')
    expect(await plugin.ui.locator('#rules-content').textContent()).toBe(before.rules)
    expect(await plugin.ui.locator('#rules-validity').textContent()).toBe(before.validity)
    expect(await plugin.ui.locator('#rules-status').textContent()).toBe(before.status)
    expect(await plugin.ui.locator('#list').textContent()).toBe(before.items)
    expect(await plugin.effects()).toEqual(before.effects)
    if (cancellation === 'disconnect' || cancellation === 'pagehide') {
      await expect(plugin.ui.locator('#refresh-rules')).toBeDisabled()
      await expect(plugin.ui.locator('#publish')).toBeDisabled()
      await expect(plugin.ui.locator('#export-report')).toBeDisabled()
    }
  })
}

test('ignores completed refresh replays and ordinary preflights from a different mode', async ({ plugin }) => {
  await plugin.pair()
  await plugin.scan()
  const first = await plugin.refresh()
  await plugin.success(first)
  await plugin.scan(99, { ...project, project: { name: 'Replayed response', revision: 99 } }, invalid, first)
  await plugin.scan(100, legacy)
  await plugin.terminal(first, 'error', 'Late failure')
  await expect(plugin.field('Project')).toHaveText('Brand project · revision 8')
  await expect(plugin.ui.locator('#publish')).toBeEnabled()
  await expect(plugin.ui.getByLabel('Project rules status', { exact: true })).toHaveText('Project rules refreshed · revision 8.')
  const second = await plugin.refresh()
  await plugin.scan(99, { ...project, project: { name: 'Old request during new pending', revision: 99 } }, invalid, first)
  await plugin.terminal(first, 'success', 'Old success during new pending')
  await stale(plugin)
  await expect(plugin.ui.locator('#refresh-rules')).toBeDisabled()
  await plugin.success(second, 9, { ...project, project: { name: 'Current request', revision: 9 } })
  await expect(plugin.field('Project')).toHaveText('Current request · revision 9')
})

test('supports older preflight messages without falsely describing unavailable rule details', async ({ plugin }) => {
  await plugin.pair()
  await plugin.scan()
  await plugin.send({ type: 'preflight', scanId: 10, items: clean, reportAvailable: true })
  await plugin.open()
  await expect(plugin.ui.locator('#rules-content')).toBeEmpty()
  await expect(plugin.ui.locator('#rules-validity')).toHaveText('Rule details unavailable. Rescan with the updated plugin.')
  await expect(plugin.ui.locator('#publish')).toBeEnabled()
  await expect(plugin.ui.locator('#export-report')).toBeEnabled()
})

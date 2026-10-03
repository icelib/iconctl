import type { Page } from '@playwright/test'
import type { PreflightInput, PreflightRules } from '../../../packages/figma-plugin/src/preflight'
import { readFile } from 'node:fs/promises'
import { inspectComponents } from '@iconctl/figma-plugin'
import { test as base, expect } from '@playwright/test'
// This consumer test intentionally exercises the freshly built public entry.

interface Message { type: string, scanId?: number, requestId?: number, nodeId?: string, [key: string]: unknown }
interface Effects { messages: Message[], fetches: string[], resources: { type: string, url: string }[] }
const node = (id: string, name: string): PreflightInput => ({ id, name, type: 'COMPONENT', width: 24, height: 24 })
const inputs = [node('1:1', 'Arrow Left'), node('1:2', 'arrow_left'), node('1:3', 'Circle'), node('1:4', '_draft')]
const issue = 'Duplicate icon name "arrow-left" on this page (2 components). Rename a component and rescan.'
const defaultRules: PreflightRules = { width: 24, height: 24, namingMode: 'default' }
const instrumentation = `<script>
  window.addEventListener('message', event => {
    if (event.source === parent && event.data.fixtureBarrier) parent.postMessage({ fixtureBarrier: event.data.fixtureBarrier }, '*');
  });
  window.fetch = async input => {
    parent.__collisionEffects.fetches.push(String(input));
    throw new Error('Unexpected collision UI network request');
  };
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const url = create(blob); parent.__collisionEffects.resources.push({ type: 'create', url }); return url;
  };
  URL.revokeObjectURL = url => {
    parent.__collisionEffects.resources.push({ type: 'revoke', url }); return revoke(url);
  };
</script>`

async function plugin(page: Page) {
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  const html = (await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')).replace('<head>', `<head>${instrumentation}`)
  await page.evaluate((html) => {
    const host = window as unknown as { __collisionEffects: Effects }
    host.__collisionEffects = { messages: [], fetches: [], resources: [] }
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data.pluginMessage) {
        host.__collisionEffects.messages.push(event.data.pluginMessage)
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
    return page.evaluate(() => (window as unknown as { __collisionEffects: Effects }).__collisionEffects)
  }
  const send = (message: unknown) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const requests = async (type: string) => (await effects()).messages.filter(message => message.type === type)
  let report = ''
  let serverNamingPending = false
  const scan = async (scanId = 20, nodes = inputs, rules = defaultRules, mode: 'console' | 'github' = 'console') => {
    // Classification comes from the freshly built public implementation. The
    // report below is an explicit wire fixture; actual host capture is tested
    // independently in the plugin's host-level regression suite.
    const items = inspectComponents(nodes, rules)
    const appliedRules = {
      mode,
      rulesSource: mode === 'console' ? 'project' : 'legacy-defaults',
      ...(mode === 'console' ? { project: { name: 'Icon library', revision: 4 } } : {}),
      rules: { name: '^[a-z0-9]+(?:-[a-z0-9]+)*$', skipPrefix: ['_', '.'], ...rules },
      serverValidationRequired: true,
    }
    serverNamingPending = rules.namingMode === 'server'
    report = JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-04T00:00:00.000Z',
      scanId,
      scope: 'current-page',
      page: { id: 'page:1', name: 'Icons' },
      ...appliedRules,
      summary: {
        total: items.length,
        checked: items.filter(item => !item.skipped).length,
        skipped: items.filter(item => item.skipped).length,
        withIssues: items.filter(item => item.issues.length > 0).length,
        issueCount: items.reduce((count, item) => count + item.issues.length, 0),
        canSubmit: items.some(item => !item.skipped) && items.every(item => item.skipped || item.issues.length === 0),
      },
      items,
    }, null, 2)
    await send({ type: 'preflight', scanId, items, appliedRules, reportAvailable: true })
    return items
  }
  const reportResponse = (request: Message) => send({ type: 'preflight-report', scanId: request.scanId, requestId: request.requestId, json: report, serverNamingPending })
  await send({ type: 'console-state', connected: true, busy: false })
  await send({ type: 'project-rules-state', paired: true, stale: false })
  return { ui, scan, send, effects, requests, reportResponse }
}
type Plugin = Awaited<ReturnType<typeof plugin>>
const test = base.extend<{ plugin: Plugin }>({
  plugin: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await plugin(page)
    await use(fixture)
    expect(errors).toEqual([])
    const effects = await fixture.effects()
    expect(effects.fetches).toEqual([])
    expect(effects.messages.filter(message => ['console-sync', 'save-settings'].includes(message.type))).toEqual([])
  },
})

test('shows both normalized collisions and keeps hidden issues blocking console submission', async ({ page, plugin }, info) => {
  await plugin.scan()
  await expect(plugin.ui.locator('#status')).toHaveText('2 of 3 icons need fixes · 1 drafts skipped')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(3)
  await expect(plugin.ui.getByText(issue, { exact: true })).toHaveCount(2)
  const submit = plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })
  await expect(submit).toBeDisabled()
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(2)
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('DUPLICATE ICON NAME')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(2)
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('Circle')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
  await expect(submit).toBeDisabled()
  await plugin.ui.getByLabel('Problems only', { exact: true }).uncheck()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  await expect(submit).toBeDisabled()
  await submit.dispatchEvent('click')
  await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await page.locator('iframe').screenshot({ path: info.outputPath('collision-overview.png') })
})

test('blocks GitHub dispatch with the same default-name collisions and explains the applied rule', async ({ page, plugin }, info) => {
  await plugin.ui.getByLabel('Connection mode').selectOption('github')
  await plugin.scan(21, inputs, defaultRules, 'github')
  const submit = plugin.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })
  await expect(submit).toBeDisabled()
  await submit.dispatchEvent('click')
  await plugin.ui.locator('#applied-rules summary').click()
  await expect(plugin.ui.locator('#rules-content')).toContainText('Default local naming. Duplicate names are checked on this page.')
  await page.locator('iframe').screenshot({ path: info.outputPath('collision-github-rules.png') })
})

test('locates each conflicting node using its own ID and the captured scan', async ({ plugin }) => {
  await plugin.scan(22)
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  for (const input of inputs.slice(0, 2)) {
    const locate = plugin.ui.getByRole('button', { name: `Locate ${input.name}`, exact: true })
    await locate.focus()
    await locate.press('Enter')
    const request = (await plugin.requests('locate')).at(-1)!
    expect(request).toMatchObject({ scanId: 22, nodeId: input.id })
    await plugin.send({ type: 'navigation-result', scanId: 22, requestId: request.requestId, text: `Located ${input.name}` })
    await expect(plugin.ui.locator('#navigation-status')).toHaveText(`Located ${input.name}`)
  }
  expect((await plugin.requests('locate')).map(message => message.nodeId)).toEqual(['1:1', '1:2'])
})

test('downloads both conflicts and skipped nodes from the complete scan despite a valid-only search', async ({ page, plugin }, info) => {
  const items = await plugin.scan(23)
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('Circle')
  await expect(plugin.ui.locator('#list > li')).toHaveCount(1)
  const button = plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })
  await button.focus()
  await button.press('Enter')
  const requests = await plugin.requests('export-report')
  expect(requests).toHaveLength(1)
  const downloading = page.waitForEvent('download')
  await plugin.reportResponse(requests[0]!)
  const download = await downloading
  expect(await download.failure()).toBeNull()
  expect(download.suggestedFilename()).toBe('iconctl-preflight-23.json')
  const path = info.outputPath('collision-report.json')
  await download.saveAs(path)
  const report = JSON.parse(await readFile(path, 'utf8'))
  expect(report).toMatchObject({ scanId: 23, summary: { total: 4, checked: 3, skipped: 1, withIssues: 2, issueCount: 2, canSubmit: false }, items })
  expect(report.items.slice(0, 2).map((item: { issues: string[] }) => item.issues)).toEqual([[issue], [issue]])
  await expect.poll(async () => {
    const events = (await plugin.effects()).resources
    return events.filter(item => item.type === 'create').every(item => events.some(other => other.type === 'revoke' && item.url === other.url))
  }).toBe(true)
  expect((await plugin.effects()).resources.filter(item => item.type === 'create')).toHaveLength(1)
  await expect(plugin.ui.locator('a[download]')).toHaveCount(0)
  await page.locator('iframe').screenshot({ path: info.outputPath('collision-report-filtered.png') })
})

test('clears a renamed collision only after rescan and blocks again when a later scan collides', async ({ plugin }) => {
  await plugin.scan(24)
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await plugin.scan(25, [inputs[0]!, node('1:2', 'Arrow Right'), inputs[2]!, inputs[3]!])
  await expect(plugin.ui.locator('#status')).toHaveText('3 icons ready · 1 drafts skipped')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  await expect(plugin.ui.getByText(issue, { exact: true })).toHaveCount(0)
  await plugin.scan(26)
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await expect(plugin.ui.getByText(issue, { exact: true })).toHaveCount(2)
})

test('keeps server naming provisional without applying a speculative local collision block', async ({ page, plugin }, info) => {
  await plugin.scan(27, inputs, { namingMode: 'server' })
  await expect(plugin.ui.locator('#status')).toHaveText('3 icons ready · 1 drafts skipped')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  await expect(plugin.ui.getByText(issue, { exact: true })).toHaveCount(0)
  await plugin.ui.locator('#applied-rules summary').click()
  await expect(plugin.ui.locator('#rules-content')).toContainText('Provisional — custom naming is validated by the server.')
  await expect(plugin.ui.locator('#rules-validity')).toContainText('Server validation is still required.')
  await page.locator('iframe').screenshot({ path: info.outputPath('collision-server-naming.png') })
})

test('wraps long normalized collision text while keeping keyboard Locate and report export reachable', async ({ page, plugin }, info) => {
  const first = 'Arrow Very Long '.repeat(14).trim()
  const second = first.toLowerCase().replaceAll(' ', '_')
  await plugin.scan(28, [node('9:1', first), node('9:2', second)])
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(2)
  for (const name of [first, second]) {
    const locate = plugin.ui.getByRole('button', { name: `Locate ${name}`, exact: true })
    await locate.focus()
    await locate.press('Enter')
    await expect(locate).toBeInViewport()
  }
  expect((await plugin.requests('locate')).map(message => message.nodeId)).toEqual(['9:1', '9:2'])
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('collision-long-names.png') })
  const button = plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })
  await button.focus()
  await button.press('Enter')
  expect(await plugin.requests('export-report')).toHaveLength(1)
  await expect(button).toBeInViewport()
})

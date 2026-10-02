import type { Download, Page, TestInfo } from '@playwright/test'
import type { PreflightItem } from '../../../packages/figma-plugin/src/preflight'
import { readFile } from 'node:fs/promises'
import { test as base, expect } from '@playwright/test'

interface Message {
  type: string
  scanId?: number
  requestId?: number
  json?: string
  serverNamingPending?: boolean
  [key: string]: unknown
}
interface ResourceEvent { type: string, url?: string }
const items: PreflightItem[] = [
  { id: '1:1', name: 'Arrow', iconName: 'arrow', width: 24, height: 24, skipped: false, issues: [] },
  { id: '1:2', name: '<img data-injected="report" src="x">', iconName: 'bad-canvas', width: 48, height: 24, skipped: false, issues: ['Canvas is 48×24, expected 24×24'] },
  { id: '1:3', name: '_draft', iconName: null, width: 24, height: 24, skipped: true, issues: [] },
]
const instrumentation = `<script>
  parent.__reportResources = [];
  const record = (type, url) => parent.__reportResources.push({ type, url });
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  const click = HTMLAnchorElement.prototype.click;
  const NativeBlob = Blob;
  window.Blob = new Proxy(NativeBlob, { construct(target, args) {
    if (window.__reportFailure === 'blob') throw new Error('fixture Blob failure');
    return Reflect.construct(target, args);
  }});
  URL.createObjectURL = (blob) => {
    if (window.__reportFailure === 'url') throw new Error('fixture URL failure');
    const url = create(blob); record('create', url); return url;
  };
  URL.revokeObjectURL = (url) => { record('revoke', url); return revoke(url); };
  HTMLAnchorElement.prototype.click = function() {
    if (this.download) {
      record('click', this.href);
      if (window.__reportFailure === 'click') throw new Error('fixture click failure');
    }
    return click.call(this);
  };
</script>`

async function plugin(page: Page) {
  const messages: Message[] = []
  await page.exposeFunction('recordPluginMessage', (message: Message) => messages.push(message))
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  const html = (await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')).replace('<head>', `<head>${instrumentation}`)
  await page.evaluate((html) => {
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data.pluginMessage) {
        const host = window as unknown as { recordPluginMessage: (message: unknown) => Promise<void> }
        void host.recordPluginMessage(event.data.pluginMessage)
      }
    })
    frame.srcdoc = html
  }, html)
  const ui = page.frameLocator('iframe')
  await expect.poll(() => messages.some(message => message.type === 'rescan')).toBe(true)
  const send = (message: unknown) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const requests = () => messages.filter(message => message.type === 'export-report')
  let captured: { json: string, serverNamingPending: boolean }
  const scan = async (scanId: number, scanned = items, server = false, mode = 'console') => {
    // The actual host capture is covered in report.test.ts. This boundary fixture
    // exercises the built UI's complete wire document and real Blob download.
    captured = { serverNamingPending: server, json: JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scanId,
      scope: 'current-page',
      page: { id: 'page:1', name: 'Icons' },
      mode,
      rulesSource: mode === 'console' ? 'project' : 'legacy-defaults',
      ...(mode === 'console' ? { project: { name: 'Brand', revision: 7 } } : {}),
      rules: { width: 24, height: 24, name: '^[a-z0-9]+(?:-[a-z0-9]+)*$', skipPrefix: ['_', '.'], namingMode: server ? 'server' : 'default' },
      serverValidationRequired: true,
      summary: {
        total: scanned.length,
        checked: scanned.filter(item => !item.skipped).length,
        skipped: scanned.filter(item => item.skipped).length,
        withIssues: scanned.filter(item => item.issues.length > 0).length,
        issueCount: scanned.reduce((count, item) => count + item.issues.length, 0),
        canSubmit: scanned.some(item => !item.skipped) && scanned.every(item => item.skipped || item.issues.length === 0),
      },
      items: scanned,
    }, null, 2) }
    await send({ type: 'preflight', scanId, reportAvailable: true, items: scanned })
  }
  const response = (request: Message) => ({ type: 'preflight-report', scanId: request.scanId, requestId: request.requestId, ...captured })
  const resources = () => page.evaluate(() => (window as unknown as { __reportResources: ResourceEvent[] }).__reportResources)
  const failure = (value: string) => ui.locator('body').evaluate((_element, value) => {
    (window as unknown as { __reportFailure: string }).__reportFailure = value
  }, value)
  const exported = async () => {
    const count = requests().length
    await ui.getByRole('button', { name: 'Export JSON report', exact: true }).click()
    await expect.poll(() => requests().length).toBe(count + 1)
    return requests().at(-1)!
  }
  return { ui, send, scan, response, exported, requests, resources, failure, messages }
}

type Plugin = Awaited<ReturnType<typeof plugin>>
const test = base.extend<{ plugin: Plugin }>({
  plugin: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await plugin(page)
    await use(fixture)
    expect(errors).toEqual([])
  },
})

async function save(download: Download, info: TestInfo, name: string) {
  expect(await download.failure()).toBeNull()
  const path = info.outputPath(name)
  await download.saveAs(path)
  return JSON.parse(await readFile(path, 'utf8'))
}
async function expectReleased(plugin: Plugin) {
  await expect.poll(async () => {
    const events = await plugin.resources()
    return events.filter(item => item.type === 'create').every(item => events.some(other => other.type === 'revoke' && other.url === item.url))
  }).toBe(true)
  await expect(plugin.ui.locator('a[download]')).toHaveCount(0)
}

test('downloads every scanned item despite filters, preserves an immutable scan and releases each Blob URL', async ({ page, plugin }, info) => {
  const network: string[] = []
  page.on('request', request => network.push(request.url()))
  await plugin.scan(17, items, true)
  await plugin.send({ type: 'settings', settings: { repo: 'secret/repo', token: 'github-token-sentinel', eventType: 'private-event-sentinel' } })
  await plugin.send({ type: 'console-status', text: 'running · fetching', busy: true, connected: true, url: 'https://iconctl.icebreaker.top/app/?job=device-task-sentinel' })
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('arrow')
  await plugin.ui.getByLabel('Problems only', { exact: true }).check()
  await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
  await plugin.send({ type: 'storage-status', scope: 'preferences', error: true, text: 'Could not save view preferences.' })
  const first = await plugin.exported()
  await expect(plugin.ui.locator('#export-report')).toBeDisabled()
  await plugin.ui.locator('#export-report').evaluate(element => (element as HTMLButtonElement).click())
  expect(plugin.requests()).toHaveLength(1)
  // A view-only filter change does not invalidate the full captured scan.
  await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  const firstDownload = page.waitForEvent('download')
  const payload = plugin.response(first)
  await plugin.send(payload)
  const download = await firstDownload
  expect(download.suggestedFilename()).toBe('iconctl-preflight-17.json')
  const report = await save(download, info, 'complete-report.json')
  expect(report).toMatchObject({ schemaVersion: 1, scanId: 17, scope: 'current-page', page: { id: 'page:1', name: 'Icons' }, mode: 'console', rulesSource: 'project', project: { name: 'Brand', revision: 7 }, rules: { width: 24, height: 24, namingMode: 'server' }, serverValidationRequired: true, summary: { total: 3, checked: 2, skipped: 1, withIssues: 1, issueCount: 1, canSubmit: false }, items })
  expect(Number.isFinite(Date.parse(report.generatedAt))).toBe(true)
  expect(Object.keys(report).sort()).toEqual(['generatedAt', 'items', 'mode', 'page', 'project', 'rules', 'rulesSource', 'scanId', 'schemaVersion', 'scope', 'serverValidationRequired', 'summary'].sort())
  for (const item of report.items) {
    expect(Object.keys(item).sort()).toEqual(['height', 'iconName', 'id', 'issues', 'name', 'skipped', 'width'])
  }
  expect(JSON.stringify(report)).not.toMatch(/github-token-sentinel|private-event-sentinel|device-task-sentinel|secret\/repo/)
  await expectReleased(plugin)
  const events = await plugin.resources()
  await plugin.send(payload)
  expect(await plugin.resources()).toEqual(events)
  await expect(plugin.ui.locator('#report-status')).toContainText('Names are provisional until server naming runs.')
  await expect(plugin.ui.locator('#report-status')).toContainText('server validation is still required')
  await expect(plugin.ui.locator('#console-status')).toContainText('running · fetching')
  await expect(plugin.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=device-task-sentinel')
  await expect(plugin.ui.locator('#preferences-feedback')).toBeVisible()
  await expect(plugin.ui.locator('#status')).toHaveText('1 of 2 icons need fixes · 1 drafts skipped')
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await plugin.ui.locator('html').evaluate(element => element.scrollTo({ top: 0 }))
  await page.locator('iframe').screenshot({ path: info.outputPath('report-complete-top.png') })
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).scrollIntoViewIfNeeded()
  await expect(plugin.ui.getByRole('button', { name: 'Rescan', exact: true })).toBeInViewport()
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeInViewport()
  await expect(plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })).toBeInViewport()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.locator('iframe').screenshot({ path: info.outputPath('report-complete-scrolled.png') })
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('draft')
  const second = await plugin.exported()
  expect(second.requestId).toBeGreaterThan(first.requestId!)
  const secondDownload = page.waitForEvent('download')
  await plugin.send(plugin.response(second))
  expect(await save(await secondDownload, info, 'same-scan-report.json')).toEqual(report)
  await expectReleased(plugin)
  expect((await plugin.resources()).map(item => item.type).sort()).toEqual(['click', 'click', 'create', 'create', 'revoke', 'revoke'].sort())
  expect(plugin.messages.filter(message => ['console-sync', 'dispatch', 'upload', 'save-settings'].includes(message.type))).toEqual([])
  expect(network).toEqual([])
  await expect(plugin.ui.locator('[data-injected]')).toHaveCount(0)
})

test('distinguishes an empty successful scan from an unavailable report and supports keyboard export at 420 by 560', async ({ page, plugin }, info) => {
  const button = plugin.ui.getByRole('button', { name: 'Export JSON report', exact: true })
  await expect(button).toBeDisabled()
  await plugin.send({ type: 'preflight', scanId: 2, items: [] })
  await expect(button).toBeDisabled()
  await plugin.scan(3, [])
  await expect(button).toBeEnabled()
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('empty scan filter')
  await plugin.ui.getByRole('button', { name: 'Clear filters', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => plugin.requests().length).toBe(1)
  const download = page.waitForEvent('download')
  await plugin.send(plugin.response(plugin.requests()[0]!))
  expect(await save(await download, info, 'empty-report.json')).toMatchObject({ items: [], summary: { total: 0, checked: 0, skipped: 0, withIssues: 0, issueCount: 0, canSubmit: false } })
  await expect(plugin.ui.locator('#report-status')).toHaveAttribute('aria-live', 'polite')
  await expectReleased(plugin)
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('report-keyboard.png') })
  await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).scrollIntoViewIfNeeded()
  await expect(plugin.ui.getByRole('button', { name: 'Rescan', exact: true })).toBeInViewport()
  await expect(plugin.ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeInViewport()
  expect(await plugin.ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('report-scrolled.png') })
})

for (const trigger of ['rescan', 'failed-scan', 'page', 'mode', 'disconnect', 'new-scan'] as const) {
  test(`rejects pending report responses immediately after ${trigger}`, async ({ plugin }) => {
    await plugin.scan(20)
    const old = await plugin.exported()
    const payload = plugin.response(old)
    if (trigger === 'rescan' || trigger === 'failed-scan') {
      await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
      if (trigger === 'failed-scan') {
        await plugin.send({ type: 'navigation-invalidated', scanId: 21, error: true, text: 'Could not scan this page. Rescan and try again.' })
      }
    }
    else if (trigger === 'page') {
      await plugin.send({ type: 'navigation-invalidated', scanId: 21, text: 'Page changed. Rescan the new page.' })
    }
    else if (trigger === 'mode') {
      await plugin.ui.getByLabel('Connection mode').selectOption('github')
    }
    else if (trigger === 'disconnect') {
      await plugin.ui.getByRole('button', { name: 'Disconnect', exact: true }).click()
    }
    else {
      await plugin.scan(21)
    }
    const feedback = await plugin.ui.locator('#report-status').textContent()
    await plugin.send(payload)
    expect(await plugin.resources()).toEqual([])
    await expect(plugin.ui.locator('#report-status')).toHaveText(feedback!)
    if (trigger !== 'new-scan') {
      await expect(plugin.ui.locator('#export-report')).toBeDisabled()
      await plugin.scan(22)
    }
    await expect(plugin.ui.locator('#export-report')).toBeEnabled()
    const current = await plugin.exported()
    expect(current.scanId).not.toBe(old.scanId)
    const pending = await plugin.ui.locator('#report-status').textContent()
    await plugin.send({ ...payload, requestId: current.requestId })
    await plugin.send({ ...payload, scanId: current.scanId })
    expect(await plugin.resources()).toEqual([])
    await expect(plugin.ui.locator('#report-status')).toHaveText(pending!)
    await plugin.send({ ...current, type: 'preflight-report', error: true, rescan: true, text: 'This scan is no longer available. Rescan the page before exporting.' })
    await expect(plugin.ui.locator('#export-report')).toBeDisabled()
    await expect(plugin.ui.locator('#report-status')).toHaveClass('err')
  })
}

for (const failure of ['blob', 'url', 'click'] as const) {
  test(`cleans a failed ${failure} download and allows a fresh export request`, async ({ page, plugin }, info) => {
    await plugin.scan(30)
    await plugin.failure(failure)
    const failed = await plugin.exported()
    await plugin.send(plugin.response(failed))
    await expect(plugin.ui.locator('#report-status')).toHaveText('Could not download the report. Try exporting again.')
    await expect(plugin.ui.locator('#export-report')).toBeEnabled()
    await expectReleased(plugin)
    expect((await plugin.resources()).filter(item => item.type === 'create')).toHaveLength(failure === 'click' ? 1 : 0)
    await plugin.failure('')
    const retry = await plugin.exported()
    expect(retry.requestId).not.toBe(failed.requestId)
    const download = page.waitForEvent('download')
    await plugin.send(plugin.response(retry))
    expect(await save(await download, info, `retry-${failure}.json`)).toMatchObject({ scanId: 30, items })
    await expectReleased(plugin)
  })
}

test('ignores a queued response after the plugin frame closes', async ({ page, plugin }) => {
  await plugin.scan(40)
  const old = await plugin.exported()
  const payload = plugin.response(old)
  await page.evaluate((payload) => {
    const frame = document.querySelector('iframe')!
    const target = frame.contentWindow!
    frame.remove()
    target.postMessage({ pluginMessage: payload }, '*')
  }, payload)
  expect(await plugin.resources()).toEqual([])
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('keeps Locate feedback and GitHub dispatch progress independent of local report downloads', async ({ page, plugin }, info) => {
  let finishDispatch!: () => void
  const gate = new Promise<void>((resolve) => {
    finishDispatch = resolve
  })
  let dispatches = 0
  await page.route('https://api.github.com/**', async (route) => {
    expect(route.request().url()).toBe('https://api.github.com/repos/fixture/icons/dispatches')
    expect(route.request().postDataJSON()).toEqual({ event_type: 'fixture-publish' })
    dispatches++
    await gate
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
  })
  await plugin.send({ type: 'settings', settings: { repo: 'fixture/icons', token: 'fixture-token', eventType: 'fixture-publish' } })
  await plugin.ui.getByLabel('Connection mode').selectOption('github')
  await plugin.scan(50, [items[0]!], false, 'github')
  await plugin.ui.getByRole('button', { name: 'Locate Arrow', exact: true }).click()
  await expect.poll(() => plugin.messages.filter(item => item.type === 'locate').length).toBe(1)
  const locate = plugin.messages.find(item => item.type === 'locate')!
  await plugin.send({ ...locate, type: 'navigation-result', text: 'Located Arrow', error: false })
  await expect(plugin.ui.getByRole('status')).toHaveText('Located Arrow')
  try {
    await plugin.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true }).click()
    await expect.poll(() => dispatches).toBe(1)
    const request = await plugin.exported()
    const download = page.waitForEvent('download')
    await plugin.send(plugin.response(request))
    expect(await save(await download, info, 'during-dispatch.json')).toMatchObject({ mode: 'github', rulesSource: 'legacy-defaults' })
    await expect(plugin.ui.locator('#status')).toHaveText('Dispatching GitHub Action…')
    await expect(plugin.ui.getByRole('status')).toHaveText('Located Arrow')
    await expect(plugin.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeDisabled()
    finishDispatch()
    await expect(plugin.ui.locator('#status')).toHaveText('Workflow started. https://github.com/fixture/icons/actions')
    const second = await plugin.exported()
    const again = page.waitForEvent('download')
    await plugin.send(plugin.response(second))
    await save(await again, info, 'after-dispatch.json')
    await expect(plugin.ui.locator('#status')).toHaveText('Workflow started. https://github.com/fixture/icons/actions')
    await expect(plugin.ui.getByRole('status')).toHaveText('Located Arrow')
    expect(dispatches).toBe(1)
    await expectReleased(plugin)
  }
  finally {
    finishDispatch()
  }
})

for (const mode of ['console', 'github'] as const) {
  test(`blocks ${mode} submission from an invalidated scan before any persistence or network effects`, async ({ page, plugin }) => {
    const outbound: string[] = []
    await page.route('https://api.github.com/**', async (route) => {
      outbound.push(route.request().url())
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
    })
    await page.evaluate(() => {
      const frame = document.querySelector('iframe')!.contentWindow!
      const effects = { messages: [] as string[], fetches: [] as string[] }
      ;(window as unknown as { submissionEffects: typeof effects }).submissionEffects = effects
      window.addEventListener('message', (event) => {
        const type = event.data?.pluginMessage?.type
        if (event.source === frame && ['console-sync', 'save-settings'].includes(type)) {
          effects.messages.push(type)
        }
      })
      const original = frame.fetch.bind(frame)
      frame.fetch = (input, init) => {
        effects.fetches.push(String(input))
        return original(input, init)
      }
    })
    const effects = () => page.evaluate(() => (window as unknown as { submissionEffects: { messages: string[], fetches: string[] } }).submissionEffects)
    await plugin.send({ type: 'settings', settings: { repo: 'fixture/icons', token: 'fixture-token', eventType: 'fixture-publish' } })
    await plugin.send({ type: 'console-state', connected: true, busy: false })
    await plugin.ui.getByLabel('Connection mode').selectOption(mode)
    const submit = plugin.ui.getByRole('button', { name: mode === 'console' ? 'Sync to console' : 'Dispatch GitHub Action', exact: true })
    let scanId = 60
    await plugin.scan(scanId++, [items[0]!], false, mode)
    await expect(submit).toBeEnabled()
    await plugin.ui.getByLabel('Search preflight', { exact: true }).fill('no matching icons')
    await plugin.ui.getByLabel('Problems only', { exact: true }).check()
    await expect(plugin.ui.locator('#list > li')).toHaveCount(0)
    await expect(submit).toBeEnabled()

    for (const trigger of ['rescan', 'failed-scan', 'page'] as const) {
      if (trigger === 'rescan') {
        await plugin.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
      }
      else {
        await plugin.send({ type: 'navigation-invalidated', scanId, error: true, text: trigger === 'page' ? 'Page changed. Rescan the new page.' : 'Could not scan this page. Rescan and try again.' })
      }
      await expect.soft(submit, `${mode}: ${trigger} must disable submission immediately`).toBeDisabled()
      // dispatchEvent bypasses a disabled button's native click protection and
      // verifies the action itself guards before settings persistence or fetch.
      await submit.dispatchEvent('click')
      await plugin.send({ type: 'test-submission-boundary' })
      expect(await effects(), `${mode}: ${trigger} must have no submission side effects`).toEqual({ messages: [], fetches: [] })
      expect(outbound).toEqual([])
      await plugin.scan(scanId++, [items[0]!], false, mode)
      await expect(submit).toBeEnabled()
    }

    // Older hosts can still publish a complete preflight without a scan ID.
    // That authorizes submission while the versioned report remains unavailable.
    await plugin.send({ type: 'preflight', items: [items[0]!] })
    await expect(submit).toBeEnabled()
    await expect(plugin.ui.locator('#export-report')).toBeDisabled()
    await submit.click()
    if (mode === 'console') {
      await expect.poll(async () => (await effects()).messages).toEqual(['console-sync'])
      expect((await effects()).fetches).toEqual([])
      expect(outbound).toEqual([])
    }
    else {
      await expect.poll(() => outbound).toEqual(['https://api.github.com/repos/fixture/icons/dispatches'])
      await expect.poll(async () => (await effects()).messages).toEqual(['save-settings'])
      expect((await effects()).fetches).toHaveLength(1)
    }
  })
}

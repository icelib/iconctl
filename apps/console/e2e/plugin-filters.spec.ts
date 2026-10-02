import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

interface Settings {
  repo: string
  token: string
  eventType: string
}
interface PluginMessage {
  type: string
  nodeId?: string
  scanId?: number
  requestId?: number
  mode?: string
  scope?: 'settings' | 'preferences'
  settings?: Settings
  preferences?: { problemsOnly: boolean }
}

function item(id: string, name: string, extra: { iconName?: string, issues?: string[], skipped?: boolean } = {}) {
  return { id, name, iconName: name.toLowerCase(), skipped: false, width: 24, height: 24, issues: [] as string[], ...extra }
}

async function plugin(page: Page, restore?: { settings: Settings, preferences: { problemsOnly: boolean } }) {
  const messages: PluginMessage[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('recordPluginMessage', (message: PluginMessage) => messages.push(message))
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  const html = await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')
  await page.evaluate(({ html, restore }) => {
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || !event.data.pluginMessage) {
        return
      }
      const message = event.data.pluginMessage
      const host = window as unknown as { recordPluginMessage: (message: unknown) => Promise<void> }
      void host.recordPluginMessage(message)
      if (message.type === 'load-settings' && restore) {
        frame.contentWindow!.postMessage({ pluginMessage: { type: 'settings', settings: restore.settings } }, '*')
        frame.contentWindow!.postMessage({ pluginMessage: { type: 'preferences', preferences: restore.preferences } }, '*')
      }
    })
    frame.srcdoc = html
  }, { html, restore })
  const ui = page.frameLocator('iframe')
  await expect.poll(() => messages.filter(message => message.type === 'load-settings').length).toBe(1)
  const send = (message: unknown) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const requests = (type: string) => messages.filter(message => message.type === type)
  return { ui, send, requests, errors }
}

test('receives settings and preferences immediately after the UI-ready load request', async ({ page }) => {
  const settings = { repo: 'stored/icons', token: 'test-stored-token', eventType: 'stored-event' }
  const { ui, send, requests, errors } = await plugin(page, { settings, preferences: { problemsOnly: true } })
  await expect(ui.getByLabel('Problems only', { exact: true })).toBeChecked()
  await send({ type: 'preflight', scanId: 1, items: [item('1:1', 'Clean'), item('1:2', 'Broken', { issues: ['Wrong canvas'] })] })
  await expect(ui.locator('#list strong')).toHaveText(['Broken'])
  await expect(ui.locator('#view-count')).toHaveText('Showing 1 of 2 icons')
  await ui.getByLabel('Connection mode').selectOption('github')
  await expect(ui.getByLabel('GitHub repo', { exact: true })).toHaveValue(settings.repo)
  await expect(ui.getByLabel('GitHub token (Contents: read and write)', { exact: true })).toHaveValue(settings.token)
  await expect(ui.getByLabel('Event type', { exact: true })).toHaveValue(settings.eventType)
  expect(requests('save-settings')).toEqual([])
  expect(requests('save-preferences')).toEqual([])
  expect(errors).toEqual([])
})

test('intersects literal name and issue search with problems-only and distinguishes empty views', async ({ page }, testInfo) => {
  const { ui, send, errors } = await plugin(page)
  const hostile = 'Arrow [Literal].* <img data-injected="name" src="x">'
  await send({
    type: 'preflight',
    scanId: 2,
    items: [
      item('1:1', hostile, { iconName: 'navigation-chevron' }),
      item('1:2', 'Broken', { iconName: 'final-warning', issues: ['Canvas [24].* MiXeD <svg data-injected="issue">'] }),
      item('1:3', 'Home'),
      item('1:4', '_draft', { skipped: true, issues: ['Canvas [24].*'] }),
    ],
  })
  const search = ui.getByLabel('Search preflight', { exact: true })
  await expect(ui.locator('#view-count')).toHaveText('Showing 3 of 3 icons')
  for (const [query, expected] of [
    ['  [LiTeRaL].*  ', [hostile]],
    ['NAVIGATION-CHEVRON', [hostile]],
    ['FINAL-WARNING', ['Broken']],
    [' [24].* mixed ', ['Broken']],
    ['<svg', ['Broken']],
    ['_draft', []],
  ] as const) {
    await search.fill(query)
    await expect(ui.locator('#list strong')).toHaveText([...expected])
    await expect(ui.locator('#view-count')).toHaveText(`Showing ${expected.length} of 3 icons`)
  }
  await expect(ui.locator('#empty-view')).toHaveText('No icons match these filters.')
  await search.fill('navigation')
  await ui.getByLabel('Problems only', { exact: true }).check()
  await expect(ui.locator('#list > li')).toHaveCount(0)
  await search.fill('broken')
  await expect(ui.locator('#list strong')).toHaveText(['Broken'])
  await expect(ui.locator('#status')).toHaveText('1 of 3 icons need fixes · 1 drafts skipped')
  await ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(search).toHaveValue('')
  await expect(ui.getByLabel('Problems only', { exact: true })).not.toBeChecked()
  await expect(ui.locator('#list strong')).toHaveText([hostile, 'Broken', 'Home'])
  await expect(ui.locator('#list img, #list svg, #list [data-injected]')).toHaveCount(0)
  expect(await ui.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: testInfo.outputPath('plugin-filters.png') })
  await ui.getByRole('button', { name: 'Rescan', exact: true }).scrollIntoViewIfNeeded()
  await expect(ui.getByRole('button', { name: 'Rescan', exact: true })).toBeInViewport()
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeInViewport()
  expect(await ui.locator('html').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await page.locator('iframe').screenshot({ path: testInfo.outputPath('plugin-filters-scrolled.png') })
  await send({ type: 'preflight', scanId: 3, items: [item('1:4', '_draft', { skipped: true })] })
  await expect(ui.locator('#view-count')).toHaveText('Showing 0 of 0 icons')
  await expect(ui.locator('#empty-view')).toHaveText('No icons to display on this page.')
  await expect(ui.locator('#empty-view')).toBeVisible()
  expect(errors).toEqual([])
})

test('uses the full preflight for submission eligibility even when filters hide every error or every icon', async ({ page }) => {
  const { ui, send, requests, errors } = await plugin(page)
  const clean = item('1:1', 'Clean')
  const broken = item('1:2', 'Broken', { issues: ['Wrong size'] })
  await send({ type: 'console-state', connected: true, busy: false })
  await send({ type: 'preflight', scanId: 4, items: [clean, broken] })
  await ui.getByLabel('Search preflight', { exact: true }).fill('clean')
  await expect(ui.locator('#list strong')).toHaveText(['Clean'])
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await ui.getByLabel('Connection mode').selectOption('github')
  await send({ type: 'preflight', scanId: 5, items: [clean, broken] })
  await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeDisabled()
  await ui.getByLabel('Problems only', { exact: true }).check()
  await expect(ui.locator('#list > li')).toHaveCount(0)
  await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeDisabled()
  await send({ type: 'preflight', scanId: 6, items: [clean] })
  await expect(ui.locator('#list > li')).toHaveCount(0)
  await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
  await ui.getByLabel('Connection mode').selectOption('console')
  await send({ type: 'preflight', scanId: 7, items: [clean] })
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeEnabled()
  await ui.getByRole('button', { name: 'Sync to console', exact: true }).click()
  await expect.poll(() => requests('console-sync').length).toBe(1)
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})

test('cancels pending Locate feedback on view changes, permits a new Locate and preserves filters on rescan', async ({ page }) => {
  const { ui, send, requests, errors } = await plugin(page)
  await send({ type: 'preflight', scanId: 10, items: [item('1:1', 'Arrow'), item('1:2', 'Home', { issues: ['Wrong size'] })] })
  await ui.getByRole('button', { name: 'Locate Arrow', exact: true }).click()
  await expect.poll(() => requests('locate').length).toBe(1)
  const old = requests('locate')[0]!
  const scans = requests('rescan').length
  await ui.getByLabel('Search preflight', { exact: true }).fill('home')
  await expect.poll(() => requests('cancel-navigation').length).toBe(1)
  expect(requests('cancel-navigation')[0]).toEqual({ type: 'cancel-navigation', scanId: 10 })
  expect(requests('rescan')).toHaveLength(scans)
  await send({ ...old, type: 'navigation-result', text: 'Stale Arrow', error: true })
  await expect(ui.getByRole('status')).toHaveText('')
  await ui.getByRole('button', { name: 'Locate Home', exact: true }).click()
  await expect.poll(() => requests('locate').length).toBe(2)
  const latest = requests('locate')[1]!
  expect(latest.scanId).toBe(old.scanId)
  expect(latest.requestId).toBeGreaterThan(old.requestId!)
  await send({ ...latest, type: 'navigation-result', text: 'Located Home', error: false })
  await expect(ui.getByRole('status')).toHaveText('Located Home')
  await ui.getByLabel('Problems only', { exact: true }).check()
  await expect(ui.getByRole('status')).toHaveText('')
  await ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect.poll(() => requests('rescan').length).toBe(scans + 1)
  await expect(ui.getByRole('button', { name: 'Locate Home', exact: true })).toBeDisabled()
  await send({ type: 'preflight', scanId: 11, items: [item('2:1', 'Home new', { issues: ['Wrong size'] }), item('2:2', 'Arrow')] })
  await expect(ui.getByLabel('Search preflight', { exact: true })).toHaveValue('home')
  await expect(ui.getByLabel('Problems only', { exact: true })).toBeChecked()
  await expect(ui.locator('#list strong')).toHaveText(['Home new'])
  await ui.getByRole('button', { name: 'Locate Home new', exact: true }).click()
  await expect.poll(() => requests('locate').length).toBe(3)
  expect(requests('locate')[2]!.scanId).toBe(11)
  expect(errors).toEqual([])
})

test('preserves active console status, task links and the full scan summary while filtering', async ({ page }) => {
  const { ui, send, errors } = await plugin(page)
  await send({ type: 'preflight', scanId: 12, items: [item('1:1', 'Home'), item('1:2', 'Arrow')] })
  const url = 'https://iconctl.icebreaker.top/app/?job=active'
  await send({ type: 'console-status', text: 'running · fetching', busy: true, connected: true, url })
  await ui.getByLabel('Search preflight', { exact: true }).fill('missing')
  await ui.getByLabel('Problems only', { exact: true }).check()
  await send({ type: 'storage-status', scope: 'preferences', error: true, text: 'Could not save view preferences.' })
  await expect(ui.locator('#list > li')).toHaveCount(0)
  await expect(ui.locator('#status')).toHaveText('2 icons ready')
  await expect(ui.locator('#console-status')).toContainText('running · fetching')
  await expect(ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', url)
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  await ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(ui.locator('#console-status')).toContainText('running · fetching')
  await expect(ui.locator('#status')).toHaveText('2 icons ready')
  expect(errors).toEqual([])
})

test('keeps GitHub dispatch progress and completion when changing the visible preflight list', async ({ page }) => {
  let release!: () => void
  const response = new Promise<void>((resolve) => {
    release = resolve
  })
  let dispatched = false
  await page.route('https://api.github.com/**', async (route) => {
    expect(route.request().url()).toBe('https://api.github.com/repos/test/icons/dispatches')
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers().authorization).toBe('Bearer test-fixture-token')
    expect(route.request().postDataJSON()).toEqual({ event_type: 'fixture-publish' })
    dispatched = true
    await response
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
  })
  const { ui, send, requests, errors } = await plugin(page)
  const settings = { repo: 'test/icons', token: 'test-fixture-token', eventType: 'fixture-publish' }
  await send({ type: 'settings', settings })
  await ui.getByLabel('Connection mode').selectOption('github')
  await send({ type: 'preflight', scanId: 13, items: [item('1:1', 'Home')] })
  try {
    await ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true }).click()
    await expect.poll(() => dispatched).toBe(true)
    await expect(ui.locator('#status')).toHaveText('Dispatching GitHub Action…')
    await ui.getByLabel('Search preflight', { exact: true }).fill('missing')
    await expect(ui.locator('#list > li')).toHaveCount(0)
    await expect(ui.locator('#status')).toHaveText('Dispatching GitHub Action…')
    await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeDisabled()
    release()
    const completed = 'Workflow started. https://github.com/test/icons/actions'
    await expect(ui.locator('#status')).toHaveText(completed)
    await ui.getByLabel('Problems only', { exact: true }).check()
    await expect(ui.locator('#status')).toHaveText(completed)
    await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
    await expect.poll(() => requests('save-settings')).toEqual([{ type: 'save-settings', settings }])
    expect(errors).toEqual([])
  }
  finally {
    release()
  }
})

for (const key of ['repo', 'token', 'eventType'] as const) {
  test(`preserves edited and explicitly cleared ${key} while restoring untouched legacy fields`, async ({ page }) => {
    const { ui, send, errors } = await plugin(page)
    const selectors = { repo: '#repo', token: '#token', eventType: '#event' }
    const saved = { repo: 'stored/icons', token: 'test-stored-token', eventType: 'stored-event' }
    await ui.getByLabel('Connection mode').selectOption('github')
    await ui.locator(selectors[key]).fill(`session-${key}`)
    await send({ type: 'settings', settings: saved })
    for (const field of ['repo', 'token', 'eventType'] as const) {
      await expect(ui.locator(selectors[field])).toHaveValue(field === key ? `session-${key}` : saved[field])
    }
    await ui.locator(selectors[key]).fill('')
    const newer = { repo: 'newer/icons', token: 'test-newer-token', eventType: 'newer-event' }
    await send({ type: 'settings', settings: newer })
    for (const field of ['repo', 'token', 'eventType'] as const) {
      await expect(ui.locator(selectors[field])).toHaveValue(field === key ? '' : newer[field])
    }
    expect(errors).toEqual([])
  })
}

test('protects edited preferences from delayed restore and retries each storage domain with only its latest values', async ({ page }) => {
  const { ui, send, requests, errors } = await plugin(page)
  await send({ type: 'preflight', scanId: 14, items: [item('1:1', 'Home', { issues: ['Wrong size'] })] })
  await ui.getByLabel('Search preflight', { exact: true }).fill('home')
  expect(requests('save-preferences')).toEqual([])
  await ui.getByLabel('Problems only', { exact: true }).check()
  await send({ type: 'preferences', preferences: { problemsOnly: false } })
  await expect(ui.getByLabel('Problems only', { exact: true })).toBeChecked()
  await expect(ui.getByLabel('Search preflight', { exact: true })).toHaveValue('home')
  await expect.poll(() => requests('save-preferences')).toEqual([{ type: 'save-preferences', preferences: { problemsOnly: true } }])
  await send({ type: 'storage-status', scope: 'preferences', error: true, text: 'Could not save view preferences.' })
  await send({ type: 'storage-status', scope: 'settings', error: true, text: 'Could not save legacy settings.' })
  await ui.getByRole('button', { name: 'Retry view storage', exact: true }).click()
  await expect.poll(() => requests('retry-storage')).toEqual([{ type: 'retry-storage', scope: 'preferences', preferences: { problemsOnly: true } }])
  await send({ type: 'storage-status', scope: 'preferences', error: false, text: '' })
  await expect(ui.locator('#preferences-feedback')).toBeHidden()
  await ui.getByLabel('Connection mode').selectOption('github')
  await expect(ui.locator('#settings-feedback')).toBeVisible()
  const settings = { repo: 'current/icons', token: 'test-current-token', eventType: 'current-event' }
  await ui.locator('#repo').fill(settings.repo)
  await ui.locator('#token').fill(settings.token)
  await ui.locator('#event').fill(settings.eventType)
  await ui.getByRole('button', { name: 'Retry settings storage', exact: true }).click()
  await expect.poll(() => requests('retry-storage')).toEqual([
    { type: 'retry-storage', scope: 'preferences', preferences: { problemsOnly: true } },
    { type: 'retry-storage', scope: 'settings', settings },
  ])
  await send({ type: 'storage-status', scope: 'preferences', error: true, text: 'Could not save view preferences.' })
  await send({ type: 'storage-status', scope: 'settings', error: false, text: '' })
  await expect(ui.locator('#settings-feedback')).toBeHidden()
  await expect(ui.locator('#preferences-feedback')).toBeVisible()
  await ui.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(ui.getByLabel('Search preflight', { exact: true })).toHaveValue('')
  await expect(ui.getByLabel('Problems only', { exact: true })).not.toBeChecked()
  await expect.poll(() => requests('save-preferences').at(-1)).toEqual({ type: 'save-preferences', preferences: { problemsOnly: false } })
  await ui.getByRole('button', { name: 'Retry view storage', exact: true }).click()
  await expect.poll(() => requests('retry-storage').at(-1)).toEqual({ type: 'retry-storage', scope: 'preferences', preferences: { problemsOnly: false } })
  expect(errors).toEqual([])
})

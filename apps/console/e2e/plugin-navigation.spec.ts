import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

interface PluginMessage {
  type: string
  nodeId?: string
  scanId?: number
  requestId?: number
  mode?: string
}

function item(id: string, name: string) {
  return { id, name, iconName: name.toLowerCase(), skipped: false, width: 24, height: 24, issues: [] as string[] }
}

async function plugin(page: Page) {
  const messages: PluginMessage[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('recordPluginMessage', (message: PluginMessage) => messages.push(message))
  await page.setContent('<iframe title="Figma plugin" style="width:420px;height:560px"></iframe>')
  const html = await readFile('../../packages/figma-plugin/dist/ui.html', 'utf8')
  await page.evaluate((html) => {
    const frame = document.querySelector('iframe')!
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || !event.data.pluginMessage) {
        return
      }
      const host = window as unknown as { recordPluginMessage: (message: unknown) => Promise<void> }
      void host.recordPluginMessage(event.data.pluginMessage)
    })
    frame.srcdoc = html
  }, html)
  const ui = page.frameLocator('iframe')
  await expect.poll(() => messages.some(message => message.type === 'rescan')).toBe(true)
  // Resolve only after the built UI has processed the host message, including
  // stale messages whose correct behavior is to leave the rendered state alone.
  const send = (message: unknown) => page.evaluate(message => new Promise<void>((resolve) => {
    const frame = document.querySelector('iframe')!.contentWindow!
    frame.addEventListener('message', () => resolve(), { once: true })
    frame.postMessage({ pluginMessage: message }, '*')
  }), message)
  const requests = () => messages.filter(message => message.type === 'locate')
  return { ui, send, messages, requests, errors }
}

test('locates visible preflight rows and treats hostile node metadata as text', async ({ page }, testInfo) => {
  const { ui, send, requests, errors } = await plugin(page)
  const name = 'Icon"><img data-injected="name" src="x" onerror="document.body.dataset.compromised=1">'
  const nodeId = '1:2" onclick="document.body.dataset.compromised=1" data-injected="node'
  const issue = '<svg data-injected="issue" onload="document.body.dataset.compromised=1">'
  await send({
    type: 'preflight',
    scanId: 17,
    items: [item('1:1', 'Arrow'), { ...item(nodeId, name), issues: [issue] }, { ...item('1:3', '_draft'), skipped: true }],
  })
  await expect(ui.locator('#list > li')).toHaveCount(2)
  await expect(ui.getByRole('button', { name: /^Locate / })).toHaveCount(2)
  await expect(ui.getByRole('button', { name: 'Locate _draft', exact: true })).toHaveCount(0)
  await expect(ui.locator('#list strong').nth(1)).toHaveText(name)
  await expect(ui.locator('#list > li').nth(1).locator('span:not(.node-id)')).toHaveText(issue)
  await expect(ui.locator('#list [data-injected], #list img, #list svg')).toHaveCount(0)
  await expect(ui.locator('body')).not.toHaveAttribute('data-compromised')
  await ui.getByRole('button', { name: `Locate ${name}`, exact: true }).click()
  await expect.poll(() => requests().length).toBe(1)
  expect(requests()[0]).toEqual({ type: 'locate', nodeId, scanId: 17, requestId: expect.any(Number) })
  await send({ ...requests()[0], type: 'navigation-result', text: `Located ${name}`, error: false })
  await expect(ui.getByRole('status')).toHaveText(`Located ${name}`)
  await expect(ui.locator('#navigation-status img, #navigation-status [data-injected]')).toHaveCount(0)
  await expect(ui.locator('body')).not.toHaveAttribute('data-compromised')
  await page.locator('iframe').screenshot({ path: testInfo.outputPath('plugin-navigation.png') })
  expect(errors).toEqual([])
})

test('keeps only the latest navigation feedback without replacing an active task status', async ({ page }) => {
  const { ui, send, requests, errors } = await plugin(page)
  await send({ type: 'preflight', scanId: 20, items: [item('1:1', 'Arrow'), item('1:2', 'Home')] })
  await send({ type: 'console-status', text: 'running · fetching', busy: true, connected: true, url: 'https://iconctl.icebreaker.top/app/?job=active' })
  await ui.getByRole('button', { name: 'Locate Arrow', exact: true }).click()
  await ui.getByRole('button', { name: 'Locate Home', exact: true }).click()
  await expect.poll(() => requests().length).toBe(2)
  const [first, latest] = requests()
  expect(latest!.requestId).toBeGreaterThan(first!.requestId!)
  await send({ ...latest, type: 'navigation-result', text: 'Located Home', error: false })
  await expect(ui.getByRole('status')).toHaveText('Located Home')

  await send({ ...first, type: 'navigation-result', text: 'Old request failed', error: true })
  await expect(ui.getByRole('status')).toHaveText('Located Home')
  await send({ ...latest, scanId: 19, type: 'navigation-result', text: 'Wrong scan', error: true })
  await expect(ui.getByRole('status')).toHaveText('Located Home')
  await expect(ui.getByRole('status')).toHaveClass('ok')
  await expect(ui.locator('#status')).toHaveText('2 icons ready')
  await expect(ui.locator('#console-status')).toContainText('running · fetching')
  await expect(ui.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=active')
  await expect(ui.getByRole('button', { name: 'Sync to console', exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})

for (const trigger of ['rescan', 'mode'] as const) {
  test(`ignores pending navigation as soon as ${trigger} requests a fresh preflight`, async ({ page }) => {
    const { ui, send, requests, messages, errors } = await plugin(page)
    await send({ type: 'preflight', scanId: 30, items: [item('1:1', 'Arrow')] })
    await ui.getByRole('button', { name: 'Locate Arrow', exact: true }).click()
    await expect.poll(() => requests().length).toBe(1)
    const old = requests()[0]!
    const scans = messages.filter(message => message.type === 'rescan').length
    if (trigger === 'rescan') {
      await ui.getByRole('button', { name: 'Rescan', exact: true }).click()
    }
    else {
      await ui.getByLabel('Connection mode').selectOption('github')
    }
    await expect.poll(() => messages.filter(message => message.type === 'rescan').length).toBe(scans + 1)
    await expect(ui.getByRole('button', { name: 'Locate Arrow', exact: true })).toBeDisabled()
    const pendingStatus = await ui.getByRole('status').textContent()
    await send({ ...old, type: 'navigation-result', text: 'Stale lookup completed', error: false })
    await expect(ui.getByRole('status')).toHaveText(pendingStatus!)

    await send({ type: 'preflight', scanId: 31, items: [item('1:2', 'Home')] })
    await expect(ui.getByRole('status')).toHaveText('')
    await expect(ui.getByRole('button', { name: 'Locate Arrow', exact: true })).toHaveCount(0)
    await ui.getByRole('button', { name: 'Locate Home', exact: true }).click()
    await expect.poll(() => requests().length).toBe(2)
    const latest = requests()[1]!
    expect(latest.scanId).toBe(31)
    await send({ ...old, requestId: latest.requestId, type: 'navigation-result', text: 'Old scan with a new request', error: true })
    await expect(ui.getByRole('status')).toHaveText('Locating component…')
    await send({ ...latest, type: 'navigation-result', text: 'Located Home', error: false })
    await expect(ui.getByRole('status')).toHaveText('Located Home')
    expect(errors).toEqual([])
  })
}

test('disables invalidated and unversioned navigation until a fresh scan arrives', async ({ page }) => {
  const { ui, send, requests, errors } = await plugin(page)
  const items = [item('1:1', 'Arrow')]
  await send({ type: 'preflight', items })
  const locate = ui.getByRole('button', { name: 'Locate Arrow', exact: true })
  await expect(locate).toBeDisabled()
  await send({ type: 'preflight', scanId: 40, items })
  await locate.click()
  await expect.poll(() => requests().length).toBe(1)
  const old = requests()[0]!
  const message = 'Page changed. Rescan to locate icons on this page.'
  await send({ type: 'navigation-invalidated', scanId: 41, text: message })
  await expect(locate).toBeDisabled()
  await expect(ui.getByRole('status')).toHaveText(message)
  await send({ ...old, type: 'navigation-result', text: 'Old page result', error: false })
  await expect(ui.getByRole('status')).toHaveText(message)
  await expect(ui.getByRole('status')).toHaveClass('err')
  await send({ type: 'preflight', scanId: 42, items })
  await expect(locate).toBeEnabled()
  await expect(ui.getByRole('status')).toHaveText('')
  await locate.click()
  await expect.poll(() => requests().length).toBe(2)
  const latest = requests()[1]!
  await send({ ...latest, type: 'navigation-result', text: 'This component moved. Rescan and try again.', error: true })
  await expect(ui.getByRole('status')).toHaveText('This component moved. Rescan and try again.')
  await expect(ui.getByRole('status')).toHaveClass('err')
  expect(errors).toEqual([])
})

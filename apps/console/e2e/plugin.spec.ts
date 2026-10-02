import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('the built plugin UI keeps sync disabled until context is ready and during a task', async ({ page }) => {
  const messages: { type: string, mode?: string }[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('recordPluginMessage', (message: { type: string }) => {
    messages.push(message)
  })
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
  const sync = ui.getByRole('button', { name: 'Sync to console', exact: true })
  await expect(sync).toBeDisabled()
  const send = async (message: unknown) => page.evaluate(message =>
    document.querySelector('iframe')!.contentWindow!.postMessage({ pluginMessage: message }, '*'), message)
  const items = [{ id: '1', name: 'arrow', iconName: 'arrow', skipped: false, width: 16, height: 16, issues: [] }]
  await send({ type: 'preflight', items })
  await expect(sync).toBeDisabled()
  await send({ type: 'console-status', text: 'Connected to brand · revision 3', busy: false, connected: true })
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect(sync).toBeDisabled()
  // A rescan arriving while the task is active must not enable another submit.
  await send({ type: 'preflight', items })
  await expect(sync).toBeDisabled()
  await expect.poll(() => messages.filter(message => message.type === 'console-sync').length).toBe(1)
  await send({ type: 'console-status', text: 'running · fetching', busy: true, connected: true, url: 'https://iconctl.icebreaker.top/app/?job=test' })
  await expect(ui.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=test')
  await send({ type: 'console-state', busy: false, connected: true })
  await expect(sync).toBeEnabled()
  await ui.locator('#mode').selectOption('github')
  await expect.poll(() => messages.some(message => message.type === 'rescan' && message.mode === 'github')).toBe(true)
  await send({ type: 'preflight', items: [{ ...items[0], issues: ['Canvas is 16×16, expected 24×24'] }] })
  await expect(ui.getByRole('button', { name: 'Dispatch GitHub Action' })).toBeDisabled()
  expect(errors).toEqual([])
})

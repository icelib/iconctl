import type { BrowserContext } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareIconSets, renderDiffHtml } from '@iconctl/core'
import { expect, test } from '@playwright/test'

test('reviews an offline report without executing icon markup or fetching external resources', async ({ playwright }, testInfo) => {
  const metadata = '"><img data-injected="metadata" src="https://offline-fixture.invalid/metadata" onerror="document.body.dataset.compromised=\'yes\'"><script>document.body.dataset.compromised="yes"</script>'
  const maliciousName = `metadata-${metadata}`
  const maliciousSvg = '<g onload="parent.document.body.dataset.compromised=\'yes\'"><script>parent.document.body.dataset.compromised="yes";fetch("https://offline-fixture.invalid/script")</script><image href="https://offline-fixture.invalid/image"/><foreignObject width="24" height="24"><img xmlns="http://www.w3.org/1999/xhtml" src="https://offline-fixture.invalid/foreign" onerror="parent.document.body.dataset.compromised=\'yes\'"/></foreignObject><rect width="24" height="24" fill="green"/></g>'
  const unchanged = { body: '<path d="M2 22L12 2l10 20z"/>' }
  const comparison = compareIconSets({
    prefix: 'before',
    width: 24,
    height: 24,
    icons: {
      changed: { body: '<rect width="24" height="24" fill="red"/>' },
      removed: { body: '<circle cx="12" cy="12" r="10"/>' },
      unchanged,
      [maliciousName]: { body: maliciousSvg },
    },
  }, {
    prefix: metadata,
    width: 24,
    height: 24,
    icons: {
      added: { body: '<circle cx="12" cy="12" r="8"/>' },
      changed: { body: '<rect width="24" height="24" fill="blue"/>' },
      unchanged,
      [maliciousName]: { body: maliciousSvg },
    },
  })
  const file = testInfo.outputPath('offline-diff.html')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, renderDiffHtml(comparison), 'utf8')

  const browser = await playwright.chromium.launch({ headless: true })
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const externalRequests: string[] = []
    context.on('request', (request) => {
      if (/^https?:/.test(request.url())) {
        externalRequests.push(request.url())
      }
    })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(pathToFileURL(file).href)
    await expect(page.getByRole('heading', { name: 'Icon changes', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('5 of 5 icons')
    await expect(page.getByRole('heading', { name: maliciousName, exact: true })).toBeVisible()
    await expect(page.locator('.meta')).toHaveText(`before → ${metadata}`)
    await expect(page.locator('[data-injected]')).toHaveCount(0)
    await expect(page.locator('script')).toHaveCount(1)
    await expect(page.locator('body')).not.toHaveAttribute('data-compromised')

    const images = page.getByRole('img')
    await expect(images).toHaveCount(8)
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded()
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true)
      await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
    }
    await expect(page.getByRole('img', { name: 'Before · before:changed', exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: `After · ${metadata}:changed`, exact: true })).toBeVisible()

    const visibleCards = page.locator('article.icon:visible')
    for (const [status, count] of [['added', 1], ['changed', 1], ['removed', 1], ['unchanged', 2]] as const) {
      await page.getByLabel('Filter changes').selectOption(status)
      await expect(visibleCards).toHaveCount(count)
      await expect(page.getByRole('status')).toHaveText(`${count} of 5 icons`)
      for (const card of await visibleCards.all()) {
        await expect(card).toHaveAttribute('data-status', status)
      }
    }
    await page.getByLabel('Filter changes').selectOption('all')
    await page.getByLabel('Search icons').fill('ADDED')
    await expect(visibleCards).toHaveCount(1)
    await expect(visibleCards).toHaveAttribute('data-name', 'added')
    await page.getByLabel('Filter changes').selectOption('removed')
    await expect(visibleCards).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveText('0 of 5 icons')
    await expect(page.getByText('No icons match this filter.')).toBeVisible()
    await page.getByLabel('Filter changes').selectOption('all')
    await page.getByLabel('Search icons').fill(maliciousName)
    await expect(visibleCards).toHaveCount(1)
    await expect(visibleCards).toHaveAttribute('data-name', maliciousName)
    await page.getByLabel('Search icons').fill('')
    await expect(visibleCards).toHaveCount(5)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toHaveAttribute('data-compromised')
    expect(externalRequests).toEqual([])
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('offline-diff.png'), fullPage: true })
  }
  finally {
    try {
      await context?.close()
    }
    finally {
      await browser.close()
      expect(browser.isConnected()).toBe(false)
    }
  }
})

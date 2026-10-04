import type { Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderPreviewHtml } from '@iconctl/core'
import { test as base, expect } from '@playwright/test'

type Collection = Parameters<typeof renderPreviewHtml>[0]
type CopyMode = 'success' | 'missing' | 'throw' | 'reject' | 'pending'
interface ClipboardFixture {
  mode: CopyMode
  writes: string[]
  pending: { resolve: () => void, reject: () => void }[]
  setMode: (mode: CopyMode) => void
}
interface PreviewWindow extends Window {
  clipboardFixture: ClipboardFixture
  previewExecution: string[]
}

const body = '<rect x="0" y="0" width="16" height="8" fill="#16824b"/>'
const hostileName = 'control-name\r\n\0"<&\'😀\uD800</script><img data-injected="metadata" src="https://preview-fixture.invalid/metadata" onerror="window.previewExecution.push(\'metadata\')">'
const hostileSvg = '<g onload="parent.previewExecution.push(\'svg-event\')"><script>parent.previewExecution.push("svg-script");fetch("https://preview-fixture.invalid/script")</script><image href="https://preview-fixture.invalid/image"/><foreignObject width="24" height="24"><img xmlns="http://www.w3.org/1999/xhtml" src="https://preview-fixture.invalid/foreign" onerror="parent.previewExecution.push(\'foreign\')"/></foreignObject><rect width="24" height="24" fill="green"/></g>'
const collection: Collection = {
  prefix: 'brand',
  width: 32,
  height: 16,
  icons: {
    'zebra': { body },
    'arrow': { body, hidden: true },
    'two words': { body },
    '[.*+?]': { body },
    [hostileName]: { body: hostileSvg, width: 24, height: 24 },
  },
  aliases: { rotated: { parent: 'arrow', rotate: 1 }, flipped: { parent: 'arrow', hFlip: true } },
}

async function writePreview(testInfo: TestInfo, json = collection, name = 'offline-preview.html') {
  const file = testInfo.outputPath(name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, renderPreviewHtml(json), 'utf8')
  return pathToFileURL(file).href
}

const test = base.extend<{ previewPage: Page }>({
  previewPage: async ({ page, context }, use, testInfo) => {
    const requests: string[] = []
    const errors: string[] = []
    const dialogs: string[] = []
    context.on('request', (request) => {
      if (/^https?:/.test(request.url())) {
        requests.push(request.url())
      }
    })
    await context.route(/^https?:/, route => route.abort())
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message())
      await dialog.dismiss()
    })
    await page.addInitScript(() => {
      const target = window as unknown as PreviewWindow
      target.previewExecution = []
      const fixture: ClipboardFixture = {
        mode: 'success',
        writes: [],
        pending: [],
        setMode(mode) {
          fixture.mode = mode
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: mode === 'missing'
              ? undefined
              : {
                  writeText(value: string) {
                    fixture.writes.push(value)
                    if (fixture.mode === 'throw') {
                      throw new Error('Synchronous clipboard failure')
                    }
                    if (fixture.mode === 'reject') {
                      return Promise.reject(new Error('Clipboard denied'))
                    }
                    if (fixture.mode === 'pending') {
                      return new Promise<void>((resolve, reject) => fixture.pending.push({ resolve, reject: () => reject(new Error('Delayed clipboard denial')) }))
                    }
                    return Promise.resolve()
                  },
                },
          })
        },
      }
      target.clipboardFixture = fixture
      fixture.setMode('success')
    })
    try {
      await use(page)
    }
    finally {
      const execution = await page.evaluate(() => (window as unknown as PreviewWindow).previewExecution ?? [])
      await writeFile(testInfo.outputPath('offline-evidence.json'), JSON.stringify({ requests, errors, dialogs, execution }, null, 2))
      expect(requests).toEqual([])
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
      expect(execution).toEqual([])
    }
  },
})

async function loadedImages(page: Page) {
  const images = page.getByRole('img')
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true)
    await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  }
}

async function copyMode(page: Page, mode: CopyMode) {
  await page.evaluate(mode => (window as unknown as PreviewWindow).clipboardFixture.setMode(mode), mode)
}

async function settleCopy(page: Page, index: number, success: boolean) {
  await page.evaluate(async ({ index, success }) => {
    const pending = (window as unknown as PreviewWindow).clipboardFixture.pending[index]!
    if (success) {
      pending.resolve()
    }
    else { pending.reject() }
    await Promise.resolve()
  }, { index, success })
}

test('searches independent literal names and classes in a real offline document while isolating SVGs and preserving aliases', async ({ previewPage: page }, testInfo) => {
  const url = await writePreview(testInfo)
  await page.goto(url)
  expect(page.url()).toBe(url)
  await expect(page.getByRole('heading', { name: 'brand icons' })).toBeVisible()
  const search = page.getByRole('searchbox', { name: 'Search icons' })
  const count = page.getByRole('status').first()
  const cards = page.locator('figure:visible')
  await expect(count).toHaveText('7 of 7 icons')
  await expect(cards).toHaveCount(7)
  await loadedImages(page)
  const captions = page.locator('figure figcaption > code:first-child')
  const originalOrder = await captions.allTextContents()
  expect(originalOrder.filter(value => !value.includes('control-name'))).toEqual([
    'brand:[.*+?]',
    'brand:arrow',
    'brand:flipped',
    'brand:rotated',
    'brand:two words',
    'brand:zebra',
  ])

  for (const [query, names] of [
    ['BRAND:ARROW', ['brand:arrow']],
    ['I-BRAND-ROTATED', ['brand:rotated']],
    ['[.*+?]', ['brand:[.*+?]']],
    [' ', ['brand:two words', originalOrder.find(value => value.includes('control-name'))!]],
    ['brand:arrow i-brand-arrow', []],
    ['arrowi-brand', []],
    [' i-brand-arrow', []],
    ['brand:[.*+?]', ['brand:[.*+?]']],
    ['does-not-exist', []],
  ] as const) {
    await search.fill(query)
    await expect(count).toHaveText(`${names.length} of 7 icons`)
    const expected = originalOrder.filter(name => (names as readonly string[]).includes(name))
    await expect(cards.locator('figcaption > code:first-child')).toHaveText(expected)
    if (names.length === 0) {
      await expect(page.getByText('No icons match this search.', { exact: true })).toBeVisible()
    }
  }
  await search.fill('')
  await expect(cards.locator('figcaption > code:first-child')).toHaveText(originalOrder)
  const arrow = page.getByRole('img', { name: 'brand:arrow', exact: true })
  const rotated = page.getByRole('img', { name: 'brand:rotated', exact: true })
  const flipped = page.getByRole('img', { name: 'brand:flipped', exact: true })
  for (const [image, expectedQuadrant] of [[arrow, 0], [rotated, 1], [flipped, 1]] as const) {
    const pixels = await image.evaluate((element: HTMLImageElement) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      const context = canvas.getContext('2d')!
      context.drawImage(element, 0, 0, 64, 64)
      return [[16, 16], [48, 16], [16, 48], [48, 48]].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data))
    })
    expect(pixels).toEqual([0, 1, 2, 3].map(index => index === expectedQuadrant ? [22, 130, 75, 255] : [0, 0, 0, 0]))
  }
  await expect(page.locator('svg, object, iframe, [data-injected]')).toHaveCount(0)
  await expect(page.locator('script')).toHaveCount(1)
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  const style = await page.locator('style').textContent()
  const script = await page.locator('script').textContent()
  const hash = (value: string) => createHash('sha256').update(value).digest('base64')
  expect(policy).toBe(`default-src 'none'; img-src data:; style-src 'sha256-${hash(style!)}'; script-src 'sha256-${hash(script!)}'; base-uri 'none'; form-action 'none'; object-src 'none'`)
  expect(await page.evaluate(() => (window as unknown as PreviewWindow).previewExecution)).toEqual([])
  await search.focus()
  await page.screenshot({ path: testInfo.outputPath('offline-preview-desktop.png'), fullPage: true })

  await page.goto(await writePreview(testInfo, { prefix: 'empty', icons: {} }, 'empty.html'))
  await expect(page.getByRole('status').first()).toHaveText('0 of 0 icons')
  await expect(page.getByText('This collection has no icons.', { exact: true })).toBeVisible()
  await page.getByRole('searchbox').fill('anything')
  await expect(page.getByText('This collection has no icons.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button')).toHaveCount(0)
})

test('copies exact captured values and handles clipboard failure, latest-action races and keyboard fallback at narrow widths', async ({ previewPage: page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto(await writePreview(testInfo))
  const search = page.getByRole('searchbox', { name: 'Search icons' })
  const feedback = page.getByRole('status').nth(1)
  const nameButton = page.getByRole('button', { name: 'Copy Iconify name: brand:arrow', exact: true })
  const classButton = page.getByRole('button', { name: 'Copy CSS class: i-brand-arrow', exact: true })
  const manual = page.getByRole('region', { name: 'Manual copy' })
  const value = page.getByLabel('Value to copy', { exact: true })
  const dismiss = page.getByRole('button', { name: 'Dismiss manual copy', exact: true })
  await search.fill('brand:arrow')
  await search.focus()
  await page.keyboard.press('Tab')
  await expect(nameButton).toBeFocused()
  expect(await nameButton.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
  await page.keyboard.press('Enter')
  await expect(feedback).toHaveText('Copied brand:arrow')
  await expect(nameButton).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(classButton).toBeFocused()
  await page.keyboard.press('Space')
  await expect(feedback).toHaveText('Copied i-brand-arrow')
  await expect(classButton).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as PreviewWindow).clipboardFixture.writes)).toEqual(['brand:arrow', 'i-brand-arrow'])

  await search.fill('control-name')
  const hostileButton = page.locator('figure:visible').getByRole('button', { name: /^Copy Iconify name:/ })
  await hostileButton.click()
  expect(await page.evaluate(() => (window as unknown as PreviewWindow).clipboardFixture.writes.at(-1))).toBe(`brand:${hostileName}`)
  expect(await feedback.textContent()).toBe(`Copied brand:${hostileName}`)
  await expect(page.locator('figure:visible').getByText('CSS class unavailable for this name.', { exact: true })).toBeVisible()
  await expect(page.locator('figure:visible').getByRole('button')).toHaveCount(1)

  for (const mode of ['missing', 'throw', 'reject'] as const) {
    await copyMode(page, mode)
    await hostileButton.click()
    await expect(feedback).toHaveText('Automatic copy is unavailable. Select the value below and copy it manually.')
    await expect(manual).toBeVisible()
    await expect(value).toBeFocused()
    expect(await value.textContent()).toBe(`brand:${hostileName}`)
    expect(await page.evaluate(() => {
      const selection = window.getSelection()!
      const selected = document.getElementById('copy-value')!
      return selection.rangeCount === 1 && selection.getRangeAt(0).startContainer === selected && selection.getRangeAt(0).endContainer === selected
    })).toBe(true)
    await expect(page.locator('[data-injected]')).toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(dismiss).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(manual).toBeHidden()
    await expect(hostileButton).toBeFocused()
    await expect(feedback).toBeEmpty()
  }

  await search.fill('brand:arrow')
  await copyMode(page, 'pending')
  await nameButton.click()
  await expect(feedback).toHaveText('Copying…')
  await expect(manual).toBeHidden()
  await copyMode(page, 'success')
  await classButton.click()
  await expect(feedback).toHaveText('Copied i-brand-arrow')
  await settleCopy(page, 0, false)
  await expect(feedback).toHaveText('Copied i-brand-arrow')
  await expect(classButton).toBeFocused()
  await expect(manual).toBeHidden()

  await copyMode(page, 'pending')
  await classButton.click()
  await copyMode(page, 'reject')
  await nameButton.click()
  await expect(value).toBeFocused()
  await expect(value).toHaveText('brand:arrow')
  await settleCopy(page, 1, true)
  await expect(feedback).toHaveText('Automatic copy is unavailable. Select the value below and copy it manually.')
  await expect(value).toBeFocused()
  await expect(value).toHaveText('brand:arrow')
  await dismiss.click()

  await copyMode(page, 'pending')
  await nameButton.click()
  await search.focus()
  await settleCopy(page, 2, false)
  await expect(manual).toBeVisible()
  await expect(search).toBeFocused()
  await search.fill('zebra')
  await dismiss.click()
  await expect(search).toBeFocused()

  await search.fill('control-name')
  await copyMode(page, 'reject')
  await hostileButton.click()
  await expect(value).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('offline-preview-manual-mobile.png'), fullPage: true })
})

for (const javascript of [false, true]) {
  test.describe(javascript ? 'blocked preview script' : 'JavaScript disabled preview', () => {
    test.use({ javaScriptEnabled: javascript, viewport: { width: 390, height: 844 } })
    test('keeps every resolved icon and caption usable without dead enhancement controls', async ({ previewPage: page }, testInfo) => {
      const file = testInfo.outputPath('static-preview.html')
      const html = renderPreviewHtml(collection)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, javascript ? html.replace(/script-src &#39;sha256-[^;]+;/, 'script-src &#39;none&#39;;') : html, 'utf8')
      await page.goto(pathToFileURL(file).href)
      await expect(page.getByRole('heading', { name: 'brand icons' })).toBeVisible()
      await expect(page.locator('figure:visible')).toHaveCount(7)
      await expect(page.getByRole('status').first()).toHaveText('7 of 7 icons')
      await expect(page.getByRole('searchbox')).toHaveCount(0)
      await expect(page.getByRole('button')).toHaveCount(0)
      await loadedImages(page)
      await expect(page.getByText('brand:arrow', { exact: true })).toBeVisible()
      await expect(page.getByText('brand:rotated', { exact: true })).toBeVisible()
      await expect(page.getByText('i-brand-arrow', { exact: true })).toBeVisible()
      await expect(page.locator('svg, object, iframe, [data-injected]')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('offline-preview-static-mobile.png'), fullPage: true })
    })
  })
}

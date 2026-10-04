import type { ConsoleState, Project, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import type { APIRequestContext, BrowserContext, Download, Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createWorkerTest, expect } from './local-worker'

interface Fixture {
  project: Project
  otherProject: Project
  current: Snapshot
  alternate: Snapshot
  baseline: Snapshot
  noFiles: Snapshot
  session: { token: string }
}
interface Worker { origin: string, fixture: Fixture, unexpectedRequests: string[] }
interface Resources { created: string[], revoked: string[], clicks: { filename: string, connected: boolean }[] }
const test = createWorkerTest<Fixture>('snapshot-svg-archive')
const button = (page: Page) => page.getByRole('button', { name: '下载完整 Iconify JSON', exact: true })
const status = (page: Page) => page.getByRole('status', { name: 'Iconify JSON 下载状态', exact: true })
const failure = (page: Page) => page.getByRole('alert', { name: 'Iconify JSON 下载失败', exact: true })
const path = (snapshot: Snapshot, format = 'icons.json') => `/api/snapshots/${snapshot.id}/${format}`
const filename = (snapshot: Snapshot) => `iconctl-icons-${snapshot.id}-${snapshot.digest.slice(0, 12)}.json`
const observations = new WeakMap<Page, { requests: string[], responses: { path: string, status: number }[], downloads: string[], errors: string[] }>()
const resources = (page: Page) => page.evaluate(() => (window as unknown as { downloadResources: Resources }).downloadResources)
const headers = (worker: Worker) => ({ cookie: `__Host-iconctl-session=${worker.fixture.session.token}` })

async function open(page: Page, context: BrowserContext, worker: Worker) {
  await context.addCookies([{ name: '__Host-iconctl-session', value: worker.fixture.session.token, domain: new URL(worker.origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }])
  await page.goto(`${worker.origin}/app/`)
  await page.getByLabel('当前项目', { exact: true }).selectOption(worker.fixture.project.id)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await page.getByLabel('选择快照', { exact: true }).selectOption(worker.fixture.current.id)
  await expect(button(page)).toBeEnabled()
}
async function preview(request: APIRequestContext, worker: Worker, snapshot = worker.fixture.current) {
  const response = await request.get(`${worker.origin}/api/snapshots/${snapshot.id}`, { headers: headers(worker) })
  expect(response.status()).toBe(200)
  return await response.json() as SnapshotPreview
}
async function state(request: APIRequestContext, worker: Worker) {
  return await (await request.get(`${worker.origin}/api/state`, { headers: headers(worker) })).json() as ConsoleState
}
async function save(file: Download, info: TestInfo, name: string) {
  expect(await file.failure()).toBeNull()
  const output = info.outputPath(name)
  await file.saveAs(output)
  const bytes = await readFile(output)
  const json = JSON.parse(bytes.toString('utf8'))
  await writeFile(info.outputPath(`${name}.evidence.json`), JSON.stringify({ filename: file.suggestedFilename(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2))
  return { json, filename: file.suggestedFilename() }
}
async function download(page: Page, info: TestInfo, name = 'collection.json') {
  const pending = page.waitForEvent('download')
  await button(page).click()
  return save(await pending, info, name)
}
async function hold(page: Page, url: string, outcome: 'success' | 'failure' | 'unauthorized' = 'success') {
  let release!: () => void
  let done!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  const settled = new Promise<void>(resolve => done = resolve)
  const requests: { url: string, status: number }[] = []
  let entered = 0
  await page.route(url, async (route) => {
    const first = ++entered === 1
    try {
      const response = await route.fetch({ timeout: 10_000 })
      requests.push({ url: route.request().url(), status: response.status() })
      if (!first) {
        await route.fulfill({ response })
        return
      }
      await gate
      await route.fulfill(outcome === 'success' ? { response } : { status: outcome === 'unauthorized' ? 401 : 500, json: { error: 'late old response' } })
    }
    finally {
      if (first) {
        done()
      }
    }
  })
  return {
    release,
    requests,
    get settled() {
      if (!entered) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Held download did not finish cleanup')), 10_000)
        void settled.then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

test.beforeEach(async ({ page }) => {
  const record = { requests: [] as string[], responses: [] as { path: string, status: number }[], downloads: [] as string[], errors: [] as string[] }
  observations.set(page, record)
  page.on('request', request => record.requests.push(`${request.method()} ${new URL(request.url()).pathname}`))
  page.on('response', response => record.responses.push({ path: new URL(response.url()).pathname, status: response.status() }))
  page.on('download', file => record.downloads.push(file.suggestedFilename()))
  page.on('pageerror', error => record.errors.push(error.message))
  await page.addInitScript(() => {
    const record: Resources = { created: [], revoked: [], clicks: [] }
    Object.assign(window, { downloadResources: record })
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (blob) => {
      const url = create(blob)
      record.created.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      record.revoked.push(url)
      revoke(url)
    }
    HTMLAnchorElement.prototype.click = function () {
      record.clicks.push({ filename: this.download, connected: this.isConnected })
      click.call(this)
    }
  })
})
test.afterEach(async ({ page, localWorker }, info) => {
  const record = observations.get(page)!
  expect(record.errors).toEqual([])
  expect(record.requests.filter(request => !request.startsWith('GET '))).toEqual([])
  expect(localWorker.unexpectedRequests).toEqual([])
  const resource = await resources(page)
  expect(resource.revoked).toEqual(resource.created)
  expect(resource.clicks.every(click => click.connected)).toBe(true)
  await expect(page.locator('a[href^="blob:"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await writeFile(info.outputPath('iconify-download-evidence.json'), JSON.stringify({ ...record, resources: resource }, null, 2))
})

test('exports the complete immutable collection with metadata through filters and release or explicit comparisons', async ({ page, context, request, localWorker }, info) => {
  await open(page, context, localWorker)
  const before = await state(request, localWorker)
  const stored = await preview(request, localWorker)
  expect(stored.content.json).toMatchObject({ width: 24, height: 24, info: { name: 'Processed collection 中文🙂' }, customCollection: { value: '<metadata>&"', ordered: ['z', 'a'] }, icons: { added: { width: 32, height: 16, customIcon: { title: '中文🙂 & <value>' } } } })
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  await page.getByRole('button', { name: '删除 1', exact: true }).click()
  await page.getByLabel('搜索图标', { exact: true }).fill('nothing-visible')
  await expect(page.getByText('没有符合条件的图标。', { exact: true })).toBeVisible()
  const response = page.waitForResponse(`**${path(localWorker.fixture.current)}`)
  const first = await download(page, info)
  const http = await response
  expect(first).toEqual({ json: stored.content.json, filename: filename(localWorker.fixture.current) })
  expect(http.headers()).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'content-security-policy': 'sandbox; default-src \'none\'', 'x-content-type-options': 'nosniff' })
  expect(http.headers()['content-disposition']).toContain(filename(localWorker.fixture.current))
  await page.getByLabel('比较基准', { exact: true }).selectOption(localWorker.fixture.baseline.id)
  await expect(button(page)).toBeEnabled()
  expect((await download(page, info, 'explicit-comparison-collection.json')).json).toEqual(stored.content.json)
  const old = await request.get(`${localWorker.origin}/api/snapshots/${localWorker.fixture.current.id}/files/icons.json`, { headers: headers(localWorker) })
  expect(await old.text()).toBe('{}')
  await expect(page.getByRole('link', { name: 'icons.json ↓', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'preview.html ↓', exact: true })).toBeVisible()
  expect(await state(request, localWorker)).toEqual(before)
})

test('downloads an empty collection without any generated files', async ({ page, context, request, localWorker }, info) => {
  await open(page, context, localWorker)
  await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.noFiles.id)
  await expect(button(page)).toBeEnabled()
  const stored = await preview(request, localWorker, localWorker.fixture.noFiles)
  expect(stored.content.files).toEqual({})
  expect(stored.content.json.icons).toEqual({})
  expect(await download(page, info, 'empty-collection.json')).toEqual({ json: stored.content.json, filename: filename(localWorker.fixture.noFiles) })
})

test('keeps downloads single-flight and retries a network failure only on explicit keyboard action at 390px', async ({ page, context, localWorker }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, context, localWorker)
  const url = `**${path(localWorker.fixture.current)}`
  const held = await hold(page, url)
  try {
    await button(page).click()
    await expect.poll(() => held.requests.length).toBe(1)
    await expect(button(page)).toBeDisabled()
    await button(page).dispatchEvent('click')
    expect(held.requests).toHaveLength(1)
    const pending = page.waitForEvent('download')
    held.release()
    await save(await pending, info, 'single-flight.json')
    await held.settled
  }
  finally {
    held.release()
    await held.settled
  }
  await page.unroute(url)
  let calls = 0
  await page.route(url, async (route) => {
    calls++
    if (calls === 1) {
      await route.abort('connectionreset')
    }
    else { await route.continue() }
  })
  await button(page).click()
  await expect(failure(page)).toBeVisible()
  await expect(button(page)).toBeEnabled()
  expect(calls).toBe(1)
  await button(page).focus()
  await page.screenshot({ path: info.outputPath('iconify-json-retry-390.png'), fullPage: true })
  const pending = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  await save(await pending, info, 'keyboard-retry.json')
  await expect(failure(page)).toHaveCount(0)
  expect(calls).toBe(2)
})

for (const action of ['missing', 'corrupt'] as const) {
  test(`reports the real ${action === 'missing' ? 404 : 409} and recovers only after explicit storage repair and retry`, async ({ page, context, request, localWorker }, info) => {
    await open(page, context, localWorker)
    const control = (action: string) => request.post(`${localWorker.origin}/__fixtures/snapshot-svg-archive/control`, { data: { action, snapshotId: localWorker.fixture.current.id } })
    expect((await control(action)).ok()).toBe(true)
    const response = page.waitForResponse(`**${path(localWorker.fixture.current)}`)
    await button(page).click()
    expect((await response).status()).toBe(action === 'missing' ? 404 : 409)
    await expect(failure(page)).toBeVisible()
    expect((await resources(page)).created).toEqual([])
    expect((await control('restore')).ok()).toBe(true)
    await download(page, info, `${action}-restored.json`)
    await expect(failure(page)).toHaveCount(0)
  })
}

for (const navigation of ['comparison', 'project', 'view'] as const) {
  test(`cancels JSON ownership on ${navigation} and ignores the delayed document`, async ({ page, context, localWorker }) => {
    await open(page, context, localWorker)
    const held = await hold(page, `**${path(localWorker.fixture.current)}`)
    try {
      await button(page).click()
      await expect.poll(() => held.requests.length).toBe(1)
      const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === path(localWorker.fixture.current))
      if (navigation === 'comparison') {
        await page.getByLabel('比较基准', { exact: true }).selectOption('release')
      }
      else if (navigation === 'project') {
        await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.otherProject.id)
      }
      else { await page.getByRole('button', { name: '任务与版本', exact: true }).click() }
      await aborted
      held.release()
      await held.settled
      await expect(status(page)).toHaveCount(0)
      await expect(failure(page)).toHaveCount(0)
      expect(observations.get(page)!.downloads).toEqual([])
      expect((await resources(page)).created).toEqual([])
    }
    finally {
      held.release()
      await held.settled
    }
  })
}

for (const outcome of ['success', 'failure', 'unauthorized'] as const) {
  test(`isolates stale ${outcome} after snapshot A to B to A from a fresh download`, async ({ page, context, localWorker }, info) => {
    await open(page, context, localWorker)
    const held = await hold(page, `**${path(localWorker.fixture.current)}`, outcome)
    try {
      await button(page).click()
      await expect.poll(() => held.requests.length).toBe(1)
      const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === path(localWorker.fixture.current))
      await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.alternate.id)
      await aborted
      await expect(button(page)).toBeEnabled()
      await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.current.id)
      await expect(button(page)).toBeEnabled()
      await download(page, info, 'fresh-after-aba.json')
      held.release()
      await held.settled
      await expect(status(page)).toHaveText('已发起下载')
      await expect(failure(page)).toHaveCount(0)
      await expect(page).toHaveURL(`${localWorker.origin}/app/`)
      expect(observations.get(page)!.downloads).toEqual([filename(localWorker.fixture.current)])
      expect((await resources(page)).created).toHaveLength(1)
    }
    finally {
      held.release()
      await held.settled
    }
  })
}

test('blocks the old collection while a real comparison request is pending', async ({ page, context, localWorker }, info) => {
  await open(page, context, localWorker)
  const held = await hold(page, `**/api/snapshots/${localWorker.fixture.current.id}?compareTo=release`)
  try {
    await page.getByLabel('比较基准', { exact: true }).selectOption('release')
    await expect.poll(() => held.requests.length).toBe(1)
    await expect(button(page)).toBeDisabled()
    await button(page).dispatchEvent('click')
    expect(observations.get(page)!.requests.filter(value => value.endsWith('/icons.json'))).toEqual([])
    held.release()
    await held.settled
    await expect(button(page)).toBeEnabled()
    await download(page, info, 'after-comparison.json')
  }
  finally {
    held.release()
    await held.settled
  }
})

test('keeps JSON and SVG independently pending for the same snapshot and completes them separately', async ({ page, context, localWorker }, info) => {
  await open(page, context, localWorker)
  const svgButton = page.getByRole('button', { name: /下载全部 SVG/ })
  const json = await hold(page, `**${path(localWorker.fixture.current)}`)
  const svg = await hold(page, `**${path(localWorker.fixture.current, 'svg.zip')}`)
  try {
    await button(page).click()
    await expect.poll(() => json.requests.length).toBe(1)
    await expect(svgButton).toBeEnabled()
    await svgButton.click()
    await expect.poll(() => svg.requests.length).toBe(1)
    await expect(button(page)).toBeDisabled()
    await expect(svgButton).toBeDisabled()
    const first = page.waitForEvent('download')
    json.release()
    expect((await save(await first, info, 'simultaneous-collection.json')).filename).toBe(filename(localWorker.fixture.current))
    await json.settled
    await expect(button(page)).toBeEnabled()
    await expect(svgButton).toBeDisabled()
    const second = page.waitForEvent('download')
    svg.release()
    const file = await second
    expect(await file.failure()).toBeNull()
    await file.saveAs(info.outputPath('simultaneous-svg.zip'))
    await svg.settled
    await expect(svgButton).toBeEnabled()
    expect(observations.get(page)!.downloads).toHaveLength(2)
  }
  finally {
    json.release()
    svg.release()
    await Promise.all([json.settled, svg.settled])
  }
})

for (const oldFormat of ['svg.zip', 'icons.json'] as const) {
  test(`does not let cancelled ${oldFormat} clear the other format's current pending request`, async ({ page, context, localWorker }, info) => {
    await open(page, context, localWorker)
    const newFormat = oldFormat === 'svg.zip' ? 'icons.json' : 'svg.zip'
    const action = (format: string) => format === 'icons.json' ? button(page) : page.getByRole('button', { name: /下载全部 SVG/ })
    const old = await hold(page, `**${path(localWorker.fixture.current, oldFormat)}`)
    const fresh = await hold(page, `**${path(localWorker.fixture.alternate, newFormat)}`)
    try {
      await action(oldFormat).click()
      await expect.poll(() => old.requests.length).toBe(1)
      const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === path(localWorker.fixture.current, oldFormat))
      await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.alternate.id)
      await aborted
      await expect(action(newFormat)).toBeEnabled()
      await action(newFormat).click()
      await expect.poll(() => fresh.requests.length).toBe(1)
      old.release()
      await old.settled
      await expect(action(newFormat)).toBeDisabled()
      const pending = page.waitForEvent('download')
      fresh.release()
      const file = await pending
      expect(await file.failure()).toBeNull()
      await file.saveAs(info.outputPath(`independent.${newFormat === 'icons.json' ? 'json' : 'zip'}`))
      await fresh.settled
      await expect(action(newFormat)).toBeEnabled()
      expect(observations.get(page)!.downloads).toHaveLength(1)
    }
    finally {
      old.release()
      fresh.release()
      await Promise.all([old.settled, fresh.settled])
    }
  })
}

test('requires a live owner session and never downloads an authentication error as JSON', async ({ page, context, request, localWorker }) => {
  await open(page, context, localWorker)
  expect((await request.get(`${localWorker.origin}${path(localWorker.fixture.current)}`)).status()).toBe(401)
  await context.clearCookies()
  const response = page.waitForResponse(`**${path(localWorker.fixture.current)}`)
  await button(page).click()
  expect((await response).status()).toBe(401)
  await expect(page).toHaveURL(`${localWorker.origin}/login`)
  expect((await resources(page)).created).toEqual([])
})

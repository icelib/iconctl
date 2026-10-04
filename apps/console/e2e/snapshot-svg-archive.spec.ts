import type { ConsoleState, Project, Snapshot } from '@iconctl/console-contracts'
import type { APIRequestContext, BrowserContext, Download, Page, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { createWorkerTest, expect } from './local-worker'

interface ArchiveFixture {
  project: Project
  otherProject: Project
  baseline: Snapshot
  current: Snapshot
  alternate: Snapshot
  empty: Snapshot
  large: Snapshot
  otherSnapshot: Snapshot
  expectedFiles: Record<string, string>
  session: { token: string, csrf: string, expiresAt: number }
}
interface Worker {
  origin: string
  fixture: ArchiveFixture
  unexpectedRequests: string[]
}
interface BrowserEvidence {
  created: string[]
  revoked: string[]
  clicks: { href: string, download: string, connected: boolean }[]
}
const test = createWorkerTest<ArchiveFixture>('snapshot-svg-archive')
const archivePath = (snapshot: Snapshot) => `/api/snapshots/${snapshot.id}/svg.zip`
const downloadButton = (page: Page, count = 3) => page.getByRole('button', { name: `下载全部 SVG（${count}）`, exact: true })
const status = (page: Page) => page.getByRole('status', { name: 'SVG 下载状态', exact: true })
const failure = (page: Page) => page.getByRole('alert', { name: 'SVG 下载失败', exact: true })
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const observations = new WeakMap<Page, { requests: { method: string, path: string }[], responses: { path: string, status: number, contentType?: string }[], failures: { path: string, error?: string }[], downloads: string[], errors: string[] }>()

async function observeDownloads(page: Page) {
  await page.addInitScript(() => {
    const evidence: BrowserEvidence = { created: [], revoked: [], clicks: [] }
    Object.assign(window, { archiveEvidence: evidence })
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (object) => {
      const url = create(object)
      evidence.created.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      evidence.revoked.push(url)
      revoke(url)
    }
    HTMLAnchorElement.prototype.click = function () {
      evidence.clicks.push({ href: this.href, download: this.download, connected: this.isConnected })
      click.call(this)
    }
  })
}
async function evidence(page: Page) {
  return page.evaluate(() => (window as unknown as { archiveEvidence: BrowserEvidence }).archiveEvidence)
}
async function openReview(page: Page, context: BrowserContext, worker: Worker) {
  await observeDownloads(page)
  await context.addCookies([{ name: '__Host-iconctl-session', value: worker.fixture.session.token, domain: new URL(worker.origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }])
  await page.goto(`${worker.origin}/app/`)
  await page.getByLabel('当前项目', { exact: true }).selectOption(worker.fixture.project.id)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await page.getByLabel('选择快照', { exact: true }).selectOption(worker.fixture.current.id)
  await expect(downloadButton(page)).toBeEnabled()
}
async function state(request: APIRequestContext, worker: Worker) {
  const response = await request.get(`${worker.origin}/api/state`, { headers: { cookie: `__Host-iconctl-session=${worker.fixture.session.token}` } })
  expect(response.ok()).toBe(true)
  return await response.json() as ConsoleState
}
async function control(request: APIRequestContext, worker: Worker, action: string) {
  const response = await request.post(`${worker.origin}/__fixtures/snapshot-svg-archive/control`, { data: { action, snapshotId: worker.fixture.current.id } })
  expect(response.ok(), await response.text()).toBe(true)
}
async function save(download: Download, info: TestInfo, name: string) {
  expect(await download.failure()).toBeNull()
  const path = info.outputPath(name)
  await download.saveAs(path)
  const bytes = await readFile(path)
  const entries = unzipSync(bytes)
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054B50)
  let central = bytes.readUInt32LE(bytes.length - 6)
  const methods: number[] = []
  for (const _ of Object.keys(entries)) {
    expect(bytes.readUInt32LE(central)).toBe(0x02014B50)
    methods.push(bytes.readUInt16LE(central + 10))
    central += 46 + bytes.readUInt16LE(central + 28) + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32)
  }
  expect(methods).toEqual(Object.keys(entries).map(() => 0))
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify({ suggestedFilename: download.suggestedFilename(), bytes: bytes.length, sha256: sha256(bytes), entries: Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])), compressionMethods: methods }, null, 2))
  return { bytes, entries }
}
async function clickDownload(page: Page, info: TestInfo, name: string, count = 3) {
  const pending = page.waitForEvent('download')
  await downloadButton(page, count).click()
  const download = await pending
  return { download, ...await save(download, info, name) }
}
async function assertReleased(page: Page) {
  const recorded = await evidence(page)
  expect(recorded.revoked).toEqual(recorded.created)
  expect(recorded.clicks.every(click => click.connected)).toBe(true)
  await expect(page.locator('a[href^="blob:"]')).toHaveCount(0)
  return recorded
}
async function holdArchive(page: Page, worker: Worker, outcome: 'success' | 'failure' = 'success') {
  let release!: () => void
  let done!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  const requests: { url: string, status: number, hash: string }[] = []
  await page.route(`**${archivePath(worker.fixture.current)}`, async (route) => {
    const response = await route.fetch()
    const bytes = await response.body()
    requests.push({ url: route.request().url(), status: response.status(), hash: sha256(bytes) })
    if (requests.length > 1) {
      await route.fulfill({ response })
      return
    }
    await gate
    try {
      await route.fulfill(outcome === 'success' ? { response } : { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'late old failure' }) })
    }
    finally {
      done()
    }
  })
  return { requests, release, settled }
}

test.beforeEach(async ({ page }) => {
  const recorded = { requests: [] as { method: string, path: string }[], responses: [] as { path: string, status: number, contentType?: string }[], failures: [] as { path: string, error?: string }[], downloads: [] as string[], errors: [] as string[] }
  observations.set(page, recorded)
  page.on('request', request => recorded.requests.push({ method: request.method(), path: new URL(request.url()).pathname }))
  page.on('response', response => recorded.responses.push({ path: new URL(response.url()).pathname, status: response.status(), contentType: response.headers()['content-type'] }))
  page.on('requestfailed', request => recorded.failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }))
  page.on('download', download => recorded.downloads.push(download.suggestedFilename()))
  page.on('pageerror', error => recorded.errors.push(error.message))
})

test.afterEach(async ({ page, localWorker }, info) => {
  const network = observations.get(page)!
  await writeFile(info.outputPath('svg-http-evidence.json'), JSON.stringify(network, null, 2))
  expect(network.requests.filter(request => request.method !== 'GET')).toEqual([])
  expect(network.errors).toEqual([])
  expect(localWorker.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const recorded = await evidence(page)
  if (recorded) {
    await writeFile(info.outputPath('svg-browser-resources.json'), JSON.stringify(recorded, null, 2))
    await assertReleased(page)
  }
})

test('downloads the entire immutable stored SVG set through the real Worker despite search, diff and release comparison filters', async ({ page, context, request, localWorker }, info) => {
  await openReview(page, context, localWorker)
  const before = await state(request, localWorker)
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  await expect(page.getByRole('button', { name: '删除 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除 1', exact: true }).click()
  await page.getByLabel('搜索图标', { exact: true }).fill('no-matching-icon')
  await expect(page.getByText('没有符合条件的图标。', { exact: true })).toBeVisible()
  const responsePromise = page.waitForResponse(`**${archivePath(localWorker.fixture.current)}`)
  const first = await clickDownload(page, info, 'all-svg.zip')
  const response = await responsePromise
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/zip')
  expect(response.headers()['cache-control']).toBe('private, no-store')
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['content-security-policy']).toBe('sandbox; default-src \'none\'')
  expect(first.download.suggestedFilename()).toBe(`iconctl-svg-${localWorker.fixture.current.id}-${localWorker.fixture.current.digest.slice(0, 12)}.zip`)
  expect(Object.keys(first.entries)).toEqual(Object.keys(localWorker.fixture.expectedFiles).sort())
  for (const [name, encoded] of Object.entries(localWorker.fixture.expectedFiles)) {
    expect(Buffer.from(first.entries[name]!)).toEqual(Buffer.from(encoded, 'base64'))
  }
  const second = await clickDownload(page, info, 'all-svg-again.zip')
  expect(second.bytes).toEqual(first.bytes)
  await expect(status(page)).toHaveText('已发起下载')
  await expect(failure(page)).toHaveCount(0)
  await expect(page.getByLabel('搜索图标', { exact: true })).toHaveValue('no-matching-icon')
  const individual = await request.get(`${localWorker.origin}/api/snapshots/${localWorker.fixture.current.id}/files/icons.json`, { headers: { cookie: `__Host-iconctl-session=${localWorker.fixture.session.token}` } })
  expect(await individual.text()).toBe('{}')
  expect(await state(request, localWorker)).toEqual(before)
})

test('disables repeated activation during the real Worker request and releases its Blob and temporary link', async ({ page, context, localWorker }, info) => {
  await openReview(page, context, localWorker)
  const held = await holdArchive(page, localWorker)
  try {
    await downloadButton(page).click()
    await expect.poll(() => held.requests.length).toBe(1)
    await expect(downloadButton(page)).toBeDisabled()
    await expect(status(page)).toHaveText('正在准备 SVG 下载…')
    await downloadButton(page).dispatchEvent('click')
    expect(held.requests).toHaveLength(1)
    const pending = page.waitForEvent('download')
    held.release()
    await save(await pending, info, 'single-pending.zip')
    await expect(downloadButton(page)).toBeEnabled()
    expect((await assertReleased(page)).created).toHaveLength(1)
    await writeFile(info.outputPath('held-request.json'), JSON.stringify(held.requests, null, 2))
  }
  finally {
    held.release()
    await held.settled
  }
})

test('keeps the current review and retries only an explicitly requested failed network download', async ({ page, context, localWorker }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openReview(page, context, localWorker)
  let calls = 0
  await page.route(`**${archivePath(localWorker.fixture.current)}`, async (route) => {
    calls++
    if (calls === 1) {
      await route.abort('connectionreset')
    }
    else {
      await route.continue()
    }
  })
  await downloadButton(page).click()
  await expect(failure(page)).toBeVisible()
  await expect(downloadButton(page)).toBeEnabled()
  await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(localWorker.fixture.current.id)
  await expect(page.getByRole('img', { name: 'added 之后', exact: true })).toBeVisible()
  expect((await evidence(page)).created).toEqual([])
  await page.screenshot({ path: info.outputPath('svg-download-retry-mobile.png'), fullPage: true })
  const pending = page.waitForEvent('download')
  await downloadButton(page).focus()
  await page.keyboard.press('Enter')
  await save(await pending, info, 'network-retry.zip')
  expect(calls).toBe(2)
  await expect(failure(page)).toHaveCount(0)
})

for (const action of ['missing', 'corrupt'] as const) {
  test(`surfaces real Worker ${action === 'missing' ? 404 : 409} without a false download and recovers the same snapshot after storage repair`, async ({ page, context, request, localWorker }, info) => {
    await openReview(page, context, localWorker)
    await control(request, localWorker, action)
    const response = page.waitForResponse(`**${archivePath(localWorker.fixture.current)}`)
    await downloadButton(page).click()
    expect((await response).status()).toBe(action === 'missing' ? 404 : 409)
    await expect(failure(page)).toBeVisible()
    expect((await evidence(page)).created).toEqual([])
    await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(localWorker.fixture.current.id)
    await control(request, localWorker, 'restore')
    await clickDownload(page, info, `${action}-restored.zip`)
    await expect(failure(page)).toHaveCount(0)
  })
}

test('reports the real Worker size limit locally and permits selecting and downloading a smaller snapshot', async ({ page, context, localWorker }, info) => {
  await openReview(page, context, localWorker)
  await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.large.id)
  await expect(downloadButton(page, 1)).toBeEnabled()
  const response = page.waitForResponse(`**${archivePath(localWorker.fixture.large)}`)
  await downloadButton(page, 1).click()
  expect((await response).status()).toBe(413)
  await expect(failure(page)).toContainText('1 MiB')
  expect((await evidence(page)).created).toEqual([])
  await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.current.id)
  await expect(failure(page)).toHaveCount(0)
  await clickDownload(page, info, 'small-after-limit.zip')
})

test('explains snapshots without SVG artifacts and preserves their original JSON artifact bytes', async ({ page, context, request, localWorker }, info) => {
  await openReview(page, context, localWorker)
  await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.empty.id)
  await expect(page.getByText('当前快照没有 SVG 产物。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /下载全部 SVG/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'icons.json ↓', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '下载完整 Iconify JSON', exact: true })).toBeEnabled()
  const artifact = await request.get(`${localWorker.origin}/api/snapshots/${localWorker.fixture.empty.id}/files/icons.json`, { headers: { cookie: `__Host-iconctl-session=${localWorker.fixture.session.token}` } })
  expect(artifact.status()).toBe(200)
  expect(artifact.headers()['content-disposition']).toContain('icons.json')
  expect(await artifact.text()).toBe('{}')
  await writeFile(info.outputPath('original-icons.json'), await artifact.body())
})

for (const navigation of ['snapshot', 'comparison', 'project', 'view'] as const) {
  test(`aborts a pending archive on ${navigation} and prevents late download or status from taking over`, async ({ page, context, localWorker }, info) => {
    await openReview(page, context, localWorker)
    const downloads: string[] = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    const held = await holdArchive(page, localWorker)
    try {
      await downloadButton(page).click()
      await expect.poll(() => held.requests.length).toBe(1)
      const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === archivePath(localWorker.fixture.current))
      if (navigation === 'snapshot') {
        await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.alternate.id)
        await expect(downloadButton(page, 1)).toBeEnabled()
      }
      else if (navigation === 'comparison') {
        await page.getByLabel('比较基准', { exact: true }).selectOption('release')
        await expect(page.getByLabel('比较基准', { exact: true })).toHaveValue('release')
      }
      else if (navigation === 'project') {
        await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.otherProject.id)
        await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(localWorker.fixture.otherProject.id)
      }
      else {
        await page.getByRole('button', { name: '任务与版本', exact: true }).click()
        await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeVisible()
      }
      const request = await aborted
      held.release()
      await held.settled
      await expect(status(page)).toHaveCount(0)
      await expect(failure(page)).toHaveCount(0)
      expect(downloads).toEqual([])
      expect((await evidence(page)).created).toEqual([])
      await writeFile(info.outputPath('cancelled-request.json'), JSON.stringify({ navigation, requestFailure: request.failure(), workerResponses: held.requests, downloads }, null, 2))
    }
    finally {
      held.release()
      await held.settled
    }
  })
}

for (const outcome of ['success', 'failure'] as const) {
  test(`isolates late ${outcome} after A to B to A while a fresh A download succeeds`, async ({ page, context, localWorker }, info) => {
    await openReview(page, context, localWorker)
    const downloads: string[] = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    const held = await holdArchive(page, localWorker, outcome)
    try {
      await downloadButton(page).click()
      await expect.poll(() => held.requests.length).toBe(1)
      const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === archivePath(localWorker.fixture.current))
      await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.alternate.id)
      await expect(downloadButton(page, 1)).toBeEnabled()
      await aborted
      await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.current.id)
      await expect(downloadButton(page)).toBeEnabled()
      await clickDownload(page, info, `fresh-after-late-${outcome}.zip`)
      held.release()
      await held.settled
      await expect(status(page)).toHaveText('已发起下载')
      await expect(failure(page)).toHaveCount(0)
      expect(downloads).toHaveLength(1)
      expect(held.requests).toHaveLength(2)
      expect((await assertReleased(page)).created).toHaveLength(1)
    }
    finally {
      held.release()
      await held.settled
    }
  })
}

test('destroys an old document during reload and permits one fresh download without leaked Blob URLs', async ({ page, context, localWorker }, info) => {
  await openReview(page, context, localWorker)
  const downloads: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  const oldDocument = await page.evaluateHandle(() => document)
  const held = await holdArchive(page, localWorker)
  try {
    await downloadButton(page).click()
    await expect.poll(() => held.requests.length).toBe(1)
    await page.reload()
    await expect(oldDocument.evaluate(document => document.URL)).rejects.toThrow()
    held.release()
    await held.settled
    await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.project.id)
    await page.getByRole('button', { name: '预览与差异', exact: true }).click()
    await page.getByLabel('选择快照', { exact: true }).selectOption(localWorker.fixture.current.id)
    await expect(status(page)).toHaveCount(0)
    await clickDownload(page, info, 'fresh-document.zip')
    expect(downloads).toHaveLength(1)
    expect((await assertReleased(page)).created).toHaveLength(1)
  }
  finally {
    held.release()
    await held.settled
    await oldDocument.dispose()
  }
})

test('requires the live owner session at the real archive endpoint and never treats an unauthorized error as ZIP bytes', async ({ page, context, request, localWorker }) => {
  await openReview(page, context, localWorker)
  const anonymous = await request.get(`${localWorker.origin}${archivePath(localWorker.fixture.current)}`)
  expect(anonymous.status()).toBe(401)
  await context.clearCookies()
  const response = page.waitForResponse(`**${archivePath(localWorker.fixture.current)}`)
  await downloadButton(page).click()
  expect((await response).status()).toBe(401)
  await expect(page).toHaveURL(`${localWorker.origin}/login`)
  expect((await evidence(page)).created).toEqual([])
})

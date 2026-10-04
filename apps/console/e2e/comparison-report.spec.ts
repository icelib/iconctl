import type { ConsoleState, IconJSON, Project, Release, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import type { BrowserContext, Download, Page, TestInfo } from '@playwright/test'
import type { ComparisonReport } from '../src/features/review/comparison-report'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createWorkerTest, expect } from './local-worker'

interface Fixture {
  project: Project
  otherProject: Project
  baseline: Snapshot
  previous: Snapshot
  current: Snapshot
  prefixOnly: Snapshot
  empty: Snapshot
  first: Snapshot
  release: Release
  hostile: string
  hostileSvg: string
  session: { token: string, csrf: string }
}
interface Worker { origin: string, fixture: Fixture, unexpectedRequests: string[] }
interface Resources { created: string[], revoked: string[], clicks: string[], failure: string }
interface TimerGate { release: () => void, held: boolean, cancelled: boolean, armed: boolean }
interface Instrumented { reportResources: Resources, reportGate?: TimerGate }
interface Observations { requests: string[], errors: string[], downloads: string[], snapshots: { path: string, data: SnapshotPreview }[] }
const test = createWorkerTest<Fixture>('comparison-report')
const recorded = new WeakMap<Page, Observations>()
const button = (page: Page, format: 'json' | 'html' = 'json') => page.getByRole('button', { name: `下载比较 ${format.toUpperCase()}`, exact: true })
const status = (page: Page) => page.getByRole('status', { name: '比较报告状态', exact: true })
const failure = (page: Page) => page.getByRole('alert', { name: '比较报告失败', exact: true })
const snapshotSelect = (page: Page) => page.getByLabel('选择快照', { exact: true })
const comparisonSelect = (page: Page) => page.getByLabel('比较基准', { exact: true })
const snapshotPath = (snapshot: Snapshot, comparison = '') => `/api/snapshots/${snapshot.id}${comparison ? `?compareTo=${comparison}` : ''}`
const resources = (page: Page) => page.evaluate(() => (window as unknown as Instrumented).reportResources)

async function select(page: Page, snapshot: Snapshot, comparison = '') {
  const path = snapshotPath(snapshot, comparison)
  if (await snapshotSelect(page).inputValue() === snapshot.id && await comparisonSelect(page).inputValue() === comparison && await button(page).isEnabled()) {
    const committed = recorded.get(page)!.snapshots.filter(item => item.path === path).at(-1)
    expect(committed).toBeDefined()
    return committed!.data
  }
  const pending = page.waitForResponse(response => new URL(response.url()).pathname + new URL(response.url()).search === path)
  if (await snapshotSelect(page).inputValue() !== snapshot.id || comparison === '') {
    await snapshotSelect(page).selectOption(snapshot.id)
  }
  else {
    await comparisonSelect(page).selectOption(comparison)
  }
  const response = await pending
  expect(response.status()).toBe(200)
  const preview = await response.json() as SnapshotPreview
  await expect(button(page)).toBeEnabled()
  await expect(snapshotSelect(page)).toHaveValue(snapshot.id)
  await expect(comparisonSelect(page)).toHaveValue(comparison)
  return preview
}

async function open(page: Page, context: BrowserContext, worker: Worker) {
  await context.addCookies([{ name: '__Host-iconctl-session', value: worker.fixture.session.token, domain: new URL(worker.origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }])
  await page.goto(`${worker.origin}/app/`)
  await page.getByLabel('当前项目', { exact: true }).selectOption(worker.fixture.project.id)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  return select(page, worker.fixture.current)
}
// Independent allowlist comparison: expectations come from the actual HTTP
// response, never the product capture/renderer or a synthetic diff calculation.
function expected(preview: SnapshotPreview): ComparisonReport {
  const metadata = (snapshot: Snapshot) => ({ id: snapshot.id, projectId: snapshot.projectId, jobId: snapshot.jobId, attempt: snapshot.attempt ?? 1, createdAt: snapshot.createdAt, digest: snapshot.digest, iconCount: snapshot.iconCount, issues: snapshot.issues })
  const side = (json: IconJSON | undefined, name: string) => {
    const icon = json?.icons[name]
    return icon ? { body: icon.body, width: icon.width ?? json!.width ?? 16, height: icon.height ?? json!.height ?? 16 } : null
  }
  return {
    format: 'iconctl-console-comparison',
    schemaVersion: 1,
    scope: 'changes',
    snapshot: metadata(preview.snapshot),
    comparison: { mode: preview.comparison.mode, snapshot: preview.comparison.snapshot ? metadata(preview.comparison.snapshot) : null, release: preview.comparison.release },
    prefixes: { before: preview.previous?.prefix ?? null, after: preview.content.json.prefix, changed: !!preview.previous && preview.previous.prefix !== preview.content.json.prefix },
    diff: { added: preview.diff.added, changed: preview.diff.changed, removed: preview.diff.removed },
    icons: (['added', 'changed', 'removed'] as const).flatMap(status => preview.diff[status].map(name => ({ name, status, before: side(preview.previous, name), after: side(preview.content.json, name) }))),
    diagnostics: { issues: preview.content.issues.map(issue => Object.fromEntries(Object.entries(issue).filter(([key]) => ['name', 'message', 'stage', 'sourceType', 'sourceIndex', 'fileKey', 'nodeId'].includes(key)))) as ComparisonReport['diagnostics']['issues'], failed: preview.content.failed },
  }
}
async function save(download: Download, info: TestInfo, name: string) {
  expect(await download.failure()).toBeNull()
  const path = info.outputPath(name)
  await download.saveAs(path)
  const text = await readFile(path, 'utf8')
  expect(text).not.toMatch(/report-private-|fixture-installation-token/)
  await writeFile(info.outputPath(`${name}.evidence.json`), JSON.stringify({ filename: download.suggestedFilename(), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }, null, 2))
  return { path, text, filename: download.suggestedFilename() }
}
async function released(page: Page) {
  const evidence = await resources(page)
  expect(evidence.revoked).toEqual(evidence.created)
  await expect(page.locator('a[href^="blob:"]')).toHaveCount(0)
}
async function download(page: Page, info: TestInfo, name: string, format: 'json' | 'html' = 'json') {
  const pending = page.waitForEvent('download')
  await button(page, format).click()
  const file = await save(await pending, info, name)
  await expect(status(page)).toHaveText('已发起比较报告下载')
  await expect(failure(page)).toHaveCount(0)
  await released(page)
  return file
}
async function gateGeneration(page: Page) {
  // Hold only the next native zero-delay task after an explicit click. The
  // renderer, AbortSignal, timer cleanup and Vue UI remain production code.
  await page.evaluate(() => {
    const w = window as unknown as Instrumented
    const nativeSet = window.setTimeout.bind(window)
    const nativeClear = window.clearTimeout.bind(window)
    let timer = 0
    let callback: (() => void) | undefined
    const gate: TimerGate = { held: false, cancelled: false, armed: true, release: () => {
      nativeClear(timer)
      callback?.()
      callback = undefined
      window.setTimeout = nativeSet
      window.clearTimeout = nativeClear
    } }
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (gate.armed && delay === 0 && typeof handler === 'function') {
        gate.armed = false
        gate.held = true
        callback = () => handler(...args)
        timer = nativeSet(() => {}, 600_000)
        return timer
      }
      return nativeSet(handler, delay, ...args)
    }) as typeof window.setTimeout
    window.clearTimeout = (id) => {
      if (id === timer) {
        gate.cancelled = true
      }
      nativeClear(id)
    }
    w.reportGate = gate
  })
  return {
    held: () => page.evaluate(() => (window as unknown as Instrumented).reportGate!.held),
    cancelled: () => page.evaluate(() => (window as unknown as Instrumented).reportGate!.cancelled),
    release: () => page.evaluate(() => (window as unknown as Instrumented).reportGate!.release()),
  }
}
async function holdRead(page: Page, path: string, failed = false) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  let done!: () => void
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  await page.route(`**${path}`, async (route) => {
    const response = await route.fetch()
    entered = true
    await gate
    try {
      await route.fulfill(failed ? { status: 502, json: { error: 'controlled replacement failure' } } : { response })
    }
    finally {
      done()
    }
  }, { times: 1 })
  return { entered: () => entered, release, settled }
}

test.beforeEach(async ({ page }) => {
  const observations: Observations = { requests: [], errors: [], downloads: [], snapshots: [] }
  recorded.set(page, observations)
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      observations.requests.push(`${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`)
    }
  })
  page.on('pageerror', error => observations.errors.push(error.message))
  page.on('download', download => observations.downloads.push(download.suggestedFilename()))
  page.on('response', async (response) => {
    const url = new URL(response.url())
    if (/^\/api\/snapshots\/[^/]+$/.test(url.pathname) && response.ok()) {
      observations.snapshots.push({ path: url.pathname + url.search, data: await response.json() as SnapshotPreview })
    }
  })
  await page.addInitScript(() => {
    const evidence: Resources = { created: [], revoked: [], clicks: [], failure: '' }
    Object.assign(window, { reportResources: evidence })
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (blob) => {
      if (evidence.failure === 'url') {
        throw new Error('controlled URL failure')
      }
      const url = create(blob)
      evidence.created.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      evidence.revoked.push(url)
      revoke(url)
    }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        evidence.clicks.push(this.download)
        if (evidence.failure === 'click') {
          throw new Error('controlled click failure')
        }
      }
      click.call(this)
    }
  })
})

test.afterEach(async ({ page, localWorker }, info) => {
  const observations = recorded.get(page)!
  await writeFile(info.outputPath('comparison-http-evidence.json'), JSON.stringify(observations, null, 2))
  expect(observations.errors).toEqual([])
  expect(observations.requests.filter(request => !request.startsWith('GET '))).toEqual([])
  expect(localWorker.unexpectedRequests).toEqual([])
  const evidence = await resources(page)
  if (evidence) {
    await writeFile(info.outputPath('comparison-resources.json'), JSON.stringify(evidence, null, 2))
    await released(page)
  }
})

test('exports the full real Worker comparison despite hidden rows and opens both script-free offline modes', async ({ page, context, browser, request, localWorker }, info) => {
  await open(page, context, localWorker)
  const preview = await select(page, localWorker.fixture.current, 'release')
  expect(preview.snapshot.baselineId).toBe(localWorker.fixture.previous.id)
  expect(preview.comparison.snapshot?.id).toBe(localWorker.fixture.baseline.id)
  expect(preview.diff).toEqual({ added: [localWorker.fixture.hostile, 'added'].sort(), changed: ['metadata', 'resized'], removed: ['removed'] })
  const report = expected(preview)
  expect(report.icons.find(icon => icon.name === 'metadata')!.before).toEqual(report.icons.find(icon => icon.name === 'metadata')!.after)
  expect(report.icons.find(icon => icon.name === 'resized')).toMatchObject({ before: { width: 20, height: 10 }, after: { width: 40, height: 16 } })
  await page.getByRole('button', { name: '删除 1', exact: true }).click()
  await page.getByLabel('搜索图标', { exact: true }).fill('nothing-matches')
  await expect(page.getByText('没有符合条件的图标。', { exact: true })).toBeVisible()
  const headers = { cookie: `__Host-iconctl-session=${localWorker.fixture.session.token}` }
  const before = await (await request.get(`${localWorker.origin}/api/state`, { headers })).json() as ConsoleState
  // No active jobs exist. Exclude only the known read-only workspace poll from
  // the API count, so periodic refresh cannot masquerade as an export request.
  const api = () => recorded.get(page)!.requests.filter(value => value !== 'GET /api/state')
  const requestsBefore = [...api()]
  const json = await download(page, info, 'release-comparison.json')
  expect(JSON.parse(json.text)).toEqual(report)
  expect(json.text).toBe(`${JSON.stringify(JSON.parse(json.text), null, 2)}\n`)
  expect(json.filename).toBe(`iconctl-comparison-${preview.snapshot.id}-${preview.snapshot.digest.slice(0, 12)}-release-${localWorker.fixture.release.id}.json`)
  const again = await download(page, info, 'release-comparison-again.json')
  expect(again.text).toBe(json.text)
  const html = await download(page, info, 'release-comparison.html', 'html')
  expect(api()).toEqual(requestsBefore)
  expect(await (await request.get(`${localWorker.origin}/api/state`, { headers })).json()).toEqual(before)
  await expect(page.getByLabel('搜索图标', { exact: true })).toHaveValue('nothing-matches')
  await writeFile(info.outputPath('actual-preview.json'), JSON.stringify(preview, null, 2))
  for (const javaScriptEnabled of [false, true]) {
    const offlineContext = await browser.newContext({ javaScriptEnabled, viewport: { width: 1100, height: 820 } })
    const offline = await offlineContext.newPage()
    const requests: string[] = []
    const errors: string[] = []
    const dialogs: string[] = []
    offline.on('request', (request) => {
      if (/^https?:/.test(request.url())) {
        requests.push(request.url())
      }
    })
    offline.on('pageerror', error => errors.push(error.message))
    offline.on('dialog', async (dialog) => {
      dialogs.push(dialog.message())
      await dialog.dismiss()
    })
    try {
      await offline.goto(pathToFileURL(html.path).href)
      await expect(offline.getByRole('heading', { name: '快照比较报告', exact: true })).toBeVisible()
      await expect(offline.locator('article[data-status] h3')).toHaveText(report.icons.map(icon => icon.name))
      await expect(offline.getByRole('region', { name: '比较基准', exact: true })).toContainText('发布版本 v1.2.3')
      await expect(offline.getByRole('region', { name: '比较基准', exact: true })).toContainText(localWorker.fixture.baseline.id)
      await expect(offline.getByRole('region', { name: '变化摘要', exact: true })).toContainText('命名空间已变化')
      await expect(offline.getByRole('region', { name: '快照诊断', exact: true })).toContainText('missing-output')
      await expect(offline.getByRole('region', { name: '快照诊断', exact: true })).toContainText(preview.content.issues[0]!.message)
      await expect(offline.locator('script, iframe, object, embed, svg, link, a, form, [data-injected]')).toHaveCount(0)
      await expect(offline.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', 'default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'')
      const images = offline.locator('img')
      expect(await images.count()).toBe(7)
      await expect.poll(async () => images.evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
      const bodies = await images.evaluateAll(images => images.map(image => ({ alt: image.getAttribute('alt'), src: image.getAttribute('src')! })))
      for (const image of bodies) {
        expect(image.src).toMatch(/^data:image\/svg\+xml;base64,/)
        const xml = Buffer.from(image.src.split(',')[1]!, 'base64').toString('utf8')
        expect(xml).toContain('viewBox="0 0 ')
        if (image.alt?.includes(localWorker.fixture.hostile)) {
          expect(xml).toContain(localWorker.fixture.hostileSvg)
        }
      }
      expect(await offline.evaluate(() => (window as unknown as { __svgExecuted?: boolean }).__svgExecuted)).toBeUndefined()
      await offline.screenshot({ path: info.outputPath(`comparison-offline-${javaScriptEnabled ? 'js' : 'no-js'}-desktop.png`), fullPage: true })
      await offline.setViewportSize({ width: 390, height: 844 })
      expect(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await offline.screenshot({ path: info.outputPath(`comparison-offline-${javaScriptEnabled ? 'js' : 'no-js'}-mobile.png`), fullPage: true })
      await offline.emulateMedia({ media: 'print' })
      if (!javaScriptEnabled) {
        await offline.pdf({ path: info.outputPath('comparison-offline-print.pdf'), format: 'A4', printBackground: true })
      }
      expect(requests).toEqual([])
      expect(errors).toEqual([])
      expect(dialogs).toEqual([])
      await writeFile(info.outputPath(`offline-${javaScriptEnabled ? 'js' : 'no-js'}-evidence.json`), JSON.stringify({ requests, errors, dialogs, loadedImages: bodies.length, scriptExecution: false }, null, 2))
    }
    finally {
      await offlineContext.close()
    }
  }
})

test('preserves previous, explicit, self, prefix-only, empty-current and first-release comparisons from real stored snapshots', async ({ page, context, localWorker }, info) => {
  let preview = await open(page, context, localWorker)
  for (const [name, target, comparison] of [
    ['previous', localWorker.fixture.current, ''],
    ['explicit', localWorker.fixture.current, localWorker.fixture.baseline.id],
    ['self', localWorker.fixture.current, localWorker.fixture.current.id],
    ['prefix-only', localWorker.fixture.prefixOnly, ''],
    ['empty-current', localWorker.fixture.empty, ''],
  ] as const) {
    if (name !== 'previous') {
      preview = await select(page, target, comparison)
    }
    const file = await download(page, info, `${name}.json`)
    const report = JSON.parse(file.text) as ComparisonReport
    expect(report).toEqual(expected(preview))
    if (['previous', 'self', 'prefix-only'].includes(name)) {
      expect(report.icons).toEqual([])
    }
    if (name === 'prefix-only') {
      expect(report.prefixes.changed).toBe(true)
    }
    if (name === 'empty-current') {
      expect(report.diff.removed).toHaveLength(5)
    }
  }
  await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.otherProject.id)
  preview = await select(page, localWorker.fixture.first)
  preview = await select(page, localWorker.fixture.first, 'release')
  const file = await download(page, info, 'first-release.json')
  const report = JSON.parse(file.text) as ComparisonReport
  expect(report).toEqual(expected(preview))
  expect(report.comparison).toEqual({ mode: 'release', snapshot: null, release: null })
  expect(report.snapshot.attempt).toBe(1)
  expect(report.icons.map(icon => icon.after)).toEqual([{ body: '<circle cx="8" cy="8" r="6"/>', width: 16, height: 16 }, { body: '<circle cx="8" cy="8" r="6"/>', width: 18, height: 16 }])
  expect((await download(page, info, 'first-release.html', 'html')).text).toContain('首次发布 · 空图标集')
})

test('blocks both formats during a failed replacement and exports the retained committed review afterward', async ({ page, context, localWorker }, info) => {
  const preview = await open(page, context, localWorker)
  const held = await holdRead(page, snapshotPath(localWorker.fixture.empty), true)
  try {
    await snapshotSelect(page).selectOption(localWorker.fixture.empty.id)
    await expect.poll(held.entered).toBe(true)
    await expect(button(page)).toBeDisabled()
    await expect(button(page, 'html')).toBeDisabled()
    await button(page).dispatchEvent('click')
    expect((await resources(page)).created).toEqual([])
    held.release()
    await held.settled
    await expect(page.getByRole('alert', { name: '快照加载失败', exact: true })).toContainText('controlled replacement failure')
    await expect(snapshotSelect(page)).toHaveValue(preview.snapshot.id)
    expect(JSON.parse((await download(page, info, 'retained-after-failure.json')).text)).toEqual(expected(preview))
  }
  finally {
    held.release()
    await held.settled
  }
})

test('shares one native generation task between both buttons and permits one completed download', async ({ page, context, localWorker }, info) => {
  const preview = await open(page, context, localWorker)
  const gate = await gateGeneration(page)
  try {
    await button(page).click()
    await expect.poll(gate.held).toBe(true)
    await expect(button(page)).toBeDisabled()
    await expect(button(page, 'html')).toBeDisabled()
    await expect(status(page)).toHaveText('正在准备比较报告…')
    await button(page, 'html').dispatchEvent('click')
    await button(page).dispatchEvent('click')
    const pending = page.waitForEvent('download')
    await gate.release()
    expect(JSON.parse((await save(await pending, info, 'single-flight.json')).text)).toEqual(expected(preview))
    await expect(status(page)).toHaveText('已发起比较报告下载')
    expect(recorded.get(page)!.downloads).toHaveLength(1)
    expect((await resources(page)).created).toHaveLength(1)
  }
  finally {
    await gate.release()
  }
})

for (const navigation of ['snapshot', 'comparison', 'project', 'view'] as const) {
  test(`cancels native report generation on ${navigation}, clears its timer and isolates late completion`, async ({ page, context, localWorker }, info) => {
    await open(page, context, localWorker)
    const gate = await gateGeneration(page)
    try {
      await button(page, 'html').click()
      await expect.poll(gate.held).toBe(true)
      if (navigation === 'snapshot') {
        await select(page, localWorker.fixture.empty)
      }
      else if (navigation === 'comparison') {
        await select(page, localWorker.fixture.current, 'release')
      }
      else if (navigation === 'project') {
        await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.otherProject.id)
      }
      else {
        await page.getByRole('button', {
          name: '任务与版本',
          exact: true,
        }).click()
      }
      await expect.poll(gate.cancelled).toBe(true)
      await gate.release()
      await expect(status(page)).toHaveCount(0)
      await expect(failure(page)).toHaveCount(0)
      expect(recorded.get(page)!.downloads).toEqual([])
      expect((await resources(page)).created).toEqual([])
      if (navigation === 'view') {
        await page.getByRole('button', {
          name: '预览与差异',
          exact: true,
        }).click()
      }
      if (navigation === 'project') {
        await page.getByLabel('当前项目', {
          exact: true,
        }).selectOption(localWorker.fixture.project.id)
      }
      const preview = await select(page, localWorker.fixture.current)
      expect(JSON.parse((await download(page, info, `${navigation}-recovered.json`)).text)).toEqual(expected(preview))
    }
    finally {
      await gate.release()
    }
  })
}

test('invalidates generation on A to B to A even when the final committed object is retained', async ({ page, context, localWorker }, info) => {
  const preview = await open(page, context, localWorker)
  const gate = await gateGeneration(page)
  const held = await holdRead(page, snapshotPath(localWorker.fixture.current, 'release'))
  try {
    await button(page).click()
    await expect.poll(gate.held).toBe(true)
    await comparisonSelect(page).selectOption('release')
    await expect.poll(held.entered).toBe(true)
    await expect(button(page)).toBeDisabled()
    await comparisonSelect(page).selectOption('')
    await expect(button(page)).toBeEnabled()
    await expect.poll(gate.cancelled).toBe(true)
    held.release()
    await held.settled
    await gate.release()
    await expect(status(page)).toHaveCount(0)
    expect(recorded.get(page)!.downloads).toEqual([])
    expect(JSON.parse((await download(page, info, 'aba-fresh.json')).text)).toEqual(expected(preview))
    await expect(comparisonSelect(page)).toHaveValue('')
  }
  finally {
    held.release()
    await held.settled
    await gate.release()
  }
})

for (const fault of ['url', 'click'] as const) {
  test(`releases a local ${fault} save failure and retries the same committed comparison by keyboard`, async ({ page, context, localWorker }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const preview = await open(page, context, localWorker)
    await page.evaluate((fault) => {
      (window as unknown as Instrumented).reportResources.failure = fault
    }, fault)
    await button(page).click()
    await expect(failure(page)).toContainText(`controlled ${fault === 'url' ? 'URL' : fault} failure`)
    await expect(button(page)).toBeEnabled()
    expect(recorded.get(page)!.downloads).toEqual([])
    await released(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`comparison-${fault}-failure-mobile.png`), fullPage: true })
    await page.evaluate(() => {
      (window as unknown as Instrumented).reportResources.failure = ''
    })
    await button(page).focus()
    const pending = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect(JSON.parse((await save(await pending, info, `${fault}-retry.json`)).text)).toEqual(expected(preview))
    await expect(failure(page)).toHaveCount(0)
    await expect(status(page)).toHaveText('已发起比较报告下载')
    await expect(button(page)).toBeFocused()
  })
}

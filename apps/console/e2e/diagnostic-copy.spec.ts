import type { Job, Project, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import type { ClipboardFixture, ClipboardMode } from './clipboard-fixture'
import { readFile, writeFile } from 'node:fs/promises'
import { installClipboard } from './clipboard-fixture'
import { firstFile, generateCoreResult, winningFile, winningNode } from './diagnostics-core'
import { createWorkerTest, expect } from './local-worker'

interface Fixture { project: Project, job: Job, rich: Snapshot, reportRich: Snapshot, failedOnly: Snapshot, invalid: Snapshot, hostile: string, session: { token: string } }
interface Worker { origin: string, fixture: Fixture, unexpectedRequests: string[] }
const test = createWorkerTest<Fixture>('diagnostics').extend<{ coreResult: Awaited<ReturnType<typeof generateCoreResult>> }>({
  // Restore global fetch before starting the actual Worker or browser.
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture dependency syntax.
  coreResult: [async ({}, use) => { await use(await generateCoreResult()) }, { auto: true }],
})
const diag = (page: Page) => page.getByRole('region', { name: '快照诊断', exact: true })
const row = (page: Page, index: number, kind = '问题') => diag(page).getByRole('article', { name: `${kind} ${index + 1}`, exact: true })
const action = (page: Page, index: number, manual = false, kind = '问题') => row(page, index, kind).getByRole('button', { name: manual ? '显示定位文本' : '复制定位信息', exact: true })
const textBox = (page: Page) => page.getByRole('textbox', { name: '定位文本', exact: true })
const status = (page: Page) => page.getByLabel('定位复制状态', { exact: true })
const select = (page: Page) => page.getByLabel('选择快照', { exact: true })
const stage = (page: Page) => page.getByRole('combobox', { name: '问题阶段', exact: true })
const source = (page: Page) => page.getByRole('combobox', { name: '问题来源', exact: true })
const report = (page: Page, format = 'JSON') => page.getByRole('button', { name: `下载比较 ${format}`, exact: true })
const observed = new WeakMap<Page, { requests: string[], errors: string[], clipboard?: ClipboardFixture }>()

async function copyHarness(page: Page, mode: ClipboardMode) {
  const clipboard = await installClipboard(page.locator('body'), mode)
  observed.get(page)!.clipboard = clipboard
  return clipboard
}
async function login(page: Page, context: BrowserContext, worker: Worker) {
  await context.addCookies([{ name: '__Host-iconctl-session', value: worker.fixture.session.token, domain: new URL(worker.origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }])
  await page.goto(`${worker.origin}/app/?job=${worker.fixture.job.id}`)
  // Finish initial deep-link navigation before this test issues a new intent.
  await expect(page.locator(`#job-${worker.fixture.job.id}`)).toBeFocused()
}
async function view(page: Page, snapshot: Snapshot) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${snapshot.id}`)
  await select(page).selectOption(snapshot.id)
  const response = await pending
  expect(response.status()).toBe(200)
  const preview = await response.json() as SnapshotPreview
  await expect(report(page)).toBeEnabled()
  return preview
}
async function openLegacy(page: Page, context: BrowserContext, worker: Worker, snapshot = worker.fixture.rich) {
  await login(page, context, worker)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  return view(page, snapshot)
}
// Independent documented wire-format expectation. Never import product helpers.
function location(preview: SnapshotPreview, index: number, kind: 'issue' | 'failed' = 'issue') {
  const s = preview.snapshot
  const fields: [string, unknown][] = [['projectId', s.projectId], ['snapshotId', s.id], ['snapshotDigest', s.digest], ['jobId', s.jobId], ['attempt', s.attempt ?? 1], ['kind', kind], ['recordIndex', index]]
  if (kind === 'failed') {
    fields.push(['name', preview.content.failed[index]])
  }
  else {
    const issue = preview.content.issues[index]!
    fields.push(['name', issue.name], ['message', issue.message])
    for (const key of ['stage', 'sourceType', 'sourceIndex', 'fileKey', 'nodeId'] as const) {
      if (issue[key] !== undefined) {
        fields.push([key, issue[key]])
      }
    }
    if (issue.sourceType === 'figma' && issue.fileKey && issue.nodeId) {
      fields.push(['figmaUrl', `https://www.figma.com/file/${encodeURIComponent(issue.fileKey)}?node-id=${encodeURIComponent(issue.nodeId)}`])
    }
  }
  return ['iconctl diagnostic location v1', ...fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)].join('\n')
}
async function saveEvidence(page: Page, info: TestInfo) {
  const observations = observed.get(page)!
  const clipboard = observations.clipboard
  if (clipboard) {
    await clipboard.releaseAll()
    const evidence = await clipboard.evidence()
    expect(evidence.active).toBe(0)
    expect(evidence.peak).toBeLessThanOrEqual(1)
    expect([evidence.readCalls, evidence.permissionCalls, evidence.execCalls]).toEqual([0, 0, 0])
    await writeFile(info.outputPath('diagnostic-clipboard-evidence.json'), JSON.stringify(evidence, null, 2))
  }
  await writeFile(info.outputPath('diagnostic-http-evidence.json'), JSON.stringify({ requests: observations.requests, errors: observations.errors }, null, 2))
}
async function holdRead(page: Page, snapshot: Snapshot, failed = false) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  let done!: () => void
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  await page.route(`**/api/snapshots/${snapshot.id}`, async (route) => {
    const response = await route.fetch()
    entered = true
    await gate
    try {
      await route.fulfill(failed ? { status: 502, json: { error: 'controlled snapshot read failure' } } : { response })
    }
    finally { done() }
  }, { times: 1 })
  return { entered: () => entered, release, settled }
}

test.beforeEach(async ({ page }) => {
  const observations = { requests: [] as string[], errors: [] as string[] }
  observed.set(page, observations)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) {
      observations.requests.push(`${request.method()} ${url.pathname}${url.search}`)
    }
  })
  page.on('pageerror', error => observations.errors.push(error.message))
})
test.afterEach(async ({ page, localWorker }, info) => {
  await saveEvidence(page, info)
  expect(observed.get(page)!.errors).toEqual([])
  expect(localWorker.unexpectedRequests).toEqual([])
})

test('copies immutable winning-source diagnostics from attempt one after a real owner retry', async ({ page, context, request, localWorker, coreResult }, info) => {
  expect(coreResult.fileKey).toBe(firstFile)
  expect(coreResult.failed).toEqual(['missing-export'])
  expect(coreResult.issues.filter(issue => issue.stage === 'validation')).toHaveLength(2)
  for (const issue of coreResult.issues.filter(issue => issue.stage === 'validation')) {
    expect(issue).toMatchObject({ sourceType: 'figma', sourceIndex: 1, fileKey: winningFile, nodeId: winningNode })
  }
  const content = { json: coreResult.json, files: {}, issues: coreResult.issues, failed: coreResult.failed, sources: coreResult.sources }
  await writeFile(info.outputPath('real-core-content.json'), JSON.stringify(content, null, 2))
  const uploaded = await request.post(`${localWorker.origin}/__fixtures/diagnostics/snapshot`, { data: { jobId: localWorker.fixture.job.id, content } })
  expect(uploaded.ok()).toBe(true)
  const first = await uploaded.json() as { snapshot: Snapshot, job: Job }
  expect(first.job).toMatchObject({ status: 'failed', attempt: 1 })
  await login(page, context, localWorker)
  const job = page.locator(`#job-${first.job.id}`)
  const retry = page.waitForResponse(`**/api/jobs/${first.job.id}/retry`)
  await job.getByRole('button', { name: '重试', exact: true }).click()
  expect((await retry).status()).toBe(202)
  const completed = await request.post(`${localWorker.origin}/__fixtures/diagnostics/complete-retry`, { data: { jobId: first.job.id } })
  expect(completed.ok()).toBe(true)
  const second = await completed.json() as { snapshot: Snapshot, job: Job }
  expect(second.job).toMatchObject({ attempt: 2, status: 'succeeded' })
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect(job).toContainText('已完成')
  await job.getByText('尝试与快照', { exact: true }).click()
  const response = page.waitForResponse(`**/api/snapshots/${first.snapshot.id}`)
  await job.getByRole('button', { name: '查看第 1 次快照', exact: true }).click()
  const preview = await (await response).json() as SnapshotPreview
  await expect(diag(page)).toBeVisible()
  await stage(page).selectOption('["validation"]')
  await source(page).selectOption('["figma",1]')
  await expect(diag(page).getByLabel('可见诊断计数')).toHaveText('显示 2 / 3 条问题')
  await expect(diag(page).getByLabel('完整诊断计数')).toHaveText('问题 3 条 · 处理失败 1 项')
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: localWorker.origin })
  const clipboard = await copyHarness(page, 'native')
  const requestCount = observed.get(page)!.requests.length
  for (const index of [1, 2]) {
    await action(page, index).click()
    await expect(status(page)).toContainText('已复制定位信息')
    expect(await clipboard.readOwnNativeWrite()).toBe(location(preview, index))
  }
  await action(page, 0, false, '处理失败').click()
  await expect.poll(async () => (await clipboard.evidence()).writes.length).toBe(3)
  await expect(status(page)).toContainText('已复制定位信息')
  expect(await clipboard.readOwnNativeWrite()).toBe(location(preview, 0, 'failed'))
  const evidence = await clipboard.evidence()
  expect(evidence.environment).toMatchObject({ secure: true, nativeApi: true, writeAllowed: true })
  expect(evidence.writes.every(write => write.activation && write.settled === 'success')).toBe(true)
  expect(evidence.writes.map(write => write.value).join('\n')).not.toContain(second.snapshot.id)
  expect(observed.get(page)!.requests.slice(requestCount).filter(request => request !== 'GET /api/state')).toEqual([])
  await page.getByRole('region', { name: '快照来源', exact: true }).getByRole('button', { name: '定位生成任务', exact: true }).click()
  await expect(job.getByRole('region', { name: '第 1 次尝试', exact: true })).toBeFocused()
})

test('filters independent legacy dimensions and exports complete reports while preserving original indices', async ({ page, context, localWorker }, info) => {
  // Same legacy dimensions, with a report-compatible name (the separate long
  // fallback fixture intentionally exceeds the report's existing 200 limit).
  const preview = await openLegacy(page, context, localWorker, localWorker.fixture.reportRich)
  const clipboard = await copyHarness(page, 'success')
  expect(preview.snapshot.attempt).toBeUndefined()
  await expect(stage(page).locator('option')).toHaveText(['全部阶段（9）', '校验（4）', '下载（1）', 'all（1）', 'missing（1）', '未记录阶段（2）'])
  await expect(source(page).locator('option')).toHaveText(['全部来源（9）', 'figma #2（3）', 'figma #1（1）', 'all #1（1）', 'missing · 序号未记录（1）', '未记录来源（1）', 'figma · 序号未记录（1）', '类型未记录 #1（1）'])
  await stage(page).selectOption('["validation"]')
  await source(page).selectOption('["figma",1]')
  await expect(diag(page).getByRole('article').filter({ has: page.getByRole('button', { name: '复制定位信息', exact: true }) })).toHaveCount(5)
  await action(page, 8).click()
  expect((await clipboard.evidence()).writes[0]?.value).toBe(location(preview, 8))
  await action(page, 1, false, '处理失败').click()
  expect((await clipboard.evidence()).writes[1]?.value).toBe(location(preview, 1, 'failed'))
  await source(page).selectOption('["all",0]')
  await expect(diag(page)).toContainText('当前筛选没有匹配的问题')
  await expect(diag(page).getByRole('region', { name: '处理失败记录' }).getByRole('article')).toHaveCount(2)
  await stage(page).selectOption('["all"]')
  await expect(row(page, 3)).toBeVisible()
  await expect(row(page, 0)).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索图标', exact: true }).fill('hidden-gallery')
  await page.getByRole('button', { name: '删除 0', exact: true }).click()
  await expect(row(page, 3)).toBeVisible()
  for (const format of ['JSON', 'HTML']) {
    const pending = page.waitForEvent('download')
    await report(page, format).click()
    const download = await pending
    expect(await download.failure()).toBeNull()
    const path = info.outputPath(`complete-diagnostics.${format.toLowerCase()}`)
    await download.saveAs(path)
    const text = await readFile(path, 'utf8')
    expect(text).not.toMatch(/private-diagnostic|private-config|private-file/)
    if (format === 'JSON') {
      const data = JSON.parse(text)
      expect(data.snapshot).toMatchObject({ id: preview.snapshot.id, attempt: 1 })
      expect(data.diagnostics.failed).toEqual(['shared', 'shared'])
      expect(data.diagnostics.issues).toEqual(preview.content.issues.map(issue => Object.fromEntries(Object.entries(issue).filter(([key]) => ['name', 'message', 'stage', 'sourceType', 'sourceIndex', 'fileKey', 'nodeId'].includes(key)))))
    }
    else {
      expect(text).toContain('Legacy validation')
      expect(text).toContain('Current validation')
      expect(text).toContain('Download failed')
      expect(text).not.toContain('<img data-injected=')
    }
  }
  await page.getByRole('button', { name: '清除诊断筛选' }).click()
  await expect(diag(page).getByLabel('可见诊断计数')).toHaveText('显示 9 / 9 条问题')
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
})

for (const mode of ['missing', 'throw', 'reject'] as const) {
  test(`offers exact readonly fallback and explicit keyboard selection at 390px: ${mode}`, async ({ page, context, localWorker }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const preview = await openLegacy(page, context, localWorker)
    const clipboard = await copyHarness(page, mode)
    await action(page, 3).click()
    await expect(textBox(page)).toHaveValue(location(preview, 3))
    await expect(textBox(page)).toHaveAttribute('readonly', '')
    await expect(page.locator('[data-injected="diagnostics"]')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const before = (await clipboard.evidence()).writes.length
    await action(page, 8, true).click()
    await expect(textBox(page)).toHaveValue(location(preview, 8))
    expect((await clipboard.evidence()).writes.length).toBe(before)
    const selectText = page.getByRole('button', { name: '选择定位文本', exact: true })
    await selectText.focus()
    await page.keyboard.press('Enter')
    await expect(textBox(page)).toBeFocused()
    expect(await textBox(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, location(preview, 8).length])
    await page.screenshot({ path: info.outputPath(`${mode}-manual-390.png`), fullPage: true })
    const failed = await view(page, localWorker.fixture.failedOnly)
    await expect(stage(page)).toHaveCount(0)
    await action(page, 0, true, '处理失败').click()
    await expect(textBox(page)).toHaveValue(location(failed, 0, 'failed'))
    expect(await textBox(page).inputValue()).not.toContain('stage:')
  })
}

for (const success of [true, false]) {
  test(`holds one physical clipboard write across filters and child unmount, late ${success ? 'success' : 'rejection'}`, async ({ page, context, localWorker }) => {
    const first = await openLegacy(page, context, localWorker)
    const clipboard = await copyHarness(page, 'pending')
    await action(page, 0).click()
    await action(page, 1).dispatchEvent('click')
    await stage(page).selectOption('["validation"]')
    await action(page, 8).dispatchEvent('click')
    expect((await clipboard.evidence()).writes).toHaveLength(1)
    await page.getByRole('button', { name: '任务与版本', exact: true }).click()
    await expect(diag(page)).toHaveCount(0)
    await page.getByRole('button', { name: '预览与差异', exact: true }).click()
    const second = await view(page, localWorker.fixture.failedOnly)
    await expect(action(page, 0, false, '处理失败')).toBeDisabled()
    await action(page, 0, false, '处理失败').dispatchEvent('click')
    await action(page, 0, true, '处理失败').click()
    await expect(textBox(page)).toHaveValue(location(second, 0, 'failed'))
    await page.getByLabel('比较基准', { exact: true }).focus()
    await clipboard.settle(0, success)
    await expect(action(page, 0, false, '处理失败')).toBeEnabled()
    await expect(textBox(page)).toHaveValue(location(second, 0, 'failed'))
    await expect(status(page)).not.toContainText('已复制定位信息')
    await expect(page.getByLabel('比较基准', { exact: true })).toBeFocused()
    expect((await clipboard.evidence()).writes[0]?.value).toBe(location(first, 0))
    await clipboard.setMode('success')
    await action(page, 0, false, '处理失败').click()
    await expect(status(page)).toContainText('已复制定位信息')
    expect((await clipboard.evidence()).writes.map(write => write.value)).toEqual([location(first, 0), location(second, 0, 'failed')])
  })
}

test('preserves committed filters on failed review and baseline changes, resets only on a new snapshot', async ({ page, context, localWorker }) => {
  await openLegacy(page, context, localWorker)
  const clipboard = await copyHarness(page, 'success')
  await stage(page).selectOption('["validation"]')
  await source(page).selectOption('["figma",1]')
  await action(page, 0).click()
  const gate = await holdRead(page, localWorker.fixture.failedOnly, true)
  try {
    await select(page).selectOption(localWorker.fixture.failedOnly.id)
    await expect.poll(gate.entered).toBe(true)
    await expect(stage(page)).toHaveValue('["validation"]')
    await expect(row(page, 8)).toBeVisible()
    await expect(stage(page)).toBeDisabled()
    await expect(action(page, 0)).toBeDisabled()
    await expect(action(page, 0, true)).toBeDisabled()
    gate.release()
    await gate.settled
    await expect(page.getByRole('alert', { name: '快照加载失败' })).toBeVisible()
    await expect(action(page, 0)).toBeEnabled()
    await expect(stage(page)).toHaveValue('["validation"]')
  }
  finally {
    gate.release()
    await gate.settled
  }
  const baseline = page.waitForResponse(`**/api/snapshots/${localWorker.fixture.rich.id}?compareTo=release`)
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  expect((await baseline).status()).toBe(200)
  await expect(stage(page)).toHaveValue('["validation"]')
  await expect(source(page)).toHaveValue('["figma",1]')
  await expect(status(page)).not.toContainText('已复制定位信息')
  expect((await clipboard.evidence()).writes).toHaveLength(1)
  await view(page, localWorker.fixture.failedOnly)
  await view(page, localWorker.fixture.rich)
  await expect(stage(page)).toHaveValue('')
  await expect(source(page)).toHaveValue('')
})

test('reverse late review response cannot replace current diagnostics or focus', async ({ page, context, localWorker }) => {
  await openLegacy(page, context, localWorker)
  await copyHarness(page, 'success')
  await stage(page).selectOption('["validation"]')
  const gate = await holdRead(page, localWorker.fixture.failedOnly)
  try {
    await select(page).selectOption(localWorker.fixture.failedOnly.id)
    await expect.poll(gate.entered).toBe(true)
    await select(page).selectOption(localWorker.fixture.rich.id)
    await expect(action(page, 0)).toBeEnabled()
    await stage(page).focus()
    gate.release()
    await gate.settled
    await expect(select(page)).toHaveValue(localWorker.fixture.rich.id)
    await expect(stage(page)).toHaveValue('["validation"]')
    await expect(stage(page)).toBeFocused()
    await expect(row(page, 8)).toBeVisible()
  }
  finally {
    gate.release()
    await gate.settled
  }
})

for (const success of [true, false]) {
  test(`pagehide prevents DOM and focus updates after native late ${success ? 'success' : 'rejection'}`, async ({ page, context, localWorker }, info) => {
    await openLegacy(page, context, localWorker)
    const clipboard = await copyHarness(page, 'pending')
    await action(page, 0).click()
    await stage(page).focus()
    await page.evaluate(async () => {
      dispatchEvent(new PageTransitionEvent('pagehide'))
      // Let pagehide's own invalidation flush before measuring the later
      // clipboard settlement; it must not be confused with that callback.
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
      const evidence = { mutations: 0, focus: document.activeElement }
      Object.assign(window, { disposalEvidence: evidence })
      new MutationObserver(records => evidence.mutations += records.length).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    })
    await clipboard.settle(0, success)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))))
    const evidence = await page.evaluate(() => {
      const evidence = (window as unknown as { disposalEvidence: { mutations: number, focus: Element | null } }).disposalEvidence
      return { mutations: evidence.mutations, focusPreserved: evidence.focus === document.activeElement }
    })
    expect(evidence).toEqual({ mutations: 0, focusPreserved: true })
    await writeFile(info.outputPath('pagehide-evidence.json'), JSON.stringify(evidence, null, 2))
  })
}

test('invalid recorded attempt is visible but cannot be copied while missing job and legacy attempt remain usable', async ({ page, context, localWorker }) => {
  const legacy = await openLegacy(page, context, localWorker)
  const clipboard = await copyHarness(page, 'success')
  await action(page, 0).click()
  expect((await clipboard.evidence()).writes[0]?.value).toBe(location(legacy, 0))
  const invalid = await view(page, localWorker.fixture.invalid)
  expect(invalid.snapshot.attempt).toBe(0)
  await expect(diag(page)).toContainText('快照尝试编号无效，无法复制定位信息')
  await expect(action(page, 0)).toBeDisabled()
  await expect(action(page, 0, true)).toBeDisabled()
  await action(page, 0).dispatchEvent('click')
  expect((await clipboard.evidence()).writes).toHaveLength(1)
})

test('late current rejection and actual workspace refresh preserve user focus and diagnostics filters', async ({ page, context, localWorker }) => {
  const preview = await openLegacy(page, context, localWorker)
  const clipboard = await copyHarness(page, 'pending')
  await stage(page).selectOption('["validation"]')
  await source(page).selectOption('["figma",1]')
  await action(page, 8).click()
  const search = page.getByRole('textbox', { name: '搜索图标', exact: true })
  await search.focus()
  await clipboard.settle(0, false)
  await expect(textBox(page)).toHaveValue(location(preview, 8))
  await expect(search).toBeFocused()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  let done!: () => void
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  await page.route(`${localWorker.origin}/api/state`, async (route) => {
    const response = await route.fetch()
    entered = true
    await gate
    try {
      await route.fulfill({ response })
    }
    finally { done() }
  }, { times: 1 })
  try {
    await page.getByRole('button', { name: '重新读取工作空间', exact: true }).click()
    await expect.poll(() => entered).toBe(true)
    await search.focus()
    release()
    await settled
    await expect(search).toBeFocused()
    await expect(stage(page)).toHaveValue('["validation"]')
    await expect(source(page)).toHaveValue('["figma",1]')
    await expect(row(page, 8)).toBeVisible()
    expect((await clipboard.evidence()).writes).toHaveLength(1)
  }
  finally {
    release()
    await settled
  }
})

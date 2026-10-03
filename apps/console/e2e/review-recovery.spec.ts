import type { ConsoleState, Job, Project, Release, ReleasePreview, Snapshot } from '@iconctl/console-contracts'
import type { APIRequestContext, BrowserContext, Page, Route } from '@playwright/test'
import { createWorkerTest, expect } from './local-worker'

interface RecoveryFixture {
  project: Project
  otherProject: Project
  snapshots: [Snapshot, Snapshot, Snapshot]
  otherSnapshot: Snapshot
  release: Release
  session: { token: string, csrf: string, expiresAt: number }
  appOrigin: string
}
const test = createWorkerTest<RecoveryFixture>('review-recovery')
interface Worker {
  origin: string
  fixture: RecoveryFixture
}

async function proxy(route: Route, worker: Worker) {
  const url = new URL(route.request().url())
  return route.fetch({
    url: `${worker.origin}${url.pathname}${url.search}`,
    headers: { ...await route.request().allHeaders(), origin: worker.fixture.appOrigin },
  })
}

async function openReview(page: Page, context: BrowserContext, worker: Worker) {
  await context.route(`${worker.fixture.appOrigin}/**`, async route => route.fulfill({ response: await proxy(route, worker) }))
  await context.addCookies([{
    name: '__Host-iconctl-session',
    value: worker.fixture.session.token,
    domain: new URL(worker.fixture.appOrigin).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
  await page.goto(`${worker.fixture.appOrigin}/app/`)
  await page.getByLabel('当前项目', { exact: true }).selectOption(worker.fixture.project.id)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await page.getByLabel('选择快照', { exact: true }).selectOption(worker.fixture.snapshots[1].id)
  await expect(page.getByRole('img', { name: 'added 之后', exact: true })).toBeVisible()
}

async function confirmation(page: Page, trigger = '查看发布确认') {
  const response = page.waitForResponse('**/release/preview')
  await page.getByRole('button', { name: trigger, exact: true }).click()
  const preview = await (await response).json() as ReleasePreview
  await expect(page.getByRole('dialog', { name: '发布确认' }).getByRole('button', { name: `确认发布 ${preview.release.version}`, exact: true })).toBeEnabled()
  return preview
}

async function control(request: APIRequestContext, worker: Worker, action: string, extra: Record<string, unknown> = {}) {
  const response = await request.post(`${worker.origin}/__fixtures/review-recovery/control`, {
    data: { action, projectId: worker.fixture.project.id, ...extra },
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function state(request: APIRequestContext, worker: Worker) {
  const response = await request.get(`${worker.origin}/api/state`, { headers: { cookie: `__Host-iconctl-session=${worker.fixture.session.token}` } })
  expect(response.ok()).toBe(true)
  return await response.json() as ConsoleState
}

test.afterEach(async ({ localWorker, page }) => {
  expect(localWorker.unexpectedRequests).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const action of ['expire', 'remove', 'baseline'] as const) {
  test(`requires a fresh explicit confirmation after real Worker ${action}`, async ({ page, context, request, localWorker }) => {
    await openReview(page, context, localWorker)
    const original = await confirmation(page)
    const keys: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/release/confirm')) {
        keys.push(request.headers()['idempotency-key']!)
      }
    })
    await control(request, localWorker, action, { confirmationId: original.id, snapshotId: localWorker.fixture.snapshots[1].id })
    const dialog = page.getByRole('dialog', { name: '发布确认' })
    await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
    await expect(dialog.getByRole('alert', { name: '发布失败' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('发布累计差异', { exact: true })).toHaveText('新增 1 · 修改 0 · 删除 1')
    expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(0)
    const fresh = await confirmation(page, '重新获取发布确认')
    expect(fresh.id).not.toBe(original.id)
    expect(fresh.release.version).toBe(action === 'baseline' ? '1.1.1' : '1.0.1')
    if (action === 'baseline') {
      await expect(dialog.getByLabel('发布累计差异', { exact: true })).toHaveText('新增 0 · 修改 0 · 删除 0')
    }
    expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(0)
    const published = page.waitForResponse('**/release/confirm')
    await dialog.getByRole('button', { name: `确认发布 ${fresh.release.version}`, exact: true }).click()
    const job = await (await published).json() as Job
    await expect(page.locator(`#job-${job.id}`)).toBeFocused()
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(1)
  })
}

test('requires a new matching-revision snapshot before replacing a stale confirmation', async ({ page, context, request, localWorker }) => {
  await openReview(page, context, localWorker)
  await confirmation(page)
  await control(request, localWorker, 'revision')
  const dialog = page.getByRole('dialog', { name: '发布确认' })
  await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
  await expect(dialog.getByRole('alert', { name: '发布失败' })).toContainText('Release confirmation is stale')
  await dialog.getByRole('button', { name: '重新获取发布确认', exact: true }).click()
  await expect(dialog.getByRole('alert', { name: '发布失败' })).toContainText('Project configuration changed; generate a new snapshot')
  await expect(dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true })).toBeDisabled()
  expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(0)
  await dialog.getByRole('button', { name: '返回审核', exact: true }).click()
  const { snapshot } = await control(request, localWorker, 'snapshot') as { snapshot: Snapshot }
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  const refreshed = page.waitForResponse('**/api/state')
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await refreshed
  await page.locator(`#job-${snapshot.jobId}`).getByRole('button', { name: '查看快照', exact: true }).click()
  await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(snapshot.id)
  const fresh = await confirmation(page)
  expect(fresh.revision).toBe(2)
  expect(fresh.release.snapshotId).toBe(snapshot.id)
  const published = page.waitForResponse('**/release/confirm')
  await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
  expect((await published).status()).toBe(202)
  expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(1)
})

test('retries a lost real Worker response with the same key and exactly one publish job after refresh', async ({ page, context, request, localWorker }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.install()
  await openReview(page, context, localWorker)
  const original = await confirmation(page)
  const submissions: { key: string, job: Job, confirmationId: string }[] = []
  await page.route('**/release/confirm', async (route) => {
    const response = await proxy(route, localWorker)
    expect(response.status()).toBe(202)
    submissions.push({ key: route.request().headers()['idempotency-key']!, job: await response.json() as Job, confirmationId: route.request().postDataJSON().confirmationId })
    if (submissions.length === 1) {
      return route.abort('connectionreset')
    }
    return route.fulfill({ response })
  })
  const dialog = page.getByRole('dialog', { name: '发布确认' })
  await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
  await expect(dialog.getByRole('alert', { name: '发布失败' })).toBeVisible()
  await expect(dialog.getByLabel('发布累计差异', { exact: true })).toHaveText('新增 1 · 修改 0 · 删除 1')
  expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(1)
  const refreshed = page.waitForResponse('**/api/state')
  await page.clock.fastForward(10_000)
  await refreshed
  await expect(dialog.getByRole('button', { name: '重试发布请求', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('publication-retry-mobile.png'), fullPage: true })
  await dialog.getByRole('button', { name: '重试发布请求', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(`#job-${submissions[0]!.job.id}`)).toBeFocused()
  expect(submissions).toHaveLength(2)
  expect(submissions[0]!.key).toBeTruthy()
  expect(submissions[1]!.key).toBe(submissions[0]!.key)
  expect(submissions.map(item => item.confirmationId)).toEqual([original.id, original.id])
  expect(submissions[1]!.job.id).toBe(submissions[0]!.job.id)
  expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(1)
})

for (const navigation of ['close', 'project'] as const) {
  test(`records a late successful publication after ${navigation} without stealing navigation or focus`, async ({ page, context, request, localWorker }) => {
    await openReview(page, context, localWorker)
    await confirmation(page)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let created: Job | undefined
    await page.route('**/release/confirm', async (route) => {
      const response = await proxy(route, localWorker)
      expect(response.status()).toBe(202)
      created = await response.json() as Job
      await gate
      await route.fulfill({ response })
    })
    const dialog = page.getByRole('dialog', { name: '发布确认' })
    await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
    await expect.poll(() => created?.id).toBeTruthy()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    if (navigation === 'project') {
      await page.getByLabel('当前项目', { exact: true }).selectOption(localWorker.fixture.otherProject.id)
    }
    const search = page.getByLabel('搜索图标', { exact: true })
    await search.fill('keep my focus')
    release()
    const locate = page.getByRole('button', { name: '定位发布任务', exact: true })
    await expect(locate).toBeVisible()
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('keep my focus')
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(navigation === 'project' ? localWorker.fixture.otherProject.id : localWorker.fixture.project.id)
    expect((await state(request, localWorker)).jobs.filter(job => job.operation === 'publish')).toHaveLength(1)
    await locate.click()
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(localWorker.fixture.project.id)
    await expect(page.locator(`#job-${created!.id}`)).toBeFocused()
  })
}

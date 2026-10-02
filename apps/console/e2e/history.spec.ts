import type { Job, Project, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import { createWorkerTest, expect } from './local-worker'

interface HistoryFixture {
  project: Project
  job: Job
  failedSnapshot: Snapshot
  session: { token: string }
}
const test = createWorkerTest<HistoryFixture>('history')

test('reviews the failed attempt and its original diagnostics after a successful retry through the real Worker', async ({ page, context, request, localWorker }, testInfo) => {
  const { origin, fixture, unexpectedRequests } = localWorker
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.addCookies([{
    name: '__Host-iconctl-session',
    value: fixture.session.token,
    domain: new URL(origin).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
  await page.goto(`${origin}/app/?job=${fixture.job.id}`)
  const row = page.locator(`#job-${fixture.job.id}`)
  await expect(row).toContainText('失败')
  const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/jobs/${fixture.job.id}/retry`)
  await row.getByRole('button', { name: '重试', exact: true }).click()
  expect((await retryResponse).status()).toBe(202)
  const completedResponse = await request.post(`${origin}/__fixtures/history/complete-retry`, { data: { jobId: fixture.job.id } })
  expect(completedResponse.ok()).toBe(true)
  const completed = await completedResponse.json() as { job: Job, snapshot: Snapshot }
  expect(completed.job).toMatchObject({ attempt: 2, status: 'succeeded' })
  await page.getByRole('button', { name: '刷新状态' }).click()
  await expect(row).toContainText('已完成')
  await row.getByText('尝试与快照', { exact: true }).click()
  await expect(row.getByRole('button', { name: '查看第 1 次快照', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: '查看第 2 次快照', exact: true })).toBeVisible()
  await expect(row.getByText('旧阶段记录（未记录尝试号）', { exact: true })).toBeVisible()

  const failedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${fixture.failedSnapshot.id}`)
  await row.getByRole('button', { name: '查看第 1 次快照', exact: true }).click()
  const failed = await (await failedResponse).json() as SnapshotPreview
  expect(failed.snapshot.id).toBe(fixture.failedSnapshot.id)
  expect(failed.snapshot.attempt).toBeUndefined()
  expect(failed.content.issues[0]).toMatchObject({ stage: 'validate', sourceIndex: 0, sourceType: 'figma', fileKey: 'AbCdEf123456', nodeId: '12:34' })
  const diagnostics = page.getByLabel('快照诊断')
  await expect(diagnostics).toContainText('Expected width 24; received 16')
  await expect(diagnostics).toContainText(/来源：\s*figma\s*#1/)
  await expect(diagnostics).toContainText(/figma/i)
  await expect(diagnostics).toContainText(/validate|校验/)
  await expect(diagnostics).toContainText('legacy-icon')
  await expect(diagnostics).toContainText('Legacy validation message')
  const figma = diagnostics.getByRole('link', { name: '在 Figma 中定位' })
  const location = new URL((await figma.getAttribute('href'))!)
  expect(location.origin).toBe('https://www.figma.com')
  expect(location.pathname).toContain('AbCdEf123456')
  expect(location.searchParams.get('node-id')).toMatch(/^12[:-]34$/)
  await expect(figma).toHaveAttribute('rel', /noopener/)
  await page.screenshot({ path: testInfo.outputPath('failed-attempt-diagnostics.png'), fullPage: true })

  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await row.getByText('尝试与快照', { exact: true }).click()
  const successResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${completed.snapshot.id}`)
  await row.getByRole('button', { name: '查看第 2 次快照', exact: true }).click()
  const success = await (await successResponse).json() as SnapshotPreview
  expect(success.snapshot).toMatchObject({ id: completed.snapshot.id, attempt: 2, issues: 0 })
  expect(success.content.issues).toEqual([])
  await expect(page.getByText('Expected width 24; received 16')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'arrow-left 之后' })).toBeVisible()
  expect(unexpectedRequests).toEqual([])
  expect(errors).toEqual([])
})

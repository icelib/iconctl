import type { ConsoleState, Job, Project, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import { writeFile } from 'node:fs/promises'
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
  const snapshotOrigin = page.getByRole('region', { name: '快照来源', exact: true })
  await expect(snapshotOrigin).toContainText(fixture.project.name)
  await expect(snapshotOrigin).toContainText(fixture.job.id)
  await expect(snapshotOrigin).toContainText('第 1 次尝试')
  await expect(snapshotOrigin).toContainText(`配置 v${fixture.job.project.revision}`)
  await expect(snapshotOrigin.getByRole('link', { name: fixture.job.sourceCommit, exact: true })).toHaveAttribute('href', `https://github.com/${fixture.job.project.repository}/commit/${fixture.job.sourceCommit}`)
  await expect(snapshotOrigin.getByRole('link', { name: 'Run 101 · 执行 1 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/icons/actions/runs/101/attempts/1')
  await expect(snapshotOrigin.getByRole('link', { name: /Run 202/ })).toHaveCount(0)
  const sourceRecords = page.getByRole('region', { name: '快照来源记录', exact: true })
  await expect(sourceRecords).toContainText('来源 1')
  await expect(sourceRecords).toContainText('figma')
  await expect(sourceRecords).toContainText('AbCdEf123456')
  await expect(sourceRecords).toContainText('已读取')
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

  await snapshotOrigin.getByRole('button', { name: '定位生成任务', exact: true }).click()
  const firstAttempt = row.getByRole('region', { name: '第 1 次尝试', exact: true })
  await expect(firstAttempt).toBeVisible()
  await expect(firstAttempt).toBeFocused()
  await expect(firstAttempt.getByRole('button', { name: '查看第 1 次快照', exact: true })).toBeVisible()
  const refresh = page.getByRole('button', { name: '刷新状态', exact: true })
  const search = page.getByLabel('搜索任务', { exact: true })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let refreshedJob: Job | undefined
  await page.route(`${origin}/api/state`, async (route) => {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const state = await response.json() as ConsoleState
    refreshedJob = state.jobs.find(job => job.id === fixture.job.id)
    expect(refreshedJob).toMatchObject({ id: fixture.job.id, attempt: 2, status: 'succeeded' })
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  try {
    const refreshed = page.waitForResponse(`${origin}/api/state`)
    await refresh.click()
    await expect.poll(() => refreshedJob?.attempt).toBe(2)
    await expect(refresh).toBeDisabled()
    // Native disabled buttons relinquish focus; the completed real read must
    // preserve the user's newer focus and keep the selected attempt expanded.
    await search.focus()
    release()
    await (await refreshed).finished()
    await expect(refresh).toBeEnabled()
    await expect(search).toBeFocused()
    await expect(row.locator('details')).toHaveAttribute('open', '')
    await expect(firstAttempt).toBeVisible()
    await writeFile(testInfo.outputPath('history-refresh-evidence.json'), JSON.stringify({
      response: { status: 200, jobId: refreshedJob!.id, attempt: refreshedJob!.attempt, jobStatus: refreshedJob!.status },
      focus: 'search',
      attemptExpanded: true,
    }, null, 2))
  }
  finally {
    release()
    await page.unroute(`${origin}/api/state`)
  }
  const successResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${completed.snapshot.id}`)
  await row.getByRole('button', { name: '查看第 2 次快照', exact: true }).click()
  const success = await (await successResponse).json() as SnapshotPreview
  expect(success.snapshot).toMatchObject({ id: completed.snapshot.id, attempt: 2, issues: 0 })
  expect(success.content.issues).toEqual([])
  await expect(snapshotOrigin).toContainText('第 2 次尝试')
  await expect(snapshotOrigin.getByRole('link', { name: 'Run 202 · 执行 2 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/icons/actions/runs/202/attempts/2')
  await expect(snapshotOrigin.getByRole('link', { name: /Run 101/ })).toHaveCount(0)
  await expect(page.getByText('Expected width 24; received 16')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'arrow-left 之后' })).toBeVisible()
  await snapshotOrigin.getByRole('button', { name: '定位生成任务', exact: true }).click()
  await expect(row.getByRole('region', { name: '第 2 次尝试', exact: true })).toBeFocused()
  expect(unexpectedRequests).toEqual([])
  expect(errors).toEqual([])
})

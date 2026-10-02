import type { ReleasePreview, SnapshotPreview } from '@iconctl/console-contracts'
import { expect, test } from './local-worker'

test('compares a later unchanged sync with its published baseline through the real Worker', async ({ page, context, localWorker }, testInfo) => {
  const { origin, fixture, unexpectedRequests } = localWorker
  const [published, previous, current] = fixture.snapshots
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

  await page.goto(`${origin}/app/`)
  await page.getByRole('button', { name: '预览与差异' }).click()
  const defaultResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${current.id}`)
  await page.getByLabel('选择快照').selectOption(current.id)
  const initial = await (await defaultResponse).json() as SnapshotPreview
  expect(initial.comparison).toMatchObject({ mode: 'previous', snapshot: { id: previous.id } })
  expect(initial.diff).toEqual({ added: [], changed: [], removed: [] })
  await expect(page.getByRole('button', { name: '删除 0', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'removed 之前' })).toHaveCount(0)

  const releasedResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('compareTo') === 'release')
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  const compared = await (await releasedResponse).json() as SnapshotPreview
  expect(compared.comparison).toMatchObject({ mode: 'release', snapshot: { id: published.id }, release: { id: fixture.release.id } })
  expect(compared.diff.removed).toEqual(['removed'])
  await expect(page.getByRole('button', { name: '删除 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除 1', exact: true }).click()
  await expect(page.getByRole('img', { name: 'removed 之前' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'removed 之后' })).toHaveCount(0)

  // Publication must retain its server-selected release baseline even when the
  // browser currently reviews an unchanged pair of synchronization snapshots.
  await page.getByLabel('比较基准', { exact: true }).selectOption('')
  await expect(page.getByRole('button', { name: '删除 0', exact: true })).toBeVisible()
  const confirmationResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/release/preview'))
  await page.getByRole('button', { name: '查看发布确认' }).click()
  const confirmation = await (await confirmationResponse).json() as ReleasePreview
  expect(confirmation.release).toMatchObject({ snapshotId: current.id, baselineReleaseId: fixture.release.id, version: '1.0.1' })
  expect(confirmation.comparison.snapshot?.id).toBe(published.id)
  expect(confirmation.diff.removed).toEqual(['removed'])
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('发布比较基准')).toContainText('v1.0.0')
  await expect(dialog.getByLabel('发布累计差异')).toHaveText('新增 0 · 修改 0 · 删除 1')
  await dialog.getByText('查看将删除的图标', { exact: true }).click()
  await expect(dialog.getByText('removed', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('release-comparison.png'), fullPage: true })
  await dialog.getByRole('button', { name: '返回审核' }).click()
  await expect(dialog).not.toBeVisible()
  expect(unexpectedRequests).toEqual([])
  expect(errors).toEqual([])
})

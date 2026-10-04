import type { Job, SnapshotPreview } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { alpha, answer, beta, test as editorTest, hold, id, mutations } from './editor-fixture'

const historicalProject = { ...alpha, name: 'Frozen design icons', revision: 3, repository: 'fixture/frozen-icons' }
function job(): Job {
  return {
    id: id(811),
    projectId: alpha.id,
    project: structuredClone(historicalProject),
    operation: 'sync',
    status: 'succeeded',
    sourceCommit: 'a'.repeat(40),
    workflowCommit: 'b'.repeat(40),
    executorCommit: 'c'.repeat(40),
    workflowDigest: 'd'.repeat(64),
    createdAt: alpha.createdAt,
    updatedAt: alpha.createdAt + 10_000,
    dispatchAttempts: 2,
    attempt: 2,
    stage: 'complete',
    runId: '202',
    runAttempt: '2',
    snapshotId: id(822),
    events: [
      { at: alpha.createdAt, stage: 'validating', status: 'failed', attempt: 1, runId: '101', runAttempt: '1' },
      { at: alpha.createdAt + 10_000, stage: 'complete', status: 'succeeded', attempt: 2, runId: '202', runAttempt: '2' },
    ],
  }
}
function preview(value: number, attempt: number, name: string): SnapshotPreview {
  return {
    snapshot: { id: id(value), projectId: alpha.id, jobId: id(811), attempt, createdAt: alpha.createdAt + value, digest: 'f'.repeat(64), iconCount: 1, issues: 0 },
    content: { json: { prefix: alpha.prefix, icons: { [name]: { body: '<path d="M0 0h24v24H0z"/>' } }, width: 24, height: 24 }, files: {}, issues: [], failed: [], sources: [] },
    diff: { added: [name], changed: [], removed: [] },
    comparison: { mode: 'previous', snapshot: null, release: null },
  }
}

const test = editorTest.extend<{ originPreviews: SnapshotPreview[] }>({
  originPreviews: async ({ page, editorApi }, use, info) => {
    const previews = [preview(821, 1, 'first-icon'), preview(822, 2, 'second-icon')]
    editorApi.state.projects[0] = { ...alpha, name: 'Current renamed icons', revision: 9, repository: 'fixture/current-icons' }
    editorApi.state.jobs = [job()]
    editorApi.state.snapshots = previews.map(item => item.snapshot)
    const reads: string[] = []
    const failures: string[] = []
    const unexpected: string[] = []
    page.on('requestfailed', request => failures.push(new URL(request.url()).pathname))
    await page.route('**/api/snapshots/*', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      reads.push(path)
      const gate = editorApi.gates.find(item => !item.entered && item.method === request.method() && item.path === path)
      if (gate) {
        gate.entered = true
        gate.transport = request
        return route.fulfill(await gate.promise)
      }
      const item = previews.find(item => path === `/api/snapshots/${item.snapshot.id}`)
      if (!item || request.method() !== 'GET') {
        unexpected.push(`${request.method()} ${path}`)
        return route.fulfill({ status: 500, json: { error: 'Unexpected origin request' } })
      }
      return route.fulfill({ json: structuredClone(item) })
    })
    try {
      await use(previews)
      expect(unexpected).toEqual([])
      expect(mutations(editorApi)).toEqual([])
    }
    finally {
      await writeFile(info.outputPath('snapshot-origin-evidence.json'), JSON.stringify({ reads, failures, unexpected, mutations: mutations(editorApi) }, null, 2))
    }
  },
})

const origin = (page: Page) => page.getByRole('region', { name: '快照来源', exact: true })
const select = (page: Page) => page.getByLabel('选择快照', { exact: true })
async function open(page: Page, snapshot = id(821)) {
  await page.goto('/app/')
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await select(page).selectOption(snapshot)
  await expect(origin(page)).toBeVisible()
}
async function expectFirst(page: Page) {
  await expect(select(page)).toHaveValue(id(821))
  await expect(origin(page)).toContainText('Frozen design icons')
  await expect(origin(page)).toContainText('配置 v3')
  await expect(origin(page)).toContainText('第 1 次尝试')
  await expect(origin(page).getByRole('link', { name: 'Run 101 · 执行 1 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/frozen-icons/actions/runs/101/attempts/1')
  await expect(origin(page).getByRole('link', { name: /Run 202/ })).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'first-icon 之后', exact: true })).toBeVisible()
}

for (const unavailable of ['missing', 'cross-project'] as const) {
  test(`keeps the snapshot review readable with a ${unavailable} source job and restores association on explicit refresh`, async ({ page, editorApi, originPreviews }) => {
    expect(originPreviews).toHaveLength(2)
    editorApi.state.jobs = unavailable === 'missing' ? [] : [{ ...job(), projectId: beta.id, project: beta }]
    await open(page)
    await expect(origin(page)).toContainText('来源任务暂不可用')
    await expect(origin(page)).toContainText(id(811))
    await expect(origin(page).getByRole('button', { name: '定位生成任务', exact: true })).toHaveCount(0)
    await expect(origin(page).getByRole('link')).toHaveCount(0)
    await expect(page.getByRole('img', { name: 'first-icon 之后', exact: true })).toBeVisible()
    editorApi.state.jobs = [job()]
    await origin(page).getByRole('button', { name: '重新读取工作空间', exact: true }).click()
    await expectFirst(page)
    await origin(page).getByRole('button', { name: '定位生成任务', exact: true }).click()
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
    await expect(page.locator(`#job-${id(811)}`).getByRole('region', { name: '第 1 次尝试', exact: true })).toBeFocused()
  })
}

test('retains frozen source metadata when restored records lack the current project and enables locate after refresh', async ({ page, editorApi, originPreviews }, info) => {
  expect(originPreviews).toHaveLength(2)
  editorApi.state.projects = []
  await open(page)
  await expectFirst(page)
  await expect(origin(page)).toContainText('当前工作空间缺少任务所属项目')
  await expect(origin(page).getByRole('button', { name: '定位生成任务', exact: true })).toBeDisabled()
  await page.screenshot({ path: info.outputPath('snapshot-origin-missing-project.png'), fullPage: true })
  editorApi.state.projects = [{ ...alpha, name: 'Restored current icons', revision: 11 }]
  await origin(page).getByRole('button', { name: '重新读取工作空间', exact: true }).click()
  await expect(origin(page).getByRole('button', { name: '定位生成任务', exact: true })).toBeEnabled()
  await expectFirst(page)
  await origin(page).getByRole('button', { name: '定位生成任务', exact: true }).click()
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
  await expect(page.locator(`#job-${id(811)}`).getByRole('region', { name: '第 1 次尝试', exact: true })).toBeFocused()
})

test('keeps the committed origin during pending and failed replacement, and ignores an old attempt response after a newer review', async ({ page, editorApi, originPreviews }) => {
  await open(page)
  await expectFirst(page)
  const pending = hold(editorApi, 'GET', `/api/snapshots/${id(822)}`)
  await select(page).selectOption(id(822))
  await expect.poll(() => pending.entered).toBe(true)
  await expect(page.getByRole('status', { name: '快照加载状态' })).toBeVisible()
  await expectFirst(page)
  await answer(page, pending, { status: 502, json: { error: 'Snapshot storage temporarily unavailable' } })
  await expect(page.getByRole('alert', { name: '快照加载失败' })).toContainText('Snapshot storage temporarily unavailable')
  await expectFirst(page)
  await select(page).selectOption(id(822))
  await expect(origin(page)).toContainText('第 2 次尝试')
  await expect(origin(page).getByRole('link', { name: 'Run 202 · 执行 2 ↗', exact: true })).toBeVisible()
  const old = hold(editorApi, 'GET', `/api/snapshots/${id(821)}`)
  await select(page).selectOption(id(821))
  await expect.poll(() => old.entered).toBe(true)
  await select(page).selectOption(id(822))
  await answer(page, old, { json: originPreviews[0] })
  await expect(select(page)).toHaveValue(id(822))
  await expect(origin(page)).toContainText('第 2 次尝试')
  await expect(origin(page).getByRole('link', { name: /Run 101/ })).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'second-icon 之后', exact: true })).toBeVisible()
})

test('clears task filters only on explicit source location and never reopens or refocuses history on polling', async ({ page, editorApi, originPreviews }) => {
  expect(originPreviews).toHaveLength(2)
  await page.goto('/app/')
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  const search = page.getByLabel('搜索任务', { exact: true })
  await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('failed')
  await page.getByRole('combobox', { name: '任务操作', exact: true }).selectOption('check')
  await search.fill('no-match')
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await select(page).selectOption(id(821))
  await expectFirst(page)
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await expect(search).toHaveValue('no-match')
  await expect(page.getByRole('combobox', { name: '任务状态', exact: true })).toHaveValue('failed')
  await expect(page.getByRole('combobox', { name: '任务操作', exact: true })).toHaveValue('check')
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await select(page).selectOption(id(821))
  await origin(page).getByRole('button', { name: '定位生成任务', exact: true }).click()
  const row = page.locator(`#job-${id(811)}`)
  await expect(search).toHaveValue('')
  await expect(page.getByRole('combobox', { name: '任务状态', exact: true })).toHaveValue('all')
  await expect(page.getByRole('combobox', { name: '任务操作', exact: true })).toHaveValue('all')
  await expect(row.getByRole('region', { name: '第 1 次尝试', exact: true })).toBeFocused()
  await row.getByText('尝试与快照', { exact: true }).click()
  await search.focus()
  const reads = editorApi.stateReads
  editorApi.state.jobs[0]!.updatedAt += 1000
  await page.clock.fastForward(10_000)
  await expect.poll(() => editorApi.stateReads).toBeGreaterThan(reads)
  await expect(search).toBeFocused()
  await expect(row.locator('details')).not.toHaveAttribute('open', '')
  const refresh = page.getByRole('button', { name: '刷新状态', exact: true })
  const manualRead = hold(editorApi, 'GET', '/api/state')
  await refresh.click()
  await expect.poll(() => manualRead.entered).toBe(true)
  await expect(refresh).toBeDisabled()
  await search.focus()
  await answer(page, manualRead, { json: editorApi.state })
  await expect(refresh).toBeEnabled()
  await expect(search).toBeFocused()
  await expect(row.locator('details')).not.toHaveAttribute('open', '')
})

test('shows an honest truncated history and inert hostile values while keyboard location works at 390px', async ({ page, editorApi, originPreviews }, info) => {
  const historical = editorApi.state.jobs[0]!
  historical.project.name = '历史设计项目'.repeat(12)
  historical.project.repository = 'javascript:alert(1)/<img src=x onerror=alert(1)>'.repeat(3)
  historical.sourceCommit = '<script>alert(1)</script>'.repeat(5)
  historical.events = [
    { at: alpha.createdAt, stage: 'validating', status: 'failed', runId: '101', runAttempt: '1' },
    { at: alpha.createdAt + 1, stage: 'complete', status: 'succeeded', attempt: 2, runId: '202', runAttempt: '2' },
  ]
  delete originPreviews[0]!.snapshot.attempt
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await expect(origin(page)).toContainText('第 1 次尝试')
  await expect(origin(page)).toContainText(historical.project.name)
  await expect(origin(page)).toContainText(historical.project.repository)
  await expect(origin(page)).toContainText(historical.sourceCommit)
  await expect(origin(page)).toContainText('未记录对应执行链接；历史阶段可能已截断。')
  await expect(origin(page).getByRole('link')).toHaveCount(0)
  await expect(origin(page).locator('script, img')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('snapshot-origin-mobile-hostile.png'), fullPage: true })
  const locate = origin(page).getByRole('button', { name: '定位生成任务', exact: true })
  await locate.focus()
  await locate.press('Enter')
  const attempt = page.locator(`#job-${id(811)}`).getByRole('region', { name: '第 1 次尝试', exact: true })
  await expect(attempt).toBeFocused()
  await expect(attempt).toContainText('此次尝试没有已记录的阶段。')
  await expect(attempt.getByRole('button', { name: '查看第 1 次快照', exact: true })).toBeVisible()
  await expect(attempt.getByRole('link')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(dialogs).toEqual([])
})

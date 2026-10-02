import type { ConsoleState, Job, JobStatus, Operation, Project, ReleasePreview, SnapshotPreview } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'

function id(value: number) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

const project: Project = {
  id: id(101),
  name: 'brand-icons',
  prefix: 'brand',
  packageName: '@icelib/brand-icons-test',
  repository: 'icelib/iconctl',
  repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
  createdAt: 1_790_000_000_000,
  revision: 1,
  sources: [{ type: 'directory', dir: 'raw' }],
  color: 'currentColor',
  validate: { skipPrefix: ['_', '.'] },
  output: { svg: true, types: true, preview: true, changelog: true },
}
const otherProject = { ...project, id: id(102), name: 'other-icons' }
const emptyProject = { ...project, id: id(103), name: 'empty-icons' }

function job(value: number, status: JobStatus, operation: Operation, extra: Partial<Job> = {}): Job {
  return {
    id: id(value),
    projectId: project.id,
    project,
    operation,
    status,
    sourceCommit: 'a'.repeat(40),
    workflowCommit: 'b'.repeat(40),
    executorCommit: 'c'.repeat(40),
    workflowDigest: 'd'.repeat(64),
    createdAt: project.createdAt + value * 1000,
    updatedAt: project.createdAt + value * 1000,
    dispatchAttempts: 1,
    attempt: 1,
    stage: status === 'succeeded' ? 'complete' : 'validating',
    ...extra,
  }
}

const snapshot: SnapshotPreview = {
  snapshot: { id: id(201), projectId: project.id, jobId: id(3), attempt: 1, createdAt: project.createdAt, digest: 'd'.repeat(64), iconCount: 1, issues: 0 },
  content: {
    json: { prefix: 'brand', width: 24, height: 24, icons: { home: { body: '<path d="M0 0h24v24H0z"/>' } } },
    files: {},
    issues: [],
    failed: [],
    sources: [],
  },
  diff: { added: ['home'], changed: [], removed: [] },
  comparison: { mode: 'previous', snapshot: null, release: null },
}
const confirmation: ReleasePreview = {
  id: id(202),
  projectId: project.id,
  revision: 1,
  expiresAt: project.createdAt + 60_000,
  packageName: project.packageName,
  iconCount: 1,
  release: { snapshotId: snapshot.snapshot.id, digest: snapshot.snapshot.digest, version: '0.2.0', branchHead: null, confirmation: id(202) },
  comparison: { mode: 'release', snapshot: null, release: null },
  diff: { added: ['home'], changed: [], removed: [] },
}

type Mutation = 'create' | 'retry' | 'publish'
type Reply = { job: Job } | { error: string, status: number }
interface ConsoleApi {
  state: ConsoleState
  replies: Record<Mutation, Reply[]>
  requests: { type: Mutation, path: string, body: unknown }[]
  reads: number
  deferredState?: { snapshot: ConsoleState, release: Promise<void> }
}

const test = base.extend<{ consoleApi: ConsoleApi }>({
  consoleApi: async ({ page }, use) => {
    const api: ConsoleApi = {
      state: {
        projects: structuredClone([project, otherProject, emptyProject]),
        jobs: [
          job(1, 'queued', 'sync', { stage: 'dispatching' }),
          job(2, 'running', 'sync', { stage: 'fetching', runId: '741852', sourceCommit: `${'abcdef'.repeat(6)}abcd` }),
          job(3, 'succeeded', 'preview', { snapshotId: snapshot.snapshot.id }),
          job(4, 'failed', 'sync', { error: 'Token [literal].* (MiXeD) <tag>' }),
          job(5, 'failed', 'dry-run', { error: 'Dry candidate' }),
          job(6, 'reconciling', 'publish', { stage: 'publishing' }),
          job(7, 'succeeded', 'check'),
          job(8, 'failed', 'sync', { projectId: otherProject.id, project: otherProject, error: 'Token [literal].* (MiXeD) <tag>' }),
        ],
        snapshots: [snapshot.snapshot],
        releases: [{ id: id(301), projectId: project.id, jobId: id(3), snapshotId: snapshot.snapshot.id, version: '0.1.0', packageName: project.packageName, integrity: 'sha512-test', commit: 'a'.repeat(40), createdAt: project.createdAt, url: 'https://www.npmjs.com/package/@icelib/brand-icons-test/v/0.1.0' }],
        connections: [],
        pairings: [],
        devices: [],
      },
      replies: { create: [], retry: [], publish: [] },
      requests: [],
      reads: 0,
    }
    const errors: string[] = []
    const unexpected: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/session') {
        return route.fulfill({ json: { csrf: 'task-filter-csrf' } })
      }
      if (path === '/api/state') {
        api.reads++
        const deferred = api.deferredState
        delete api.deferredState
        if (deferred) {
          await deferred.release
          return route.fulfill({ json: deferred.snapshot })
        }
        return route.fulfill({ json: api.state })
      }
      if (path === `/api/snapshots/${snapshot.snapshot.id}`) {
        return route.fulfill({ json: snapshot })
      }
      if (path === `/api/projects/${project.id}/release/preview`) {
        expect(request.postDataJSON()).toEqual({ snapshotId: snapshot.snapshot.id, bump: 'patch' })
        return route.fulfill({ json: confirmation })
      }
      const type: Mutation | undefined = path === `/api/projects/${project.id}/jobs`
        ? 'create'
        : path === `/api/jobs/${id(4)}/retry`
          ? 'retry'
          : path === `/api/projects/${project.id}/release/confirm` ? 'publish' : undefined
      if (type) {
        expect(request.method()).toBe('POST')
        expect(request.headers()['x-csrf-token']).toBe('task-filter-csrf')
        const body = request.postDataJSON()
        api.requests.push({ type, path, body })
        const reply = api.replies[type].shift()
        expect(reply, `Unexpected ${type} mutation`).toBeDefined()
        if (!reply) {
          return route.fulfill({ status: 500, json: { error: 'No fixture response' } })
        }
        if ('error' in reply) {
          return route.fulfill({ status: reply.status, json: { error: reply.error } })
        }
        if (type === 'create') {
          expect(body).toEqual({ operation: reply.job.operation })
        }
        else if (type === 'publish') {
          expect(body).toEqual({ confirmationId: confirmation.id })
        }
        else {
          expect(body).toEqual({})
        }
        api.state.jobs = [reply.job, ...api.state.jobs.filter(item => item.id !== reply.job.id)]
        return route.fulfill({ status: 202, json: reply.job })
      }
      unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 404, json: { error: 'Unexpected request' } })
    })
    await use(api)
    expect(errors).toEqual([])
    expect(unexpected).toEqual([])
  },
})

async function history(page: Page) {
  await page.goto('/app/')
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
}

async function filters(page: Page, status = 'all', operation = 'all', query = '') {
  await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption(status)
  await page.getByRole('combobox', { name: '任务操作', exact: true }).selectOption(operation)
  await page.getByLabel('搜索任务', { exact: true }).fill(query)
}

async function expectFilters(page: Page, status = 'all', operation = 'all', query = '') {
  await expect(page.getByRole('combobox', { name: '任务状态', exact: true })).toHaveValue(status)
  await expect(page.getByRole('combobox', { name: '任务操作', exact: true })).toHaveValue(operation)
  await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue(query)
}

async function rows(page: Page, expected: number[], total = 7) {
  const visible = page.locator('tr[id^="job-"]')
  await expect(visible).toHaveCount(expected.length)
  await expect.poll(async () => (await visible.evaluateAll(elements => elements.map(element => element.id))).sort()).toEqual(expected.map(value => `job-${id(value)}`).sort())
  await expect(page.getByLabel('任务筛选结果', { exact: true })).toHaveText(`匹配 ${expected.length} / 当前项目 ${total}`)
}

test('intersects status, operation and trimmed literal search across task fields and labels', async ({ page, consoleApi }) => {
  expect(consoleApi.state.jobs).toHaveLength(8)
  await history(page)
  await rows(page, [1, 2, 3, 4, 5, 6, 7])
  await filters(page, 'failed', 'sync', '  [LiTeRaL].*  ')
  await rows(page, [4])
  await filters(page, 'failed', 'dry-run', '[literal].*')
  await rows(page, [])
  await expect(page.getByText('没有匹配的任务。调整条件或清除任务筛选。', { exact: true })).toBeVisible()
  await filters(page, 'reconciling', 'publish')
  await rows(page, [6])
  for (const [query, expected] of [
    [id(7), [7]],
    ['ABCDEFAB', [2]],
    ['741852', [2]],
    [' FETCHING ', [2]],
    ['抓取来源', [2]],
    ['失败', [4, 5]],
    ['仅校验', [7]],
    ['<tag>', [4]],
    ['(mixed)', [4]],
  ] as const) {
    await filters(page, 'all', 'all', query)
    await rows(page, [...expected])
  }
  await page.getByRole('button', { name: '清除任务筛选', exact: true }).click()
  await expectFilters(page)
  await rows(page, [1, 2, 3, 4, 5, 6, 7])
})

test('resets filters on project changes and distinguishes an empty project from no matches', async ({ page, consoleApi }) => {
  expect(consoleApi.state.projects).toHaveLength(3)
  await history(page)
  await filters(page, 'failed', 'sync', 'absent')
  await rows(page, [])
  await expect(page.getByRole('link', { name: 'npm ↗', exact: true })).toHaveAttribute('href', consoleApi.state.releases[0]!.url)
  await page.getByLabel('当前项目', { exact: true }).selectOption(otherProject.id)
  await expectFilters(page)
  await rows(page, [8], 1)
  await filters(page, 'running', 'check', 'absent')
  await page.getByLabel('当前项目', { exact: true }).selectOption(emptyProject.id)
  await expectFilters(page)
  await rows(page, [], 0)
  await expect(page.getByText('还没有任务。从项目配置中发起一次同步。', { exact: true })).toBeVisible()
  await expect(page.getByText('没有匹配的任务。调整条件或清除任务筛选。', { exact: true })).toHaveCount(0)
  await page.getByLabel('当前项目', { exact: true }).selectOption(project.id)
  await rows(page, [1, 2, 3, 4, 5, 6, 7])
})

test('searches and displays arbitrary stage names without resolving inherited object properties', async ({ page, consoleApi }) => {
  const stages = ['constructor', '__proto__', 'toString', 'custom-stage']
  for (const [index, stage] of stages.entries()) {
    consoleApi.state.jobs[index]!.stage = stage
  }
  await history(page)
  await filters(page, 'all', 'all', 'not-a-task-field')
  await rows(page, [])
  for (const [index, stage] of stages.entries()) {
    for (const query of [stage.toUpperCase(), stage.toLowerCase()]) {
      await page.getByLabel('搜索任务', { exact: true }).fill(query)
      await rows(page, [index + 1])
      await expect(page.locator(`#job-${id(index + 1)}`).getByRole('cell').nth(2)).toContainText(stage)
    }
  }
})

test('preserves filters and input focus as polling changes an active task, and on manual refresh', async ({ page, consoleApi }) => {
  await page.clock.install()
  await history(page)
  await filters(page, 'running', 'sync', ' FETCHING ')
  await rows(page, [2])
  const search = page.getByLabel('搜索任务', { exact: true })
  await search.focus()
  const reads = consoleApi.reads
  consoleApi.state.jobs = consoleApi.state.jobs.map(item => item.id === id(2) ? { ...item, status: 'succeeded', stage: 'complete' } : item)
  await page.clock.fastForward(10_000)
  await expect.poll(() => consoleApi.reads).toBeGreaterThan(reads)
  await rows(page, [])
  await expectFilters(page, 'running', 'sync', ' FETCHING ')
  await expect(search).toBeFocused()
  const refresh = page.getByRole('button', { name: '刷新状态', exact: true })
  const refreshed = page.waitForResponse('**/api/state')
  await refresh.click()
  await (await refreshed).finished()
  await expectFilters(page, 'running', 'sync', ' FETCHING ')
  await expect(page.locator('tr[id^="job-"]:focus')).toHaveCount(0)
})

test('locates a cross-project task once and restores it explicitly after filters or project changes hide it', async ({ page, consoleApi }) => {
  await page.clock.install()
  await page.goto(`/app/?job=${id(8)}`)
  const linked = page.locator(`#job-${id(8)}`)
  await expect(linked).toBeFocused()
  await expect(linked).toHaveClass(/linked-job/)
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(otherProject.id)
  await filters(page, 'running', 'preview', 'not-found')
  await rows(page, [], 1)
  const search = page.getByLabel('搜索任务', { exact: true })
  await search.focus()
  const reads = consoleApi.reads
  await page.clock.fastForward(10_000)
  await expect.poll(() => consoleApi.reads).toBeGreaterThan(reads)
  await expect(search).toBeFocused()
  await expectFilters(page, 'running', 'preview', 'not-found')
  await page.getByRole('button', { name: '定位链接任务', exact: true }).click()
  await expectFilters(page)
  await expect(linked).toBeFocused()

  await page.getByLabel('当前项目', { exact: true }).selectOption(project.id)
  await filters(page, 'failed', 'sync', 'Token')
  const refreshed = page.waitForResponse('**/api/state')
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await (await refreshed).finished()
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(project.id)
  await expectFilters(page, 'failed', 'sync', 'Token')
  await rows(page, [4])
  await page.getByRole('button', { name: '定位链接任务', exact: true }).click()
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(otherProject.id)
  await expectFilters(page)
  await expect(linked).toBeFocused()
})

test('reports an unavailable task link and reveals it before focusing when it appears later', async ({ page, consoleApi }) => {
  const linked = consoleApi.state.jobs.find(item => item.id === id(8))!
  consoleApi.state.jobs = consoleApi.state.jobs.filter(item => item.id !== linked.id)
  await page.goto(`/app/?job=${linked.id}`)
  await expect(page.getByRole('alert')).toHaveText('任务链接无效，或该任务已不可用。')
  await filters(page, 'running', 'check', 'cannot-match')
  await rows(page, [])
  consoleApi.state.jobs.push(linked)
  await page.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(otherProject.id)
  await expectFilters(page)
  await expect(page.locator(`#job-${linked.id}`)).toBeFocused()
})

for (const status of ['queued', 'running'] as const) {
  test(`preserves a failed retry's filters and reveals the successful ${status} retry`, async ({ page, consoleApi }) => {
    await page.clock.install()
    consoleApi.replies.retry.push(
      { error: 'An active task already exists', status: 409 },
      { job: job(4, status, 'sync', { stage: status === 'queued' ? 'dispatching' : 'fetching', attempt: 2 }) },
    )
    await history(page)
    await filters(page, 'failed', 'sync', 'Token')
    const row = page.locator(`#job-${id(4)}`)
    await row.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('An active task already exists')
    await expectFilters(page, 'failed', 'sync', 'Token')
    await rows(page, [4])
    let releaseState!: () => void
    consoleApi.deferredState = {
      snapshot: structuredClone(consoleApi.state),
      release: new Promise<void>((resolve) => { releaseState = resolve }),
    }
    const reads = consoleApi.reads
    const staleResponse = page.waitForResponse('**/api/state')
    await page.clock.fastForward(10_000)
    await expect.poll(() => consoleApi.reads).toBeGreaterThan(reads)
    await row.getByRole('button', { name: '重试', exact: true }).click()
    await expectFilters(page)
    await expect(row).toContainText(status === 'queued' ? '等待执行' : '运行中')
    await expect(row).toBeInViewport()
    await expect(row).toBeFocused()
    await expect(row.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    releaseState()
    await (await staleResponse).finished()
    await page.clock.runFor(100)
    await expectFilters(page)
    await expect(row).toContainText(status === 'queued' ? '等待执行' : '运行中')
    await expect(row.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    await expect(row).toBeFocused()
    expect(consoleApi.requests.map(request => request.type)).toEqual(['retry', 'retry'])
  })
}

test('preserves filters when creating a task fails, then clears them for the returned running task', async ({ page, consoleApi }) => {
  consoleApi.replies.create.push(
    { error: 'An active task already exists', status: 409 },
    { job: job(9, 'running', 'check', { stage: 'validating' }) },
  )
  await history(page)
  await filters(page, 'failed', 'sync', 'Token')
  await page.getByRole('button', { name: '项目配置', exact: true }).click()
  await page.getByRole('button', { name: '仅校验', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('An active task already exists')
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await expectFilters(page, 'failed', 'sync', 'Token')
  await page.getByRole('button', { name: '项目配置', exact: true }).click()
  await page.getByRole('button', { name: '仅校验', exact: true }).click()
  await expectFilters(page)
  const returned = page.locator(`#job-${id(9)}`)
  await expect(returned).toContainText('运行中')
  await expect(returned).toBeInViewport()
  await expect(returned).toBeFocused()
  await rows(page, [1, 2, 3, 4, 5, 6, 7, 9], 8)
})

test('preserves filters on snapshot return and failed publication, then reveals the returned publish task', async ({ page, consoleApi }) => {
  consoleApi.replies.publish.push(
    { error: 'Publication confirmation expired', status: 409 },
    { job: job(10, 'queued', 'publish', { stage: 'dispatching' }) },
  )
  await history(page)
  await filters(page, 'succeeded', 'preview', id(3))
  await page.locator(`#job-${id(3)}`).getByRole('button', { name: '查看快照', exact: true }).click()
  await expect(page.getByRole('img', { name: 'home 之后', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await expectFilters(page, 'succeeded', 'preview', id(3))
  await rows(page, [3])
  await page.locator(`#job-${id(3)}`).getByRole('button', { name: '查看快照', exact: true }).click()
  await page.getByRole('button', { name: '查看发布确认', exact: true }).click()
  await page.getByRole('button', { name: '确认发布 0.2.0', exact: true }).click()
  await page.getByRole('button', { name: '返回审核', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Publication confirmation expired')
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await expectFilters(page, 'succeeded', 'preview', id(3))
  await page.locator(`#job-${id(3)}`).getByRole('button', { name: '查看快照', exact: true }).click()
  await page.getByRole('button', { name: '查看发布确认', exact: true }).click()
  await page.getByRole('button', { name: '确认发布 0.2.0', exact: true }).click()
  await expectFilters(page)
  const returned = page.locator(`#job-${id(10)}`)
  await expect(returned).toContainText('等待执行')
  await expect(returned.getByRole('cell').first()).toContainText('发布')
  await expect(returned).toBeInViewport()
  await expect(returned).toBeFocused()
  await rows(page, [1, 2, 3, 4, 5, 6, 7, 10], 8)
})

test('supports keyboard filtering at 390px with horizontal scrolling confined to the task table', async ({ page, consoleApi }, testInfo) => {
  expect(consoleApi.state.jobs.length).toBeGreaterThan(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await history(page)
  await filters(page, 'failed', 'sync', '[literal].*')
  await rows(page, [4])
  const search = page.getByLabel('搜索任务', { exact: true })
  await search.focus()
  await search.press('Tab')
  const clear = page.getByRole('button', { name: '清除任务筛选', exact: true })
  await expect(clear).toBeFocused()
  await clear.press('Enter')
  await expectFilters(page)
  await rows(page, [1, 2, 3, 4, 5, 6, 7])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const table = page.locator('.table-scroll')
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await table.evaluate(element => element.scrollTo({ left: element.scrollWidth }))
  expect(await table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('task-filters-mobile.png'), fullPage: true })
})

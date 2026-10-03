import type { ConsoleState, Job, Project } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
const alpha: Project = {
  id: id(801),
  name: 'submission-alpha',
  prefix: 'alpha',
  packageName: '@fixture/submission-alpha',
  repository: 'fixture/icons',
  revision: 1,
  repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
  createdAt: 1_790_000_000_000,
  sources: [{ type: 'directory', dir: 'raw' }],
  color: 'currentColor',
  validate: { skipPrefix: ['_', '.'] },
  output: { svg: true, types: true, preview: true, changelog: true },
}
const beta: Project = { ...alpha, id: id(802), name: 'submission-beta', prefix: 'beta', packageName: '@fixture/submission-beta' }
function job(value: number, project = alpha, extra: Partial<Job> = {}): Job {
  return {
    id: id(value),
    projectId: project.id,
    project,
    operation: 'sync',
    status: 'failed',
    stage: 'fetching',
    error: 'Fixture failure',
    sourceCommit: 'a'.repeat(40),
    workflowCommit: 'b'.repeat(40),
    executorCommit: 'c'.repeat(40),
    workflowDigest: 'd'.repeat(64),
    createdAt: project.createdAt + value * 1000,
    updatedAt: project.createdAt + value * 1000,
    dispatchAttempts: 1,
    attempt: 1,
    ...extra,
  }
}
const failed = job(851)
const otherFailed = job(852, beta)
type Operation = 'start' | 'retry'
interface Reply { status?: number, json: unknown }
interface Captured { path: string, method: string, body: unknown }
interface Gate {
  path: string
  method: string
  entered: boolean
  settled: boolean
  request?: Captured
  promise: Promise<Reply>
  release: (reply: Reply) => void
}
interface SubmissionApi {
  state: ConsoleState
  gates: Gate[]
  requests: Captured[]
}
function hold(api: SubmissionApi, path: string, method = 'POST') {
  let done!: (reply: Reply) => void
  const gate: Gate = {
    path,
    method,
    entered: false,
    settled: false,
    promise: new Promise<Reply>((resolve) => { done = resolve }),
    release(reply) {
      if (!gate.settled) {
        gate.settled = true
        done(structuredClone(reply))
      }
    },
  }
  api.gates.push(gate)
  return gate
}
const test = base.extend<{ submissionApi: SubmissionApi }>({
  submissionApi: async ({ page }, use) => {
    await page.clock.install()
    const api: SubmissionApi = {
      state: { projects: structuredClone([alpha, beta]), jobs: structuredClone([failed, otherFailed]), snapshots: [], releases: [], connections: [], pairings: [], devices: [] },
      gates: [],
      requests: [],
    }
    const errors: string[] = []
    const unexpected: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const method = request.method()
      const captured = { method, path, body: request.postData() ? structuredClone(request.postDataJSON()) as unknown : undefined }
      api.requests.push(captured)
      if (path === '/api/session') {
        return route.fulfill({ json: { csrf: 'submission-csrf' } })
      }
      const gate = api.gates.find(item => !item.entered && item.path === path && item.method === method)
      if (gate) {
        if (method === 'POST') {
          expect(request.headers()['x-csrf-token']).toBe('submission-csrf')
        }
        gate.request = captured
        gate.entered = true
        const reply = await gate.promise
        if (method === 'POST' && (reply.status ?? 200) < 400) {
          const submitted = reply.json as Job
          const previous = api.state.jobs.find(item => item.id === submitted.id)
          if (!previous || submitted.attempt > previous.attempt || (submitted.attempt === previous.attempt && submitted.updatedAt >= previous.updatedAt)) {
            api.state.jobs = [submitted, ...api.state.jobs.filter(item => item.id !== submitted.id)]
          }
        }
        return route.fulfill(reply)
      }
      if (path === '/api/state') {
        return route.fulfill({ json: structuredClone(api.state) })
      }
      unexpected.push(`${method} ${path}`)
      return route.fulfill({ status: 500, json: { error: 'Unplanned submission request' } })
    })
    try {
      await use(api)
      expect(errors).toEqual([])
      expect(unexpected).toEqual([])
    }
    finally {
      api.gates.forEach(gate => gate.release({ status: 503, json: { error: 'Fixture closed' } }))
    }
  },
})

const mutations = (api: SubmissionApi) => api.requests.filter(request => request.method === 'POST')
async function open(page: Page, operation: Operation) {
  await page.goto('/app/')
  if (operation === 'start') {
    await page.getByRole('button', { name: alpha.name, exact: true }).click()
  }
  else {
    await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  }
}
async function begin(page: Page, api: SubmissionApi, operation: Operation) {
  const path = operation === 'start' ? `/api/projects/${alpha.id}/jobs` : `/api/jobs/${failed.id}/retry`
  const gate = hold(api, path)
  if (operation === 'start') {
    await page.getByRole('button', { name: '仅校验', exact: true }).click()
  }
  else {
    await page.locator(`#job-${failed.id}`).getByRole('button', { name: '重试', exact: true }).click()
  }
  await expect.poll(() => gate.entered).toBe(true)
  expect(gate.request?.body).toEqual(operation === 'start' ? { operation: 'check' } : {})
  return gate
}
async function answer(page: Page, gate: Gate, reply: Reply) {
  await expect.poll(() => gate.entered).toBe(true)
  const response = page.waitForResponse(response => new URL(response.url()).pathname === gate.path && response.request().method() === gate.method)
  gate.release(reply)
  await (await response).finished()
  await page.clock.runFor(50)
}
function result(operation: Operation, extra: Partial<Job> = {}) {
  return job(operation === 'start' ? 853 : 851, alpha, {
    operation: operation === 'start' ? 'check' : 'sync',
    status: 'queued',
    stage: 'queued',
    error: undefined,
    attempt: operation === 'start' ? 1 : 2,
    updatedAt: failed.updatedAt + 10_000,
    ...extra,
  })
}
async function filters(page: Page) {
  await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('failed')
  await page.getByRole('combobox', { name: '任务操作', exact: true }).selectOption('sync')
  await page.getByLabel('搜索任务', { exact: true }).fill('keep-this-filter')
}
async function expectFilters(page: Page) {
  await expect(page.getByRole('combobox', { name: '任务状态', exact: true })).toHaveValue('failed')
  await expect(page.getByRole('combobox', { name: '任务操作', exact: true })).toHaveValue('sync')
  await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('keep-this-filter')
}

for (const operation of ['start', 'retry'] as const) {
  for (const navigation of ['project', 'view'] as const) {
    test(`preserves navigation and focus when ${operation} succeeds after a ${navigation} change`, async ({ page, submissionApi }, info) => {
      if (operation === 'retry' && navigation === 'project') {
        await page.setViewportSize({ width: 390, height: 844 })
      }
      await open(page, operation)
      const gate = await begin(page, submissionApi, operation)
      let inputName: string
      if (navigation === 'project') {
        await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
        inputName = operation === 'start' ? '图标前缀' : '搜索任务'
      }
      else {
        await page.getByRole('button', { name: operation === 'start' ? '任务与版本' : '项目配置', exact: true }).click()
        inputName = operation === 'start' ? '搜索任务' : '图标前缀'
      }
      const target = page.getByLabel(inputName, { exact: true })
      if (inputName === '搜索任务') {
        await filters(page)
      }
      else {
        await target.fill('keep-current-draft')
      }
      await target.focus()
      const submitted = result(operation)
      await answer(page, gate, { status: 202, json: submitted })
      await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(navigation === 'project' ? beta.id : alpha.id)
      await expect(target).toBeFocused()
      if (inputName === '搜索任务') {
        await expectFilters(page)
      }
      else {
        await expect(target).toHaveValue('keep-current-draft')
      }
      const notice = page.getByLabel('提交任务已完成', { exact: true })
      await expect(notice).toContainText(submitted.id)
      const locate = notice.getByRole('button', { name: '定位任务', exact: true })
      await expect(locate).toBeEnabled()
      expect(mutations(submissionApi)).toHaveLength(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (operation === 'retry' && navigation === 'project') {
        await page.screenshot({ path: info.outputPath('late-retry-mobile.png'), fullPage: true })
      }
      await locate.focus()
      await locate.press('Enter')
      await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
      const row = page.locator(`#job-${submitted.id}`)
      await expect(row).toBeFocused()
      await expect(row).toContainText('等待执行')
      await expect(page.getByRole('combobox', { name: '任务状态', exact: true })).toHaveValue('all')
      await expect(page.getByRole('combobox', { name: '任务操作', exact: true })).toHaveValue('all')
      await expect(page.getByLabel('搜索任务', { exact: true })).toHaveValue('')
    })
  }
}

test('treats a task filter change alone as a newer navigation intent for a pending retry', async ({ page, submissionApi }) => {
  await open(page, 'retry')
  const gate = await begin(page, submissionApi, 'retry')
  await filters(page)
  await answer(page, gate, { status: 202, json: result('retry') })
  await expectFilters(page)
  await expect(page.getByLabel('搜索任务', { exact: true })).toBeFocused()
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
  await expect(page.getByLabel('提交任务已完成', { exact: true })).toBeVisible()
  await expect(page.locator(`#job-${failed.id}`)).toHaveCount(0)
  await page.getByRole('button', { name: '定位任务', exact: true }).click()
  await expect(page.locator(`#job-${failed.id}`)).toBeFocused()
  await expect(page.locator(`#job-${failed.id}`)).toContainText('等待执行')
})

for (const operation of ['start', 'retry'] as const) {
  test(`keeps a late ${operation} failure out of another project's current context`, async ({ page, submissionApi }) => {
    await open(page, operation)
    const gate = await begin(page, submissionApi, operation)
    await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
    const target = page.getByLabel(operation === 'start' ? '图标前缀' : '搜索任务', { exact: true })
    await target.fill('beta-current-context')
    await answer(page, gate, { status: 409, json: { error: 'Old alpha task conflict' } })
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(beta.id)
    await expect(target).toHaveValue('beta-current-context')
    await expect(target).toBeFocused()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText('Old alpha task conflict', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('提交任务已完成', { exact: true })).toBeHidden()
    expect(mutations(submissionApi)).toHaveLength(1)
  })
}

for (const operation of ['start', 'retry'] as const) {
  test(`still reveals a successful ${operation} when the original navigation context is current`, async ({ page, submissionApi }) => {
    await open(page, operation)
    const gate = await begin(page, submissionApi, operation)
    const submitted = result(operation)
    await answer(page, gate, { status: 202, json: submitted })
    await expect(page.locator(`#job-${submitted.id}`)).toBeFocused()
    await expect(page.locator(`#job-${submitted.id}`)).toContainText('等待执行')
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
    await expect(page.getByLabel('提交任务已完成', { exact: true })).toBeHidden()
    expect(mutations(submissionApi)).toHaveLength(1)
  })
}

for (const newerAttempt of [2, 3]) {
  test(`does not downgrade an observed completed attempt ${newerAttempt} when the queued retry response arrives`, async ({ page, submissionApi }) => {
    await open(page, 'retry')
    const stateRead = hold(submissionApi, '/api/state', 'GET')
    await page.clock.fastForward(10_000)
    await expect.poll(() => stateRead.entered).toBe(true)
    const gate = await begin(page, submissionApi, 'retry')
    await filters(page)
    const completed = result('retry', { status: 'succeeded', stage: 'complete', attempt: newerAttempt, updatedAt: failed.updatedAt + 20_000 })
    submissionApi.state.jobs = [completed, structuredClone(otherFailed)]
    await answer(page, stateRead, { json: submissionApi.state })
    await answer(page, gate, { status: 202, json: result('retry') })
    await expectFilters(page)
    await expect(page.getByLabel('搜索任务', { exact: true })).toBeFocused()
    await page.getByRole('button', { name: '定位任务', exact: true }).click()
    const row = page.locator(`#job-${failed.id}`)
    await expect(row).toBeFocused()
    await expect(row).toContainText('已完成')
    await expect(row).not.toContainText('等待执行')
    await expect(row.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    expect(mutations(submissionApi)).toHaveLength(1)
  })
}

test('does not let an older state read remove a late created task before explicit location', async ({ page, submissionApi }) => {
  await open(page, 'start')
  const oldState = structuredClone(submissionApi.state)
  const read = hold(submissionApi, '/api/state', 'GET')
  await page.clock.fastForward(10_000)
  await expect.poll(() => read.entered).toBe(true)
  const gate = await begin(page, submissionApi, 'start')
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await filters(page)
  const submitted = result('start')
  await answer(page, gate, { status: 202, json: submitted })
  await answer(page, read, { json: oldState })
  await expectFilters(page)
  await page.getByRole('button', { name: '定位任务', exact: true }).click()
  await expect(page.locator(`#job-${submitted.id}`)).toBeFocused()
  await expect(page.locator(`#job-${submitted.id}`)).toContainText('等待执行')
  expect(mutations(submissionApi)).toHaveLength(1)
})

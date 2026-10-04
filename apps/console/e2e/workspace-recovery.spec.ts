import type { ConsoleState } from '@iconctl/console-contracts'
import { writeFile } from 'node:fs/promises'
import { test as base, expect } from '@playwright/test'
import { alpha } from './editor-fixture'
import { test as workerTest } from './local-worker'

interface Reply { status?: number, json: unknown }
function gate() {
  let release!: (reply: Reply) => void
  const promise = new Promise<Reply>((resolve) => {
    release = resolve
  })
  return { entered: false, promise, release }
}
interface WorkspaceApi {
  state: ConsoleState
  fail: 'session' | 'state' | undefined
  reads: number
  sessions: number
  mutations: string[]
  held: ReturnType<typeof gate>[]
}
const test = base.extend<{ workspaceApi: WorkspaceApi }>({
  workspaceApi: async ({ page }, use) => {
    await page.clock.install()
    const workspace: WorkspaceApi = {
      state: { projects: [structuredClone(alpha)], jobs: [], snapshots: [], releases: [], connections: [], pairings: [], devices: [{ id: 'fixture-device', projectId: alpha.id, label: 'Paired plugin' }] },
      fail: undefined,
      reads: 0,
      sessions: 0,
      mutations: [],
      held: [],
    }
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/session') {
        workspace.sessions++
        if (workspace.fail === 'session') {
          workspace.fail = undefined
          return route.fulfill({ status: 502, json: { error: 'Session temporarily unavailable' } })
        }
        return route.fulfill({ json: { csrf: 'workspace-csrf' } })
      }
      if (path === '/api/state') {
        workspace.reads++
        if (workspace.fail === 'state') {
          workspace.fail = undefined
          return route.fulfill({ status: 502, json: { error: 'Workspace temporarily unavailable' } })
        }
        const pending = workspace.held.find(item => !item.entered)
        if (pending) {
          pending.entered = true
          return route.fulfill(await pending.promise)
        }
        return route.fulfill({ json: structuredClone(workspace.state) })
      }
      expect(request.headers()['x-csrf-token']).toBe('workspace-csrf')
      workspace.mutations.push(`${request.method()} ${path}`)
      if (path === '/api/devices/fixture-device' && request.method() === 'DELETE') {
        workspace.state.devices = []
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ status: 500, json: { error: 'Unexpected workspace request' } })
    })
    try {
      await use(workspace)
      expect(errors).toEqual([])
    }
    finally {
      workspace.held.forEach(pending => pending.release({ status: 503, json: { error: 'Fixture closing' } }))
    }
  },
})

for (const failure of ['session', 'state'] as const) {
  test(`recovers an initial ${failure} failure without reload and establishes CSRF before mutations`, async ({ page, workspaceApi }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    workspaceApi.fail = failure
    await page.goto('/app/')
    const status = page.getByRole('alert', { name: '工作空间连接状态' })
    await expect(status).toContainText('工作空间加载失败')
    await expect(page.getByRole('button', { name: '＋ 新建项目', exact: true })).toBeDisabled()
    const retry = status.getByRole('button', { name: '重新读取工作空间', exact: true })
    await retry.focus()
    await retry.press('Enter')
    await expect(page.getByRole('button', { name: alpha.name, exact: true })).toBeVisible()
    await expect(status).toBeHidden()
    expect(workspaceApi.sessions).toBe(failure === 'session' ? 2 : 1)
    await page.getByRole('button', { name: '授权与插件', exact: true }).click()
    await expect(page.getByText('Paired plugin', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByText('Paired plugin', { exact: true })).toBeHidden()
    expect(workspaceApi.mutations).toEqual(['DELETE /api/devices/fixture-device'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`workspace-${failure}-recovered-mobile.png`), fullPage: true })
  })
}

test('commits a slow successful poll without starting overlapping reads and schedules from completion', async ({ page, workspaceApi }) => {
  await page.goto('/app/')
  await expect(page.getByRole('button', { name: alpha.name, exact: true })).toBeVisible()
  const pending = gate()
  workspaceApi.held.push(pending)
  await page.clock.fastForward(10_000)
  await expect.poll(() => pending.entered).toBe(true)
  await page.clock.fastForward(20_000)
  expect(workspaceApi.reads).toBe(2)
  workspaceApi.state.projects = [{ ...alpha, name: 'Refreshed project', revision: 2 }]
  pending.release({ json: structuredClone(workspaceApi.state) })
  await expect(page.getByRole('button', { name: 'Refreshed project', exact: true })).toBeVisible()
  await page.clock.runFor(9_000)
  expect(workspaceApi.reads).toBe(2)
  await page.clock.runFor(1_100)
  await expect.poll(() => workspaceApi.reads).toBe(3)
})

test('retains dirty input and focus through background failure and automatic recovery', async ({ page, workspaceApi }, info) => {
  await page.goto('/app/')
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
  const prefix = page.getByLabel('图标前缀', { exact: true })
  await prefix.fill('unsaved-prefix')
  await prefix.focus()
  workspaceApi.fail = 'state'
  await page.clock.fastForward(10_000)
  const status = page.getByRole('alert', { name: '工作空间连接状态' })
  await expect(status).toContainText('保留上次读取的状态')
  await expect(prefix).toHaveValue('unsaved-prefix')
  await expect(prefix).toBeFocused()
  await page.screenshot({ path: info.outputPath('workspace-stale-preserves-draft.png'), fullPage: true })
  await page.clock.fastForward(10_000)
  await expect(status).toBeHidden()
  await expect(prefix).toHaveValue('unsaved-prefix')
  await expect(prefix).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(workspaceApi.mutations).toEqual([])
})

test('starts a new read after device revocation instead of joining a pre-write poll', async ({ page, workspaceApi }) => {
  await page.goto('/app/?view=connections')
  await expect(page.getByText('Paired plugin', { exact: true })).toBeVisible()
  const before = structuredClone(workspaceApi.state)
  const pending = gate()
  workspaceApi.held.push(pending)
  await page.clock.fastForward(10_000)
  await expect.poll(() => pending.entered).toBe(true)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByText('Paired plugin', { exact: true })).toBeHidden()
  await expect.poll(() => workspaceApi.reads).toBe(3)
  pending.release({ json: before })
  await page.clock.runFor(50)
  await expect(page.getByText('Paired plugin', { exact: true })).toBeHidden()
  expect(workspaceApi.mutations).toEqual(['DELETE /api/devices/fixture-device'])
})

test('retries only the read when a successful device revocation cannot refresh state', async ({ page, workspaceApi }) => {
  await page.goto('/app/?view=connections')
  await expect(page.getByText('Paired plugin', { exact: true })).toBeVisible()
  workspaceApi.fail = 'state'
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const status = page.getByRole('alert', { name: '工作空间连接状态' })
  await expect(status).toContainText('保留上次读取的状态')
  await expect(page.getByRole('alert')).toHaveCount(1)
  await status.getByRole('button', { name: '重新读取工作空间', exact: true }).click()
  await expect(status).toBeHidden()
  await expect(page.getByText('Paired plugin', { exact: true })).toBeHidden()
  expect(workspaceApi.mutations).toEqual(['DELETE /api/devices/fixture-device'])
})

for (const failedPath of ['/api/session', '/api/state']) {
  workerTest(`recovers a real Worker ${failedPath} transport interruption and persists exactly one CSRF-protected project update`, async ({ page, context, localWorker }, info) => {
    await page.clock.install()
    const { origin, fixture, unexpectedRequests } = localWorker
    await context.addCookies([{
      name: '__Host-iconctl-session',
      value: fixture.session.token,
      domain: new URL(origin).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }])
    const errors: string[] = []
    const requests: { method: string, path: string, interrupted: boolean, csrfMatches?: boolean }[] = []
    page.on('pageerror', error => errors.push(error.message))
    let firstFailure = true
    let failPostWriteRead = false
    await page.route(`${origin}/api/**`, async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const interrupted = (firstFailure && path === failedPath) || (failPostWriteRead && path === '/api/state')
      requests.push({ method: request.method(), path, interrupted, ...(request.method() === 'PUT' ? { csrfMatches: request.headers()['x-csrf-token'] === fixture.session.csrf } : {}) })
      if (interrupted) {
        firstFailure = false
        failPostWriteRead = false
        return route.abort('connectionreset')
      }
      await route.continue()
    })
    await page.goto(`${origin}/app/`)
    const status = page.getByRole('alert', { name: '工作空间连接状态' })
    await expect(status).toContainText('工作空间加载失败')
    const restored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' && response.ok())
    await status.getByRole('button', { name: '重新读取工作空间', exact: true }).click()
    const state = await (await restored).json() as ConsoleState
    expect(state.projects).toContainEqual(fixture.project)
    expect(state.snapshots).toHaveLength(3)
    await expect(status).toBeHidden()
    await page.getByRole('button', { name: fixture.project.name, exact: true }).click()
    const prefix = page.getByLabel('图标前缀', { exact: true })
    await prefix.fill('recovered-live')
    failPostWriteRead = true
    const write = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/projects/${fixture.project.id}`)
    await page.getByRole('button', { name: '保存项目', exact: true }).click()
    const response = await write
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ id: fixture.project.id, prefix: 'recovered-live', revision: 2 })
    await expect(page.getByLabel('保存状态', { exact: true })).toContainText('已保存')
    await expect(page.getByLabel('工作空间刷新失败', { exact: true })).toBeVisible()
    await expect(page.getByLabel('保存失败', { exact: true })).toBeHidden()
    await prefix.fill('unsaved-after-recovery')
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' && response.ok())
    await page.getByRole('button', { name: '重新刷新工作空间', exact: true }).click()
    const current = await (await reread).json() as ConsoleState
    expect(current.projects.find(project => project.id === fixture.project.id)).toMatchObject({ prefix: 'recovered-live', revision: 2 })
    await expect(page.getByLabel('工作空间刷新失败', { exact: true })).toBeHidden()
    await expect(prefix).toHaveValue('unsaved-after-recovery')
    await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
    expect(requests.filter(request => request.method === 'PUT')).toEqual([{ method: 'PUT', path: `/api/projects/${fixture.project.id}`, interrupted: false, csrfMatches: true }])
    expect(requests.filter(request => request.interrupted)).toHaveLength(2)
    expect(unexpectedRequests).toEqual([])
    expect(errors).toEqual([])
    await writeFile(info.outputPath('workspace-real-worker-evidence.json'), JSON.stringify({ requests, errors, unexpectedRequests, persistedRevision: 2 }, null, 2))
    await page.screenshot({ path: info.outputPath('workspace-real-worker-recovered.png'), fullPage: true })
  })
}

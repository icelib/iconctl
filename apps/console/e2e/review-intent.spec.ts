import type { ConsoleState, Project, ReleasePreview, SnapshotPreview } from '@iconctl/console-contracts'
import type { Page, Route } from '@playwright/test'
import { projectInput } from '@iconctl/console-contracts'
import { test as base, expect } from '@playwright/test'

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
const project: Project = {
  ...projectInput.parse({ name: 'review-icons', prefix: 'brand', packageName: '@test/review-icons', repository: 'fixture/icons', sources: [{ type: 'directory', dir: 'raw' }] }),
  id: id(1),
  revision: 1,
  repositoryInfo: { id: 123, installationId: 456, defaultBranch: 'main' },
  createdAt: 1_790_000_000_000,
}
const otherProject: Project = { ...project, id: id(2), name: 'other-icons' }
function preview(value: number, name: string, owner = project): SnapshotPreview {
  return {
    snapshot: { id: id(value), projectId: owner.id, jobId: id(value + 100), attempt: 1, createdAt: project.createdAt + value * 1000, digest: `${value}`.padEnd(64, 'a'), iconCount: 1, issues: 0 },
    content: { json: { prefix: 'brand', width: 24, height: 24, icons: { [name]: { body: '<path d="M4 4h16v16H4z"/>' } } }, files: { 'iconify.json': '{}' }, issues: [], failed: [], sources: [] },
    diff: { added: [name], changed: [], removed: [] },
    comparison: { mode: 'previous', snapshot: null, release: null },
  }
}
const snapshots = [preview(11, 'base'), preview(12, 'alpha'), preview(13, 'beta'), preview(14, 'gamma', otherProject)]

interface HeldRequest {
  path: string
  entered: boolean
  release: () => void
  gate: Promise<void>
  status?: number
}
interface ReviewApi {
  previews: SnapshotPreview[]
  holds: HeldRequest[]
  confirmations: number
  confirmStatus?: number
  snapshotStatus?: number
  requests: { path: string, key?: string }[]
  failedRequests: string[]
}
const test = base.extend<{ reviewApi: ReviewApi }>({
  reviewApi: async ({ page }, use) => {
    const api: ReviewApi = { previews: structuredClone(snapshots), holds: [], confirmations: 0, requests: [], failedRequests: [] }
    const errors: string[] = []
    const unexpected: string[] = []
    const state: ConsoleState = {
      projects: [project, otherProject],
      snapshots: api.previews.map(item => item.snapshot),
      jobs: [],
      releases: [],
      connections: [],
      pairings: [],
      devices: [],
    }
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => api.failedRequests.push(new URL(request.url()).pathname + new URL(request.url()).search))
    await page.route('**/api/**', async (route: Route) => {
      const url = new URL(route.request().url())
      const path = url.pathname + url.search
      api.requests.push({ path, key: route.request().headers()['idempotency-key'] })
      const hold = api.holds.find(item => item.path === path && !item.entered)
      if (hold) {
        hold.entered = true
        await hold.gate
      }
      if (path === '/api/session') {
        return route.fulfill({ json: { csrf: 'review-csrf' } })
      }
      if (path === '/api/state') {
        return route.fulfill({ json: state })
      }
      if (url.pathname.startsWith('/api/snapshots/')) {
        const status = hold?.status ?? api.snapshotStatus
        if (status) {
          return route.fulfill({ status, contentType: 'text/html', body: '<h1>Unavailable</h1>' })
        }
        const item = structuredClone(api.previews.find(item => url.pathname.endsWith(item.snapshot.id))!)
        if (url.searchParams.get('compareTo') === 'release') {
          item.comparison = { mode: 'release', snapshot: snapshots[0]!.snapshot, release: { id: id(500), version: '1.0.0', snapshotId: snapshots[0]!.snapshot.id } }
          item.diff.removed = ['released-only']
          item.previous = { prefix: 'brand', icons: { 'released-only': { body: '<circle cx="12" cy="12" r="8"/>' } } }
        }
        return route.fulfill({ json: item })
      }
      if (url.pathname.endsWith('/release/preview')) {
        api.confirmations++
        const body = route.request().postDataJSON()
        const item = api.previews.find(item => item.snapshot.id === body.snapshotId)!
        const confirmation: ReleasePreview = {
          id: id(600 + api.confirmations),
          projectId: project.id,
          revision: 1,
          expiresAt: Date.now() + 600_000,
          packageName: project.packageName,
          iconCount: item.snapshot.iconCount,
          release: { snapshotId: item.snapshot.id, digest: item.snapshot.digest, version: `1.0.${api.confirmations}`, branchHead: null, confirmation: id(600 + api.confirmations) },
          comparison: { mode: 'release', snapshot: null, release: null },
          diff: item.diff,
        }
        return route.fulfill({ json: confirmation })
      }
      if (url.pathname.endsWith('/release/confirm')) {
        expect(route.request().headers()['x-csrf-token']).toBe('review-csrf')
        return route.fulfill({ status: api.confirmStatus ?? 502, contentType: 'text/html', body: '<h1>Upstream unavailable</h1>' })
      }
      unexpected.push(path)
      return route.fulfill({ status: 404, json: { error: 'Unexpected request' } })
    })
    try {
      await use(api)
      expect(errors).toEqual([])
      expect(unexpected).toEqual([])
    }
    finally {
      api.holds.forEach(item => item.release())
    }
  },
})

function hold(api: ReviewApi, path: string, status?: number) {
  let release!: () => void
  const request = { path, entered: false, gate: new Promise<void>((resolve) => {
    release = resolve
  }), release: () => release(), status }
  api.holds.push(request)
  return request
}

async function open(page: Page) {
  await page.goto('/app/')
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await page.getByLabel('选择快照', { exact: true }).selectOption(snapshots[0]!.snapshot.id)
  await expect(page.getByRole('img', { name: 'base 之后', exact: true })).toBeVisible()
}

test('commits only the newest snapshot, aborts the older network read and preserves the visible review while loading', async ({ page, reviewApi }) => {
  await open(page)
  const slow = hold(reviewApi, `/api/snapshots/${id(12)}`)
  await page.getByLabel('选择快照', { exact: true }).selectOption(id(12))
  await expect.poll(() => slow.entered).toBe(true)
  await expect(page.getByRole('status', { name: '快照加载状态' })).toBeVisible()
  await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(id(11))
  await expect(page.getByRole('img', { name: 'base 之后', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
  await page.getByLabel('选择快照', { exact: true }).selectOption(id(13))
  await expect(page.getByRole('img', { name: 'beta 之后', exact: true })).toBeVisible()
  await expect.poll(() => reviewApi.failedRequests).toContain(slow.path)
  slow.release()
  await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(id(13))
  await expect(page.getByRole('img', { name: 'alpha 之后', exact: true })).toHaveCount(0)
  await expect(page.getByRole('status', { name: '快照加载状态' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'iconify.json ↓', exact: true })).toHaveAttribute('href', `/api/snapshots/${id(13)}/files/iconify.json`)
})

test('keeps comparison selection, metadata and diff atomic when same-snapshot responses reverse', async ({ page, reviewApi }) => {
  await open(page)
  const slow = hold(reviewApi, `/api/snapshots/${id(11)}?compareTo=release`)
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  await expect.poll(() => slow.entered).toBe(true)
  await expect(page.getByLabel('比较基准', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '删除 0', exact: true })).toBeVisible()
  await page.getByLabel('比较基准', { exact: true }).selectOption('')
  await expect(page.getByRole('status', { name: '快照加载状态' })).toHaveCount(0)
  await expect.poll(() => reviewApi.failedRequests).toContain(slow.path)
  slow.release()
  await expect(page.getByLabel('比较基准', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '删除 0', exact: true })).toBeVisible()
  await page.getByLabel('比较基准', { exact: true }).selectOption('release')
  await expect(page.getByLabel('比较基准', { exact: true })).toHaveValue('release')
  await expect(page.getByLabel('当前比较基准', { exact: true })).toContainText('v1.0.0')
  await expect(page.getByRole('button', { name: '删除 1', exact: true })).toBeVisible()
})

for (const navigation of ['project', 'history'] as const) {
  test(`invalidates old snapshot errors when leaving by ${navigation}`, async ({ page, reviewApi }) => {
    await open(page)
    const slow = hold(reviewApi, `/api/snapshots/${id(12)}`, 502)
    await page.getByLabel('选择快照', { exact: true }).selectOption(id(12))
    await expect.poll(() => slow.entered).toBe(true)
    if (navigation === 'project') {
      await page.getByLabel('当前项目', { exact: true }).selectOption(otherProject.id)
      await page.getByLabel('选择快照', { exact: true }).selectOption(id(14))
      await expect(page.getByRole('img', { name: 'gamma 之后', exact: true })).toBeVisible()
    }
    else {
      await page.getByRole('button', { name: '任务与版本', exact: true }).click()
      await expect(page.getByRole('heading', { name: '任务记录', exact: true })).toBeVisible()
    }
    await expect.poll(() => reviewApi.failedRequests).toContain(slow.path)
    slow.release()
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (navigation === 'project') {
      await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(otherProject.id)
      await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(id(14))
    }
    else {
      await expect(page.getByRole('heading', { name: '任务记录', exact: true })).toBeVisible()
    }
  })
}

test('preserves the committed preview and exposes an accessible local failure for a current read', async ({ page, reviewApi }) => {
  await open(page)
  reviewApi.snapshotStatus = 502
  await page.getByLabel('选择快照', { exact: true }).selectOption(id(12))
  await expect(page.getByRole('alert', { name: '快照加载失败' })).toContainText('502')
  await expect(page.getByLabel('选择快照', { exact: true })).toHaveValue(id(11))
  await expect(page.getByRole('img', { name: 'base 之后', exact: true })).toBeVisible()
  delete reviewApi.snapshotStatus
  await page.getByLabel('选择快照', { exact: true }).selectOption(id(12))
  await expect(page.getByRole('img', { name: 'alpha 之后', exact: true })).toBeVisible()
  await expect(page.getByRole('alert', { name: '快照加载失败' })).toHaveCount(0)
})

for (const status of [404, 409, 410, 502]) {
  test(`keeps non-JSON ${status} publication failures inside the dialog with the appropriate recovery`, async ({ page, reviewApi }) => {
    await open(page)
    reviewApi.confirmStatus = status
    await page.getByRole('button', { name: '查看发布确认', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '发布确认' })
    await dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true }).click()
    await expect(dialog.getByRole('alert', { name: '发布失败' })).toContainText(`${status}`)
    await expect(dialog.getByLabel('发布累计差异', { exact: true })).toHaveText('新增 1 · 修改 0 · 删除 0')
    if (status === 502) {
      await dialog.getByRole('button', { name: '重试发布请求', exact: true }).click()
      await expect(dialog.getByRole('alert', { name: '发布失败' })).toBeVisible()
      const keys = reviewApi.requests.filter(item => item.path.endsWith('/release/confirm')).map(item => item.key)
      expect(keys).toHaveLength(2)
      expect(keys[0]).toBe(keys[1])
    }
    else {
      await expect(dialog.getByRole('button', { name: '确认发布 1.0.1', exact: true })).toBeDisabled()
      await dialog.getByRole('button', { name: '重新获取发布确认', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '确认发布 1.0.2', exact: true })).toBeEnabled()
      expect(reviewApi.requests.filter(item => item.path.endsWith('/release/confirm'))).toHaveLength(1)
    }
  })
}

test('opens a pending dialog immediately and supports keyboard close and focus recovery at 390px', async ({ page, reviewApi }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const slow = hold(reviewApi, `/api/projects/${project.id}/release/preview`)
  const trigger = page.getByRole('button', { name: '查看发布确认', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  await expect.poll(() => slow.entered).toBe(true)
  const dialog = page.getByRole('dialog', { name: '发布确认' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status', { name: '发布请求状态' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '返回审核', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('pending-confirmation-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await expect.poll(() => reviewApi.failedRequests).toContain(slow.path)
  slow.release()
  await expect(dialog).not.toBeVisible()
  await trigger.press('Enter')
  await expect(dialog.getByRole('button', { name: '确认发布 1.0.2', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '返回审核', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('redirects a current unauthorized snapshot response to login', async ({ page, reviewApi }) => {
  await page.route('**/login', route => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' }))
  await open(page)
  reviewApi.snapshotStatus = 401
  await page.getByLabel('选择快照', { exact: true }).selectOption(id(12))
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('renders unknown diagnostic stages literally without inherited object lookup', async ({ page, reviewApi }) => {
  const stages = ['constructor', '__proto__', 'toString', 'custom-stage']
  reviewApi.previews[0]!.content.issues = stages.map((stage, index) => ({ name: `icon-${index}`, stage, message: 'Review this icon' }))
  reviewApi.previews[0]!.snapshot.issues = stages.length
  await open(page)
  const diagnostics = page.getByLabel('快照诊断', { exact: true })
  for (const stage of stages) {
    await expect(diagnostics.getByText(`阶段：${stage} · 来源：未记录来源`, { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
})

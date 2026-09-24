import type { ConsoleState, Project } from '@iconctl/console-contracts'
import { expect, test } from '@playwright/test'

const project: Project = {
  id: '11111111-1111-4111-8111-111111111111',
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
const snapshot = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: project.id,
  jobId: '33333333-3333-4333-8333-333333333333',
  createdAt: 1_790_000_000_000,
  digest: 'a'.repeat(64),
  iconCount: 2,
  issues: 0,
}
const state: ConsoleState = {
  projects: [project],
  snapshots: [snapshot],
  jobs: [],
  releases: [],
  connections: [],
  devices: [],
  pairings: [],
}
const content = {
  json: {
    prefix: 'brand',
    width: 24,
    height: 24,
    icons: {
      'arrow-left': {
        body: '<path fill="currentColor" d="m10 4-8 8 8 8v-6h12v-4H10z"/>',
      },
      'circle': {
        body: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>',
      },
    },
  },
  files: { 'icons.json': 'e30=' },
  issues: [],
  failed: [],
  sources: [],
}

test('creates a project with a CSRF protected mutation', async ({ page }) => {
  let saved = false
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') {
      return route.fulfill({ json: { csrf: 'test-csrf' } })
    }
    if (path === '/api/state') {
      return route.fulfill({
        json: { ...state, projects: saved ? [project] : [] },
      })
    }
    if (path === '/api/projects') {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf')
      expect(route.request().postDataJSON().name).toBe('brand-icons')
      saved = true
      return route.fulfill({ json: project })
    }
    return route.fulfill({
      status: 404,
      json: { error: 'Unexpected request' },
    })
  })
  await page.goto('/app/')
  await expect(page.getByText('创建你的第一个图标项目')).toBeVisible()
  await page.getByRole('button', { name: '＋ 新建项目' }).click()
  await page.getByLabel('项目名称', { exact: true }).fill('brand-icons')
  await page.getByLabel('图标前缀', { exact: true }).fill('brand')
  await page.getByLabel('公开 npm 包名').fill(project.packageName)
  await page.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('项目配置已保存')
  expect(saved).toBe(true)
  expect(errors).toEqual([])
})

test('reviews image differences and requires a distinct publication confirmation', async ({
  page,
}) => {
  let published = false
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') {
      return route.fulfill({ json: { csrf: 'test-csrf' } })
    }
    if (path === '/api/state') {
      return route.fulfill({ json: state })
    }
    if (path === `/api/snapshots/${snapshot.id}`) {
      return route.fulfill({
        json: {
          snapshot,
          content,
          previous: {
            ...content.json,
            icons: {
              'arrow-left': {
                body: '<path d="M2 12h20" stroke="currentColor"/>',
              },
            },
          },
          diff: { added: ['circle'], changed: ['arrow-left'], removed: [] },
        },
      })
    }
    if (path.endsWith('/release/preview')) {
      expect(route.request().postDataJSON()).toEqual({
        snapshotId: snapshot.id,
        bump: 'patch',
      })
      return route.fulfill({
        json: {
          id: 'confirmation',
          packageName: project.packageName,
          iconCount: 2,
          release: { version: '0.1.0', digest: snapshot.digest },
        },
      })
    }
    if (path.endsWith('/release/confirm')) {
      expect(route.request().postDataJSON()).toEqual({
        confirmationId: 'confirmation',
      })
      published = true
      return route.fulfill({ json: { id: 'publish-job' } })
    }
    return route.fulfill({
      status: 404,
      json: { error: 'Unexpected request' },
    })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: '预览与差异' }).click()
  await page.getByLabel('选择快照').selectOption(snapshot.id)
  await expect(page.getByRole('img', { name: 'circle 之后' })).toBeVisible()
  await page.screenshot({
    path: 'test-results/console-preview.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: '查看发布确认' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('v0.1.0', { exact: true })).toBeVisible()
  expect(published).toBe(false)
  await page.getByRole('button', { name: '返回审核' }).click()
  expect(published).toBe(false)
  await page.getByRole('button', { name: '查看发布确认' }).click()
  await page.getByRole('button', { name: '确认发布 0.1.0' }).click()
  await expect(page.getByRole('status')).toHaveText('发布任务已创建')
  expect(published).toBe(true)
  expect(errors).toEqual([])
})

test('supports narrow screens and editing an existing reactive project', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/session', route =>
    route.fulfill({ json: { csrf: 'test-csrf' } }))
  await page.route('**/api/state', route => route.fulfill({ json: state }))
  await page.goto('/app/')
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue(
    'brand-icons',
  )
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/console-mobile.png',
    fullPage: true,
  })
})

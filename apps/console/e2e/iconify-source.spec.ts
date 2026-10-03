import type { ConsoleState, Project, ProjectInput } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import { projectInput } from '@iconctl/console-contracts'
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
  sources: [{ type: 'iconify', file: 'vendor/icons.json', include: [] }],
  color: 'currentColor',
  validate: { skipPrefix: ['_', '.'] },
  output: { svg: true, types: true, preview: true, changelog: true },
}

async function projectApi(page: Page, initial?: Project) {
  let saved = initial
  const submissions: ProjectInput[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/session') {
      return route.fulfill({ json: { csrf: 'test-csrf' } })
    }
    if (path === '/api/state') {
      const state: ConsoleState = {
        projects: saved ? [saved] : [],
        jobs: [],
        snapshots: [],
        releases: [],
        connections: [],
        pairings: [],
        devices: [],
      }
      return route.fulfill({ json: state })
    }
    if (path === '/api/projects' || path === `/api/projects/${project.id}`) {
      expect(request.headers()['x-csrf-token']).toBe('test-csrf')
      expect(request.method()).toBe(saved ? 'PUT' : 'POST')
      const body = request.postDataJSON()
      if (saved) {
        expect(body.revision).toBe(saved.revision)
      }
      const input: ProjectInput = saved ? body.project : body
      submissions.push(structuredClone(input))
      saved = {
        ...project,
        ...projectInput.parse(input),
        revision: saved ? saved.revision + 1 : 1,
      }
      return route.fulfill({ json: saved })
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected request' } })
  })
  return submissions
}

test('creates and reloads an Iconify repository source with exact names and a literal prefix', async ({ page }, testInfo) => {
  const submissions = await projectApi(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/app/')
  await page.getByRole('button', { name: '＋ 新建项目' }).click()
  await page.getByLabel('项目名称', { exact: true }).fill(project.name)
  await page.getByLabel('图标前缀', { exact: true }).fill(project.prefix)
  await page.getByLabel('公开 npm 包名').fill(project.packageName)
  await page.getByRole('button', { name: '移除来源 1', exact: true }).click()
  await page.getByLabel('新增来源类型').selectOption('iconify')
  await page.getByRole('button', { name: '添加来源', exact: true }).click()

  const source = page.getByRole('group', { name: 'iconify 1', exact: true })
  await source.getByLabel('仓库内 JSON 文件路径').fill('vendor/icons.json')
  await source.getByLabel('名称前缀（原样添加）').fill(' Vendor__')
  await expect(source.getByLabel('导入范围')).toHaveValue('all')
  await expect(source.getByLabel('图标名称（每行一个）')).toHaveCount(0)
  await expect(source.locator('input[type="file"]')).toHaveCount(0)
  await expect(source.getByLabel('授权', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  expect(submissions[0]!.sources).toEqual([
    { type: 'iconify', file: 'vendor/icons.json', namePrefix: ' Vendor__' },
  ])

  await page.reload()
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(source.getByLabel('仓库内 JSON 文件路径')).toHaveValue('vendor/icons.json')
  await expect(source.getByLabel('名称前缀（原样添加）')).toHaveValue(' Vendor__')
  await source.getByLabel('导入范围').selectOption('selected')
  const names = source.getByLabel('图标名称（每行一个）')
  await names.fill('home\n')
  await expect(names).toHaveValue('home\n')
  await names.pressSequentially('arrow-left')
  await names.press('Enter')
  await names.press('Enter')
  await names.pressSequentially('home-alias')
  await page.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  expect(submissions[1]!.sources).toEqual([
    { type: 'iconify', file: 'vendor/icons.json', namePrefix: ' Vendor__', include: ['home', 'arrow-left', 'home-alias'] },
  ])

  await page.reload()
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(source.getByLabel('导入范围')).toHaveValue('selected')
  await expect(names).toHaveValue('home\narrow-left\nhome-alias')
  await expect(source.getByLabel('名称前缀（原样添加）')).toHaveValue(' Vendor__')
  await source.screenshot({ path: testInfo.outputPath('iconify-source.png') })
  expect(errors).toEqual([])
})

test('preserves an explicit empty selection and can restore all icons on a narrow screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const submissions = await projectApi(page, project)
  await page.goto('/app/')
  await page.getByRole('button', { name: '配置', exact: true }).click()
  const source = page.getByRole('group', { name: 'iconify 1', exact: true })
  await expect(source.getByLabel('导入范围')).toHaveValue('selected')
  await expect(source.getByLabel('图标名称（每行一个）')).toHaveValue('')
  await expect(source.getByText('空行会忽略；名单留空时不导入任何图标。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await source.screenshot({ path: testInfo.outputPath('iconify-source-mobile.png') })
  await page.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  expect(submissions[0]!.sources).toEqual([
    { type: 'iconify', file: 'vendor/icons.json', include: [] },
  ])

  await page.reload()
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await expect(source.getByLabel('导入范围')).toHaveValue('selected')
  await source.getByLabel('导入范围').selectOption('all')
  await expect(source.getByLabel('图标名称（每行一个）')).toHaveCount(0)
  await page.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  expect(submissions[1]!.sources).toEqual([
    { type: 'iconify', file: 'vendor/icons.json' },
  ])
})

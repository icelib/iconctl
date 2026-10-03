import type { Project, ProjectInput } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import type { EditorApi, Gate } from './editor-fixture'
import { expect } from '@playwright/test'
import { discardDraft } from './draft-navigation'
import { advanceState, alpha, answer, baseline, beta, form, hold, id, input, mutations, open, save, test } from './editor-fixture'

test('keeps a late alpha save out of beta and sends the next beta request to its own revision and complete draft', async ({ page, editorApi }) => {
  await open(page)
  await page.getByLabel('图标前缀', { exact: true }).fill('alpha-saved')
  const first = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, first)
  await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
  await discardDraft(page)
  await page.getByLabel('图标前缀', { exact: true }).fill('beta-local')
  const source = page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })
  await source.fill('raw/beta-local')
  await expect(form(page).locator('button[type=submit]')).toBeDisabled()
  const saved = { ...alpha, prefix: 'alpha-saved', revision: 2 }
  await answer(page, first, { json: saved })
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(beta.id)
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('beta-local')
  await expect(source).toHaveValue('raw/beta-local')
  await expect(source).toBeFocused()
  await baseline(page, 7)
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  const second = hold(editorApi, 'PUT', `/api/projects/${beta.id}`)
  await save(page, second)
  const expected = { ...input(beta), prefix: 'beta-local', sources: [{ type: 'directory', dir: 'raw/beta-local' }] }
  expect(second.request?.body).toEqual({ revision: 7, project: expected })
  expect(first.request?.body).toEqual({ revision: 1, project: { ...input(alpha), prefix: 'alpha-saved' } })
  await answer(page, second, { json: { ...beta, ...expected, revision: 8 } })
  await page.getByRole('button', { name: '图标项目', exact: true }).click()
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('alpha-saved')
  await baseline(page, 2)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`does not let an old alpha ${outcome} take over a reopened alpha editor`, async ({ page, editorApi }) => {
    await open(page)
    await page.getByLabel('图标前缀', { exact: true }).fill('old-submission')
    const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
    await save(page, gate)
    await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
    await discardDraft(page)
    await page.getByLabel('当前项目', { exact: true }).selectOption(alpha.id)
    const prefix = page.getByLabel('图标前缀', { exact: true })
    await prefix.fill('new-session')
    await answer(page, gate, outcome === 'success'
      ? { json: { ...alpha, prefix: 'old-normalized', revision: 2 } }
      : { status: 409, json: { error: 'Old alpha conflict' } })
    await expect(prefix).toHaveValue('new-session')
    await expect(prefix).toBeFocused()
    await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(alpha.id)
    await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
    await expect(page.getByLabel('保存失败', { exact: true })).toBeHidden()
    expect(mutations(editorApi)).toHaveLength(1)
  })
}

test('invalidates save ownership when leaving and reentering the same editor', async ({ page, editorApi }) => {
  await open(page)
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, gate)
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  await page.getByRole('button', { name: '项目配置', exact: true }).click()
  const color = page.getByLabel('统一颜色', { exact: true })
  await color.fill('#123456')
  await answer(page, gate, { json: { ...alpha, color: '#abcdef', revision: 2 } })
  await expect(color).toHaveValue('#123456')
  await expect(color).toBeFocused()
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
})

test('freezes a save body while preserving subsequent scalar and nested edits for the next revision', async ({ page, editorApi }) => {
  await open(page)
  const first = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, first)
  await page.getByLabel('图标前缀', { exact: true }).fill('alpha-next')
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/next')
  await page.getByLabel('宽度', { exact: true }).fill('32')
  await page.getByLabel('svg', { exact: true }).uncheck()
  await page.getByText('高级配置 · 仓库中的命名函数', { exact: true }).click()
  await page.getByLabel('配置路径', { exact: true }).fill('next.config.ts')
  await form(page).dispatchEvent('submit')
  expect(mutations(editorApi)).toHaveLength(1)
  expect(first.request?.body).toEqual({ revision: 1, project: input(alpha) })
  await answer(page, first, { json: { ...alpha, revision: 2 } })
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('alpha-next')
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/next')
  await expect(page.getByLabel('宽度', { exact: true })).toHaveValue('32')
  await expect(page.getByLabel('svg', { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('配置路径', { exact: true })).toHaveValue('next.config.ts')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  await baseline(page, 2)
  const next: ProjectInput = { ...input(alpha), prefix: 'alpha-next', sources: [{ type: 'directory', dir: 'raw/next' }], validate: { ...alpha.validate, width: 32 }, output: { ...alpha.output, svg: false }, advancedConfig: { ...alpha.advancedConfig!, path: 'next.config.ts' } }
  const second = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, second)
  expect(second.request?.body).toEqual({ revision: 2, project: next })
  await answer(page, second, { json: { ...alpha, ...next, revision: 3 } })
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  expect(mutations(editorApi)).toHaveLength(2)
})

test('accepts normalized saved fields and becomes clean again when edits return to that baseline', async ({ page, editorApi }) => {
  await open(page)
  const prefix = page.getByLabel('图标前缀', { exact: true })
  const directory = page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })
  await prefix.fill('submitted')
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, gate)
  await form(page).dispatchEvent('submit')
  expect(mutations(editorApi)).toHaveLength(1)
  await answer(page, gate, { json: { ...alpha, prefix: 'normalized', sources: [{ type: 'directory', dir: 'normalized/icons' }], revision: 2 } })
  await expect(prefix).toHaveValue('normalized')
  await expect(directory).toHaveValue('normalized/icons')
  await expect(page.getByLabel('保存状态', { exact: true })).toContainText('已保存')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  await prefix.fill('temporary')
  await directory.fill('temporary/icons')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  await prefix.fill('normalized')
  await directory.fill('normalized/icons')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  expect(mutations(editorApi)).toHaveLength(1)
})

async function create(page: Page, api: EditorApi) {
  await page.goto('/app/')
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click()
  await page.getByLabel('项目名称', { exact: true }).fill('created-icons')
  await page.getByLabel('GitHub 仓库', { exact: true }).fill('fixture/created')
  await page.getByLabel('图标前缀', { exact: true }).fill('created')
  await page.getByLabel('公开 npm 包名', { exact: true }).fill('@fixture/created-icons')
  const gate = hold(api, 'POST', '/api/projects')
  await save(page, gate)
  const project = { ...alpha, ...gate.request!.body as ProjectInput, id: id(703), revision: 1 }
  delete project.advancedConfig
  return { gate, project }
}

test('adopts the created project ID without discarding later input or creating a duplicate project', async ({ page, editorApi }) => {
  const { gate, project } = await create(page, editorApi)
  await page.getByLabel('图标前缀', { exact: true }).fill('created-later')
  await answer(page, gate, { json: project })
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(project.id)
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('created-later')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  const update = hold(editorApi, 'PUT', `/api/projects/${project.id}`)
  await save(page, update)
  expect(update.request?.body).toEqual({ revision: 1, project: { ...input(project), prefix: 'created-later' } })
  await answer(page, update, { json: { ...project, prefix: 'created-later', revision: 2 } })
  expect(mutations(editorApi).map(request => request.method)).toEqual(['POST', 'PUT'])
})

test('records a late new project without selecting it or replacing the current beta draft', async ({ page, editorApi }) => {
  const { gate, project } = await create(page, editorApi)
  await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
  await discardDraft(page)
  const prefix = page.getByLabel('图标前缀', { exact: true })
  await prefix.fill('beta-still-editing')
  await answer(page, gate, { json: project })
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(beta.id)
  await expect(prefix).toHaveValue('beta-still-editing')
  await expect(prefix).toBeFocused()
  await baseline(page, 7)
  await page.getByRole('button', { name: '图标项目', exact: true }).click()
  await discardDraft(page)
  await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible()
  expect(mutations(editorApi)).toHaveLength(1)
})

for (const conflict of ['Project changed', 'Project changed or a task is active']) {
  test(`keeps a conflicted draft until explicit reload without retrying: ${conflict}`, async ({ page, editorApi }, info) => {
    if (conflict === 'Project changed') {
      await page.setViewportSize({ width: 390, height: 844 })
    }
    await open(page)
    await page.getByLabel('图标前缀', { exact: true }).fill('keep-my-draft')
    await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/keep')
    const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
    await save(page, gate)
    await answer(page, gate, { status: 409, json: { error: conflict } })
    await expect(page.getByLabel('保存失败', { exact: true })).toContainText(conflict)
    await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('keep-my-draft')
    await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/keep')
    await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
    const latest = { ...alpha, prefix: 'server-current', revision: conflict === 'Project changed' ? 3 : 1 }
    editorApi.state.projects = [latest, structuredClone(beta)]
    await page.clock.fastForward(20_000)
    await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('keep-my-draft')
    expect(mutations(editorApi)).toHaveLength(1)
    await expect(form(page)).toContainText('替换当前草稿')
    const reload = page.getByRole('button', { name: '载入最新配置', exact: true })
    if (conflict === 'Project changed') {
      await reload.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('project-conflict-mobile.png') })
    }
    await reload.focus()
    await reload.press('Enter')
    await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('server-current')
    await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/alpha')
    await baseline(page, latest.revision)
    await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
    expect(mutations(editorApi)).toHaveLength(1)
  })
}

for (const method of ['PUT', 'POST'] as const) {
  test(`keeps a successful ${method} distinct from a failed state refresh and retries only the read`, async ({ page, editorApi }, info) => {
    if (method === 'PUT') {
      await page.setViewportSize({ width: 390, height: 844 })
      await open(page)
    }
    let gate: Gate
    let project: Project
    if (method === 'POST') {
      ({ gate, project } = await create(page, editorApi))
    }
    else {
      gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
      project = { ...alpha, revision: 2 }
      await save(page, gate)
    }
    const refresh = hold(editorApi, 'GET', '/api/state')
    await answer(page, gate, { json: project })
    await answer(page, refresh, { status: 502, json: { error: 'Workspace read failed' } })
    await expect(page.getByLabel('保存状态', { exact: true })).toContainText('已保存')
    await expect(page.getByLabel('工作空间刷新失败', { exact: true })).toBeVisible()
    await expect(page.getByLabel('保存失败', { exact: true })).toBeHidden()
    await baseline(page, project.revision)
    if (method === 'PUT') {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: info.outputPath('saved-state-refresh-failed-mobile.png'), fullPage: true })
    }
    await page.getByLabel('图标前缀', { exact: true }).fill('after-save')
    const retry = hold(editorApi, 'GET', '/api/state')
    const trigger = page.getByRole('button', { name: '重新刷新工作空间', exact: true })
    await trigger.focus()
    await trigger.press('Enter')
    await expect.poll(() => retry.entered).toBe(true)
    expect(mutations(editorApi)).toHaveLength(1)
    await answer(page, retry, { json: editorApi.state })
    await expect(page.getByLabel('工作空间刷新失败', { exact: true })).toBeHidden()
    await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('after-save')
    await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
    expect(mutations(editorApi)).toHaveLength(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`saved-${method.toLowerCase()}-read-recovered.png`), fullPage: true })
  })
}

test('does not roll a saved project back when a previously started state read completes late', async ({ page, editorApi }) => {
  await open(page)
  const old = await advanceState(page, editorApi, editorApi.state)
  await page.getByLabel('图标前缀', { exact: true }).fill('saved-v2')
  const saveGate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, saveGate)
  await answer(page, saveGate, { json: { ...alpha, prefix: 'saved-v2', revision: 2 } })
  await baseline(page, 2)
  await answer(page, old.gate, { json: old.value })
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('saved-v2')
  await baseline(page, 2)
  await page.getByRole('button', { name: '图标项目', exact: true }).click()
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('saved-v2')
  await baseline(page, 2)
})

test('keeps a newer server revision separate from the older successful editor baseline until explicit recovery', async ({ page, editorApi }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const read = await advanceState(page, editorApi, editorApi.state)
  await page.getByLabel('图标前缀', { exact: true }).fill('submitted-v2')
  const saveGate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, saveGate)
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/unsaved-after-submit')
  const newer = { ...alpha, prefix: 'server-v3', revision: 3 }
  editorApi.state.projects = [newer, structuredClone(beta)]
  await answer(page, read.gate, { json: editorApi.state })
  await answer(page, saveGate, { json: { ...alpha, prefix: 'submitted-v2', revision: 2 } })
  await baseline(page, 2)
  await expect(page.getByLabel('服务器配置已更新', { exact: true })).toBeVisible()
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('submitted-v2')
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/unsaved-after-submit')
  await expect(form(page).locator('button[type=submit]')).toBeDisabled()
  await form(page).dispatchEvent('submit')
  expect(mutations(editorApi)).toHaveLength(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('newer-server-revision-mobile.png'), fullPage: true })
  const recover = page.getByRole('button', { name: '载入最新配置', exact: true })
  await expect(form(page)).toContainText('替换当前草稿')
  await recover.focus()
  await recover.press('Enter')
  await baseline(page, 3)
  await expect(page.getByLabel('图标前缀', { exact: true })).toHaveValue('server-v3')
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/alpha')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  await expect(page.getByLabel('服务器配置已更新', { exact: true })).toBeHidden()
  expect(mutations(editorApi)).toHaveLength(1)
  await page.getByRole('button', { name: '图标项目', exact: true }).click()
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
  await baseline(page, 3)
})

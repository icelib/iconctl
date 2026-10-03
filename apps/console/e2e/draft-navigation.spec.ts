import type { Job, ProjectInput } from '@iconctl/console-contracts'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { discardDraft, navigationDialog } from './draft-navigation'
import { advanceState, alpha, answer, baseline, beta, hold, id, input, mutations, open, save, test } from './editor-fixture'

const prefix = (page: Page) => page.getByLabel('图标前缀', { exact: true })
const current = (page: Page) => page.getByLabel('当前项目', { exact: true })
const configNavigation = (page: Page) => page.getByRole('button', { name: '项目配置', exact: true })
const draftInput: ProjectInput = {
  ...input(alpha),
  prefix: 'unsaved-prefix',
  sources: [{ type: 'directory', dir: 'raw/unsaved' }],
  validate: { ...alpha.validate, width: 32 },
  output: { ...alpha.output, svg: false },
  advancedConfig: { ...alpha.advancedConfig!, path: 'unsaved.config.ts' },
}

async function editCompleteDraft(page: Page) {
  await prefix(page).fill(draftInput.prefix)
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/unsaved')
  await page.getByLabel('宽度', { exact: true }).fill('32')
  await page.getByLabel('svg', { exact: true }).uncheck()
  await page.getByText('高级配置 · 仓库中的命名函数', { exact: true }).click()
  await page.getByLabel('配置路径', { exact: true }).fill('unsaved.config.ts')
}

async function expectCompleteDraft(page: Page) {
  await expect(prefix(page)).toHaveValue(draftInput.prefix)
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/unsaved')
  await expect(page.getByLabel('宽度', { exact: true })).toHaveValue('32')
  await expect(page.getByLabel('svg', { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('配置路径', { exact: true })).toHaveValue('unsaved.config.ts')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeVisible()
  await expect(current(page)).toHaveValue(alpha.id)
}

async function cancelNavigation(page: Page) {
  const dialog = navigationDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('preserves the complete draft and save ownership when activating the current editor again', async ({ page, editorApi }, info) => {
  await open(page)
  await editCompleteDraft(page)
  await configNavigation(page).click()
  await expect(navigationDialog(page)).toBeHidden()
  await expectCompleteDraft(page)
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, gate)
  await configNavigation(page).click()
  await expect(navigationDialog(page)).toBeHidden()
  await expectCompleteDraft(page)
  expect(gate.request?.body).toEqual({ revision: 1, project: draftInput })
  await answer(page, gate, { json: { ...alpha, ...draftInput, revision: 2 } })
  await baseline(page, 2)
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  expect(mutations(editorApi)).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('same-editor-preserved.png'), fullPage: true })
})

test('keeps a new draft when the current configuration navigation still has an older project selected', async ({ page, editorApi }) => {
  await page.goto('/app/')
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click()
  await page.getByLabel('项目名称', { exact: true }).fill('new-unsaved-project')
  await prefix(page).fill('new-unsaved')
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/new-unsaved')
  await configNavigation(page).click()
  await expect(navigationDialog(page)).toBeHidden()
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('new-unsaved-project')
  await expect(prefix(page)).toHaveValue('new-unsaved')
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/new-unsaved')
  await expect(page.getByLabel('编辑基线', { exact: true })).toHaveCount(0)
  expect(mutations(editorApi)).toHaveLength(0)
})

test('defers keyboard project selection until confirmation and Escape restores the native selector and full draft', async ({ page, editorApi }) => {
  await open(page)
  await editCompleteDraft(page)
  const select = current(page)
  await select.focus()
  // Native select type-ahead commits on both macOS and Linux Chromium.
  await select.press('b')
  await expect(navigationDialog(page)).toBeVisible()
  await expectCompleteDraft(page)
  await expect(page.getByRole('heading', { name: '项目配置', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(navigationDialog(page)).toBeHidden()
  await expect(select).toBeFocused()
  await expectCompleteDraft(page)
  expect(mutations(editorApi)).toHaveLength(0)
  // Native select type-ahead commits on both macOS and Linux Chromium.
  await select.press('b')
  const confirm = navigationDialog(page).getByRole('button', { name: '放弃修改并继续', exact: true })
  await confirm.focus()
  await confirm.press('Enter')
  await expect(navigationDialog(page)).toBeHidden()
  await expect(select).toHaveValue(beta.id)
  await expect(prefix(page)).toHaveValue(beta.prefix)
  await baseline(page, beta.revision)
  expect(mutations(editorApi)).toHaveLength(0)
})

test('keeps a long-name mobile confirmation and its keyboard focus inside the dialog', async ({ page, editorApi }, info) => {
  const name = '设计系统项目'.repeat(14)
  editorApi.state.projects[0]!.name = name
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, { ...alpha, name })
  await prefix(page).fill('mobile-unsaved')
  const trigger = page.getByRole('button', { name: '任务与版本', exact: true })
  await trigger.click()
  const dialog = navigationDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(name)
  const cancel = dialog.getByRole('button', { name: '继续编辑', exact: true })
  const confirm = dialog.getByRole('button', { name: '放弃修改并继续', exact: true })
  await expect(cancel).toBeInViewport()
  await expect(confirm).toBeInViewport()
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 80) }))).toMatchObject({ inside: true })
  }
  await page.keyboard.press('Shift+Tab')
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('dirty-navigation-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(prefix(page)).toHaveValue('mobile-unsaved')
})

for (const destination of ['图标项目', '预览与差异', '任务与版本', '授权与插件']) {
  test(`protects a draft before navigating to ${destination} and runs only the confirmed intent`, async ({ page, editorApi }) => {
    await open(page)
    await editCompleteDraft(page)
    const trigger = page.getByRole('button', { name: destination, exact: true })
    await trigger.click()
    await expectCompleteDraft(page)
    await cancelNavigation(page)
    await expect(trigger).toBeFocused()
    await expectCompleteDraft(page)
    await trigger.click()
    await discardDraft(page)
    await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible()
    expect(mutations(editorApi)).toHaveLength(0)
  })
}

test('navigates directly when every edited field returns to its baseline', async ({ page, editorApi }) => {
  await open(page)
  await prefix(page).fill('temporary')
  await prefix(page).fill(alpha.prefix)
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('temporary/directory')
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/alpha')
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  await current(page).selectOption(beta.id)
  await expect(navigationDialog(page)).toBeHidden()
  await expect(prefix(page)).toHaveValue(beta.prefix)
  expect(mutations(editorApi)).toHaveLength(0)
})

test('requires explicit continuation when a pending save completes inside the navigation dialog', async ({ page, editorApi }) => {
  await open(page)
  await prefix(page).fill('saved-in-dialog')
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, gate)
  await current(page).selectOption(beta.id)
  await expect(navigationDialog(page)).toBeVisible()
  await answer(page, gate, { json: { ...alpha, prefix: 'saved-in-dialog', revision: 2 } })
  await baseline(page, 2)
  await expect(current(page)).toHaveValue(alpha.id)
  await expect(navigationDialog(page)).toBeVisible()
  await expect(navigationDialog(page).getByRole('button', { name: '放弃修改并继续', exact: true })).toHaveCount(0)
  await navigationDialog(page).getByRole('button', { name: '继续前往', exact: true }).click()
  await expect(current(page)).toHaveValue(beta.id)
  await expect(prefix(page)).toHaveValue(beta.prefix)
  expect(mutations(editorApi)).toHaveLength(1)
})

test('keeps input made after submit protected and sends the next save at the returned revision after cancellation', async ({ page, editorApi }) => {
  await open(page)
  await prefix(page).fill('submitted')
  const first = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, first)
  await page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true }).fill('raw/after-submit')
  await current(page).selectOption(beta.id)
  await answer(page, first, { json: { ...alpha, prefix: 'submitted', revision: 2 } })
  await expect(navigationDialog(page).getByRole('button', { name: '放弃修改并继续', exact: true })).toBeVisible()
  await cancelNavigation(page)
  await expect(current(page)).toHaveValue(alpha.id)
  await expect(page.getByLabel('仓库内目录 / ZIP 子目录', { exact: true })).toHaveValue('raw/after-submit')
  await baseline(page, 2)
  const second = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, second)
  const expected = { ...input(alpha), prefix: 'submitted', sources: [{ type: 'directory', dir: 'raw/after-submit' }] }
  expect(second.request?.body).toEqual({ revision: 2, project: expected })
  await answer(page, second, { json: { ...alpha, ...expected, revision: 3 } })
  await current(page).selectOption(beta.id)
  await expect(navigationDialog(page)).toBeHidden()
  await expect(current(page)).toHaveValue(beta.id)
  expect(mutations(editorApi)).toHaveLength(2)
})

test('preserves a current save conflict and its explicit recovery when navigation is canceled', async ({ page, editorApi }) => {
  await open(page)
  await editCompleteDraft(page)
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  await save(page, gate)
  await current(page).selectOption(beta.id)
  await answer(page, gate, { status: 409, json: { error: 'Project changed' } })
  await cancelNavigation(page)
  await expectCompleteDraft(page)
  await expect(page.getByLabel('保存失败', { exact: true })).toContainText('Project changed')
  await expect(page.getByRole('button', { name: '载入最新配置', exact: true })).toBeVisible()
  expect(mutations(editorApi)).toHaveLength(1)
})

test('preserves saved-but-unrefreshed recovery and subsequent local input after canceled navigation', async ({ page, editorApi }) => {
  await open(page)
  const gate = hold(editorApi, 'PUT', `/api/projects/${alpha.id}`)
  const read = hold(editorApi, 'GET', '/api/state')
  await save(page, gate)
  await answer(page, gate, { json: { ...alpha, revision: 2 } })
  await answer(page, read, { status: 502, json: { error: 'Read unavailable' } })
  await prefix(page).fill('after-save')
  await current(page).selectOption(beta.id)
  await cancelNavigation(page)
  await expect(prefix(page)).toHaveValue('after-save')
  await expect(page.getByLabel('工作空间刷新失败', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新刷新工作空间', exact: true })).toBeVisible()
  await baseline(page, 2)
  expect(mutations(editorApi)).toHaveLength(1)
})

test('keeps the older draft revision and server-changed recovery when canceling navigation', async ({ page, editorApi }) => {
  await open(page)
  await editCompleteDraft(page)
  const read = await advanceState(page, editorApi, { ...editorApi.state, projects: [{ ...alpha, prefix: 'server-v3', revision: 3 }, structuredClone(beta)] })
  await answer(page, read.gate, { json: read.value })
  await expect(page.getByLabel('服务器配置已更新', { exact: true })).toBeVisible()
  await current(page).selectOption(beta.id)
  await cancelNavigation(page)
  await expectCompleteDraft(page)
  await baseline(page, 1)
  await expect(page.getByLabel('服务器配置已更新', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '载入最新配置', exact: true })).toBeVisible()
  expect(mutations(editorApi)).toHaveLength(0)
})

test('sends logout only after confirmation and preserves the draft when that action fails', async ({ page, editorApi }) => {
  await open(page)
  await editCompleteDraft(page)
  const logout = page.getByRole('button', { name: '退出登录', exact: true })
  await logout.click()
  await cancelNavigation(page)
  await expect(logout).toBeFocused()
  expect(mutations(editorApi)).toHaveLength(0)
  const gate = hold(editorApi, 'POST', '/api/logout')
  await logout.click()
  const confirm = navigationDialog(page).getByRole('button', { name: '放弃修改并继续', exact: true })
  // Two queued DOM clicks reproduce rapid repeated activation without waiting
  // for a disabled control to become enabled again.
  await confirm.evaluate((element) => {
    (element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  await expect.poll(() => gate.entered).toBe(true)
  expect(mutations(editorApi)).toHaveLength(1)
  await answer(page, gate, { status: 502, json: { error: 'Logout unavailable' } })
  await expect(page.getByLabel('导航失败', { exact: true })).toContainText('Logout unavailable')
  await expectCompleteDraft(page)
  expect(mutations(editorApi)).toHaveLength(1)
})

test('uses the browser beforeunload event for a dirty editor and removes it after returning to the baseline', async ({ page, editorApi }) => {
  await open(page)
  await prefix(page).fill('reload-protected')
  const dialog = page.waitForEvent('dialog')
  const reload = page.evaluate(() => location.reload())
  const warning = await dialog
  expect(warning.type()).toBe('beforeunload')
  await warning.dismiss()
  await reload
  await expect(prefix(page)).toHaveValue('reload-protected')
  await expect(navigationDialog(page)).toBeHidden()
  await prefix(page).fill(alpha.prefix)
  await expect(page.getByLabel('未保存修改', { exact: true })).toBeHidden()
  const unexpected: string[] = []
  page.on('dialog', async (event) => {
    unexpected.push(event.type())
    await event.dismiss()
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: '图标项目', exact: true })).toBeVisible()
  expect(unexpected).toEqual([])
  expect(mutations(editorApi)).toHaveLength(0)
})

test('records a successful task without leaving a dirty editor, and explicit Locate asks once without submitting again', async ({ page, editorApi }) => {
  await open(page)
  await editCompleteDraft(page)
  const gate = hold(editorApi, 'POST', `/api/projects/${alpha.id}/jobs`)
  await page.getByRole('button', { name: '仅校验', exact: true }).click()
  await expect.poll(() => gate.entered).toBe(true)
  const job: Job = {
    id: id(750),
    projectId: alpha.id,
    project: structuredClone(alpha),
    operation: 'check',
    status: 'queued',
    stage: 'queued',
    sourceCommit: 'a'.repeat(40),
    workflowCommit: 'b'.repeat(40),
    executorCommit: 'c'.repeat(40),
    workflowDigest: 'd'.repeat(64),
    createdAt: alpha.createdAt,
    updatedAt: alpha.createdAt,
    dispatchAttempts: 1,
    attempt: 1,
  }
  editorApi.state.jobs = [job]
  await answer(page, gate, { status: 202, json: job })
  await expectCompleteDraft(page)
  await expect(navigationDialog(page)).toBeHidden()
  await expect(page.getByLabel('任务提交失败', { exact: true })).toBeHidden()
  const locate = page.getByLabel('提交任务已完成', { exact: true }).getByRole('button', { name: '定位任务', exact: true })
  await locate.click()
  await cancelNavigation(page)
  await expect(locate).toBeFocused()
  await expectCompleteDraft(page)
  await locate.click()
  await discardDraft(page)
  await expect(page.locator(`#job-${job.id}`)).toBeFocused()
  await expect(page.locator(`#job-${job.id}`)).toContainText('等待执行')
  expect(mutations(editorApi)).toHaveLength(1)
  expect(gate.request?.body).toEqual({ operation: 'check' })
})

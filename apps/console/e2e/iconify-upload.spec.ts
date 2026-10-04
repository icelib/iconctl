import type { ConsoleState, Job, Project, SnapshotPreview } from '@iconctl/console-contracts'
import type { Page, TestInfo } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createWorkerTest, expect } from './local-worker'

interface UploadFixture { projects: [Project, Project], repository: string, sourceCommit: string, session: { token: string, csrf: string } }
const collection = { prefix: 'vendor', width: 32, height: 16, icons: { home: { body: '<path fill="#f00" d="M1 1h12v8H1z"/>' } }, aliases: { rotated: { parent: 'home', rotate: 1 }, reflected: { parent: 'rotated', hFlip: true }, broken: { parent: 'missing' } }, info: { name: '中文🙂' } }
const file = { name: '设计图标-中文🙂.json', mimeType: 'application/json', buffer: Buffer.from(`\uFEFF${JSON.stringify(collection)}`) }
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const source = (page: Page, index = 1) => page.getByRole('group', { name: `iconify ${index}`, exact: true })
const input = (page: Page, index = 1) => source(page, index).getByLabel('上传 Iconify JSON（最多 10 MiB）')
const failure = (page: Page) => source(page).getByRole('alert', { name: '来源上传失败', exact: true })
const save = (page: Page) => page.getByRole('button', { name: '保存项目', exact: true })
const pathInput = (page: Page) => source(page).getByLabel('仓库内 JSON 文件路径')
const test = createWorkerTest<UploadFixture>('iconify-upload').extend<{ uploadReady: void }>({
  uploadReady: [async ({ context, page, localWorker }, use, info) => {
    const errors: string[] = []
    const calls: { url: string, method: string, status: number }[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/')) {
        calls.push({ url: response.url(), method: response.request().method(), status: response.status() })
      }
    })
    await page.route('**/api/**', async route => route.fulfill({ response: await route.fetch({ headers: { ...await route.request().allHeaders(), origin: 'https://iconify-upload.test' } }) }))
    await context.addCookies([{ name: '__Host-iconctl-session', value: localWorker.fixture.session.token, domain: new URL(localWorker.origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }])
    try {
      await use()
    }
    finally {
      await writeFile(info.outputPath('iconify-http-evidence.json'), JSON.stringify({ calls, errors, unexpected: localWorker.unexpectedRequests }, null, 2))
      expect(errors).toEqual([])
      expect(localWorker.unexpectedRequests).toEqual([])
    }
  }, { auto: true }],
})
async function open(page: Page, origin: string) {
  await page.goto(`${origin}/app/`)
  await page.getByRole('button', { name: 'upload-icons', exact: true }).click()
  await expect(pathInput(page)).toHaveValue('vendor/icons.json')
}
async function upload(page: Page, payload = file) {
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/uploads')
  await input(page).setInputFiles(payload)
  const response = await next
  expect(response.status()).toBe(201)
  expect(response.request().url()).toContain('kind=iconify-json')
  expect(response.request().headers()['content-type']).toBe('application/json')
  const uploaded = await response.json() as { id: string, digest: string }
  expect(uploaded.digest).toBe(hash(payload.buffer))
  await expect(source(page)).toContainText(uploaded.id)
  await expect(pathInput(page)).toHaveCount(0)
  return uploaded
}
async function saveProject(page: Page) {
  const next = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.startsWith('/api/projects/'))
  await save(page).click()
  const response = await next
  expect(response.status()).toBe(200)
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  return await response.json() as Project
}
async function run(page: Page, origin: string, fixture: UploadFixture, info: TestInfo, operation: 'sync' | 'check' | 'dry-run' = 'sync') {
  const next = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/jobs') && response.request().method() === 'POST')
  await page.getByRole('button', { name: { 'sync': '同步图标', 'check': '仅校验', 'dry-run': 'Dry run' }[operation], exact: true }).click()
  const response = await next
  expect(response.status()).toBe(202)
  const job = await response.json() as Job
  expect(job.operation).toBe(operation)
  expect(job.sourceCommit).toBe(fixture.sourceCommit)
  const signed = await page.request.post(`${origin}/__fixtures/iconify-upload/runner`, { data: { jobId: job.id } })
  expect(signed.ok()).toBe(true)
  const directory = await mkdtemp(join(tmpdir(), 'iconctl-json-runner-'))
  try {
    const work = join(directory, 'work')
    const path = join(directory, 'input.json')
    await writeFile(path, JSON.stringify({ ...await signed.json(), origin, repository: fixture.repository, work }))
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/iconify-upload-runner.mjs', import.meta.url)), path], { timeout: 20_000 })
    const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { succeeded: boolean, error?: string, requests: { path: string, status: number, mime: string, digest: string }[], workRemoved: boolean }
    await writeFile(info.outputPath(`runner-${job.id}.json`), JSON.stringify(outcome, null, 2))
    expect(outcome.workRemoved).toBe(true)
    expect(outcome.requests.every(request => request.status < 300)).toBe(true)
    expect(outcome.requests.some(request => request.path === 'snapshot'), JSON.stringify(outcome)).toBe(true)
    await page.goto(`${origin}/app/?job=${job.id}`)
    const row = page.locator(`#job-${job.id}`)
    await expect(row).toBeFocused()
    await row.getByRole('button', { name: '查看快照', exact: true }).click()
    await expect(page.getByLabel('快照尝试', { exact: true })).toContainText('第 1 次尝试')
    const state = await (await page.request.get(`${origin}/api/state`, { headers: { cookie: `__Host-iconctl-session=${fixture.session.token}` } })).json() as ConsoleState
    const completed = state.jobs.find(item => item.id === job.id)!
    const preview = await (await page.request.get(`${origin}/api/snapshots/${completed.snapshotId}`, { headers: { cookie: `__Host-iconctl-session=${fixture.session.token}` } })).json() as SnapshotPreview
    await writeFile(info.outputPath(`snapshot-${job.id}.json`), JSON.stringify(preview, null, 2))
    return { job, completed, preview, outcome }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function downloadCollection(page: Page, info: TestInfo, preview: SnapshotPreview, name: string) {
  const response = page.waitForResponse(`**/api/snapshots/${preview.snapshot.id}/icons.json`)
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载完整 Iconify JSON', exact: true }).click()
  const file = await pending
  expect(await file.failure()).toBeNull()
  const http = await response
  expect(http.status()).toBe(200)
  expect(http.headers()).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'content-security-policy': 'sandbox; default-src \'none\'' })
  expect(file.suggestedFilename()).toBe(`iconctl-icons-${preview.snapshot.id}-${preview.snapshot.digest.slice(0, 12)}.json`)
  const path = info.outputPath(name)
  await file.saveAs(path)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(preview.content.json)
  await writeFile(info.outputPath(`${name}.http.json`), JSON.stringify({ status: http.status(), headers: http.headers(), filename: file.suggestedFilename() }, null, 2))
  return path
}

for (const operation of ['check', 'dry-run'] as const) {
  test(`downloads a complete no-files snapshot from the real ${operation} runner and reads it with the current CLI`, async ({ page, localWorker }, info) => {
    await open(page, localWorker.origin)
    await upload(page)
    await source(page).getByLabel('导入范围').selectOption('selected')
    await source(page).getByLabel('图标名称（每行一个）').fill('home\nreflected')
    await saveProject(page)
    const { completed, preview, outcome } = await run(page, localWorker.origin, localWorker.fixture, info, operation)
    expect(completed.status).toBe('succeeded')
    expect(outcome.succeeded).toBe(true)
    expect(preview.content.files).toEqual({})
    expect(Object.keys(preview.content.json.icons)).toEqual(['home', 'reflected'])
    await expect(page.getByRole('link', { name: 'icons.json ↓', exact: true })).toHaveCount(0)
    await page.getByLabel('搜索图标', { exact: true }).fill('nothing-visible')
    await expect(page.getByText('没有符合条件的图标。', { exact: true })).toBeVisible()
    const path = await downloadCollection(page, info, preview, `${operation}-collection.json`)
    if (operation === 'check') {
      const cli = fileURLToPath(new URL('../../cli/dist/cli.mjs', import.meta.url))
      const commands = [
        ['preview', '--input', path, '--output', info.outputPath('downloaded-preview.html'), '--json'],
        ['diff', path, path, '--json'],
        ['sprite', '--input', path, '--output', info.outputPath('downloaded-sprite.svg'), '--json'],
      ]
      const results = []
      for (const args of commands) {
        const result = await promisify(execFile)(process.execPath, [cli, ...args], { timeout: 20_000 })
        results.push({ args, stdout: result.stdout, stderr: result.stderr })
      }
      expect(await readFile(info.outputPath('downloaded-preview.html'), 'utf8')).toContain('home')
      expect(await readFile(info.outputPath('downloaded-sprite.svg'), 'utf8')).toContain('<symbol')
      await writeFile(info.outputPath('downloaded-cli-interop.json'), JSON.stringify(results, null, 2))
    }
  })
}

test('downloads an actual failed check snapshot after retry makes it historical without hiding its diagnostics', async ({ page, localWorker }, info) => {
  await open(page, localWorker.origin)
  await upload(page)
  await source(page).getByLabel('导入范围').selectOption('selected')
  await source(page).getByLabel('图标名称（每行一个）').fill('home\nbroken')
  await saveProject(page)
  const { completed, preview, outcome } = await run(page, localWorker.origin, localWorker.fixture, info, 'check')
  expect(outcome.succeeded).toBe(false)
  expect(completed.status).toBe('failed')
  expect(preview.content.files).toEqual({})
  expect(preview.content.failed).toEqual(['broken'])
  expect(Object.keys(preview.content.json.icons)).toEqual(['home'])
  await page.getByRole('button', { name: '任务与版本', exact: true }).click()
  const retried = page.waitForResponse(`**/api/jobs/${completed.id}/retry`)
  await page.locator(`#job-${completed.id}`).getByRole('button', { name: '重试', exact: true }).click()
  expect((await retried).status()).toBe(202)
  await page.getByRole('button', { name: '预览与差异', exact: true }).click()
  await page.getByLabel('选择快照', { exact: true }).selectOption(preview.snapshot.id)
  await expect(page.getByLabel('快照诊断', { exact: true })).toContainText('broken')
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
  await expect(page.getByText('此快照包含问题，集合可能不完整；下载不代表校验通过。', { exact: true })).toBeVisible()
  await downloadCollection(page, info, preview, 'failed-historical-check.json')
  await expect(page.getByLabel('快照诊断', { exact: true })).toContainText('broken')
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
})

test('uploads original JSON bytes, saves a frozen revision and renders a real runner alias snapshot absent from Git', async ({ page, localWorker }, info) => {
  await open(page, localWorker.origin)
  const uploaded = await upload(page)
  await source(page).getByLabel('导入范围').selectOption('selected')
  await source(page).getByLabel('图标名称（每行一个）').fill('reflected')
  await source(page).getByLabel('名称前缀（原样添加）').fill('v')
  const saved = await saveProject(page)
  expect(saved.revision).toBe(2)
  expect(saved.sources).toEqual([{ type: 'iconify', upload: uploaded.id, include: ['reflected'], namePrefix: 'v' }])
  await page.reload()
  await page.getByRole('button', { name: 'upload-icons', exact: true }).click()
  await expect(source(page)).toContainText(uploaded.id)
  await expect(pathInput(page)).toHaveCount(0)
  const { job, completed, preview, outcome } = await run(page, localWorker.origin, localWorker.fixture, info)
  expect(job.project.revision).toBe(saved.revision)
  expect(completed.status).toBe('succeeded')
  expect(outcome.succeeded).toBe(true)
  expect(outcome.requests.find(request => request.path === `uploads/${uploaded.id}`)).toMatchObject({ mime: 'application/json', digest: uploaded.digest })
  expect(Object.keys(preview.content.json.icons)).toEqual(['vreflected'])
  const icon = preview.content.json.icons['vreflected']!
  expect(icon.width ?? preview.content.json.width ?? 16).toBe(16)
  expect(icon.height ?? preview.content.json.height ?? 16).toBe(32)
  expect(icon.body).toContain('currentColor')
  expect(preview.content.issues).toEqual([])
  expect(preview.content.failed).toEqual([])
  expect(preview.content.sources).toEqual([{ type: 'iconify', notModified: false }])
  expect(Object.keys(preview.content.files)).toEqual(expect.arrayContaining(['icons.json', 'index.d.ts', 'preview.html', 'svg/vreflected.svg']))
  await expect(page.getByRole('img', { name: 'vreflected 之后', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('iconify-upload-runner.png'), fullPage: true })
})

test('rejects invalid JSON without replacing the repository source and snapshots a selected broken alias through the real runner', async ({ page, localWorker }, info) => {
  await open(page, localWorker.origin)
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/uploads')
  await input(page).setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') })
  expect((await next).status()).toBe(400)
  await expect(failure(page)).toContainText('JSON')
  await expect(pathInput(page)).toHaveValue('vendor/icons.json')
  await upload(page)
  await source(page).getByLabel('导入范围').selectOption('selected')
  await source(page).getByLabel('图标名称（每行一个）').fill('broken')
  await saveProject(page)
  const { completed, preview, outcome } = await run(page, localWorker.origin, localWorker.fixture, info)
  expect(outcome).toMatchObject({ succeeded: false, error: 'Icon validation failed' })
  expect(completed).toMatchObject({ status: 'failed', error: 'validation' })
  expect(preview.content.failed).toEqual(['broken'])
  expect(preview.content.issues[0]).toMatchObject({ sourceType: 'iconify', sourceIndex: 0, name: 'broken' })
  await expect(page.getByLabel('快照诊断', { exact: true })).toContainText('broken')
  await expect(page.getByRole('button', { name: '查看发布确认', exact: true })).toBeDisabled()
})

interface UploadGate {
  entered: boolean
  id?: string
  digest?: string
  kind?: string | null
  aborted: boolean
  release: (status?: number) => void
  handled: Promise<void>
}
async function interceptUploads(page: Page) {
  const gates: UploadGate[] = []
  const pending: Promise<void>[] = []
  await page.route('**/api/uploads*', async (route) => {
    const gate = gates.find(item => !item.entered)!
    expect(gate).toBeDefined()
    gate.kind = new URL(route.request().url()).searchParams.get('kind')
    page.on('requestfailed', (request) => {
      if (request === route.request()) {
        gate.aborted = true
      }
    })
    const actual = await route.fetch({ headers: { ...await route.request().allHeaders(), origin: 'https://iconify-upload.test' } })
    expect(actual.status()).toBe(201)
    const stored = await actual.json()
    gate.id = stored.id
    gate.digest = stored.digest
    gate.entered = true
    const response = await (gate as UploadGate & { response: Promise<number | undefined> }).response
    try {
      if (response) {
        await route.fulfill({ status: response, json: { error: 'Upload response interrupted' } })
      }
      else { await route.fulfill({ response: actual }) }
    }
    finally { (gate as UploadGate & { done: () => void }).done() }
  })
  return {
    gates,
    hold() {
      let release!: (status?: number) => void
      let done!: () => void
      const response = new Promise<number | undefined>(resolve => release = resolve)
      const handled = new Promise<void>(resolve => done = resolve)
      const gate = { entered: false, aborted: false, release, handled, response, done }
      gates.push(gate)
      pending.push(handled)
      return gate as UploadGate
    },
    async close() {
      for (const gate of gates) {
        gate.release()
      }
      await Promise.all(pending.filter((_, index) => gates[index]!.entered))
      await page.unroute('**/api/uploads*')
    },
  }
}
const uploadStatus = (page: Page) => source(page).getByRole('status', { name: '来源上传状态', exact: true })
const cancelUpload = (page: Page) => source(page).getByRole('button', { name: '取消上传', exact: true })
const restoreFile = (page: Page) => source(page).getByRole('button', { name: '恢复使用仓库文件', exact: true })
async function beginHeld(page: Page, gate: UploadGate, payload = file) {
  await input(page).setInputFiles(payload)
  await expect.poll(() => gate.entered).toBe(true)
  expect(gate.digest).toBe(hash(payload.buffer))
  expect(gate.kind).toBe('iconify-json')
  await expect(uploadStatus(page)).toContainText(payload.name)
  await expect(input(page)).toHaveValue('')
}

test('retains a saved upload on interrupted replacement and keyboard retries only that file with simultaneous options preserved at 390px', async ({ page, localWorker }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, localWorker.origin)
  const old = await upload(page)
  await saveProject(page)
  const api = await interceptUploads(page)
  const longFile = { ...file, name: `${'设计🙂'.repeat(18)}.json` }
  try {
    const failed = api.hold()
    await beginHeld(page, failed, longFile)
    await expect(source(page)).toContainText(old.id)
    await source(page).getByLabel('名称前缀（原样添加）').fill('kept-')
    failed.release(502)
    await failed.handled
    await expect(failure(page)).toContainText('Upload response interrupted')
    await expect(source(page).getByLabel('名称前缀（原样添加）')).toBeFocused()
    await expect(source(page)).toContainText(old.id)
    expect(api.gates).toHaveLength(1)
    const retry = api.hold()
    const button = source(page).getByRole('button', { name: '重试上传', exact: true })
    await button.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => retry.entered).toBe(true)
    expect(retry.digest).toBe(failed.digest)
    expect(retry.kind).toBe('iconify-json')
    await source(page).getByLabel('导入范围').selectOption('selected')
    await expect(save(page)).toBeDisabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('iconify-upload-390.png'), fullPage: true })
    retry.release()
    await retry.handled
    await expect(source(page)).toContainText(retry.id!)
    await expect(source(page)).not.toContainText(old.id)
    const saved = await saveProject(page)
    expect(saved.sources).toEqual([{ type: 'iconify', upload: retry.id, namePrefix: 'kept-', include: [] }])
    await page.reload()
    await page.getByRole('button', { name: 'upload-icons', exact: true }).click()
    await expect(source(page)).toContainText(retry.id!)
    await expect(source(page).getByLabel('导入范围')).toHaveValue('selected')
    await expect(source(page).getByLabel('图标名称（每行一个）')).toHaveValue('')
  }
  finally { await api.close() }
})

test('restores the previous repository file while a replacement is pending and rejects its late success', async ({ page, localWorker }) => {
  await open(page, localWorker.origin)
  await pathInput(page).fill('vendor/remembered.json')
  await upload(page)
  const api = await interceptUploads(page)
  try {
    const pending = api.hold()
    await beginHeld(page, pending)
    await restoreFile(page).click()
    await expect.poll(() => pending.aborted).toBe(true)
    await expect(pathInput(page)).toHaveValue('vendor/remembered.json')
    await pathInput(page).fill('vendor/explicit.json')
    pending.release()
    await pending.handled
    await expect(source(page)).not.toContainText(pending.id!)
    const saved = await saveProject(page)
    expect(saved.sources).toEqual([{ type: 'iconify', file: 'vendor/explicit.json' }])
  }
  finally { await api.close() }
})

const zipFile = { name: 'raw.zip', mimeType: 'application/zip', buffer: Buffer.from('UEsDBBQAAAAIAAAARF32OrZ3VAAAAG4AAAAJAAAAc3ZnL2Euc3ZndYxJCsAgDAC/EvIAI7anon6mWhXsgoamz+9y721ghrH9THCtdesOM/MxEYmIkkHtLZHRWtNTIEgJnB2aESHHkjJ/7G2LM/9IWEqtDlsMSN6+G38DUEsBAhQDFAAAAAgAAABEXfY6tndUAAAAbgAAAAkAAAAAAAAAAAAAAIABAAAAAHN2Zy9hLnN2Z1BLBQYAAAAAAQABADcAAAB7AAAAAAA=', 'base64') }

test('shares the JSON and ZIP pending lock, cancels explicitly and isolates a removed source after reindexing', async ({ page, localWorker }) => {
  await open(page, localWorker.origin)
  await page.getByLabel('新增来源类型').selectOption('directory')
  await page.getByRole('button', { name: '添加来源', exact: true }).click()
  const directory = page.getByRole('group', { name: 'directory 2', exact: true })
  const zip = directory.locator('input[type=file]')
  const api = await interceptUploads(page)
  let saves = 0
  page.on('request', (request) => {
    if (request.method() === 'PUT') {
      saves++
    }
  })
  try {
    const json = api.hold()
    await beginHeld(page, json)
    await expect(zip).toBeDisabled()
    await expect(save(page)).toBeDisabled()
    await expect(pathInput(page)).toBeDisabled()
    await page.getByRole('form', { name: '项目编辑', exact: true }).dispatchEvent('submit')
    expect(saves).toBe(0)
    await cancelUpload(page).click()
    await expect.poll(() => json.aborted).toBe(true)
    await expect(pathInput(page)).toHaveValue('vendor/icons.json')
    const zipped = api.hold()
    await zip.setInputFiles(zipFile)
    await expect.poll(() => zipped.entered).toBe(true)
    await expect(input(page)).toBeDisabled()
    json.release()
    await json.handled
    await expect(zip).toBeDisabled()
    await expect(pathInput(page)).toHaveValue('vendor/icons.json')
    await source(page).getByRole('button', { name: '移除来源 1', exact: true }).click()
    const remaining = page.getByRole('group', { name: 'directory 1', exact: true })
    await expect(remaining.getByRole('button', { name: '取消上传', exact: true })).toBeEnabled()
    zipped.release()
    await zipped.handled
    await expect(remaining).toContainText(zipped.id!)
    const saved = await saveProject(page)
    expect(saved.sources).toEqual([{ type: 'directory', dir: 'svg', upload: zipped.id }])
  }
  finally { await api.close() }
})

test('isolates a held JSON response across project A to B to A', async ({ page, localWorker }) => {
  await open(page, localWorker.origin)
  await source(page).getByLabel('名称前缀（原样添加）').fill('unsaved-')
  const api = await interceptUploads(page)
  try {
    const pending = api.hold()
    await beginHeld(page, pending)
    await page.getByRole('combobox', { name: '当前项目', exact: true }).selectOption(localWorker.fixture.projects[1].id)
    const dialog = page.getByRole('dialog', { name: '离开项目编辑', exact: true })
    await dialog.getByRole('button', { name: '放弃修改并继续', exact: true }).click()
    await expect.poll(() => pending.aborted).toBe(true)
    await page.getByRole('combobox', { name: '当前项目', exact: true }).selectOption(localWorker.fixture.projects[0].id)
    await expect(pathInput(page)).toHaveValue('vendor/icons.json')
    pending.release()
    await pending.handled
    await expect(source(page)).not.toContainText(pending.id!)
    await expect(input(page)).toBeEnabled()
    const saved = await saveProject(page)
    expect(saved.sources).toEqual([{ type: 'iconify', file: 'vendor/icons.json' }])
  }
  finally { await api.close() }
})

test('rechecks a project revision after real asynchronous GitHub validation and preserves the rejected draft', async ({ page, localWorker }) => {
  await open(page, localWorker.origin)
  const uploaded = await upload(page)
  const control = (action: string) => page.request.post(`${localWorker.origin}/__fixtures/iconify-upload/control`, { data: { action } })
  await control('hold')
  try {
    const next = page.waitForResponse(response => response.request().method() === 'PUT')
    await save(page).click()
    await expect.poll(async () => (await (await control('status')).json()).held).toBe(true)
    const revision = await page.request.post(`${localWorker.origin}/__fixtures/iconify-upload/revision`, { data: { projectId: localWorker.fixture.projects[0].id } })
    expect(revision.ok()).toBe(true)
    await control('release')
    expect((await next).status()).toBe(409)
    await expect(source(page)).toContainText(uploaded.id)
    await expect(page.getByRole('alert', { name: '保存失败', exact: true })).toContainText('Project changed')
    const state = await (await page.request.get(`${localWorker.origin}/api/state`, { headers: { cookie: `__Host-iconctl-session=${localWorker.fixture.session.token}` } })).json() as ConsoleState
    expect(state.projects.find(project => project.id === localWorker.fixture.projects[0].id)!.sources).toEqual([{ type: 'iconify', file: 'vendor/icons.json' }])
  }
  finally { await control('release') }
})

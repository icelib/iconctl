import type { ConsoleState, Project, ProjectInput } from '@iconctl/console-contracts'
import type { Page, Request } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { test as base, expect } from '@playwright/test'
import { discardDraft, navigationDialog } from './draft-navigation'
import { alpha, beta, id } from './editor-fixture'

// Two deterministic ZIP archives containing svg/a.svg and svg/b.svg. They are
// uploaded through a real file input; request bytes prove which file was sent.
const fileA = { name: 'alpha-icons.zip', mimeType: 'application/zip', buffer: Buffer.from('UEsDBBQAAAAIAAAARF32OrZ3VAAAAG4AAAAJAAAAc3ZnL2Euc3ZndYxJCsAgDAC/EvIAI7anon6mWhXsgoamz+9y721ghrH9THCtdesOM/MxEYmIkkHtLZHRWtNTIEgJnB2aESHHkjJ/7G2LM/9IWEqtDlsMSN6+G38DUEsBAhQDFAAAAAgAAABEXfY6tndUAAAAbgAAAAkAAAAAAAAAAAAAAIABAAAAAHN2Zy9hLnN2Z1BLBQYAAAAAAQABADcAAAB7AAAAAAA=', 'base64') }
const fileB = { name: 'beta-icons.zip', mimeType: 'application/zip', buffer: Buffer.from('UEsDBBQAAAAIAAAARF3wwlmSVQAAAG8AAAAJAAAAc3ZnL2Iuc3ZndYxJDoAgDAC/QvoAS9CTAR6jIiXBJVCtz3e5e5tkJmPrGdW15LU6IOa9RxSRRtpmKxGN1hqfApSkicmB6UBRSJH4Y29LGPlHqjnl7GDIRwD09v34G1BLAQIUAxQAAAAIAAAARF3wwlmSVQAAAG8AAAAJAAAAAAAAAAAAAACAAQAAAABzdmcvYi5zdmdQSwUGAAAAAAEAAQA3AAAAfAAAAAAA', 'base64') }
const uploadA = id(901)
const uploadB = id(902)
const oldUpload = id(900)
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex')
interface Reply { status?: number, json: unknown }
interface UploadGate {
  request?: Request
  body?: Buffer
  aborted: boolean
  reply: (reply: Reply) => void
  handled: Promise<void>
  response: Promise<Reply>
  handledDone: () => void
}
interface SaveRequest { path: string, method: string, body: { revision: number, project: ProjectInput } }
interface UploadApi {
  state: ConsoleState
  gates: UploadGate[]
  uploads: UploadGate[]
  saves: SaveRequest[]
  hold: () => UploadGate
}

const test = base.extend<{ uploadApi: UploadApi }>({
  uploadApi: async ({ page }, use, info) => {
    const api: UploadApi = {
      state: { projects: structuredClone([alpha, beta]), jobs: [], snapshots: [], releases: [], connections: [], pairings: [], devices: [] },
      gates: [],
      uploads: [],
      saves: [],
      hold() {
        let release!: (reply: Reply) => void
        let done!: () => void
        const gate: UploadGate = {
          aborted: false,
          response: new Promise(resolve => release = resolve),
          handled: new Promise(resolve => done = resolve),
          reply: reply => release(reply),
          handledDone: () => done(),
        }
        api.gates.push(gate)
        return gate
      },
    }
    const errors: string[] = []
    const unexpected: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', (request) => {
      const gate = api.uploads.find(item => item.request === request)
      if (gate) {
        gate.aborted = true
      }
    })
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const method = request.method()
      if (path === '/api/session') {
        return route.fulfill({ json: { csrf: 'upload-csrf' } })
      }
      if (path === '/api/state') {
        return route.fulfill({ json: structuredClone(api.state) })
      }
      expect(request.headers()['x-csrf-token']).toBe('upload-csrf')
      if (path === '/api/uploads' && method === 'POST') {
        const gate = api.gates.find(item => !item.request)
        if (!gate) {
          unexpected.push('Unexpected upload without an explicit request gate')
          return route.fulfill({ status: 500, json: { error: 'No upload expected' } })
        }
        gate.request = request
        gate.body = request.postDataBuffer()!
        api.uploads.push(gate)
        expect(request.headers()['content-type']).toBe('application/zip')
        try {
          await route.fulfill(await gate.response)
        }
        finally {
          gate.handledDone()
        }
        return
      }
      if (/^\/api\/projects\/[^/]+$/.test(path) && method === 'PUT') {
        const body = request.postDataJSON() as SaveRequest['body']
        api.saves.push({ path, method, body: structuredClone(body) })
        const project = api.state.projects.find(project => path === `/api/projects/${project.id}`)!
        expect(body.revision).toBe(project.revision)
        const saved: Project = { ...project, ...body.project, revision: project.revision + 1 }
        api.state.projects = [saved, ...api.state.projects.filter(item => item.id !== saved.id)]
        return route.fulfill({ json: saved })
      }
      unexpected.push(`${method} ${path}`)
      return route.fulfill({ status: 500, json: { error: 'Unexpected upload lifecycle request' } })
    })
    try {
      await use(api)
      expect(errors).toEqual([])
      expect(unexpected).toEqual([])
    }
    finally {
      for (const gate of api.gates) {
        gate.reply({ status: 503, json: { error: 'Fixture disposed' } })
      }
      await Promise.all(api.uploads.map(gate => gate.handled))
      await writeFile(info.outputPath('upload-request-evidence.json'), JSON.stringify({
        uploads: api.uploads.map(gate => ({ path: new URL(gate.request!.url()).pathname, method: gate.request!.method(), bytes: gate.body!.length, sha256: hash(gate.body!), aborted: gate.aborted })),
        saves: api.saves,
      }, null, 2))
    }
  },
})

const source = (page: Page, index = 1) => page.getByRole('group', { name: `directory ${index}`, exact: true })
const fileInput = (page: Page, index = 1) => source(page, index).locator('input[type=file]')
const directory = (page: Page, index = 1) => source(page, index).getByLabel('仓库内目录 / ZIP 子目录', { exact: true })
const status = (page: Page, index = 1) => source(page, index).getByRole('status', { name: '来源上传状态', exact: true })
const failure = (page: Page, index = 1) => source(page, index).getByRole('alert', { name: '来源上传失败', exact: true })
const cancel = (page: Page, index = 1) => source(page, index).getByRole('button', { name: '取消上传', exact: true })
const retry = (page: Page, index = 1) => source(page, index).getByRole('button', { name: '重试上传', exact: true })
const submit = (page: Page) => page.getByRole('form', { name: '项目编辑', exact: true }).locator('button[type=submit]')

async function open(page: Page) {
  await page.goto('/app/')
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
}
async function begin(page: Page, api: UploadApi, file = fileA, index = 1) {
  const gate = api.hold()
  await fileInput(page, index).setInputFiles(file)
  await expect.poll(() => Boolean(gate.request)).toBe(true)
  expect(hash(gate.body!)).toBe(hash(file.buffer))
  await expect(status(page, index)).toContainText(file.name)
  await expect(fileInput(page, index)).toHaveValue('')
  return gate
}
async function respond(gate: UploadGate, reply: Reply = { json: { id: uploadA } }) {
  gate.reply(reply)
  await gate.handled
}
async function saved(page: Page, api: UploadApi) {
  const before = api.saves.length
  await submit(page).click()
  await expect(page.getByRole('status', { name: '保存状态', exact: true })).toHaveText('项目配置已保存')
  expect(api.saves).toHaveLength(before + 1)
  return api.saves.at(-1)!
}
async function noStaleFeedback(page: Page) {
  await expect(page.getByText('SVG 压缩包已上传；保存项目后生效', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert', { name: '来源上传失败', exact: true })).toHaveCount(0)
}

test('binds the displayed file to the actual ZIP bytes and preserves a later directory edit in the saved revision', async ({ page, uploadApi }) => {
  await open(page)
  const gate = await begin(page, uploadApi)
  await expect(fileInput(page)).toBeDisabled()
  await expect(cancel(page)).toBeEnabled()
  await expect(submit(page)).toBeDisabled()
  await page.getByRole('form', { name: '项目编辑', exact: true }).dispatchEvent('submit')
  expect(uploadApi.saves).toEqual([])
  await expect(directory(page)).toBeEnabled()
  await directory(page).fill('svg/custom-subfolder')
  await respond(gate)
  await expect(source(page)).toContainText(uploadA)
  await expect(status(page)).toContainText('保存')
  await expect(directory(page)).toHaveValue('svg/custom-subfolder')
  await expect(fileInput(page)).toBeEnabled()
  expect(uploadApi.uploads).toHaveLength(1)
  const save = await saved(page, uploadApi)
  expect(save).toMatchObject({ path: `/api/projects/${alpha.id}`, body: { revision: 1, project: { sources: [{ type: 'directory', dir: 'svg/custom-subfolder', upload: uploadA }] } } })
})

test('retries only the explicitly selected failed file and retains the previous upload until replacement succeeds', async ({ page, uploadApi }) => {
  uploadApi.state.projects[0]!.sources = [{ type: 'directory', dir: 'svg/original', upload: oldUpload }]
  await open(page)
  const first = await begin(page, uploadApi)
  await expect(source(page)).toContainText(oldUpload)
  await respond(first, { status: 502, json: { error: 'Upload storage unavailable' } })
  await expect(failure(page)).toContainText('Upload storage unavailable')
  await expect(failure(page)).toContainText(fileA.name)
  await expect(source(page)).toContainText(oldUpload)
  await expect(directory(page)).toHaveValue('svg/original')
  expect(uploadApi.uploads).toHaveLength(1)
  const second = uploadApi.hold()
  await retry(page).focus()
  await retry(page).press('Enter')
  await expect.poll(() => Boolean(second.request)).toBe(true)
  expect(hash(second.body!)).toBe(hash(fileA.buffer))
  await expect(fileInput(page)).toBeDisabled()
  await expect(source(page)).toContainText(oldUpload)
  await respond(second, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  await expect(source(page)).not.toContainText(oldUpload)
  await expect(failure(page)).toHaveCount(0)
  const save = await saved(page, uploadApi)
  expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'svg', upload: uploadB }])
  expect(uploadApi.uploads).toHaveLength(2)
})

test('cancels A, accepts B, and ignores the late A response without releasing B ownership', async ({ page, uploadApi }) => {
  await open(page)
  const first = await begin(page, uploadApi)
  await cancel(page).click()
  await expect.poll(() => first.aborted).toBe(true)
  await expect(fileInput(page)).toBeEnabled()
  await expect(submit(page)).toBeEnabled()
  const second = await begin(page, uploadApi, fileB)
  await respond(first)
  await expect(status(page)).toContainText(fileB.name)
  await expect(fileInput(page)).toBeDisabled()
  await expect(source(page)).not.toContainText(uploadA)
  await respond(second, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  const save = await saved(page, uploadApi)
  expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'svg', upload: uploadB }])
  expect(uploadApi.uploads.map(item => hash(item.body!))).toEqual([hash(fileA.buffer), hash(fileB.buffer)])
})

test('allows the same file to be selected again after cancellation', async ({ page, uploadApi }) => {
  await open(page)
  const first = await begin(page, uploadApi)
  await cancel(page).click()
  await expect.poll(() => first.aborted).toBe(true)
  await respond(first)
  const second = await begin(page, uploadApi)
  await respond(second, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  expect(uploadApi.uploads.map(item => hash(item.body!))).toEqual([hash(fileA.buffer), hash(fileA.buffer)])
  expect(uploadApi.saves).toEqual([])
})

for (const outcome of ['success', 'failure'] as const) {
  test(`removing the uploading source cancels it and isolates a late ${outcome} from the surviving source`, async ({ page, uploadApi }) => {
    uploadApi.state.projects[0]!.sources.push({ type: 'directory', dir: 'raw/remaining' })
    await open(page)
    const gate = await begin(page, uploadApi)
    await source(page).getByRole('button', { name: '移除来源 1', exact: true }).click()
    await expect.poll(() => gate.aborted).toBe(true)
    await respond(gate, outcome === 'success' ? { json: { id: uploadA } } : { status: 502, json: { error: 'Old removed source failure' } })
    await expect(page.getByRole('group', { name: /^directory / })).toHaveCount(1)
    await expect(directory(page)).toHaveValue('raw/remaining')
    await expect(source(page)).not.toContainText(uploadA)
    await expect(fileInput(page)).toBeEnabled()
    await noStaleFeedback(page)
    const save = await saved(page, uploadApi)
    expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'raw/remaining' }])
  })
}

test('keeps an upload attached to its source when removing a preceding source changes its array index', async ({ page, uploadApi }) => {
  uploadApi.state.projects[0]!.sources.push({ type: 'directory', dir: 'raw/second' })
  await open(page)
  const gate = await begin(page, uploadApi, fileB, 2)
  await source(page).getByRole('button', { name: '移除来源 1', exact: true }).click()
  await expect(page.getByRole('group', { name: /^directory / })).toHaveCount(1)
  await expect(status(page)).toContainText(fileB.name)
  await directory(page).fill('svg/second')
  await respond(gate, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  expect(gate.aborted).toBe(false)
  const save = await saved(page, uploadApi)
  expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'svg/second', upload: uploadB }])
})

test('restoring repository mode cancels replacement without reattaching either upload', async ({ page, uploadApi }) => {
  uploadApi.state.projects[0]!.sources = [{ type: 'directory', dir: 'svg/original', upload: oldUpload }]
  await open(page)
  const gate = await begin(page, uploadApi)
  await source(page).getByRole('button', { name: '恢复使用仓库目录', exact: true }).click()
  await expect.poll(() => gate.aborted).toBe(true)
  await directory(page).fill('raw/repository')
  await respond(gate)
  await expect(source(page)).not.toContainText(oldUpload)
  await expect(source(page)).not.toContainText(uploadA)
  await noStaleFeedback(page)
  const save = await saved(page, uploadApi)
  expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'raw/repository' }])
})

test('keeps the upload active while dirty navigation is undecided or canceled', async ({ page, uploadApi }) => {
  await open(page)
  await page.getByLabel('图标前缀', { exact: true }).fill('keep-upload-draft')
  const gate = await begin(page, uploadApi)
  await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
  await expect(navigationDialog(page)).toBeVisible()
  expect(gate.aborted).toBe(false)
  await page.keyboard.press('Escape')
  await expect(navigationDialog(page)).toBeHidden()
  await expect(status(page)).toContainText(fileA.name)
  await respond(gate)
  await expect(source(page)).toContainText(uploadA)
  const save = await saved(page, uploadApi)
  expect(save.body).toMatchObject({ revision: 1, project: { prefix: 'keep-upload-draft', sources: [{ type: 'directory', dir: 'svg', upload: uploadA }] } })
})

for (const outcome of ['success', 'failure'] as const) {
  test(`accepting dirty navigation prevents a late ${outcome} from reviving after A to B to A`, async ({ page, uploadApi }) => {
    await open(page)
    await page.getByLabel('图标前缀', { exact: true }).fill('discard-me')
    const gate = await begin(page, uploadApi)
    await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
    await discardDraft(page)
    await expect.poll(() => gate.aborted).toBe(true)
    await expect(directory(page)).toHaveValue('raw/beta')
    await page.getByLabel('当前项目', { exact: true }).selectOption(alpha.id)
    await respond(gate, outcome === 'success' ? { json: { id: uploadA } } : { status: 502, json: { error: 'Old session unavailable' } })
    await expect(directory(page)).toHaveValue('raw/alpha')
    await expect(source(page)).not.toContainText(uploadA)
    await expect(status(page)).toHaveCount(0)
    await expect(fileInput(page)).toBeEnabled()
    await noStaleFeedback(page)
    expect(uploadApi.saves).toEqual([])
  })
}

test('releases the previous session lock when clean navigation starts a new project upload', async ({ page, uploadApi }) => {
  await open(page)
  const first = await begin(page, uploadApi)
  await page.getByLabel('当前项目', { exact: true }).selectOption(beta.id)
  await expect(navigationDialog(page)).toBeHidden()
  await expect.poll(() => first.aborted).toBe(true)
  const second = await begin(page, uploadApi, fileB)
  await respond(first)
  await expect(status(page)).toContainText(fileB.name)
  await expect(fileInput(page)).toBeDisabled()
  await respond(second, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  await noStaleFeedback(page)
  const save = await saved(page, uploadApi)
  expect(save).toMatchObject({ path: `/api/projects/${beta.id}`, body: { revision: 7, project: { sources: [{ type: 'directory', dir: 'svg', upload: uploadB }] } } })
})

test('shows local file errors and keyboard retry at 390px without hiding the cancellation controls', async ({ page, uploadApi }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const longFile = { ...fileA, name: `${'设计系统图标-'.repeat(12)}final.zip` }
  const first = await begin(page, uploadApi, longFile)
  await cancel(page).scrollIntoViewIfNeeded()
  await expect(cancel(page)).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await source(page).screenshot({ path: info.outputPath('source-upload-mobile-pending.png') })
  await respond(first, { status: 502, json: { error: 'Storage temporarily unavailable' } })
  await expect(failure(page)).toContainText(longFile.name)
  await expect(failure(page)).toContainText('Storage temporarily unavailable')
  const second = uploadApi.hold()
  await retry(page).focus()
  await expect(retry(page)).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await source(page).screenshot({ path: info.outputPath('source-upload-mobile-retry.png') })
  await retry(page).press('Enter')
  await expect.poll(() => Boolean(second.request)).toBe(true)
  expect(hash(second.body!)).toBe(hash(fileA.buffer))
  await respond(second)
  await expect(source(page)).toContainText(uploadA)
  await expect(failure(page)).toHaveCount(0)
  expect(uploadApi.uploads).toHaveLength(2)
})

test('reloading a clean editor destroys the old document and isolates its response from a new upload', async ({ page, uploadApi }) => {
  await open(page)
  const gate = await begin(page, uploadApi)
  await page.evaluate(() => {
    (window as unknown as { uploadDocument: string }).uploadDocument = 'original-document'
  })
  await page.reload()
  expect(await page.evaluate(() => (window as unknown as { uploadDocument?: string }).uploadDocument)).toBeUndefined()
  // Navigation destroys the old JS realm. Playwright does not emit requestfailed
  // consistently for a route held across document replacement, so verify actual
  // new-document state and a second upload instead of a synthetic abort event.
  await respond(gate)
  await page.getByRole('button', { name: alpha.name, exact: true }).click()
  await expect(directory(page)).toHaveValue('raw/alpha')
  await expect(source(page)).not.toContainText(uploadA)
  await expect(fileInput(page)).toBeEnabled()
  await noStaleFeedback(page)
  expect(uploadApi.saves).toEqual([])
  const current = await begin(page, uploadApi, fileB)
  await respond(current, { json: { id: uploadB } })
  await expect(source(page)).toContainText(uploadB)
  const save = await saved(page, uploadApi)
  expect(save.body).toMatchObject({ revision: 1, project: { sources: [{ type: 'directory', dir: 'svg', upload: uploadB }] } })
})

test('serializes uploads across sources and retains only the failed source retry file', async ({ page, uploadApi }) => {
  uploadApi.state.projects[0]!.sources.push({ type: 'directory', dir: 'raw/second' })
  await open(page)
  const failed = await begin(page, uploadApi)
  await expect(fileInput(page, 2)).toBeDisabled()
  await respond(failed, { status: 502, json: { error: 'First source unavailable' } })
  await expect(retry(page)).toBeEnabled()
  const second = await begin(page, uploadApi, fileB, 2)
  await expect(fileInput(page)).toBeDisabled()
  await expect(retry(page)).toBeDisabled()
  await expect(cancel(page, 2)).toBeEnabled()
  await respond(second, { json: { id: uploadB } })
  await expect(source(page, 2)).toContainText(uploadB)
  await expect(retry(page)).toBeEnabled()
  const retried = uploadApi.hold()
  await retry(page).click()
  await expect.poll(() => Boolean(retried.request)).toBe(true)
  expect(hash(retried.body!)).toBe(hash(fileA.buffer))
  await respond(retried)
  await expect(source(page)).toContainText(uploadA)
  const save = await saved(page, uploadApi)
  expect(save.body.project.sources).toEqual([{ type: 'directory', dir: 'svg', upload: uploadA }, { type: 'directory', dir: 'svg', upload: uploadB }])
})

for (const dirty of [false, true]) {
  test(`leaving the ${dirty ? 'dirty' : 'clean'} editor for task history releases upload ownership only after navigation`, async ({ page, uploadApi }) => {
    await open(page)
    if (dirty) {
      await page.getByLabel('图标前缀', { exact: true }).fill('history-draft')
    }
    const gate = await begin(page, uploadApi)
    await page.getByRole('button', { name: '任务与版本', exact: true }).click()
    if (dirty) {
      await expect(navigationDialog(page)).toBeVisible()
      expect(gate.aborted).toBe(false)
      await page.keyboard.press('Escape')
      await expect(status(page)).toContainText(fileA.name)
      await page.getByRole('button', { name: '任务与版本', exact: true }).click()
      await discardDraft(page)
    }
    await expect(page.getByRole('heading', { name: '任务记录', exact: true })).toBeVisible()
    await expect.poll(() => gate.aborted).toBe(true)
    await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled()
    await respond(gate)
    await noStaleFeedback(page)
    await page.getByRole('button', { name: '项目配置', exact: true }).click()
    await expect(directory(page)).toHaveValue('raw/alpha')
    await expect(fileInput(page)).toBeEnabled()
    await expect(source(page)).not.toContainText(uploadA)
    await expect(status(page)).toHaveCount(0)
    expect(uploadApi.saves).toEqual([])
  })
}

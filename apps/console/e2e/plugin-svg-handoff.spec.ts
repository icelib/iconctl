import type { Page } from '@playwright/test'
import type { BrowserResources, SvgFixture } from './plugin-svg-fixture'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveConfig, sync } from '@iconctl/core'
import { test as base, expect } from '@playwright/test'
import { extractSvgArchive, validateDirectory } from '../../console-runner/src/files'
import { mountSvg, rawSvg } from './plugin-svg-fixture'

const test = base.extend<{ svg: SvgFixture }>({
  svg: async ({ page }, use, info) => {
    const fixture = await mountSvg(page, info)
    try {
      await use(fixture)
    }
    finally { await fixture.close() }
  },
})
const button = (f: SvgFixture) => f.ui.getByRole('button', { name: 'Export SVG ZIP', exact: true })
const cancel = (f: SvgFixture) => f.ui.getByRole('button', { name: 'Cancel SVG export', exact: true })
const status = (f: SvgFixture) => f.ui.getByLabel('SVG handoff status', { exact: true })
const resources = (f: SvgFixture) => f.ui.locator('body').evaluate(() => (window as unknown as { svgResources: BrowserResources }).svgResources)
async function ready(f: SvgFixture) {
  await f.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(button(f)).toBeEnabled()
}
async function download(page: Page, f: SvgFixture, destination: string) {
  const next = page.waitForEvent('download')
  await button(f).click()
  const file = await next
  await file.saveAs(destination)
  expect(await file.failure()).toBeNull()
  await expect(status(f)).toContainText('Download started for 3 raw SVGs.')
  await expect.poll(() => f.first.listeners.size).toBe(0)
  await expect.poll(async () => (await resources(f)).active).toEqual([])
  await expect(f.ui.locator('a[download]')).toHaveCount(0)
}

test('downloads the complete raw page through shipped host and UI, independently extracts bytes and consumes them with the real runner and built core', async ({ page, svg }, info) => {
  expect(svg.first.listeners.size).toBe(0)
  await svg.ui.getByLabel('Search preflight', { exact: true }).fill('Arrow')
  await expect(svg.ui.locator('#list > li')).toHaveCount(1)
  const writes = [...svg.writes]
  const network = [...svg.network]
  const next = page.waitForEvent('download')
  await button(svg).focus()
  await page.keyboard.press('Enter')
  const file = await next
  const path = info.outputPath('raw-svg-handoff.zip')
  await file.saveAs(path)
  expect(await file.failure()).toBeNull()
  await expect(status(svg)).toContainText('Download started for 3 raw SVGs.')
  const paths = ['raw-svg/actions-filled.svg', 'raw-svg/arrow.svg', 'raw-svg/nested-icon.svg']
  const exec = promisify(execFile)
  expect((await exec('unzip', ['-Z1', path])).stdout.trim().split('\n')).toEqual(paths)
  expect((await exec('unzip', ['-t', path])).stdout).toContain('No errors detected')
  for (const entry of paths) {
    expect((await exec('unzip', ['-p', path, entry])).stdout).toBe(rawSvg)
  }
  const input = info.outputPath('consumer-input')
  await extractSvgArchive(await readFile(path), input)
  const directory = await validateDirectory(input, 'raw-svg')
  const output = info.outputPath('consumer-output')
  await mkdir(output)
  const config = resolveConfig({ prefix: 'handoff', sources: [{ type: 'directory', dir: directory }], validate: { width: 32, height: 16 }, output: { json: 'icons.json', svg: 'svg', types: 'icons.d.ts', preview: 'preview.html' } })
  const dry = await sync({ cwd: output, config, dryRun: true })
  expect(dry.failed).toEqual([])
  expect(dry.diff.added.sort()).toEqual(['actions-filled', 'arrow', 'nested-icon'])
  expect(await readdir(output)).toEqual([])
  const result = await sync({ cwd: output, config })
  expect(result.failed).toEqual([])
  const json = JSON.parse(await readFile(join(output, 'icons.json'), 'utf8'))
  expect(Object.keys(json.icons).sort()).toEqual(['actions-filled', 'arrow', 'nested-icon'])
  expect(json.icons.arrow.width ?? json.width).toBe(32)
  expect(json.icons.arrow.height ?? json.height ?? 16).toBe(16)
  for (const entry of paths) {
    expect(await readFile(join(input, entry), 'utf8')).toBe(rawSvg)
  }
  await expect.poll(() => svg.first.listeners.size).toBe(0)
  await expect.poll(async () => (await resources(svg)).active).toEqual([])
  expect(svg.exports.map(item => item.id)).toEqual(['2:1', '1:1', '3:1'])
  expect(svg.peak()).toBe(1)
  expect(svg.network).toEqual(network)
  expect(svg.writes).toEqual(writes)
  expect(svg.requests.filter(item => ['console-sync', 'dispatch'].includes(item.type))).toEqual([])
  const files = svg.responses.find(message => message.type === 'svg-handoff-files')!
  await svg.send(files)
  await svg.send(svg.responses.find(message => message.type === 'svg-handoff-status' && message.state === 'ready')!)
  expect(svg.downloads).toHaveLength(1)
  expect((await resources(svg)).clicks).toHaveLength(1)
  await expect(svg.ui.locator('a[download], svg, object')).toHaveCount(0)
  await button(svg).focus()
  expect(await svg.ui.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('iframe').screenshot({ path: info.outputPath('svg-handoff-ready.png') })
  await writeFile(info.outputPath('svg-handoff-consumer.json'), JSON.stringify({ independentEntries: paths, nativeExports: svg.exports, nativePeak: svg.peak(), runnerValidated: true, dryRunEmpty: true, coreNames: Object.keys(json.icons), rawBytesUnchanged: true }, null, 2))
})

for (const live of [false, true]) {
  test(`waits for a cancelled native export before retry and preserves live=${live} ownership`, async ({ page, svg }, info) => {
    if (live) {
      await svg.ui.getByLabel('Live preflight', { exact: true }).check()
      await expect(svg.ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
    }
    const pending = svg.holdExport()
    await button(svg).click()
    await expect.poll(() => pending.started).toBe(true)
    expect(svg.first.listeners.size).toBe(live ? 2 : 1)
    const requestId = svg.requests.find(item => item.type === 'export-svg-handoff')!.requestId
    await svg.dispatch({ type: 'export-svg-handoff', requestId })
    expect(svg.exports).toHaveLength(1)
    await cancel(svg).click()
    await expect(status(svg)).toContainText('Waiting for the current Figma operation to finish')
    await expect(button(svg)).toBeDisabled()
    await expect(cancel(svg)).toBeDisabled()
    expect(svg.first.listeners.size).toBe(live ? 1 : 0)
    expect(svg.inFlight()).toBe(1)
    await page.locator('iframe').screenshot({ path: info.outputPath('svg-handoff-cancel-pending.png') })
    pending.resolve(rawSvg)
    await svg.settleHost()
    await expect(status(svg)).toHaveText('SVG export cancelled.')
    expect(svg.downloads).toEqual([])
    expect(svg.exports).toHaveLength(1)
    if (live) {
      await expect(svg.ui.getByLabel('Live preflight', { exact: true })).toBeChecked()
      await svg.ui.getByLabel('Live preflight', { exact: true }).uncheck()
      await expect.poll(() => svg.first.listeners.size).toBe(0)
    }
    await ready(svg)
    await download(page, svg, info.outputPath('after-cancel.zip'))
    expect(svg.peak()).toBe(1)
    expect(svg.requests.filter(item => item.type === 'export-svg-handoff').map(item => item.requestId)).toEqual([1, 2])
  })

  test(`invalidates an export on remote parent edits with live=${live} and cannot revive through a detached callback`, async ({ page, svg }, info) => {
    if (live) {
      await svg.ui.getByLabel('Live preflight', { exact: true }).check()
      await expect(svg.ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
    }
    const pending = svg.holdExport()
    await button(svg).click()
    await expect.poll(() => pending.started).toBe(true)
    const old = svg.first.attached.at(-1)!
    svg.first.emit('CREATE', [])
    await expect(status(svg)).toContainText('Waiting for the current Figma operation to finish')
    pending.resolve(rawSvg)
    await svg.settleHost()
    await expect(status(svg)).toHaveText('SVG export cancelled.')
    expect(svg.downloads).toEqual([])
    if (live) {
      await expect(svg.ui.locator('#live-preflight-status')).toContainText('Live preflight is on')
      await svg.ui.getByLabel('Live preflight', { exact: true }).uncheck()
      await expect.poll(() => svg.first.listeners.size).toBe(0)
    }
    await ready(svg)
    const next = svg.holdExport()
    await button(svg).click()
    await expect.poll(() => next.started).toBe(true)
    old({ nodeChanges: [{ type: 'DELETE', properties: [], origin: 'REMOTE' }] })
    await expect(status(svg)).toContainText('Exporting 1 of 3')
    const downloaded = page.waitForEvent('download')
    next.resolve(rawSvg)
    await (await downloaded).saveAs(info.outputPath('after-old-edit.zip'))
    await expect(status(svg)).toContainText('Download started for 3 raw SVGs.')
    expect(svg.downloads).toHaveLength(1)
  })
}

for (const failure of ['native', 'xml', 'utf8-limit'] as const) {
  test(`rejects ${failure} failure without partial download and succeeds on a fresh request`, async ({ page, svg }, info) => {
    svg.holdExport().resolve(rawSvg)
    const pending = svg.holdExport()
    await button(svg).click()
    await expect.poll(() => pending.started).toBe(true)
    if (failure === 'native') {
      pending.reject(new Error('Native SVG export failed'))
    }
    else if (failure === 'xml') {
      pending.resolve('<svg xmlns="http://www.w3.org/2000/svg"><path></svg>')
    }
    else { pending.resolve(`<svg>${'中'.repeat(360_000)}</svg>`) }
    await svg.settleHost()
    await expect(status(svg)).toContainText(failure === 'native' ? 'Native SVG export failed' : failure === 'xml' ? 'Invalid SVG' : '1 MiB')
    await expect(button(svg)).toBeEnabled()
    expect(svg.downloads).toEqual([])
    expect((await resources(svg)).created).toEqual([])
    await expect.poll(() => svg.first.listeners.size).toBe(0)
    await download(page, svg, info.outputPath('after-error.zip'))
  })
}

for (const invalidate of ['page', 'mode', 'rescan', 'rules', 'disconnect', 'pagehide', 'close'] as const) {
  test(`drops delayed native work after ${invalidate} without taking ownership of a later context`, async ({ svg }) => {
    const lookup = invalidate === 'page' || invalidate === 'disconnect'
    const pendingLookup = lookup ? svg.holdLookup() : undefined
    const pendingExport = lookup ? undefined : svg.holdExport()
    await button(svg).click()
    await expect.poll(() => (pendingLookup ?? pendingExport)!.started).toBe(true)
    if (invalidate === 'page') {
      svg.changePage()
      svg.changePage(svg.first)
    }
    else if (invalidate === 'mode') {
      await svg.ui.getByRole('combobox', { name: 'Connection mode', exact: true }).selectOption('github')
    }
    else if (invalidate === 'rescan') {
      await svg.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
    }
    else if (invalidate === 'rules') {
      svg.setContext({ revision: 8 })
      await svg.ui.locator('#applied-rules > summary').click()
      await svg.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
    }
    else if (invalidate === 'disconnect') {
      await svg.ui.getByRole('button', { name: 'Disconnect', exact: true }).click()
    }
    else if (invalidate === 'pagehide') {
      await svg.ui.locator('body').evaluate(() => window.dispatchEvent(new Event('pagehide')))
    }
    else { svg.closeHost() }
    await expect.poll(() => svg.first.listeners.size).toBe(0)
    pendingLookup?.resolve(svg.variant)
    pendingExport?.resolve(rawSvg)
    await svg.settleHost()
    await svg.flush()
    expect(svg.downloads).toEqual([])
    expect(svg.responses.filter(item => item.type === 'svg-handoff-files')).toEqual([])
    expect(svg.exports).toHaveLength(lookup ? 0 : 1)
    expect((await resources(svg)).created).toEqual([])
  })
}

test('enforces confirmed project rules and portable names independently from the filtered list', async ({ svg }) => {
  await expect(button(svg)).toBeEnabled()
  svg.arrow.name = 'CON'
  await svg.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(button(svg)).toBeDisabled()
  await expect(svg.ui.locator('#svg-handoff-help')).toContainText('portable SVG filename')
  svg.arrow.name = 'Arrow'
  svg.arrow.width = 24
  await svg.ui.getByRole('button', { name: 'Rescan', exact: true }).click()
  await svg.ui.getByLabel('Search preflight', { exact: true }).fill('Nested Icon')
  await expect(svg.ui.locator('#list > li')).toHaveCount(1)
  await expect(button(svg)).toBeDisabled()
  await expect(svg.ui.locator('#svg-handoff-help')).toContainText('Fix all preflight errors')
  svg.arrow.width = 32
  svg.setContext({ namingMode: 'server', revision: 8 })
  await svg.ui.locator('#applied-rules > summary').click()
  await svg.ui.getByRole('button', { name: 'Refresh project rules', exact: true }).click()
  await expect(svg.ui.locator('#svg-handoff-help')).toContainText('Custom names require a console sync')
  await expect(button(svg)).toBeDisabled()
  expect(svg.exports).toEqual([])
  expect(svg.downloads).toEqual([])
})

test('waits for project context and preserves a restored task while exporting locally', async ({ page }, info) => {
  const svg = await mountSvg(page, info, { restoredTask: true, pendingContext: true })
  try {
    await expect(button(svg)).toBeDisabled()
    svg.initialContext!.resolve(Response.json(svg.context()))
    await expect.poll(() => svg.job!.started).toBe(true)
    await expect(button(svg)).toBeEnabled()
    const network = [...svg.network]
    const writes = [...svg.writes]
    const taskStatus = await svg.ui.locator('#console-status').textContent()
    await download(page, svg, info.outputPath('with-running-task.zip'))
    await expect(svg.ui.locator('#console-status')).toHaveText(taskStatus!)
    expect(svg.network).toEqual(network)
    expect(svg.writes).toEqual(writes)
    expect(svg.stored.get('iconctl-console-task')).toMatchObject({ jobId: 'running-task', requestId: 'saved-svg-task' })
    svg.job!.resolve(Response.json({ status: 'succeeded', stage: 'complete' }))
    await expect(svg.ui.locator('#console-status')).toContainText('succeeded')
    await expect(svg.ui.getByRole('link', { name: 'Open task ↗', exact: true })).toHaveAttribute('href', 'https://iconctl.icebreaker.top/app/?job=running-task')
    await expect(status(svg)).toContainText('Download started for 3 raw SVGs.')
  }
  finally { await svg.close() }
})

test('keeps maximum-length filenames and native errors readable with cancel reachable at 420px', async ({ page, svg }, info) => {
  svg.arrow.name = 'x'.repeat(228)
  svg.first.children = [svg.arrow]
  await ready(svg)
  const pending = svg.holdExport()
  await button(svg).click()
  await expect.poll(() => pending.started).toBe(true)
  await expect(status(svg)).toContainText(svg.arrow.name)
  const progress = await svg.ui.locator('body').evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  await status(svg).scrollIntoViewIfNeeded()
  await expect(cancel(svg)).toBeEnabled()
  await expect(cancel(svg)).toBeInViewport()
  await page.locator('iframe').screenshot({ path: info.outputPath('svg-handoff-long-progress.png') })
  pending.reject(new Error(`Native failure ${'设计导出错误'.repeat(50)}`))
  await expect(status(svg)).toContainText('Native failure')
  await expect(status(svg)).toHaveCSS('color', 'rgb(204, 0, 0)')
  const failure = await svg.ui.locator('body').evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  await page.locator('iframe').screenshot({ path: info.outputPath('svg-handoff-long-error.png') })
  await writeFile(info.outputPath('svg-handoff-width.json'), JSON.stringify({ progress, failure }, null, 2))
  expect(progress.scrollWidth).toBeLessThanOrEqual(progress.width)
  expect(failure.scrollWidth).toBeLessThanOrEqual(failure.width)
})

test('preserves the active GitHub dispatch status and exports only after the current native operation settles', async ({ page, svg }, info) => {
  for (const node of svg.nodes.values()) {
    node.width = 24
    node.height = 24
  }
  await svg.ui.getByRole('combobox', { name: 'Connection mode', exact: true }).selectOption('github')
  await expect(svg.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true })).toBeEnabled()
  let release!: () => void
  let received = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('https://api.github.com/repos/fixture/icons/dispatches', async (route) => {
    received = true
    expect(route.request().method()).toBe('POST')
    await gate
    await route.fulfill({ status: 204, body: '' })
  })
  try {
    await svg.ui.getByRole('button', { name: 'Dispatch GitHub Action', exact: true }).click()
    await expect.poll(() => received).toBe(true)
    await expect(svg.ui.locator('#github-status')).toHaveText('Dispatching GitHub Action…')
    const pending = svg.holdExport()
    await button(svg).click()
    await expect.poll(() => pending.started).toBe(true)
    await expect(svg.ui.locator('#github-status')).toHaveText('Dispatching GitHub Action…')
    const file = page.waitForEvent('download')
    pending.resolve(rawSvg)
    await (await file).saveAs(info.outputPath('with-github-dispatch.zip'))
    await expect(status(svg)).toContainText('Download started for 3 raw SVGs.')
    await expect(svg.ui.locator('#github-status')).toHaveText('Dispatching GitHub Action…')
    release()
    await expect(svg.ui.locator('#github-status')).toHaveText('Workflow started. https://github.com/fixture/icons/actions')
    await expect(status(svg)).toContainText('Download started for 3 raw SVGs.')
  }
  finally { release() }
})

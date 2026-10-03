import type { Job, Project, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, sync } from '@iconctl/core'
import { createWorkerTest, expect } from './local-worker'

const firstFile = 'AbCdEfGhIjKlMnOpQrStUv'
const winningFile = 'ZbCdEfGhIjKlMnOpQrStUv'
const winningNode = '8:9'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

async function generateCoreResult() {
  const cwd = await mkdtemp(join(tmpdir(), 'iconctl-browser-provenance-'))
  const originalFetch = globalThis.fetch
  const files: Record<string, { id: string, name: string }[]> = {
    [firstFile]: [{ id: '1:1', name: 'shared' }],
    [winningFile]: [{ id: winningNode, name: 'shared' }],
  }
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (request.method !== 'GET') {
        throw new Error(`Unexpected core fixture request: ${request.method} ${url}`)
      }
      if (url.origin === 'https://cdn.example.com') {
        const [file, node] = url.pathname.slice(1).split('/')
        if (!files[file!]?.some(icon => icon.id === node)) {
          throw new Error(`Unexpected SVG fixture: ${url}`)
        }
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      }
      if (url.origin !== 'https://api.figma.com') {
        throw new Error(`Unexpected core fixture origin: ${url.origin}`)
      }
      const [version, resource, file] = url.pathname.slice(1).split('/')
      const icons = files[file!]
      if (version !== 'v1' || !icons) {
        throw new Error(`Unexpected Figma fixture: ${url}`)
      }
      if (resource === 'files') {
        return Response.json({
          editorType: 'figma',
          version: '1',
          lastModified: '1',
          document: { id: '0:0', type: 'DOCUMENT', children: [{
            id: '0:1',
            name: 'Icons',
            type: 'CANVAS',
            children: icons.map(({ id, name }) => ({
              id,
              name,
              type: 'COMPONENT',
              children: [],
              absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            })),
          }] },
        })
      }
      if (resource === 'images') {
        return Response.json({ images: Object.fromEntries(icons.map(icon => [icon.id, `https://cdn.example.com/${file}/${icon.id}`])) })
      }
      throw new Error(`Unexpected Figma fixture resource: ${url}`)
    }
    return await sync({
      cwd,
      config: resolveConfig({
        prefix: 'brand',
        sources: [firstFile, winningFile].map(file => ({ type: 'figma', file, token: 'fixture', pages: ['Icons'] })),
        validate: { height: 16, name: /^allowed$/ },
      }),
      continueOnError: true,
      dryRun: true,
    })
  }
  finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true, force: true })
  }
}

interface ProvenanceFixture {
  project: Project
  job: Job
  session: { token: string }
}

const test = createWorkerTest<ProvenanceFixture>('provenance').extend<{ coreResult: Awaited<ReturnType<typeof sync>> }>({
  // Automatic fixtures run before the localWorker and page fixtures, so the
  // temporary fetch mock is already restored before either service is used.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires fixture dependencies to use object destructuring.
  coreResult: [async ({}, use) => {
    await use(await generateCoreResult())
  }, { auto: true }],
})

test('preserves the winning Figma source from real core validation through Worker storage and node navigation', async ({ page, context, request, localWorker, coreResult }, testInfo) => {
  const { origin, fixture, unexpectedRequests } = localWorker
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  expect(coreResult.complete).toBe(false)
  expect(coreResult.fileKey).toBe(firstFile)
  expect(coreResult.issues).toHaveLength(2)
  expect(coreResult.sources.map(source => source.fileKey)).toEqual([firstFile, winningFile])
  for (const issue of coreResult.issues) {
    expect(issue).toMatchObject({ name: 'shared', stage: 'validation', sourceType: 'figma', sourceIndex: 1, fileKey: winningFile, nodeId: winningNode })
    expect(issue.fileKey).not.toBe(coreResult.fileKey)
  }
  const content = { json: coreResult.json, files: {}, issues: coreResult.issues, failed: coreResult.failed, sources: coreResult.sources }
  await testInfo.attach('core-generated-snapshot.json', { body: JSON.stringify(content, null, 2), contentType: 'application/json' })
  const uploaded = await request.post(`${origin}/__fixtures/provenance/snapshot`, { data: { jobId: fixture.job.id, content } })
  expect(uploaded.ok()).toBe(true)
  const completed = await uploaded.json() as { job: Job, snapshot: Snapshot }
  expect(completed.job).toMatchObject({ status: 'failed', error: 'validation', snapshotId: completed.snapshot.id })
  expect(completed.snapshot).toMatchObject({ iconCount: 1, issues: 2, attempt: 1 })
  await context.addCookies([{
    name: '__Host-iconctl-session',
    value: fixture.session.token,
    domain: new URL(origin).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
  await page.goto(`${origin}/app/?job=${fixture.job.id}`)
  const row = page.locator(`#job-${fixture.job.id}`)
  await expect(row).toBeFocused()
  await expect(row).toContainText('失败')
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/snapshots/${completed.snapshot.id}`)
  await row.getByRole('button', { name: '查看快照', exact: true }).click()
  const preview = await (await previewResponse).json() as SnapshotPreview
  expect(preview.content.issues).toEqual(coreResult.issues)
  expect(preview.content.sources).toEqual(coreResult.sources)
  const diagnostics = page.getByLabel('快照诊断', { exact: true })
  await expect(diagnostics).toContainText(/来源：\s*figma\s*#2/)
  await expect(diagnostics).toContainText('校验')
  for (const issue of coreResult.issues) {
    await expect(diagnostics).toContainText(issue.message)
  }
  const links = diagnostics.getByRole('link', { name: '在 Figma 中定位', exact: true })
  await expect(links).toHaveCount(2)
  for (const link of await links.all()) {
    const location = new URL((await link.getAttribute('href'))!)
    expect(location.origin).toBe('https://www.figma.com')
    expect(location.pathname).toBe(`/file/${winningFile}`)
    expect(location.searchParams.get('node-id')).toBe(winningNode)
    await expect(link).toHaveAttribute('rel', /noopener/)
  }
  await page.screenshot({ path: testInfo.outputPath('core-provenance-diagnostics.png'), fullPage: true })
  const opened: string[] = []
  await context.route('https://www.figma.com/**', async (route) => {
    opened.push(route.request().url())
    await route.fulfill({ contentType: 'text/html', body: '<title>Figma destination fixture</title>' })
  })
  const popupPromise = context.waitForEvent('page')
  await links.first().click()
  const popup = await popupPromise
  await expect(popup).toHaveTitle('Figma destination fixture')
  const destination = new URL(popup.url())
  expect(destination.pathname).toBe(`/file/${winningFile}`)
  expect(destination.searchParams.get('node-id')).toBe(winningNode)
  expect(opened).toEqual([popup.url()])
  await popup.close()
  expect(unexpectedRequests).toEqual([])
  expect(errors).toEqual([])
})

import type { Job, SnapshotContent, Source } from '@iconctl/console-contracts'
import type { RunnerApi } from '../src/client'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { projectInput } from '@iconctl/console-contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sha256 } from '../src/files'
import { classifyFailure, synchronize } from '../src/index'

const exec = promisify(execFile)
const body = '<path fill="#123456" d="M0 0h4v8H0z"/>'
const collection = {
  prefix: 'vendor',
  width: 24,
  height: 16,
  icons: { home: { body }, _draft: { body } },
  aliases: { rotated: { parent: 'home', rotate: 1 } },
}
let root: string
let repository: string
let work: string
let job: Job
let snapshot: SnapshotContent | undefined
let client: RunnerApi

async function saveCommit(content: string) {
  await writeFile(join(repository, 'vendor.json'), content)
  await exec('git', ['add', '.'], { cwd: repository })
  await exec('git', ['-c', 'user.name=Iconctl Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: repository })
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'iconctl-runner-iconify-'))
  repository = join(root, 'repo')
  work = join(root, 'work')
  await mkdir(repository)
  await mkdir(work)
  await exec('git', ['init', '--quiet'], { cwd: repository })
  const sourceCommit = await saveCommit(`\uFEFF${JSON.stringify(collection)}`)
  const project = {
    ...projectInput.parse({ name: 'brand', prefix: 'brand', packageName: '@test/icons', repository: 'owner/repo', sources: [{ type: 'iconify', file: 'vendor.json' }] }),
    id: crypto.randomUUID(),
    revision: 1,
    createdAt: Date.now(),
    repositoryInfo: { id: 1, installationId: 1, defaultBranch: 'main' },
  }
  job = {
    id: crypto.randomUUID(),
    projectId: project.id,
    project,
    operation: 'sync',
    status: 'running',
    sourceCommit,
    executorCommit: sourceCommit,
    workflowCommit: sourceCommit,
    workflowDigest: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dispatchAttempts: 1,
    attempt: 1,
    stage: 'claimed',
  }
  snapshot = undefined
  client = {
    request: async () => { throw new Error('Unexpected binary request') },
    async json<T>(path: string, value?: unknown): Promise<T> {
      if (path === 'snapshot') {
        snapshot = value as SnapshotContent
      }
      else if (path !== 'progress') {
        throw new Error(`Unexpected runner request: ${path}`)
      }
      return {} as T
    },
  }
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected network request')
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it('reads the pinned commit and imports all icons through normal outputs without credentials or network', async () => {
  await saveCommit(JSON.stringify({ prefix: 'newer', icons: { other: { body } } }))
  await synchronize(job, client, repository, work)
  expect(snapshot!.json.prefix).toBe('brand')
  expect(Object.keys(snapshot!.json.icons).sort()).toEqual(['home', 'rotated'])
  expect(snapshot!.json.icons['home']!.body).toContain('currentColor')
  expect(snapshot!.issues).toEqual([])
  expect(snapshot!.sources).toEqual([{ type: 'iconify', notModified: false }])
  expect(Object.keys(snapshot!.files)).toEqual(expect.arrayContaining(['icons.json', 'index.d.ts', 'preview.html', 'svg/rotated.svg']))
  expect(await readFile(join(work, 'iconify-0.json'), 'utf8')).toBe(`\uFEFF${JSON.stringify(collection)}`)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['check', 'dry-run'] as const)('preserves explicit empty selections during %s without generated files', async (operation) => {
  job.operation = operation
  job.project.sources = [{ type: 'iconify', file: 'vendor.json', include: [] }]
  await synchronize(job, client, repository, work)
  expect(snapshot!.json.icons).toEqual({})
  expect(snapshot!.files).toEqual({})
  await expect(readFile(join(work, 'output/icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves literal name prefixes, exact include names and ordered duplicate overrides', async () => {
  await writeFile(join(repository, 'override.json'), JSON.stringify({ prefix: 'override', width: 32, icons: { home: { body: '<path d="M0 0h2v2H0z"/>' } } }))
  job.sourceCommit = await saveCommit(JSON.stringify(collection))
  job.project.sources = [
    { type: 'iconify', file: 'override.json', include: ['home'], namePrefix: 'v' },
    { type: 'iconify', file: 'vendor.json', include: ['rotated'], namePrefix: 'v-' },
    { type: 'iconify', file: 'vendor.json', include: ['home'], namePrefix: 'v' },
  ]
  await synchronize(job, client, repository, work)
  expect(Object.keys(snapshot!.json.icons).sort()).toEqual(['v-rotated', 'vhome'])
  expect(snapshot!.sources).toHaveLength(3)
  expect(snapshot!.json.icons['vhome']!.width ?? snapshot!.json.width ?? 16).toBe(24)
})

it.each(['not json', '{"prefix":"vendor","icons":[]}', '{"prefix":"vendor","icons":{},"width":0}'])('classifies malformed collection files as configuration failures: %s', async (value) => {
  job.sourceCommit = await saveCommit(value)
  const failure = await synchronize(job, client, repository, work).catch(error => error as Error)
  expect(failure).toBeInstanceOf(Error)
  expect(classifyFailure(failure)).toBe('configuration')
  expect(snapshot).toBeUndefined()
})

it.each<Source>([
  { type: 'iconify', file: 'vendor.json', include: ['absent'] },
  { type: 'iconify', file: 'vendor.json', include: ['circular'] },
])('reports invalid selected icons through validation snapshots: %j', async (source) => {
  job.sourceCommit = await saveCommit(JSON.stringify({ ...collection, aliases: { circular: { parent: 'circular' } } }))
  job.project.sources = [source]
  const failure = await synchronize(job, client, repository, work).catch(error => error as Error)
  expect(classifyFailure(failure)).toBe('validation')
  expect(snapshot!.failed).toHaveLength(1)
  expect(snapshot!.issues).toHaveLength(1)
})

function uploadedCollection(value: unknown = collection) {
  const bytes = new TextEncoder().encode(`\uFEFF${JSON.stringify(value)}`)
  const upload = crypto.randomUUID()
  job.project.sources = [{ type: 'iconify', upload }]
  client.request = vi.fn(async (path) => {
    expect(path).toBe(`uploads/${upload}`)
    return new Response(bytes, { headers: { 'Content-Type': 'application/json', 'X-Content-SHA256': sha256(bytes) } })
  })
  return bytes
}

it('imports a JSON upload absent from the pinned repository with aliases, original names and normal outputs', async () => {
  // The only repository file deliberately contains an unrelated collection.
  job.sourceCommit = await saveCommit('{"prefix":"repo","icons":{}}')
  const bytes = uploadedCollection()
  const source = job.project.sources[0]!
  if (source.type !== 'iconify') {
    throw new Error('Fixture source type')
  }
  source.include = ['rotated']
  source.namePrefix = 'upload-'
  await synchronize(job, client, repository, work)
  expect(Object.keys(snapshot!.json.icons)).toEqual(['upload-rotated'])
  expect(snapshot!.json.icons['upload-rotated']!.body).toContain('currentColor')
  expect(snapshot!.files['svg/upload-rotated.svg']).toBeDefined()
  expect(new Uint8Array(await readFile(join(work, 'iconify-0.json')))).toEqual(bytes)
  expect(snapshot!.sources).toEqual([{ type: 'iconify', notModified: false }])
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['check', 'dry-run'] as const)('accepts an uploaded explicit empty selection during %s', async (operation) => {
  uploadedCollection()
  job.operation = operation
  Object.assign(job.project.sources[0]!, { include: [] })
  await synchronize(job, client, repository, work)
  expect(snapshot!.json.icons).toEqual({})
  expect(snapshot!.files).toEqual({})
})

it('leaves unselected invalid aliases to core and snapshots selected alias failures', async () => {
  uploadedCollection({ ...collection, aliases: { bad: { parent: 'absent' } } })
  Object.assign(job.project.sources[0]!, { include: ['home'] })
  await synchronize(job, client, repository, work)
  expect(Object.keys(snapshot!.json.icons)).toEqual(['home'])
  expect(snapshot!.issues).toEqual([])
  await rm(work, { recursive: true })
  await mkdir(work)
  snapshot = undefined
  Object.assign(job.project.sources[0]!, { include: ['bad'] })
  const failure = await synchronize(job, client, repository, work).catch(error => error)
  expect(classifyFailure(failure)).toBe('validation')
  expect(snapshot!.failed).toEqual(['bad'])
})

it('preserves mixed repository/upload override order', async () => {
  const upload = crypto.randomUUID()
  const body = JSON.stringify({ prefix: '../hostile-prefix', width: 32, icons: { home: { body: '<path d="M0 0h2v2H0z"/>' } } })
  client.request = async () => new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Content-SHA256': sha256(body), 'Content-Disposition': 'attachment; filename="../../escape.json"' } })
  job.project.sources = [{ type: 'iconify', file: 'vendor.json' }, { type: 'iconify', upload }]
  await synchronize(job, client, repository, work)
  expect(snapshot!.json.icons['home']!.width ?? snapshot!.json.width).toBe(32)
  expect(await readFile(join(work, 'iconify-1.json'), 'utf8')).toBe(body)
  expect(snapshot!.sources).toHaveLength(2)
})

it.each([
  ['HTTP 404 unavailable', 'configuration'],
  ['HTTP 401 authorization', 'authorization'],
  ['HTTP 403 forbidden', 'permissions'],
] as const)('retains request failure classification: %s', async (message, category) => {
  uploadedCollection()
  client.request = async () => {
    throw new Error(message)
  }
  const failure = await synchronize(job, client, repository, work).catch(error => error)
  expect(classifyFailure(failure)).toBe(category)
  expect(snapshot).toBeUndefined()
  await expect(readFile(join(work, 'iconify-0.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('materializes an upload before advanced configuration executes and keeps its task-bound source', async () => {
  const bytes = uploadedCollection()
  const marker = join(work, 'advanced-read.json')
  await writeFile(join(repository, 'advanced.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, readFileSync(${JSON.stringify(join(work, 'iconify-0.json'))})); export default { prefix: 'ignored', sources: [{type:'iconify',file:'not-allowed.json'}] };`)
  job.sourceCommit = await saveCommit('{"prefix":"repo","icons":{}}')
  job.project.advancedConfig = { path: 'advanced.mjs', commit: job.sourceCommit }
  await synchronize(job, client, repository, work)
  expect(new Uint8Array(await readFile(marker))).toEqual(bytes)
  expect(snapshot!.json.prefix).toBe('brand')
  expect(Object.keys(snapshot!.json.icons).sort()).toEqual(['home', 'rotated'])
})

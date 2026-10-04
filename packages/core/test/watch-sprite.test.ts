import type { IconctlConfig, WatchEvent, WatchOptions } from '../src'
import type { createWatchObserver } from '../src/watch-observer'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { IconctlAbortError, watch } from '../src'
import { sync } from '../src/sync'

const observations = vi.hoisted(() => ({
  observer: undefined as ReturnType<typeof createWatchObserver> | undefined,
  changes: [] as boolean[],
}))
vi.mock('../src/watch-session', () => import('./helpers/watch-session'))
vi.mock('../src/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync')>()
  return { ...actual, sync: vi.fn(actual.sync) }
})
vi.mock('../src/watch-observer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/watch-observer')>()
  return { ...actual, createWatchObserver: (onChange: Parameters<typeof createWatchObserver>[0], onError: Parameters<typeof createWatchObserver>[1]) => {
    observations.observer = actual.createWatchObserver((configuration) => {
      observations.changes.push(configuration)
      onChange(configuration)
    }, onError)
    return observations.observer
  } }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const changedSvg = svg.replace('h24', 'h12')
let root: string
let cwd: string
let controller: AbortController
let events: WatchEvent[]
let finished: Promise<unknown> | undefined

function config(sprite: string | null = 'generated/bundle.svg', sources: IconctlConfig['sources'] = [{ type: 'directory', dir: 'raw' }]): IconctlConfig {
  return { prefix: 'watch', sources, output: { json: 'icons.json', ...(sprite === null ? {} : { sprite }) } }
}
async function saveConfig(value = config()) {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify(value)}`)
}
async function source(name: string, contents = svg) {
  await writeFile(join(cwd, 'raw', `${name}.svg`), contents)
}
function start(options: Pick<WatchOptions, 'dryRun'> = {}) {
  finished = watch({ cwd, signal: controller.signal, ...options, onEvent: event => events.push(event) }).catch(error => error)
  return finished
}
function results() {
  return events.filter(event => event.type === 'result')
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate(), JSON.stringify(events.map(event => ({
    type: event.type,
    ...('phase' in event ? { phase: event.phase } : {}),
    ...('reason' in event ? { reason: event.reason } : {}),
  })))).toBe(true), { timeout: 5000, interval: 20 })
}
async function reconcile() {
  expect(observations.observer).toBeDefined()
  await observations.observer!.check()
}
async function files(directory = cwd): Promise<Record<string, string>> {
  const contents: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(contents, await files(file))
    }
    else {
      contents[relative(cwd, file)] = await readFile(file, 'utf8')
    }
  }
  return contents
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-watch-sprite-')))
  cwd = join(root, 'project')
  await mkdir(join(cwd, 'raw'), { recursive: true })
  controller = new AbortController()
  events = []
  finished = undefined
  observations.observer = undefined
  observations.changes = []
  vi.mocked(sync).mockClear()
  await source('home')
  await saveConfig()
})
afterEach(async () => {
  controller.abort('test finished')
  await finished
  await rm(root, { recursive: true, force: true })
})

it('updates sprite symbols for edits, renames and deletions without observing generated writes', async () => {
  await source('rename-me')
  await source('remove-me')
  start()
  await until(() => results().length === 1)
  const spriteFile = join(cwd, 'generated/bundle.svg')
  const initial = await readFile(spriteFile, 'utf8')
  expect(initial).toContain('id="iconctl-watch-home"')
  expect(initial).toContain('id="iconctl-watch-rename-me"')
  expect(initial).toContain('id="iconctl-watch-remove-me"')
  await source('home', changedSvg)
  await rename(join(cwd, 'raw/rename-me.svg'), join(cwd, 'raw/renamed.svg'))
  await rm(join(cwd, 'raw/remove-me.svg'))
  await reconcile()
  await until(() => results().length === 2)
  const current = await readFile(spriteFile, 'utf8')
  expect(current).toContain('id="iconctl-watch-renamed"')
  expect(current).not.toContain('id="iconctl-watch-rename-me"')
  expect(current).not.toContain('id="iconctl-watch-remove-me"')
  expect(current).not.toBe(initial)
  expect(results()[1]!.result.diff).toMatchObject({ added: ['renamed'], removed: ['remove-me', 'rename-me'], changed: ['home'] })
  expect(results()[1]!.result.files).toContain(spriteFile)
  expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons).toEqual(results()[1]!.result.json.icons)

  const changes = [...observations.changes]
  // An explicit completed sample checks the same metadata as the idle fallback.
  await reconcile()
  await writeFile(spriteFile, '<svg><!-- external output edit --></svg>')
  await reconcile()
  expect(observations.changes).toEqual(changes)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(results()).toHaveLength(2)
  expect(events.filter(event => event.type === 'error')).toEqual([])
  controller.abort('done')
  expect(await finished).toBeInstanceOf(IconctlAbortError)
})

it.each([
  { name: 'SVG inside its source directory', sprite: 'raw/bundle.svg' },
  { name: 'the source directory itself', sprite: 'raw' },
  { name: 'the configuration file', sprite: 'iconctl.config.ts' },
  { name: 'a source directory alias', sprite: 'alias/bundle.svg', link: 'alias', target: 'raw' },
  { name: 'a source SVG alias', sprite: 'bundle.svg', link: 'bundle.svg', target: 'raw/home.svg' },
  { name: 'a configuration alias', sprite: 'bundle.svg', link: 'bundle.svg', target: 'iconctl.config.ts' },
])('rejects sprite output at $name before starting an import', async ({ sprite, link, target }) => {
  if (link && target) {
    await symlink(join(cwd, target), join(cwd, link))
  }
  await saveConfig(config(sprite))
  const originalConfig = await readFile(join(cwd, 'iconctl.config.ts'), 'utf8')
  const originalSource = await readFile(join(cwd, 'raw/home.svg'), 'utf8')
  const error = await start()
  expect(error).toBeInstanceOf(Error)
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', phase: 'config', fatal: true }))
  expect(events.some(event => event.type === 'ready' || event.type === 'start')).toBe(false)
  expect(sync).not.toHaveBeenCalled()
  expect(await readFile(join(cwd, 'iconctl.config.ts'), 'utf8')).toBe(originalConfig)
  expect(await readFile(join(cwd, 'raw/home.svg'), 'utf8')).toBe(originalSource)
})

it('preserves the existing JSON when sprite and JSON output targets collide', async () => {
  await saveConfig(config('icons.json'))
  const previous = JSON.stringify({ prefix: 'watch', icons: { previous: { body: '<path d="M0 0h1v1H0z"/>' } }, width: 24, height: 24 })
  await writeFile(join(cwd, 'icons.json'), previous)
  start()
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(events).toContainEqual(expect.objectContaining({
    type: 'error',
    phase: 'sync',
    fatal: false,
    error: expect.objectContaining({ message: expect.stringContaining('Conflicting output targets') }),
  }))
  expect(results()).toHaveLength(0)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(previous)
  expect((await readdir(cwd)).some(file => file.startsWith('.iconctl-stage-'))).toBe(false)
})

it.each([false, true])('validates sprite changes in dry-run without creating or replacing files (existing: %s)', async (existing) => {
  if (existing) {
    await mkdir(join(cwd, 'generated'))
    await writeFile(join(cwd, 'generated/bundle.svg'), '<svg><!-- old sprite --></svg>')
    await writeFile(join(cwd, 'icons.json'), JSON.stringify({ prefix: 'watch', icons: {}, width: 24, height: 24 }))
  }
  const before = await files()
  start({ dryRun: true })
  await until(() => results().length === 1)
  expect(results()[0]!.result.files).toEqual([])
  expect(await files()).toEqual(before)
  await source('new')
  const edited = await files()
  await reconcile()
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons).sort()).toEqual(['home', 'new'])
  expect(results()[1]!.result.files).toEqual([])
  expect(await files()).toEqual(edited)
  expect(events.filter(event => event.type === 'error')).toEqual([])
})

it('enables sprite output on reload and stops excluding it when disabled and configured as a source', async () => {
  await saveConfig(config(null))
  start()
  await until(() => results().length === 1)
  expect(results()[0]!.result.files).not.toContain(join(cwd, 'generated/bundle.svg'))

  await saveConfig()
  await reconcile()
  await until(() => results().length === 2)
  const spriteFile = join(cwd, 'generated/bundle.svg')
  expect(await readFile(spriteFile, 'utf8')).toContain('id="iconctl-watch-home"')
  expect(results()[1]!.result.files).toContain(spriteFile)
  const notices = [...observations.changes]
  await writeFile(spriteFile, svg)
  await reconcile()
  expect(observations.changes).toEqual(notices)

  await saveConfig(config(null, [{ type: 'directory', dir: 'raw' }, { type: 'directory', dir: 'generated' }]))
  await reconcile()
  await until(() => results().length === 3)
  expect(Object.keys(results()[2]!.result.json.icons).sort()).toEqual(['bundle', 'home'])
  expect(results()[2]!.result.files).not.toContain(spriteFile)
  await writeFile(spriteFile, changedSvg)
  await reconcile()
  await until(() => results().length === 4)
  expect(results()[3]!.result.diff.changed).toEqual(['bundle'])
  expect(await readFile(spriteFile, 'utf8')).toBe(changedSvg)

  // A reload cannot re-enable sprite at a location that is now a source.
  await saveConfig(config('generated/bundle.svg', [{ type: 'directory', dir: 'raw' }, { type: 'directory', dir: 'generated' }]))
  await reconcile()
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  expect(sync).toHaveBeenCalledTimes(4)
  expect(await readFile(spriteFile, 'utf8')).toBe(changedSvg)
  await saveConfig(config('next/bundle.svg'))
  await reconcile()
  await until(() => results().length === 5)
  expect(results()[4]!.result.files).toContain(join(cwd, 'next/bundle.svg'))
  expect(Object.keys(results()[4]!.result.json.icons)).toEqual(['home'])
  const recoveredNotices = [...observations.changes]
  await writeFile(spriteFile, svg)
  await reconcile()
  expect(observations.changes).toEqual(recoveredNotices)
  expect(sync).toHaveBeenCalledTimes(5)
})

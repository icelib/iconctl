import type { IconctlConfig, WatchEvent } from '../src'
import type { WatchConfigSnapshot } from '../src/watch-config-snapshot'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'
import { loadConfigDetails } from '../src/load-config'
import { sync } from '../src/sync'
import { watchConfigChangedSinceRead } from '../src/watch-config-snapshot'
import { watchPaths } from '../src/watch-paths'

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn((...args: Parameters<typeof actual.watch>) => {
    const listener = actual.watch(...args)
    const emit = listener.emit.bind(listener)
    listener.emit = ((event: string | symbol, ...values: unknown[]) => event === 'all' || event === 'raw' ? false : Reflect.apply(emit, listener, [event, ...values])) as typeof listener.emit
    return listener
  }) }
})
vi.mock('../src/watch-session', () => import('./helpers/watch-session'))
vi.mock('../src/watch-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/watch-paths')>()
  return { ...actual, watchPaths: vi.fn(actual.watchPaths) }
})
vi.mock('../src/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync')>()
  return { ...actual, sync: vi.fn(actual.sync) }
})

let cwd: string
let controller: AbortController
let events: WatchEvent[]
let finished: Promise<unknown> | undefined
let releases: (() => void)[]

function config(prefix: string): IconctlConfig {
  return { prefix, sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json', svg: 'svg' } }
}
async function save(file: string, prefix: string) {
  await writeFile(file, `export default ${JSON.stringify(config(prefix))}`)
}
function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error)
}
function results() {
  return events.filter(event => event.type === 'result')
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate(), JSON.stringify(events)).toBe(true), { timeout: 5000, interval: 20 })
}
async function blockPaths() {
  let release!: () => void
  let entered = false
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  const actual = await vi.importActual<typeof import('../src/watch-paths')>('../src/watch-paths')
  vi.mocked(watchPaths).mockImplementationOnce(async (...args) => {
    // The configuration is already evaluated; no observer for this generation
    // has been installed and its new extends files are absent from the old one.
    entered = true
    await pending
    return actual.watchPaths(...args)
  })
  return { release, entered: () => entered }
}

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-config-read-')))
  controller = new AbortController()
  events = []
  finished = undefined
  releases = []
  await mkdir(join(cwd, 'raw'))
  await writeFile(join(cwd, 'raw/home.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
  await save(join(cwd, 'iconctl.config.ts'), 'initial')
  const actualPaths = await vi.importActual<typeof import('../src/watch-paths')>('../src/watch-paths')
  const actualSync = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  vi.mocked(watchPaths).mockReset().mockImplementation(actualPaths.watchPaths)
  vi.mocked(sync).mockReset().mockImplementation(actualSync.sync)
  vi.mocked(watchFiles).mockClear()
})

afterEach(async () => {
  controller.abort()
  for (const release of releases) {
    release()
  }
  const outcome = await finished
  await rm(cwd, { recursive: true, force: true })
  if (finished) {
    expect(outcome).toBeInstanceOf(IconctlAbortError)
  }
})

it('reloads a main config edited after evaluation before the first observer exists', async () => {
  const gate = await blockPaths()
  start()
  await until(gate.entered)
  await save(join(cwd, 'iconctl.config.ts'), 'fresh-main')
  gate.release()
  await until(() => results().length === 1)
  expect(results()[0]!.result.prefix).toBe('fresh-main')
  expect(sync).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === 'ready')).toHaveLength(1)
  expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).prefix).toBe('fresh-main')
})

it('reloads a newly referenced extends layer edited after its first evaluation', async () => {
  start()
  await until(() => results().length === 1)
  const layer = join(cwd, 'layer.ts')
  await save(layer, 'stale-layer')
  const gate = await blockPaths()
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./layer.ts"] }')
  await until(gate.entered)
  await save(layer, 'fresh-layer')
  gate.release()
  await until(() => results().length === 2)
  expect(results().map(event => event.result.prefix)).toEqual(['initial', 'fresh-layer'])
  expect(sync).toHaveBeenCalledTimes(2)
  expect(events.filter(event => event.type === 'ready')).toHaveLength(2)
})

it('detects an ancestor link replacement between config evaluation and watch installation', async () => {
  await mkdir(join(cwd, 'first'))
  await mkdir(join(cwd, 'second'))
  await save(join(cwd, 'first/layer.ts'), 'stale-target')
  await save(join(cwd, 'second/layer.ts'), 'fresh-target')
  await symlink(join(cwd, 'first'), join(cwd, 'settings'), 'dir')
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./settings/layer.ts"] }')
  const gate = await blockPaths()
  start()
  await until(gate.entered)
  await symlink(join(cwd, 'second'), join(cwd, 'replacement'), 'dir')
  await rename(join(cwd, 'replacement'), join(cwd, 'settings'))
  gate.release()
  await until(() => results().length === 1)
  expect(results()[0]!.result.prefix).toBe('fresh-target')
  expect(sync).toHaveBeenCalledTimes(1)
})

it.each(['.config/iconctl.ts', 'iconctl.config/index.ts'])('captures %s resolution before its evaluation', async (relativeFile) => {
  await rm(join(cwd, 'iconctl.config.ts'))
  await mkdir(join(cwd, relativeFile.startsWith('.config') ? '.config' : 'iconctl.config'))
  const file = join(cwd, relativeFile)
  await save(file, 'resolved')
  const loaded = await loadConfigDetails({ cwd }, true)
  expect(loaded.entryFile).toBe(file)
  expect(await watchConfigChangedSinceRead(loaded.configReadSnapshot)).toBe(false)
  await save(file, 'edited')
  expect(await watchConfigChangedSinceRead(loaded.configReadSnapshot)).toBe(true)
})

it('keeps ordinary import helpers outside the explicit configuration read boundary', async () => {
  const helper = join(cwd, 'helper.ts')
  await writeFile(helper, 'export default "before"')
  await writeFile(join(cwd, 'iconctl.config.ts'), `import prefix from './helper.ts'; export default { ...${JSON.stringify(config('unused'))}, prefix }`)
  const loaded = await loadConfigDetails({ cwd }, true)
  expect(loaded.config.prefix).toBe('before')
  expect(loaded.configReadSnapshot.files).not.toContain(helper)
  await writeFile(helper, 'export default "after"')
  expect(await watchConfigChangedSinceRead(loaded.configReadSnapshot)).toBe(false)
})

it('captures versions before evaluating an async config exactly once', async () => {
  const file = join(cwd, 'iconctl.config.ts')
  const replacement = `export default ${JSON.stringify(config('next-evaluation'))}`
  await writeFile(file, `import { writeFile } from 'node:fs/promises'; export default async () => {
    await writeFile(${JSON.stringify(file)}, ${JSON.stringify(replacement)});
    return ${JSON.stringify(config('first-evaluation'))};
  }`)
  const loaded = await loadConfigDetails({ cwd }, true)
  expect(loaded.config.prefix).toBe('first-evaluation')
  expect(await readFile(file, 'utf8')).toBe(replacement)
  expect(await watchConfigChangedSinceRead(loaded.configReadSnapshot)).toBe(true)
})

it('retains a failed extends read boundary so repair before recovery install is detectable', async () => {
  const layer = join(cwd, 'layer.ts')
  await writeFile(layer, 'export default { broken!')
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./layer.ts"] }')
  let attempted: WatchConfigSnapshot | undefined
  const files: string[] = []
  await expect(loadConfigDetails({ cwd }, true, file => files.push(file), snapshot => attempted = snapshot)).rejects.toThrow()
  expect(files).toContain(layer)
  expect(attempted!.files).toContain(layer)
  expect(await watchConfigChangedSinceRead(attempted!)).toBe(false)
  await save(layer, 'repaired')
  expect(await watchConfigChangedSinceRead(attempted!)).toBe(true)
})

it('recovers a failed newly resolved JSON5 layer after its recovery observer is installed', async () => {
  start()
  await until(() => results().length === 1)
  const layer = join(cwd, 'layer.config.json5')
  await writeFile(layer, '{ prefix: broken! }')
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./layer.config"] }')
  // One failed load installs the new candidates, then an explicit retry checks
  // that installation window. The second failure is now stably paused.
  await until(() => events.filter(event => event.type === 'error' && event.phase === 'config').length === 2)
  await writeFile(layer, JSON.stringify(config('repaired-json5')))
  await until(() => results().length === 2)
  expect(results().map(event => event.result.prefix)).toEqual(['initial', 'repaired-json5'])
  expect(sync).toHaveBeenCalledTimes(2)
})

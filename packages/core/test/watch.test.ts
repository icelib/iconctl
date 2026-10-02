import type { IconctlConfig, WatchEvent } from '../src'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'
import { sync } from '../src/sync'

vi.mock('../src/sync', async (original) => {
  const actual = await original<typeof import('../src/sync')>()
  return { ...actual, sync: vi.fn(actual.sync) }
})
vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
let cwd: string
let events: WatchEvent[]
let controller: AbortController
let finished: Promise<unknown> | undefined

function config(input = 'raw', extra: Partial<IconctlConfig> = {}): IconctlConfig {
  return { prefix: 'watch', sources: [{ type: 'directory', dir: input }], output: { json: 'icons.json', svg: 'svg' }, ...extra }
}
async function saveConfig(value: IconctlConfig = config()) {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify(value)}`)
}
async function source(directory = 'raw', name = 'home') {
  await mkdir(join(cwd, directory), { recursive: true })
  await writeFile(join(cwd, directory, `${name}.svg`), svg)
}
function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error)
  return finished
}
async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 8000, interval: 20 })
}
function results() {
  return events.filter(event => event.type === 'result')
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-watch-'))
  events = []
  controller = new AbortController()
  finished = undefined
  vi.mocked(sync).mockClear()
  vi.mocked(watchFiles).mockClear()
  await source()
  await saveConfig()
})
afterEach(async () => {
  controller.abort()
  await finished
  await rm(cwd, { recursive: true, force: true })
})

it('runs initially, debounces SVG edits, ignores outputs and closes on cancellation', async () => {
  start()
  await until(() => results().length === 1)
  await Promise.all(['a', 'b', 'c'].map(name => source('raw', name)))
  await until(() => results().length === 2)
  expect(results()[1]!.result.diff.added).toEqual(['a', 'b', 'c'])
  await writeFile(join(cwd, 'raw', 'notes.json'), '{}')
  await writeFile(join(cwd, 'svg', 'output.svg'), svg)
  await mkdir(join(cwd, 'raw', '.hidden'))
  await writeFile(join(cwd, 'raw', '.hidden', 'skip.svg'), svg)
  await setTimeout(400)
  expect(results()).toHaveLength(2)
  controller.abort('done')
  expect(await finished).toBeInstanceOf(IconctlAbortError)
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'aborted' })
  await source('raw', 'late')
  expect(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).icons).not.toHaveProperty('late')
})

it('coalesces changes during a run into one serial follow-up', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  let release!: () => void
  let entered = false
  vi.mocked(sync).mockImplementationOnce(async (options) => {
    entered = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return actual.sync(options)
  })
  start()
  await until(() => entered)
  await source('raw', 'a')
  await source('raw', 'b')
  await setTimeout(220)
  expect(sync).toHaveBeenCalledTimes(1)
  release()
  await until(() => results().length === 2)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(events.filter(event => event.type === 'start').map(event => event.reason)).toEqual(['initial', 'source'])
})

it('pauses on invalid config, reloads without cache and switches source roots', async () => {
  start()
  await until(() => results().length === 1)
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { broken!')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  await source('raw', 'ignored-while-paused')
  await setTimeout(220)
  expect(results()).toHaveLength(1)
  await source('next', 'next')
  await saveConfig(config('next', { prefix: 'updated' }))
  await until(() => results().length === 2)
  expect(results()[1]!.result.prefix).toBe('updated')
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['next'])
  await source('raw', 'old-root')
  await setTimeout(220)
  expect(results()).toHaveLength(2)
  await source('next', 'new-root')
  await until(() => results().length === 3)
})

it('recovers from deleted source and configuration files', async () => {
  start()
  await until(() => results().length === 1)
  await rm(join(cwd, 'raw'), { recursive: true })
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  await source('raw', 'restored')
  await until(() => results().length === 2)
  await rm(join(cwd, 'iconctl.config.ts'))
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config'))
  await saveConfig(config('raw', { prefix: 'restored' }))
  await until(() => results().length === 3)
  expect(results()[2]!.result.prefix).toBe('restored')
})

it('watches local extends layers', async () => {
  await writeFile(join(cwd, 'base.ts'), `export default ${JSON.stringify(config())}`)
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./base.ts"] }')
  start()
  await until(() => results().length === 1)
  await writeFile(join(cwd, 'base.ts'), `export default ${JSON.stringify(config('raw', { prefix: 'layer' }))}`)
  await until(() => results().length === 2)
  expect(results()[1]!.result.prefix).toBe('layer')
  await rm(join(cwd, 'base.ts'))
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config'))
  await writeFile(join(cwd, 'base.ts'), `export default ${JSON.stringify(config('raw', { prefix: 'fixed-layer' }))}`)
  await until(() => results().length === 3)
  expect(results()[2]!.result.prefix).toBe('fixed-layer')
})

it('recovers when a newly referenced missing extends file is created', async () => {
  start()
  await until(() => results().length === 1)
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./new-layer.ts"] }')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config'))
  await writeFile(join(cwd, 'new-layer.ts'), `export default ${JSON.stringify(config('raw', { prefix: 'new-layer' }))}`)
  await until(() => results().length === 2)
  expect(results()[1]!.result.prefix).toBe('new-layer')
})

it('resolves local directory extends', async () => {
  await mkdir(join(cwd, 'base'))
  await writeFile(join(cwd, 'base', 'iconctl.config.ts'), `export default ${JSON.stringify(config())}`)
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { extends: ["./base"] }')
  start()
  await until(() => results().length === 1)
})

it('aborts a stale run before reloading configuration', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  let entered = false
  vi.mocked(sync).mockImplementationOnce(async (options) => {
    entered = true
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return actual.sync(options)
  })
  start()
  await until(() => entered)
  await saveConfig(config('raw', { prefix: 'new' }))
  await until(() => results().length === 1)
  expect(results()[0]).toMatchObject({ runId: 2, result: { prefix: 'new' } })
  expect(events.filter(event => event.type === 'error')).toEqual([])
})

it('cancels and drains an active run before resolving cleanup', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  let entered = false
  vi.mocked(sync).mockImplementationOnce(async (options) => {
    entered = true
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return actual.sync(options)
  })
  start()
  await until(() => entered)
  controller.abort()
  expect(await finished).toBeInstanceOf(IconctlAbortError)
  expect(results()).toHaveLength(0)
  await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  config('svg'),
  config('.', { output: { json: 'icons.json', svg: 'raw/output' } }),
  config('raw', { output: { jsonPackage: { dir: 'raw/package' } } }),
  config('raw', { cacheDir: '.' }),
  config('raw', { cacheDir: 'raw/cache' }),
  config('raw', { output: { json: 'raw/generated.svg' } }),
  config('raw', { output: { json: 'iconctl.config.ts' } }),
  config('raw', { sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }] }),
  config('raw', { sources: [{ type: 'iconfont', dir: 'raw', url: 'https://example.test/iconfont.js' }] }),
])('rejects unsafe or remote initial configuration %#', async (value) => {
  await saveConfig(value)
  expect(await start()).toBeInstanceOf(Error)
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', phase: 'config', fatal: true }))
  expect(sync).not.toHaveBeenCalled()
})

it('rejects symlink aliases into output directories before writing', async () => {
  await mkdir(join(cwd, 'svg'))
  await symlink(join(cwd, 'svg'), join(cwd, 'raw', 'alias'), 'dir')
  start()
  await until(() => events.some(event => event.type === 'error'))
  expect(sync).not.toHaveBeenCalled()
  await expect(readFile(join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts local iconfont and jsdesign folders', async () => {
  await saveConfig(config('raw', { sources: [{ type: 'iconfont', dir: 'raw' }, { type: 'jsdesign', dir: 'raw' }] }))
  start()
  await until(() => results().length === 1)
  expect(results()[0]!.result.sources.map(item => item.type)).toEqual(['iconfont', 'jsdesign'])
})

it('allows non-SVG output files and hidden cache inside sources without loops', async () => {
  await saveConfig(config('raw', {
    output: { json: 'raw/icons.json', types: 'raw/icons.d.ts', preview: 'raw/preview.html' },
    cacheDir: 'raw/.cache',
  }))
  start()
  await until(() => results().length === 1)
  await setTimeout(350)
  expect(results()).toHaveLength(1)
  expect(events.filter(event => event.type === 'error')).toEqual([])
})

it('rejects an output alias through an existing ancestor before creating the output', async () => {
  await symlink(join(cwd, 'raw'), join(cwd, 'alias'), 'dir')
  await saveConfig(config('raw', { output: { svg: 'alias/not-created-yet' } }))
  expect(await start()).toBeInstanceOf(Error)
  expect(sync).not.toHaveBeenCalled()
})

it('rejects recursive source directory links before importing', async () => {
  await symlink(join(cwd, 'raw'), join(cwd, 'raw', 'loop'), 'dir')
  start()
  await until(() => events.some(event => event.type === 'error'))
  expect(sync).not.toHaveBeenCalled()
})

it('does not start a run when cancelled from the ready event', async () => {
  finished = watch({ cwd, signal: controller.signal, onEvent(event) {
    events.push(event)
    if (event.type === 'ready') {
      controller.abort()
    }
  } }).catch(error => error)
  expect(await finished).toBeInstanceOf(IconctlAbortError)
  expect(sync).not.toHaveBeenCalled()
  expect(events.map(event => event.type)).toEqual(['ready', 'stopped'])
})

it('reports watcher creation failure as fatal', async () => {
  vi.mocked(watchFiles).mockImplementationOnce(() => {
    throw new Error('watch unavailable')
  })
  expect(await start()).toMatchObject({ message: 'watch unavailable' })
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', phase: 'watch', fatal: true }))
  expect(sync).not.toHaveBeenCalled()
})

it('closes the watcher after an asynchronous watcher failure', async () => {
  start()
  await until(() => results().length === 1)
  const listener = vi.mocked(watchFiles).mock.results[0]!.value
  listener.emit('error', new Error('watch failed'))
  expect(await finished).toMatchObject({ message: 'watch failed' })
  expect(listener.closed).toBe(true)
  expect(events.at(-2)).toMatchObject({ type: 'error', phase: 'watch', fatal: true })
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'error' })
})

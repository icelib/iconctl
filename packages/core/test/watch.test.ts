import type { IconctlConfig, WatchEvent } from '../src'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'
import { sync } from '../src/sync'

const timing = vi.hoisted(() => ({ startedAt: 0, syncEntries: [] as number[] }))

vi.mock('../src/sync', async (original) => {
  const actual = await original<typeof import('../src/sync')>()
  return {
    ...actual,
    sync: vi.fn((options) => {
      timing.syncEntries.push(Date.now() - timing.startedAt)
      return actual.sync(options)
    }),
  }
})
vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
let fixtureRoot: string
let cwd: string
let events: WatchEvent[]
let eventTimes: number[]
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
function recordEvent(event: WatchEvent) {
  eventTimes.push(Date.now() - timing.startedAt)
  events.push(event)
}
function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: recordEvent }).catch(error => error)
  return finished
}
async function until(predicate: () => boolean, phase = 'watch condition') {
  const startedAt = Date.now()
  await vi.waitFor(() => {
    const summary = events.map((event, index) => ({
      elapsed: eventTimes[index],
      type: event.type,
      ...('runId' in event ? { runId: event.runId } : {}),
      ...('reason' in event ? { reason: event.reason } : {}),
      ...('phase' in event ? { phase: event.phase } : {}),
    }))
    expect(predicate(), JSON.stringify({ phase, waitElapsed: Date.now() - startedAt, syncCalls: vi.mocked(sync).mock.calls.length, syncEntries: timing.syncEntries, results: events.filter(event => event.type === 'result').length, events: summary })).toBe(true)
  }, { timeout: 8000, interval: 20 })
}
function results() {
  return events.filter(event => event.type === 'result')
}

beforeEach(async () => {
  timing.startedAt = Date.now()
  timing.syncEntries = []
  // External targets stay outside cwd, with parent scans confined to our fixture.
  fixtureRoot = await mkdtemp(join(tmpdir(), 'iconctl-watch-'))
  cwd = join(fixtureRoot, 'project')
  await mkdir(cwd)
  events = []
  eventTimes = []
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
  await rm(fixtureRoot, { recursive: true, force: true })
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
    timing.syncEntries.push(Date.now() - timing.startedAt)
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
    timing.syncEntries.push(Date.now() - timing.startedAt)
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
    timing.syncEntries.push(Date.now() - timing.startedAt)
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

it('ignores replayed discovery and access-only notifications while preserving real edits', async () => {
  start()
  await until(() => results().length === 1)
  const listener = vi.mocked(watchFiles).mock.results[0]!.value
  for (const file of ['raw/home.svg', 'iconctl.config.ts']) {
    const target = join(cwd, file)
    const info = await stat(target)
    // Chokidar can emit change with the same file version after access updates.
    const accessed = Object.assign(Object.create(info), { atimeMs: info.atimeMs + 1000 })
    listener.emit('all', 'change', target, accessed)
    listener.emit('all', 'add', target, info)
  }
  listener.emit('all', 'addDir', join(cwd, 'raw'), await stat(join(cwd, 'raw')))
  await setTimeout(350)
  expect(results()).toHaveLength(1)
  await writeFile(join(cwd, 'raw/home.svg'), svg.replace('h24', 'h12'))
  await until(() => results().length === 2)
  expect(results()[1]!.result.diff.changed).toEqual(['home'])
})

it('reloads an unchanged config saved again and preserves atomic file replacement', async () => {
  start()
  await until(() => results().length === 1)
  await saveConfig()
  await until(() => results().length === 2)
  expect(events.filter(event => event.type === 'start').at(-1)).toMatchObject({ reason: 'config' })
  // Replacing with identical bytes still creates a new filesystem entry.
  await writeFile(join(cwd, 'raw/temporary'), svg)
  await rename(join(cwd, 'raw/temporary'), join(cwd, 'raw/home.svg'))
  await until(() => results().length === 3)
  expect(events.filter(event => event.type === 'start').at(-1)).toMatchObject({ reason: 'source' })
})

it('invalidates all path aliases when a directory is removed and rediscovered', async () => {
  await symlink(cwd, join(cwd, 'alias'), 'dir')
  await saveConfig(config('raw', { sources: [{ type: 'directory', dir: 'raw' }, { type: 'directory', dir: 'alias/raw' }] }))
  start()
  await until(() => results().length === 1)
  const listener = vi.mocked(watchFiles).mock.results[0]!.value
  // Native notifications may use different spellings for the same entry. A
  // moved-out/moved-back directory can retain its inode and birthtime.
  listener.emit('all', 'unlinkDir', join(cwd, 'raw'))
  await until(() => results().length === 2)
  listener.emit('all', 'addDir', join(cwd, 'alias/raw'), await stat(join(cwd, 'alias/raw')))
  await until(() => results().length === 3)
})

it('ignores a late initial link discovery while still observing its target changes', async () => {
  const external = await mkdtemp(join(fixtureRoot, 'iconctl-watch-late-link-'))
  await writeFile(join(external, 'external.svg'), svg)
  const link = join(cwd, 'raw/linked')
  await symlink(external, link, 'dir')
  start()
  await until(() => results().length === 1)
  const listener = vi.mocked(watchFiles).mock.results.at(-1)!.value
  expect(listener.closed).toBe(false)
  expect(listener.listenerCount('all')).toBeGreaterThan(0)
  listener.emit('all', 'add', link, await lstat(link))
  await setTimeout(350)
  expect(events.filter(event => event.type === 'start')).toHaveLength(1)
  expect(results()).toHaveLength(1)
  await writeFile(join(external, 'external.svg'), svg.replace('h24', 'h12'))
  await until(() => results().length === 2)
  expect(results()[1]!.result.diff.changed).toEqual(['external'])
  await symlink(external, join(cwd, 'replacement-link'), 'dir')
  await rename(join(cwd, 'replacement-link'), link)
  await until(() => results().length === 3)
  expect(events.filter(event => event.type === 'start').at(-1)).toMatchObject({ reason: 'source' })
})

it('rejects an output alias through an existing ancestor before creating the output', async () => {
  await symlink(join(cwd, 'raw'), join(cwd, 'alias'), 'dir')
  await saveConfig(config('raw', { output: { svg: 'alias/not-created-yet' } }))
  expect(await start()).toBeInstanceOf(Error)
  expect(sync).not.toHaveBeenCalled()
})

it('rejects recursive source directory links before importing', async () => {
  await symlink(join(cwd, 'raw'), join(cwd, 'raw', 'loop'), 'dir')
  expect(await start()).toBeInstanceOf(Error)
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', phase: 'config', fatal: true }))
  expect(watchFiles).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
})

it.each(['ancestor', 'self'])('recovers from a %s directory link added after readiness without following it', async (kind) => {
  start()
  await until(() => results().length === 1)
  const previous = await readFile(join(cwd, 'icons.json'), 'utf8')
  const link = join(cwd, 'raw', 'loop')
  await symlink(kind === 'ancestor' ? join(cwd, 'raw') : link, link, 'dir')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(previous)
  await rm(link)
  await until(() => results().length === 2)
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
  expect(vi.mocked(watchFiles).mock.calls.every(([, options]) => options?.followSymlinks === false)).toBe(true)
})

it('adds and removes explicit watches for valid external SVG directory links', async () => {
  const external = await mkdtemp(join(fixtureRoot, 'iconctl-watch-svg-target-'))
  await writeFile(join(external, 'external.svg'), svg)
  start()
  await until(() => results().length === 1, 'initial source import')
  const link = join(cwd, 'raw', 'linked')
  await symlink(external, link, 'dir')
  await until(() => results().length === 2, 'external directory link added')
  expect(results()[1]!.result.processed).toBe(2)
  await writeFile(join(external, 'added.svg'), svg)
  await until(() => results().length === 3, 'SVG added inside external directory')
  expect(results()[2]!.result.processed).toBe(3)
  await rm(link)
  await until(() => results().length === 4, 'external directory link removed')
  expect(results()[3]!.result.processed).toBe(1)
  await writeFile(join(external, 'unobserved.svg'), svg)
  await setTimeout(350)
  expect(results()).toHaveLength(4)
})

it('observes an SVG symlink target with a different extension and a dangling target being repaired', async () => {
  const external = await mkdtemp(join(fixtureRoot, 'iconctl-watch-svg-file-'))
  const target = join(external, 'icon.asset')
  await writeFile(target, svg)
  await symlink(target, join(cwd, 'raw', 'linked.svg'))
  start()
  await until(() => results().length === 1)
  await writeFile(target, svg.replace('h24', 'h12'))
  await until(() => results().length === 2)
  await rm(target)
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  await writeFile(target, svg)
  await until(() => results().length === 3)
  expect(results()[2]!.result.processed).toBe(2)
})

it('does not start a run when cancelled from the ready event', async () => {
  finished = watch({ cwd, signal: controller.signal, onEvent(event) {
    recordEvent(event)
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

it('watches an Iconify JSON file, recovers after deletion and ignores other JSON outputs', async () => {
  const vendor = (name: string) => JSON.stringify({ prefix: 'vendor', icons: { [name]: { body: '<path d="M0 0h8v8H0z"/>' } } })
  await writeFile(join(cwd, 'vendor.json'), vendor('first'))
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file: 'vendor.json' }] }))
  start()
  await until(() => results().length === 1)
  await writeFile(join(cwd, 'vendor.json'), vendor('second'))
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['second'])
  await writeFile(join(cwd, 'unrelated.json'), '{}')
  await setTimeout(250)
  expect(results()).toHaveLength(2)
  await rm(join(cwd, 'vendor.json'))
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  await writeFile(join(cwd, 'vendor.json'), vendor('restored'))
  await until(() => results().length === 3)
  expect(Object.keys(results()[2]!.result.json.icons)).toEqual(['restored'])
})

it.each(['icons.json', 'svg/vendor.json', '.iconctl-cache/vendor.json'])('rejects an Iconify source overwritten by an output/cache path: %s', async (file) => {
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file }] }))
  expect(await start()).toBeInstanceOf(Error)
  expect(sync).not.toHaveBeenCalled()
})

it('rejects a JSON input symlink that points to an output', async () => {
  await writeFile(join(cwd, 'icons.json'), '{"prefix":"vendor","icons":{}}')
  await symlink(join(cwd, 'icons.json'), join(cwd, 'vendor.json'))
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file: 'vendor.json' }] }))
  expect(await start()).toBeInstanceOf(Error)
  expect(sync).not.toHaveBeenCalled()
})

it('observes a valid JSON symlink target changing outside the project, including atomic saves', async () => {
  const external = await mkdtemp(join(fixtureRoot, 'iconctl-watch-target-'))
  const target = join(external, 'icons.json')
  const vendor = (name: string) => JSON.stringify({ prefix: 'vendor', icons: { [name]: { body: '<path d="M0 0h8v8H0z"/>' } } })
  await writeFile(target, vendor('first'))
  await symlink(target, join(cwd, 'vendor.json'))
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file: 'vendor.json' }] }))
  start()
  await until(() => results().length === 1)
  await writeFile(target, vendor('edited'))
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['edited'])
  await writeFile(join(external, 'temporary.json'), vendor('atomic'))
  await rename(join(external, 'temporary.json'), target)
  await until(() => results().length === 3)
  expect(Object.keys(results()[2]!.result.json.icons)).toEqual(['atomic'])
})

it('recovers a configured JSON link after self-reference, retargeting and target recreation', async () => {
  const external = await mkdtemp(join(fixtureRoot, 'iconctl-watch-json-link-'))
  const target = join(external, 'icons.json')
  const vendor = (name: string) => JSON.stringify({ prefix: 'vendor', icons: { [name]: { body: '<path d="M0 0h8v8H0z"/>' } } })
  await writeFile(target, vendor('first'))
  const link = join(cwd, 'vendor.json')
  await symlink(target, link)
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file: 'vendor.json' }] }))
  start()
  await until(() => results().length === 1)
  await symlink(link, join(cwd, 'temporary-link'))
  await rename(join(cwd, 'temporary-link'), link)
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  const replacement = join(external, 'replacement.json')
  await writeFile(replacement, vendor('replacement'))
  await symlink(replacement, join(cwd, 'temporary-link'))
  await rename(join(cwd, 'temporary-link'), link)
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['replacement'])
  await writeFile(target, vendor('obsolete'))
  await setTimeout(350)
  expect(results()).toHaveLength(2)
  const errors = events.filter(event => event.type === 'error').length
  await rm(replacement)
  await until(() => events.filter(event => event.type === 'error').length > errors)
  await writeFile(replacement, vendor('restored'))
  await until(() => results().length === 3)
  expect(Object.keys(results()[2]!.result.json.icons)).toEqual(['restored'])
})

it('recovers when the JSON source parent is removed and recreated', async () => {
  await mkdir(join(cwd, 'vendor'))
  const vendor = JSON.stringify({ prefix: 'vendor', icons: { home: { body: '<path d="M0 0h8v8H0z"/>' } } })
  await writeFile(join(cwd, 'vendor', 'icons.json'), vendor)
  await saveConfig(config('raw', { sources: [{ type: 'iconify', file: 'vendor/icons.json' }] }))
  start()
  await until(() => results().length === 1)
  await rm(join(cwd, 'vendor'), { recursive: true })
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  await mkdir(join(cwd, 'vendor'))
  await writeFile(join(cwd, 'vendor', 'icons.json'), vendor)
  await until(() => results().length === 2)
})

it.each(['iconify', 'directory', 'config'] as const)('rejects a %s symlink entry inside a generated package even if its target is outside', async (kind) => {
  await mkdir(join(cwd, 'package'))
  const settings = config('raw', { output: { json: 'icons.json', jsonPackage: 'package' } })
  if (kind === 'iconify') {
    await writeFile(join(cwd, 'external.json'), '{"prefix":"vendor","icons":{}}')
    await symlink(join(cwd, 'external.json'), join(cwd, 'package', 'input.json'))
    settings.sources = [{ type: 'iconify', file: 'package/input.json' }]
  }
  else if (kind === 'directory') {
    await symlink(join(cwd, 'raw'), join(cwd, 'package', 'input'), 'dir')
    settings.sources = [{ type: 'directory', dir: 'package/input' }]
  }
  else {
    await writeFile(join(cwd, 'external.config.ts'), `export default ${JSON.stringify(settings)}`)
    await symlink(join(cwd, 'external.config.ts'), join(cwd, 'package', 'config.ts'))
    finished = watch({ cwd, configFile: 'package/config.ts', signal: controller.signal, onEvent: recordEvent }).catch(error => error)
    expect(await finished).toBeInstanceOf(Error)
    expect(sync).not.toHaveBeenCalled()
    return
  }
  await saveConfig(settings)
  expect(await start()).toBeInstanceOf(Error)
  expect(sync).not.toHaveBeenCalled()
})

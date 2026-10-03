import type { FSWatcher } from 'chokidar'
import type { IconctlConfig, WatchEvent } from '../src'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'
import { sync } from '../src/sync'

const linkReads = vi.hoisted(() => ({ pending: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readlink: (...args: Parameters<typeof actual.readlink>) => {
      linkReads.pending++
      return actual.readlink(...args).finally(() => {
        linkReads.pending--
      })
    },
  }
})

vi.mock('../src/sync', async (original) => {
  const actual = await original<typeof import('../src/sync')>()
  return { ...actual, sync: vi.fn(actual.sync) }
})

vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn() }
})

class ControlledWatcher extends EventEmitter {
  closed = false
  private rejectStat!: (error: Error) => void
  private readonly pendingStat = new Promise<void>((_resolve, reject) => {
    this.rejectStat = reject
  }).catch((error) => {
    this.emit('error', error)
  })

  close() {
    // Chokidar 5 removes listeners synchronously, but does not await pending stat
    // work. Its eventual error emission can therefore happen after close resolves.
    this.closed = true
    this.removeAllListeners()
    return Promise.resolve()
  }

  failPendingStat(error: Error) {
    this.rejectStat(error)
    // Observe that background task directly: an unhandled EventEmitter error
    // rejects it, which the real watcher leaves unobserved. No global error hook.
    return this.pendingStat
  }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
let cwd: string
let controller: AbortController
let events: WatchEvent[]
let watchers: ControlledWatcher[]
let autoReady: boolean
let finished: Promise<unknown> | undefined

async function saveConfig(input = 'raw', prefix = 'watch') {
  const config: IconctlConfig = {
    prefix,
    sources: [{ type: 'directory', dir: input }],
    output: { json: 'icons.json' },
  }
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify(config)}`)
}

async function source(directory: string, name: string) {
  await mkdir(join(cwd, directory), { recursive: true })
  await writeFile(join(cwd, directory, `${name}.svg`), svg)
}

function start() {
  const task = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) })
  finished = task.catch(error => error)
  return task
}

async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 10 })
}

function results() {
  return events.filter(event => event.type === 'result')
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-watch-lifecycle-'))
  controller = new AbortController()
  events = []
  watchers = []
  autoReady = true
  finished = undefined
  vi.mocked(sync).mockClear()
  vi.mocked(watchFiles).mockImplementation(() => {
    const listener = new ControlledWatcher()
    watchers.push(listener)
    if (autoReady) {
      queueMicrotask(() => listener.emit('ready'))
    }
    return listener as unknown as FSWatcher
  })
  await source('raw', 'home')
  await saveConfig()
})

afterEach(async () => {
  controller.abort()
  await finished
  await rm(cwd, { recursive: true, force: true })
})

it.each(['starting', 'ready'] as const)('owns pending watcher errors after cancellation while %s', async (phase) => {
  autoReady = phase === 'ready'
  const task = start()
  await until(() => phase === 'ready' ? results().length === 1 : watchers.length === 1)
  const listener = watchers[0]!
  controller.abort('cancelled')
  await expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  expect(listener.closed).toBe(true)
  const settledEvents = [...events]

  await expect(listener.failPendingStat(new Error('stat failed after cancellation'))).resolves.toBeUndefined()

  expect(events).toEqual(settledEvents)
  expect(events.filter(event => event.type === 'error')).toEqual([])
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'aborted' })
})

it('keeps the replacement watcher working after a retired watcher finishes failing stat work', async () => {
  const task = start()
  await until(() => results().length === 1)
  const previous = watchers[0]!
  const ready = events.find(event => event.type === 'ready')!
  await source('next', 'replacement')
  await saveConfig('next', 'updated')
  previous.emit('all', 'change', ready.configFile)
  await until(() => results().length === 2)
  expect(previous.closed).toBe(true)
  expect(results()[1]!.result.prefix).toBe('updated')

  await expect(previous.failPendingStat(new Error('old watcher stat failed'))).resolves.toBeUndefined()

  const current = watchers.at(-1)!
  expect(current).not.toBe(previous)
  expect(current.closed).toBe(false)
  await source('next', 'added')
  current.emit('all', 'add', join(cwd, 'next', 'added.svg'))
  await until(() => results().length === 3)
  expect(Object.keys(results()[2]!.result.json.icons)).toEqual(['added', 'replacement'])
  expect(events.filter(event => event.type === 'error' || event.type === 'stopped')).toEqual([])

  const failure = new Error('active watcher stat failed')
  await expect(current.failPendingStat(failure)).resolves.toBeUndefined()
  await expect(task).rejects.toBe(failure)
  expect(events.at(-2)).toEqual({ type: 'error', phase: 'watch', fatal: true, error: failure })
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'error' })
  expect(current.closed).toBe(true)
})

it.each(['reported directory', 'silent directory', 'silent file'] as const)('observes a new external %s link created while its replacement watcher is starting', async (kind) => {
  start()
  await until(() => results().length === 1)
  await source('external', 'outer')
  await source('third', 'inner')
  const outerLink = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), outerLink, 'dir')
  autoReady = false
  watchers[0]!.emit('all', 'add', outerLink, await lstat(outerLink))
  await until(() => watchers.length === 2)

  // This target was absent from validation. The old watcher excludes external,
  // and the replacement discovers the new link before its ready event.
  const fileLink = kind === 'silent file'
  const name = fileLink ? 'nested' : 'inner'
  const nestedLink = join(await realpath(join(cwd, 'external')), fileLink ? 'nested.svg' : 'nested')
  const target = await realpath(join(cwd, 'third', 'inner.svg'))
  await symlink(fileLink ? target : dirname(target), nestedLink, fileLink ? 'file' : 'dir')
  const replacement = watchers[1]!
  if (kind === 'reported directory') {
    replacement.emit('all', 'add', nestedLink, await lstat(nestedLink))
    replacement.emit('raw', 'rename', 'nested', { watchedPath: dirname(nestedLink) })
  }
  autoReady = true
  replacement.emit('ready')
  await until(() => results().length === 2)

  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['home', name, 'outer'])
  const ignored = vi.mocked(watchFiles).mock.calls.at(-1)![1]!.ignored
  if (typeof ignored !== 'function') {
    throw new TypeError('Watch must configure an input path filter')
  }
  expect(ignored(target)).toBe(false)
  if (fileLink) {
    await rm(target)
    watchers.at(-1)!.emit('all', 'unlink', target)
    await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  }
  await writeFile(target, svg.replace('h24', 'h12'))
  watchers.at(-1)!.emit('all', fileLink ? 'add' : 'change', target, await lstat(target))
  await until(() => results().length === 3)
  expect(results()[2]!.result.diff.changed).toEqual([name])
})

it.each(['output', 'recursive', 'self'] as const)('rejects and recovers from a new %s link created while its replacement watcher is starting', async (kind) => {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify({
    prefix: 'watch',
    sources: [{ type: 'directory', dir: 'raw' }],
    output: { json: 'icons.json', svg: 'published' },
  })}`)
  start()
  await until(() => results().length === 1)
  const previous = await readFile(join(cwd, 'icons.json'), 'utf8')
  await source('external', 'outer')
  const outerLink = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), outerLink, 'dir')
  autoReady = false
  watchers[0]!.emit('all', 'add', outerLink, await lstat(outerLink))
  await until(() => watchers.length === 2)

  const nestedLink = join(await realpath(join(cwd, 'external')), 'nested')
  await symlink(kind === 'self' ? nestedLink : join(cwd, kind === 'output' ? 'published' : 'external'), nestedLink, 'dir')
  const replacement = watchers[1]!
  // Missing native discovery is possible when creation predates fs.watch;
  // self-referential links also produce no Chokidar all-event.
  autoReady = true
  replacement.emit('ready')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync') || results().length === 2)

  expect(results()).toHaveLength(1)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(events.find(event => event.type === 'error')).toMatchObject({
    phase: 'sync',
    fatal: false,
    error: expect.objectContaining(kind === 'self'
      ? { code: 'ELOOP' }
      : { message: expect.stringContaining(kind === 'output' ? 'Watch input links to an output' : 'Watch input contains a recursive') }),
  })
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(previous)
  await rm(nestedLink)
  if (kind === 'self') {
    await source('third', 'inner')
    await symlink(join(cwd, 'third'), nestedLink, 'dir')
  }
  if (kind === 'output') {
    watchers.at(-1)!.emit('all', 'unlink', nestedLink)
    await writeFile(nestedLink, 'An ordinary file is not an SVG source.')
  }
  else {
    watchers.at(-1)!.emit('raw', 'rename', 'nested', { watchedPath: dirname(nestedLink) })
  }
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(kind === 'self' ? ['home', 'inner', 'outer'] : ['home', 'outer'])
  if (kind === 'output') {
    const current = watchers.at(-1)!
    current.emit('all', 'add', nestedLink, await lstat(nestedLink))
    current.emit('raw', 'rename', 'nested', { watchedPath: dirname(nestedLink) })
    await setTimeout(350)
    expect(results()).toHaveLength(2)
  }
})

it('recovers when a configured root becomes a self link during replacement startup', async () => {
  start()
  await until(() => results().length === 1)
  await source('external', 'outer')
  const outerLink = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), outerLink, 'dir')
  autoReady = false
  watchers[0]!.emit('all', 'add', outerLink, await lstat(outerLink))
  await until(() => watchers.length === 2)

  const root = join(cwd, 'raw')
  await rm(root, { recursive: true })
  await symlink(root, root, 'dir')
  autoReady = true
  watchers[1]!.emit('ready')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  await rm(root)
  await source('raw', 'restored')
  watchers.at(-1)!.emit('raw', 'rename', 'raw', { watchedPath: cwd })
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['restored'])
})

it('retains source aliases when a newly discovered link fails validation', async () => {
  await symlink(join(cwd, 'raw'), join(cwd, 'alias'), 'dir')
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify({
    prefix: 'watch',
    sources: [{ type: 'directory', dir: 'raw' }, { type: 'directory', dir: 'alias' }],
    output: { json: 'icons.json' },
  })}`)
  start()
  await until(() => results().length === 1)
  const link = join(cwd, 'raw', 'nested')
  await symlink(join(cwd, 'raw'), link, 'dir')
  // The scan, rather than a symlink notification, discovers this invalid entry.
  watchers[0]!.emit('all', 'change', join(cwd, 'raw', 'home.svg'))
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  await rm(link)
  watchers[0]!.emit('all', 'unlink', join(cwd, 'alias', 'nested'))
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['home'])
})

it('ignores a replayed startup link notification when its target was already watched', async () => {
  await source('third', 'inner')
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify({
    prefix: 'watch',
    sources: [{ type: 'directory', dir: 'raw' }, { type: 'directory', dir: 'third' }],
    output: { json: 'icons.json' },
  })}`)
  start()
  await until(() => results().length === 1)
  await source('external', 'outer')
  const outerLink = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), outerLink, 'dir')
  autoReady = false
  watchers[0]!.emit('all', 'add', outerLink, await lstat(outerLink))
  await until(() => watchers.length === 2)

  const nestedLink = join(await realpath(join(cwd, 'external')), 'nested')
  await symlink(join(cwd, 'third'), nestedLink, 'dir')
  autoReady = true
  watchers[1]!.emit('ready')
  await until(() => results().length === 2)
  const current = watchers.at(-1)!
  current.emit('raw', 'rename', 'nested', { watchedPath: dirname(nestedLink) })
  await setTimeout(350)
  expect(results()).toHaveLength(2)
  expect(sync).toHaveBeenCalledTimes(2)
})

it('cancels while a replacement watcher is starting without importing the new graph', async () => {
  const task = start()
  await until(() => results().length === 1)
  await source('external', 'outer')
  const link = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), link, 'dir')
  autoReady = false
  watchers[0]!.emit('all', 'add', link, await lstat(link))
  await until(() => watchers.length === 2)
  controller.abort('cancelled during replacement')
  await expect(task).rejects.toBeInstanceOf(IconctlAbortError)
  expect(watchers.every(listener => listener.closed)).toBe(true)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(results()).toHaveLength(1)
})

it.each([
  { first: 'raw', separateEdit: false },
  { first: 'all', separateEdit: false },
  { first: 'raw', separateEdit: true },
  { first: 'all', separateEdit: true },
])('coalesces delayed link deletion ($first first) while preserving a separate edit: $separateEdit', async ({ first, separateEdit }) => {
  await source('external', 'outer')
  const link = join(cwd, 'raw', 'linked')
  await symlink(join(cwd, 'external'), link, 'dir')
  start()
  await until(() => results().length === 1)
  const previous = watchers[0]!
  const parent = await realpath(join(cwd, 'raw'))
  const emitRaw = () => previous.emit('raw', 'rename', 'linked', { watchedPath: parent })
  const emitAll = () => previous.emit('all', 'unlink', link)
  autoReady = false
  await rm(link)
  first === 'raw' ? emitRaw() : emitAll()
  await until(() => watchers.length === 2)
  // Raw discovery and Chokidar's delayed all-event describe the same deletion,
  // potentially through different aliases and more than 150 ms apart.
  first === 'raw' ? emitAll() : emitRaw()
  // Keep the old listener alive until its real readlink lookup settles.
  await until(() => linkReads.pending === 0)
  if (separateEdit) {
    await writeFile(join(cwd, 'raw', 'home.svg'), svg.replace('h24', 'h12'))
    previous.emit('all', 'change', join(cwd, 'raw', 'home.svg'), await lstat(join(cwd, 'raw', 'home.svg')))
  }
  autoReady = true
  watchers[1]!.emit('ready')
  await until(() => results().length === (separateEdit ? 3 : 2))
  await setTimeout(350)
  expect(results()).toHaveLength(separateEdit ? 3 : 2)
  expect(events.filter(event => event.type === 'start')).toHaveLength(separateEdit ? 3 : 2)
  expect(Object.keys(results().at(-1)!.result.json.icons)).toEqual(['home'])
  await symlink(join(cwd, 'external'), link, 'dir')
  watchers.at(-1)!.emit('raw', 'rename', 'linked', { watchedPath: parent })
  await until(() => results().length === (separateEdit ? 4 : 3))
  expect(events.filter(event => event.type === 'start')).toHaveLength(separateEdit ? 4 : 3)
  expect(results().at(-1)!.result.diff.added).toEqual(['outer'])
})

it.each(['starting', 'ready'] as const)('reports an active watcher error while %s instead of swallowing it', async (phase) => {
  autoReady = phase === 'ready'
  const task = start()
  await until(() => phase === 'ready' ? results().length === 1 : watchers.length === 1)
  const listener = watchers[0]!
  const failure = new Error('active watcher failed')

  await expect(listener.failPendingStat(failure)).resolves.toBeUndefined()
  await expect(task).rejects.toBe(failure)

  expect(events.filter(event => event.type === 'error')).toEqual([
    { type: 'error', phase: 'watch', fatal: true, error: failure },
  ])
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'error' })
  expect(listener.closed).toBe(true)
})

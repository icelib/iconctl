import type { FSWatcher } from 'chokidar'
import type { IconctlConfig, WatchEvent } from '../src'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'

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

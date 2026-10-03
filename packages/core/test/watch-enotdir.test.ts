import type { FSWatcher } from 'chokidar'
import type { WatchEvent } from '../src/watch'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError } from '../src/errors'
import { watch } from '../src/watch'

vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const readdir = fs.promises.readdir
let cwd: string
let controller: AbortController
let events: WatchEvent[]
let finished: Promise<unknown> | undefined
let release: (() => void) | undefined
let intercepted: Promise<unknown> | undefined

async function source(directory: string, name: string) {
  await mkdir(join(cwd, directory), { recursive: true })
  await writeFile(join(cwd, directory, `${name}.svg`), svg)
}

async function config(directory: string) {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify({
    prefix: directory,
    sources: [{ type: 'directory', dir: directory }],
    output: { json: 'icons.json' },
  })}`)
}

function results() {
  return events.filter(event => event.type === 'result')
}
async function until(predicate: () => boolean, label = 'expected watch state') {
  await vi.waitFor(() => expect(predicate(), `${label}: ${JSON.stringify(events)}`).toBe(true), { timeout: 5000, interval: 10 })
}

function race(directory: string) {
  const target = join(cwd, directory)
  let entered = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const wrapper = async (...args: Parameters<typeof readdir>) => {
    const options: unknown = args[1]
    // Chokidar's readdirp uses alwaysStat, so this is its first traversal after
    // directory stat. Application validation uses a plain readdir instead.
    if (!entered && String(args[0]) === target && typeof options === 'object'
      && options !== null && 'encoding' in options && options.encoding === 'utf8'
      && 'withFileTypes' in options && options.withFileTypes === false) {
      entered = true
      const pending = (async () => {
        await rm(target, { recursive: true })
        await writeFile(target, 'replaced directory')
        await gate
        return readdir(...args)
      })()
      intercepted = pending.catch(() => {})
      return pending
    }
    return readdir(...args)
  }
  fs.promises.readdir = wrapper as typeof readdir
  syncBuiltinESMExports()
  return () => entered
}

function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error)
}

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-watch-enotdir-')))
  controller = new AbortController()
  events = []
  finished = undefined
  release = undefined
  intercepted = undefined
  vi.mocked(watchFiles).mockClear()
  await source('raw', 'original')
  await source('next', 'replacement')
  await config('raw')
})

afterEach(async () => {
  controller.abort()
  release?.()
  const outcome = await finished
  await intercepted
  fs.promises.readdir = readdir
  syncBuiltinESMExports()
  await rm(cwd, { recursive: true, force: true })
  if (finished) {
    expect(outcome).toBeInstanceOf(IconctlAbortError)
    expect(vi.mocked(watchFiles).mock.results.every(result => (result.value as FSWatcher).closed)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'aborted' })
  }
})

it.each(['startup', 'handover'] as const)('settles ENOTDIR during %s and recovers through its live parent observer', async (phase) => {
  if (phase === 'handover') {
    start()
    await until(() => results().length === 1)
  }
  const previous = phase === 'handover' ? await readFile(join(cwd, 'icons.json'), 'utf8') : 'previous output'
  if (phase === 'startup') {
    await writeFile(join(cwd, 'icons.json'), previous)
  }
  const directory = phase === 'startup' ? 'raw' : 'next'
  const entered = race(directory)
  if (phase === 'startup') {
    start()
  }
  else {
    await config(directory)
  }
  await until(entered, 'traversal race entered')
  const listeners = vi.mocked(watchFiles).mock.results.map(result => result.value as FSWatcher)
  expect(listeners).toHaveLength(phase === 'startup' ? 1 : 2)
  expect(listeners.every(listener => !listener.closed)).toBe(true)
  release!()
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'), 'sync validates replaced root')
  expect(events.filter(event => event.type === 'ready')).toHaveLength(phase === 'startup' ? 1 : 2)
  expect(results()).toHaveLength(phase === 'startup' ? 0 : 1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(previous)
  expect(listeners.at(-1)!.closed).toBe(false)
  if (phase === 'handover') {
    expect(listeners[0]!.closed).toBe(true)
  }
  await rm(join(cwd, directory))
  await source(directory, 'restored')
  await until(() => results().length === (phase === 'startup' ? 1 : 2))
  expect(Object.keys(results().at(-1)!.result.json.icons)).toEqual(['restored'])
  expect(results().at(-1)!.result.prefix).toBe(directory)
  expect(events.some(event => event.type === 'error' && event.fatal)).toBe(false)
})

it.each(['startup', 'handover'] as const)('cancels all real observers while ENOTDIR traversal is pending during %s', async (phase) => {
  if (phase === 'handover') {
    start()
    await until(() => results().length === 1)
  }
  const entered = race(phase === 'startup' ? 'raw' : 'next')
  if (phase === 'startup') {
    start()
  }
  else {
    await config('next')
  }
  await until(entered, 'traversal race entered')
  controller.abort('cancel during traversal')
  await expect(finished).resolves.toBeInstanceOf(IconctlAbortError)
  expect(vi.mocked(watchFiles).mock.results.every(result => (result.value as FSWatcher).closed)).toBe(true)
  const settled = [...events]
  release!()
  await intercepted
  expect(events).toEqual(settled)
  expect(results()).toHaveLength(phase === 'startup' ? 0 : 1)
})

import type { IconctlConfig, WatchEvent } from '../src'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { watch as watchFiles } from 'chokidar'
import { IconctlAbortError, watch } from '../src'
import { sync } from '../src/sync'
import { createWatchSession } from '../src/watch-session'

const observation = vi.hoisted(() => ({
  changes: [] as boolean[],
  blockedPath: '',
  blocked: false,
  pending: undefined as Promise<void> | undefined,
  validationPending: undefined as Promise<void> | undefined,
  validationEntered: false,
  validationKind: '' as '' | 'resolved' | 'rejected',
}))

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn((...args: Parameters<typeof actual.watch>) => {
    const listener = actual.watch(...args)
    const emit = listener.emit.bind(listener)
    // Model a platform that loses every native change hint, including raw events.
    listener.emit = ((event: string | symbol, ...values: unknown[]) => event === 'all' || event === 'raw' ? false : Reflect.apply(emit, listener, [event, ...values])) as typeof listener.emit
    return listener
  }) }
})
vi.mock('../src/watch-session', async () => {
  const helper = await import('./helpers/watch-session')
  return { createWatchSession: vi.fn(helper.createWatchSession) }
})
vi.mock('../src/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync')>()
  return { ...actual, sync: vi.fn(actual.sync) }
})
vi.mock('../src/watch-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/watch-paths')>()
  return { ...actual, validateWatchInputs: async (...args: Parameters<typeof actual.validateWatchInputs>) => {
    try {
      const result = await actual.validateWatchInputs(...args)
      if (observation.validationKind === 'resolved' && observation.validationPending) {
        observation.validationEntered = true
        await observation.validationPending
      }
      return result
    }
    catch (error) {
      if (observation.validationKind === 'rejected' && observation.validationPending) {
        observation.validationEntered = true
        await observation.validationPending
      }
      throw error
    }
  } }
})
vi.mock('../src/watch-observer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/watch-observer')>()
  return { ...actual, createWatchObserver: (onChange: Parameters<typeof actual.createWatchObserver>[0], onError: Parameters<typeof actual.createWatchObserver>[1]) => actual.createWatchObserver((configuration) => {
    observation.changes.push(configuration)
    onChange(configuration)
  }, onError) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === observation.blockedPath && observation.pending) {
      observation.blocked = true
      await observation.pending
    }
    return actual.lstat(...args)
  } }
})

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
let root: string
let cwd: string
let controller: AbortController
let events: WatchEvent[]
let finished: Promise<unknown> | undefined
let settled: boolean
let releases: (() => void)[]

function config(extra: Partial<IconctlConfig> = {}): IconctlConfig {
  return { prefix: 'watch', sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json', svg: 'svg' }, ...extra }
}
async function saveConfig(value = config()) {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify(value)}`)
}
async function source(name: string, contents = svg) {
  await writeFile(join(cwd, 'raw', `${name}.svg`), contents)
}
function gate() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { pending, release }
}
function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error).finally(() => {
    settled = true
  })
}
const results = () => events.filter(event => event.type === 'result')
const sourceNotices = () => observation.changes.filter(configuration => !configuration).length
async function until(predicate: () => boolean) {
  await vi.waitFor(() => {
    expect(predicate(), JSON.stringify({ settled, events: events.map(event => ({ type: event.type, ...('phase' in event ? { phase: event.phase } : {}), ...('reason' in event ? { reason: event.reason } : {}) })) })).toBe(true)
  }, { timeout: 5000, interval: 20 })
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-watch-reconcile-')))
  cwd = join(root, 'project')
  await mkdir(join(cwd, 'raw'), { recursive: true })
  controller = new AbortController()
  events = []
  finished = undefined
  settled = false
  releases = []
  observation.changes = []
  observation.blockedPath = ''
  observation.blocked = false
  observation.pending = undefined
  observation.validationPending = undefined
  observation.validationEntered = false
  observation.validationKind = ''
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  vi.mocked(sync).mockReset().mockImplementation(actual.sync)
  vi.mocked(watchFiles).mockClear()
  vi.mocked(createWatchSession).mockClear()
  await source('home')
  await saveConfig()
})

afterEach(async () => {
  controller.abort()
  observation.blockedPath = ''
  observation.pending = undefined
  for (const release of releases) {
    release()
  }
  await finished
  await rm(root, { recursive: true, force: true })
})

it('finds source edits, additions, renames, deletions and same-content saves without native hints', async () => {
  await source('rename-me')
  await source('remove-me')
  start()
  await until(() => results().length === 1)
  const changed = svg.replace('h24', 'h12')
  await Promise.all([
    source('added'),
    source('home', changed),
    rename(join(cwd, 'raw/rename-me.svg'), join(cwd, 'raw/renamed.svg')),
    rm(join(cwd, 'raw/remove-me.svg')),
  ])
  await until(() => results().length === 2)
  expect(results()[1]!.result.diff).toMatchObject({ added: ['added', 'renamed'], removed: ['remove-me', 'rename-me'], changed: ['home'] })
  await rm(join(cwd, 'raw/added.svg'))
  await until(() => results().length === 3)
  expect(results()[2]!.result.diff.removed).toEqual(['added'])
  await source('home', changed)
  await until(() => results().length === 4)
  expect(results()[3]!.result.diff).toMatchObject({ added: [], removed: [], changed: [] })
  expect(events.filter(event => event.type === 'start').map(event => event.reason)).toEqual(['initial', 'source', 'source', 'source'])
}, 10000)

it('ignores generated outputs, hidden entries and non-SVG files for a full scan interval', async () => {
  await saveConfig(config({ output: { json: 'raw/icons.json', svg: 'svg', types: 'raw/types.ts', preview: 'raw/preview.html' }, cacheDir: 'raw/.cache' }))
  start()
  await until(() => results().length === 1)
  await mkdir(join(cwd, 'raw/.hidden'))
  await Promise.all([
    writeFile(join(cwd, 'raw/.hidden/ignored.svg'), svg),
    writeFile(join(cwd, 'raw/notes.txt'), 'not an icon'),
    writeFile(join(cwd, 'raw/types.ts'), '// generated output edit'),
    writeFile(join(cwd, 'svg/manual.svg'), svg),
  ])
  await setTimeout(1250)
  expect(results()).toHaveLength(1)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === 'error')).toEqual([])
})

it('pauses on invalid config and observes recovery while source notifications are silent', async () => {
  start()
  await until(() => results().length === 1)
  await writeFile(join(cwd, 'iconctl.config.ts'), 'export default { broken!')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  await source('while-paused')
  await setTimeout(1250)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === 'error' && event.phase === 'config')).toHaveLength(1)
  await mkdir(join(cwd, 'next'))
  await writeFile(join(cwd, 'next/fresh.svg'), svg)
  await saveConfig(config({ prefix: 'recovered', sources: [{ type: 'directory', dir: 'next' }] }))
  await until(() => results().length === 2)
  expect(results()[1]!.result.prefix).toBe('recovered')
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['fresh'])
  expect(events.filter(event => event.type === 'start').map(event => event.reason)).toEqual(['initial', 'config'])
  await source('old-scope')
  await setTimeout(1250)
  expect(results()).toHaveLength(2)
}, 10000)

it('recovers when a removed source root is recreated without native notifications', async () => {
  start()
  await until(() => results().length === 1)
  const before = await readFile(join(cwd, 'icons.json'), 'utf8')
  await rm(join(cwd, 'raw'), { recursive: true })
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
  await mkdir(join(cwd, 'raw'))
  await source('restored')
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons)).toEqual(['restored'])
}, 10000)

it.each(['self', 'output'] as const)('recovers after an unseen %s directory link is removed', async (kind) => {
  start()
  await until(() => results().length === 1)
  const before = await readFile(join(cwd, 'icons.json'), 'utf8')
  const link = join(cwd, 'raw/loop')
  await symlink(kind === 'self' ? link : join(cwd, 'svg'), link, 'dir')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
  await setTimeout(1250)
  expect(events.filter(event => event.type === 'error' && event.phase === 'sync')).toHaveLength(1)
  await rm(link)
  await until(() => results().length === 2)
  expect(results()[1]!.result.processed).toBe(1)
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
}, 10000)

it('recovers a retargeted config link when only its missing target is created', async () => {
  const entry = join(cwd, 'iconctl.config.ts')
  const original = join(root, 'original-config.ts')
  const repaired = join(root, 'repaired-config.ts')
  await writeFile(original, `export default ${JSON.stringify(config())}`)
  await rm(entry)
  await symlink(original, entry)
  start()
  await until(() => results().length === 1)
  await symlink(repaired, join(cwd, 'replacement-config'))
  await rename(join(cwd, 'replacement-config'), entry)
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  // The link is unchanged while its previously missing target becomes valid.
  await writeFile(repaired, `export default ${JSON.stringify(config({ prefix: 'target-repaired' }))}`)
  await until(() => results().length === 2)
  expect(results()[1]!.result.prefix).toBe('target-repaired')
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
}, 10000)

it('observes dangling SVG link repair and stops observing the target after unlink', async () => {
  start()
  await until(() => results().length === 1)
  const before = await readFile(join(cwd, 'icons.json'), 'utf8')
  const target = join(root, 'external.asset')
  const link = join(cwd, 'raw/linked.svg')
  await symlink(target, link)
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
  await writeFile(target, svg)
  await until(() => results().length === 2)
  expect(results()[1]!.result.processed).toBe(2)
  await rm(link)
  await until(() => results().length === 3)
  expect(results()[2]!.result.diff.removed).toEqual(['linked'])
  await writeFile(target, svg.replace('h24', 'h12'))
  await setTimeout(1250)
  expect(results()).toHaveLength(3)
}, 10000)

it('coalesces scans during a blocked sync into one serial follow-up', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  const blocked = gate()
  let entered = false
  vi.mocked(sync).mockImplementationOnce(async (options) => {
    entered = true
    await blocked.pending
    return actual.sync(options)
  })
  start()
  await until(() => entered)
  const notices = sourceNotices()
  await source('first')
  await until(() => sourceNotices() > notices)
  await source('second')
  await until(() => sourceNotices() > notices + 1)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(results()).toHaveLength(0)
  blocked.release()
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons).sort()).toEqual(['first', 'home', 'second'])
  expect(events.filter(event => event.type === 'start').map(event => event.reason)).toEqual(['initial', 'source'])
  await setTimeout(1250)
  expect(sync).toHaveBeenCalledTimes(2)
}, 10000)

it('aborts and drains the old sync before loading a silently edited config', async () => {
  const actual = await vi.importActual<typeof import('../src/sync')>('../src/sync')
  const drain = gate()
  let entered = false
  let aborted = false
  let drained = false
  vi.mocked(sync).mockImplementationOnce(async (options) => {
    entered = true
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => {
      aborted = true
      resolve()
    }, { once: true }))
    await drain.pending
    drained = true
    return actual.sync(options)
  })
  start()
  await until(() => entered)
  await saveConfig(config({ prefix: 'fresh' }))
  await until(() => aborted)
  expect(drained).toBe(false)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(createWatchSession).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === 'ready')).toHaveLength(1)
  expect(results()).toHaveLength(0)
  drain.release()
  await until(() => results().length === 1)
  expect(drained).toBe(true)
  expect(createWatchSession).toHaveBeenCalledTimes(2)
  expect(results()[0]).toMatchObject({ runId: 2, result: { prefix: 'fresh' } })
  expect(events.filter(event => event.type === 'error')).toEqual([])
}, 10000)

it('drains a pending scan on stop and emits no late work after its filesystem read finishes', async () => {
  start()
  await until(() => results().length === 1)
  const before = await readFile(join(cwd, 'icons.json'), 'utf8')
  const scan = gate()
  observation.blockedPath = join(cwd, 'raw/home.svg')
  observation.pending = scan.pending
  await until(() => observation.blocked)
  const notices = observation.changes.length
  controller.abort('stop pending scan')
  await setTimeout(50)
  expect(settled).toBe(false)
  expect(events.some(event => event.type === 'stopped')).toBe(false)
  await source('late')
  observation.blockedPath = ''
  observation.pending = undefined
  scan.release()
  expect(await finished).toBeInstanceOf(IconctlAbortError)
  expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'aborted' })
  const stoppedEvents = [...events]
  await setTimeout(1250)
  expect(events).toEqual(stoppedEvents)
  expect(observation.changes).toHaveLength(notices)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
}, 10000)

it('queues a repair completed after validation rejects instead of accepting it silently', async () => {
  start()
  await until(() => results().length === 1)
  const validation = gate()
  observation.validationKind = 'rejected'
  observation.validationPending = validation.pending
  const link = join(cwd, 'raw/unsafe')
  await symlink(join(cwd, 'svg'), link, 'dir')
  await until(() => observation.validationEntered)
  await rm(link)
  observation.validationPending = undefined
  validation.release()
  await until(() => results().length === 2)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(events.filter(event => event.type === 'error' && event.phase === 'sync')).toHaveLength(1)
  expect(results()[1]!.result.processed).toBe(1)
}, 10000)

it('revalidates a new link introduced after the previous graph validation finishes', async () => {
  start()
  await until(() => results().length === 1)
  const before = await readFile(join(cwd, 'icons.json'), 'utf8')
  const validation = gate()
  observation.validationKind = 'resolved'
  observation.validationPending = validation.pending
  await source('new')
  await until(() => observation.validationEntered)
  const link = join(cwd, 'raw/unsafe')
  await symlink(join(cwd, 'svg'), link, 'dir')
  observation.validationPending = undefined
  validation.release()
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(before)
  await rm(link)
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons).sort()).toEqual(['home', 'new'])
}, 10000)

it('recovers a rejected external source link when only its target chain is repaired', async () => {
  start()
  await until(() => results().length === 1)
  const target = join(root, 'external-loop')
  await symlink(target, target, 'dir')
  await symlink(target, join(cwd, 'raw/external'), 'dir')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'))
  expect(sync).toHaveBeenCalledTimes(1)
  await rm(target)
  await mkdir(target)
  await writeFile(join(target, 'repaired.svg'), svg)
  await until(() => results().length === 2)
  expect(Object.keys(results()[1]!.result.json.icons).sort()).toEqual(['home', 'repaired'])
}, 10000)

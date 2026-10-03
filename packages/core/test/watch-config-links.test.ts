import type { IconctlConfig } from '../src/config'
import type { WatchEvent } from '../src/watch'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { IconctlAbortError } from '../src/errors'
import { watch } from '../src/watch'

vi.mock('../src/watch-session', () => import('./helpers/watch-session'))

let cwd: string
let controller: AbortController
let events: WatchEvent[]
let finished: Promise<unknown> | undefined

function contents(prefix: string) {
  const config: IconctlConfig = {
    prefix,
    sources: [{ type: 'directory', dir: 'raw' }],
    output: { json: 'icons.json', svg: 'svg' },
  }
  return `export default ${JSON.stringify(config)}`
}

function start() {
  finished = watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error)
}

function results() {
  return events.filter(event => event.type === 'result')
}

async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 8000, interval: 20 })
}

async function untilResults(prefixes: string[]) {
  await vi.waitFor(() => expect(results().map(event => event.result.prefix)).toEqual(prefixes), { timeout: 8000, interval: 20 })
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'iconctl-config-links-'))
  controller = new AbortController()
  events = []
  finished = undefined
  await mkdir(join(cwd, 'raw'))
  await mkdir(join(cwd, 'settings'))
  await writeFile(join(cwd, 'raw', 'home.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
})

afterEach(async () => {
  controller.abort()
  const outcome = await finished
  await rm(cwd, { recursive: true, force: true })
  if (finished) {
    expect(outcome).toBeInstanceOf(IconctlAbortError)
  }
})

it('loads a linked main config and reloads its target and link without self-triggered runs', async () => {
  const target = join(cwd, 'settings', 'main.ts')
  const config = join(cwd, 'iconctl.config.ts')
  await writeFile(target, contents('initial'))
  await symlink(target, config)
  start()
  await untilResults(['initial'])
  await setTimeout(400)
  expect(results()).toHaveLength(1)
  expect(results()[0]!.result.prefix).toBe('initial')

  await writeFile(target, contents('edited-target'))
  await untilResults(['initial', 'edited-target'])
  expect(results()[1]!.result.prefix).toBe('edited-target')

  const replacement = join(cwd, 'settings', 'replacement.ts')
  await writeFile(replacement, contents('retargeted'))
  await symlink(replacement, join(cwd, 'replacement-link'))
  await rename(join(cwd, 'replacement-link'), config)
  await untilResults(['initial', 'edited-target', 'retargeted'])
  expect(results()[2]!.result.prefix).toBe('retargeted')
  await writeFile(target, contents('old-target'))
  await setTimeout(400)
  expect(results()).toHaveLength(3)
  expect(events.filter(event => event.type === 'error')).toEqual([])
  expect(events.filter(event => event.type === 'start').map(event => event.reason)).toEqual(['initial', 'config', 'config'])
}, 15000)

it('recovers a newly referenced broken extends link when only its target is repaired', async () => {
  const config = join(cwd, 'iconctl.config.ts')
  await writeFile(config, contents('initial'))
  start()
  await untilResults(['initial'])

  const target = join(cwd, 'settings', 'broken-layer.ts')
  await writeFile(target, 'export default { broken!')
  await symlink(target, join(cwd, 'layer.ts'))
  await writeFile(config, 'export default { extends: ["./layer.ts"] }')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  // Let config recovery install its observer before repairing only the linked target.
  await setTimeout(400)
  expect(results()).toHaveLength(1)
  await writeFile(target, contents('recovered-layer'))
  await untilResults(['initial', 'recovered-layer'])
  expect(results()[1]!.result.prefix).toBe('recovered-layer')
  await setTimeout(400)
  expect(results()).toHaveLength(2)
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
}, 15000)

it.each(['self', 'missing'] as const)('recovers a paused main config after a %s link is restored to the same target', async (kind) => {
  const target = join(cwd, 'settings', 'main.ts')
  const config = join(cwd, 'iconctl.config.ts')
  await writeFile(target, contents('linked-config'))
  await symlink(target, config)
  start()
  await untilResults(['linked-config'])

  await rm(config)
  await symlink(kind === 'self' ? config : join(cwd, 'missing.ts'), config)
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  expect(results()).toHaveLength(1)
  await rm(config)
  await symlink(target, config)
  await untilResults(['linked-config', 'linked-config'])
  await setTimeout(400)
  expect(results()).toHaveLength(2)
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
}, 15000)

it('keeps watching a newly referenced self-linked extends file until its entry is repaired', async () => {
  const config = join(cwd, 'iconctl.config.ts')
  const layer = join(cwd, 'layer.ts')
  await writeFile(config, contents('initial'))
  start()
  await untilResults(['initial'])

  await symlink(layer, layer)
  await writeFile(config, 'export default { extends: ["./layer.ts"] }')
  await until(() => events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal))
  await setTimeout(400)
  expect(events.some(event => event.type === 'stopped')).toBe(false)
  expect(results()).toHaveLength(1)

  const target = join(cwd, 'settings', 'repaired-layer.ts')
  await writeFile(target, contents('repaired-link'))
  await symlink(target, join(cwd, 'replacement-link'))
  await rename(join(cwd, 'replacement-link'), layer)
  await untilResults(['initial', 'repaired-link'])
  await setTimeout(400)
  expect(results()).toHaveLength(2)
  expect(events.filter(event => event.type === 'error' && event.fatal)).toEqual([])
}, 15000)

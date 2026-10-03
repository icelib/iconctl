import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const entry = mode === 'cjs' ? require.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
const core = mode === 'cjs' ? require('@iconctl/core') : await import('@iconctl/core')

const fixture = await realpath(await mkdtemp(join(consumer, 'config-watch-')))
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const timeout = 10000
const completed = []

function settings(prefix) {
  return `{ prefix: ${prefix}, sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json' } }`
}

function results(session) {
  return session.events.filter(event => event.type === 'result')
}

function summary(session) {
  return session?.events.map(event => ({
    type: event.type,
    ...('runId' in event ? { runId: event.runId } : {}),
    ...('reason' in event ? { reason: event.reason } : {}),
    ...('phase' in event ? { phase: event.phase, message: event.error?.message } : {}),
    ...(event.type === 'result' ? { prefix: event.result.prefix } : {}),
  }))
}

async function until(predicate, label, session) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    assert(!session?.settled, `${label}: watch settled early: ${session?.outcome?.stack ?? session?.outcome}`)
    assert(Date.now() < deadline, `${label}: ${JSON.stringify(summary(session))}`)
    await delay(20)
  }
}

async function bounded(task, label) {
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), timeout)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function exists(file) {
  return access(file).then(() => true, (error) => {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  })
}

function openWatch(cwd, configFile = 'iconctl.config.mjs', expectedStop = 'aborted') {
  const session = { events: [], controller: new AbortController(), settled: false, outcome: undefined, expectedStop }
  session.finished = core.watch({
    cwd,
    configFile,
    signal: session.controller.signal,
    onEvent: event => session.events.push(event),
  }).catch(error => error).then((outcome) => {
    session.settled = true
    session.outcome = outcome
    return outcome
  })
  return session
}

async function closeWatch(session, name) {
  session.controller.abort('consumer completed')
  const outcome = await bounded(session.finished, `${name} cleanup`)
  assert(outcome instanceof (session.expectedStop === 'aborted' ? core.IconctlAbortError : core.IconctlError), `${name} cleanup: ${outcome?.stack ?? outcome}`)
  assert.deepEqual(session.events.at(-1), { type: 'stopped', reason: session.expectedStop })
  assert.equal(session.events.filter(event => event.type === 'stopped').length, 1)
}

async function scenario(name, action) {
  const cwd = join(fixture, name)
  await mkdir(join(cwd, 'raw'), { recursive: true })
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}')
  await writeFile(join(cwd, 'raw', 'home.svg'), svg)
  const cleanup = []
  let session
  const project = {
    cwd,
    cleanup,
    write: (file, source) => writeFile(join(cwd, file), source),
    start(configFile = 'iconctl.config.mjs', expectedStop = 'aborted') {
      assert.equal(session, undefined, 'A fixture owns one public watch call')
      session = openWatch(cwd, configFile, expectedStop)
      return session
    },
  }
  try {
    await action(project)
    completed.push(name)
  }
  finally {
    // Release controlled user code before awaiting the product's own cleanup.
    // A failing assertion must not strand a Worker in a fixture-owned TLA gate.
    try {
      for (const release of cleanup.reverse()) {
        await release()
      }
    }
    finally {
      try {
        if (session) {
          await closeWatch(session, name)
        }
      }
      finally {
        await rm(cwd, { recursive: true, force: true })
      }
    }
  }
}

try {
  for (const extension of ['mjs', 'cjs', 'js']) {
    await scenario(`${extension}-helper-json-reload`, async ({ write, start, cwd }) => {
      const main = `iconctl.config.${extension}`
      const helper = `helper.${extension}`
      const source = extension === 'cjs'
        ? `const { value } = require('./${helper}'); const data = require('./data.json'); module.exports = () => (${settings('value + "-" + data.suffix')})`
        : `import { value } from './${helper}'; import data from './data.json' with { type: 'json' }; export default () => (${settings('value + "-" + data.suffix')})`
      const helperSource = value => extension === 'cjs'
        ? `module.exports = { value: ${JSON.stringify(value)} }`
        : `export const value = ${JSON.stringify(value)}`
      await write(helper, helperSource(`${extension}-before`))
      await write('data.json', '{"suffix":"initial"}')
      await write(main, source)
      const session = start(main)
      await until(() => results(session).length === 1, 'initial helper and JSON load', session)
      assert.equal(results(session)[0].result.prefix, `${extension}-before-initial`)
      await write(helper, helperSource(`${extension}-after`))
      await write('data.json', '{"suffix":"edited"}')
      await write(main, `${source}\n// Reload the watched entry after editing its helpers.\n`)
      await until(() => results(session).length === 2, 'updated helper and JSON load', session)
      assert.equal(results(session)[1].result.prefix, `${extension}-after-edited`)
      assert.equal(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).prefix, `${extension}-after-edited`)
      assert.deepEqual(session.events.filter(event => event.type === 'error'), [])
      assert.deepEqual(session.events.filter(event => event.type === 'start').map(event => event.reason), ['initial', 'config'])
    })
  }

  await scenario('extends-reload-and-missing-layer-recovery', async ({ write, start, cwd }) => {
    const main = 'export default { extends: ["./extends.mjs"] }'
    const layer = `import helper from './layer-helper.cjs'; import data from './layer-data.json' with { type: 'json' }; export default ${settings('helper.value + "-" + data.suffix')}`
    await write('layer-helper.cjs', `module.exports = { value: 'layer-before' }`)
    await write('layer-data.json', '{"suffix":"initial"}')
    await write('extends.mjs', layer)
    await write('iconctl.config.mjs', main)
    const session = start()
    await until(() => results(session).length === 1, 'initial local extends graph', session)
    assert.equal(results(session)[0].result.prefix, 'layer-before-initial')
    await write('layer-helper.cjs', `module.exports = { value: 'layer-after' }`)
    await write('layer-data.json', '{"suffix":"edited"}')
    await write('extends.mjs', `${layer}\n// Reload only the watched extends layer.\n`)
    await until(() => results(session).length === 2, 'extends edit reloads CJS and JSON helpers', session)
    assert.equal(results(session)[1].result.prefix, 'layer-after-edited')
    assert.equal(await readFile(join(cwd, 'iconctl.config.mjs'), 'utf8'), main)
    assert.deepEqual(session.events.filter(event => event.type === 'error'), [])

    const previous = await readFile(join(cwd, 'icons.json'), 'utf8')
    const missing = 'export default { extends: ["./new-layer.mjs"] }'
    await write('iconctl.config.mjs', missing)
    await until(() => session.events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal), 'missing extends pauses without discarding attempted files', session)
    await delay(250)
    assert.equal(results(session).length, 2)
    assert.equal(await readFile(join(cwd, 'icons.json'), 'utf8'), previous)
    assert.equal(session.events.some(event => event.type === 'stopped'), false)
    // This creation is the only recovery notification: do not save main again.
    await write('new-layer.mjs', `export default ${settings('\'recovered-layer\'')}`)
    await until(() => results(session).length === 3, 'creating only the attempted extends file recovers watch', session)
    assert.equal(await readFile(join(cwd, 'iconctl.config.mjs'), 'utf8'), missing)
    assert.deepEqual(results(session).map(event => event.result.prefix), ['layer-before-initial', 'layer-after-edited', 'recovered-layer'])
    assert.equal(JSON.parse(await readFile(join(cwd, 'icons.json'), 'utf8')).prefix, 'recovered-layer')
    assert.equal(session.events.some(event => event.type === 'error' && event.fatal), false)
    assert.deepEqual(session.events.filter(event => event.type === 'start').map(event => event.reason), ['initial', 'config', 'config'])
  })

  await scenario('esm-graph-semantics', async ({ write, start }) => {
    await write('consumer.mjs', `import { getValue } from './iconctl.config.mjs'; export const result = getValue()`)
    await write('provider.mjs', `export function getValue() { return 'linked' }`)
    await write('mutable.mjs', `export let value = 1; export function increment() { value++ }`)
    await write('ready.mjs', `await new Promise(resolve => setImmediate(resolve)); export const value = 'ready'`)
    await write('failed.mjs', `await new Promise(resolve => setImmediate(resolve)); throw new Error('controlled module failure')`)
    await write('iconctl.config.mjs', `
      import { result } from './consumer.mjs'
      export { getValue } from './provider.mjs'
      import { value, increment } from './mutable.mjs'
      const target = './ready.mjs'
      const pending = await Promise.all([import(target), import(target)])
      const failed = await Promise.allSettled([import('./failed.mjs'), import('./failed.mjs')])
      export default () => {
        const before = value
        increment()
        const prefix = [result, before, value, ...pending.map(item => item.value), ...failed.map(item => item.status)].join('-')
        return ${settings('prefix')}
      }
    `)
    const session = start()
    await until(() => results(session).length === 1, 'native ESM graph semantics', session)
    assert.equal(results(session)[0].result.prefix, 'linked-1-2-ready-ready-rejected-rejected')
    assert.deepEqual(session.events.filter(event => event.type === 'error'), [])
  })

  await scenario('syntax-recovery', async ({ write, start, cwd }) => {
    const source = `import { prefix } from './helper.mjs'; export default ${settings('prefix')}`
    await write('helper.mjs', `export const prefix = 'initial'`)
    await write('iconctl.config.mjs', source)
    const session = start()
    await until(() => results(session).length === 1, 'initial syntax fixture', session)
    const previous = await readFile(join(cwd, 'icons.json'), 'utf8')
    await write('helper.mjs', 'export const prefix = { broken!')
    await write('iconctl.config.mjs', `${source}\n// broken helper\n`)
    await until(() => session.events.some(event => event.type === 'error' && event.phase === 'config' && !event.fatal), 'helper syntax error pauses watch', session)
    await write('raw/while-paused.svg', svg)
    await delay(250)
    assert.equal(results(session).length, 1)
    assert.equal(await readFile(join(cwd, 'icons.json'), 'utf8'), previous)
    await write('helper.mjs', `export const prefix = 'recovered'`)
    await write('iconctl.config.mjs', `${source}\n// repaired helper\n`)
    await until(() => results(session).length === 2, 'helper syntax recovery', session)
    assert.equal(results(session)[1].result.prefix, 'recovered')
    assert.deepEqual(Object.keys(results(session)[1].result.json.icons), ['home', 'while-paused'])
    assert.equal(session.events.some(event => event.type === 'error' && event.fatal), false)
  })

  await scenario('generation-lifetime', async ({ write, start, cwd }) => {
    const source = `
      import { appendFile } from 'node:fs/promises'
      import { threadId } from 'node:worker_threads'
      globalThis.iconctlConsumerLoads = (globalThis.iconctlConsumerLoads ?? 0) + 1
      await appendFile(new URL('./generations.ndjson', import.meta.url), JSON.stringify({ threadId, loads: globalThis.iconctlConsumerLoads }) + String.fromCharCode(10))
      export default ${settings('\'generation-\' + globalThis.iconctlConsumerLoads')}
    `
    const generations = async () => (await readFile(join(cwd, 'generations.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    await write('iconctl.config.mjs', source)
    const session = start()
    await until(() => results(session).length === 1, 'first config generation', session)
    const first = await generations()
    assert.equal(first.length, 1)
    assert(first[0].threadId > 0, 'Configuration must execute in its generation Worker')
    assert.equal(first[0].loads, 1)
    await write('raw/source-change.svg', svg)
    await until(() => results(session).length === 2, 'source run reuses generation', session)
    assert.deepEqual(await generations(), first, 'A source run must not reevaluate its configuration')
    await write('iconctl.config.mjs', `${source}\n// next generation\n`)
    await until(() => results(session).length === 3, 'configuration creates a new generation', session)
    const next = await generations()
    assert.equal(next.length, 2)
    assert(next[1].threadId > 0)
    assert.notEqual(next[1].threadId, first[0].threadId)
    assert.deepEqual(next.map(item => item.loads), [1, 1])
    assert.deepEqual(results(session).map(event => event.result.prefix), ['generation-1', 'generation-1', 'generation-1'])
    assert.deepEqual(session.events.filter(event => event.type === 'start').map(event => event.reason), ['initial', 'source', 'config'])
  })

  await scenario('concurrent-watch-generations', async ({ write, start, cwd, cleanup }) => {
    const secondCwd = join(cwd, 'second')
    await mkdir(join(secondCwd, 'raw'), { recursive: true })
    await write('second/raw/home.svg', svg)
    const helper = value => `
      import { threadId } from 'node:worker_threads'
      globalThis.iconctlConcurrentLoads = (globalThis.iconctlConcurrentLoads ?? 0) + 1
      export const state = { value: ${JSON.stringify(value)}, threadId, loads: globalThis.iconctlConcurrentLoads }
    `
    const config = (name, helperPath) => `
      import { appendFile } from 'node:fs/promises'
      import { state } from '${helperPath}'
      import { state as again } from '${helperPath}'
      if (state !== again) throw new Error('A generation must preserve its module identity')
      await appendFile(new URL('./generations.ndjson', import.meta.url), JSON.stringify(state) + String.fromCharCode(10))
      export default ${settings(`${JSON.stringify(name)} + '-' + state.value + '-' + state.loads`)}
    `
    const firstConfig = config('first', './shared-helper.mjs')
    const secondConfig = config('second', '../shared-helper.mjs')
    const generations = async directory => (await readFile(join(directory, 'generations.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    await write('shared-helper.mjs', helper('before'))
    await write('iconctl.config.mjs', firstConfig)
    await write('second/iconctl.config.mjs', secondConfig)
    const first = start()
    const second = openWatch(secondCwd)
    cleanup.push(() => closeWatch(second, 'concurrent second watch'))
    await Promise.all([
      until(() => results(first).length === 1, 'first concurrent watch is ready', first),
      until(() => results(second).length === 1, 'second concurrent watch is ready', second),
    ])
    const firstInitial = await generations(cwd)
    const secondInitial = await generations(secondCwd)
    assert.deepEqual(firstInitial.map(({ value, loads }) => ({ value, loads })), [{ value: 'before', loads: 1 }])
    assert.deepEqual(secondInitial.map(({ value, loads }) => ({ value, loads })), [{ value: 'before', loads: 1 }])
    assert(firstInitial[0].threadId > 0)
    assert(secondInitial[0].threadId > 0)
    assert.notEqual(firstInitial[0].threadId, secondInitial[0].threadId)

    await write('shared-helper.mjs', helper('after'))
    await write('iconctl.config.mjs', `${firstConfig}\n// Reload only the first watch.\n`)
    await until(() => results(first).length === 2, 'first watch refreshes the shared helper', first)
    const firstReloaded = await generations(cwd)
    assert.deepEqual(firstReloaded.map(({ value, loads }) => ({ value, loads })), [{ value: 'before', loads: 1 }, { value: 'after', loads: 1 }])
    assert.notEqual(firstReloaded[1].threadId, firstInitial[0].threadId)
    assert.notEqual(firstReloaded[1].threadId, secondInitial[0].threadId)
    assert.deepEqual(await generations(secondCwd), secondInitial)
    assert.equal(results(second).length, 1)
    await write('second/raw/while-first-reloaded.svg', svg)
    await until(() => results(second).length === 2, 'second source run retains its original generation', second)
    assert.deepEqual(await generations(secondCwd), secondInitial)
    assert.deepEqual(results(second).map(event => event.result.prefix), ['second-before-1', 'second-before-1'])

    await closeWatch(first, 'first watch stops independently')
    const stoppedEvents = [...first.events]
    const stoppedOutput = await readFile(join(cwd, 'icons.json'), 'utf8')
    await write('raw/after-stop.svg', svg)
    await write('iconctl.config.mjs', `${firstConfig}\n// A stopped watch must stay stopped.\n`)
    await write('second/raw/after-first-stopped.svg', svg)
    await until(() => results(second).length === 3, 'second watch survives the first watch stopping', second)
    assert.deepEqual(await generations(secondCwd), secondInitial)
    assert.equal(results(second)[2].result.prefix, 'second-before-1')
    await write('second/iconctl.config.mjs', `${secondConfig}\n// The second watch now reloads independently.\n`)
    await until(() => results(second).length === 4, 'second watch starts its own fresh generation', second)
    const secondReloaded = await generations(secondCwd)
    assert.deepEqual(secondReloaded.map(({ value, loads }) => ({ value, loads })), [{ value: 'before', loads: 1 }, { value: 'after', loads: 1 }])
    assert.notEqual(secondReloaded[1].threadId, secondInitial[0].threadId)
    assert.deepEqual(results(first).map(event => event.result.prefix), ['first-before-1', 'first-after-1'])
    assert.deepEqual(results(second).map(event => event.result.prefix), ['second-before-1', 'second-before-1', 'second-before-1', 'second-after-1'])
    assert.deepEqual(Object.keys(results(second)[3].result.json.icons), ['after-first-stopped', 'home', 'while-first-reloaded'])
    assert.deepEqual(first.events, stoppedEvents)
    assert.deepEqual(await generations(cwd), firstReloaded)
    assert.equal(await readFile(join(cwd, 'icons.json'), 'utf8'), stoppedOutput)
    assert.equal(JSON.parse(await readFile(join(secondCwd, 'icons.json'), 'utf8')).prefix, 'second-after-1')
    assert.deepEqual(first.events.filter(event => event.type === 'start').map(event => event.reason), ['initial', 'config'])
    assert.deepEqual(second.events.filter(event => event.type === 'start').map(event => event.reason), ['initial', 'source', 'source', 'config'])
    assert.deepEqual(first.events.filter(event => event.type === 'error'), [])
    assert.deepEqual(second.events.filter(event => event.type === 'error'), [])
  })

  await scenario('public-sync-error', async ({ write, start }) => {
    await write('iconctl.config.mjs', `export default { ...${settings('\'errors\'')}, validate: { width: 16 } }`)
    const session = start()
    await until(() => session.events.some(event => event.type === 'error' && event.phase === 'sync'), 'public sync error crosses generation boundary', session)
    const failure = session.events.find(event => event.type === 'error' && event.phase === 'sync')
    assert.equal(failure.fatal, false)
    assert.equal(failure.runId, 1)
    assert(failure.error instanceof core.IconctlSyncError)
    assert(failure.error instanceof core.IconctlError)
    assert.equal(failure.error.name, 'IconctlSyncError')
    assert.equal(failure.error.issues.length, 1)
    assert.deepEqual({ ...failure.error.issues[0], message: undefined }, {
      name: 'home',
      stage: 'validation',
      sourceType: 'directory',
      sourceIndex: 0,
      message: undefined,
    })
    assert.equal(typeof failure.error.issues[0].message, 'string')
    assert(failure.error.message.startsWith('Icon processing or validation failed:\n'))
    assert.equal(results(session).length, 0)
    await write('raw/home.svg', svg.replace('viewBox="0 0 24 24"', 'viewBox="0 0 16 16"'))
    await until(() => results(session).length === 1, 'source repair after Worker sync error', session)
    assert.equal(results(session)[0].runId, 2)
    assert.equal(results(session)[0].result.complete, true)
  })

  await scenario('worker-exit-during-config', async ({ write, start, cwd }) => {
    await write('iconctl.config.mjs', `
      import process from 'node:process'
      import { isMainThread } from 'node:worker_threads'
      import { writeFile } from 'node:fs/promises'
      if (isMainThread) throw new Error('The exit fixture must run in its Worker')
      await writeFile(new URL('./worker-exited', import.meta.url), 'exit 17')
      process.exit(17)
      export default ${settings('\'unreachable\'')}
    `)
    const session = start('iconctl.config.mjs', 'error')
    const outcome = await bounded(session.finished, 'configuration Worker exit')
    assert(outcome instanceof core.IconctlError)
    assert.equal(outcome instanceof core.IconctlAbortError, false)
    assert.match(outcome.message, /17/)
    assert.equal(await readFile(join(cwd, 'worker-exited'), 'utf8'), 'exit 17')
    assert.equal(session.events.length, 2)
    assert.equal(session.events[0].type, 'error')
    assert.equal(session.events[0].phase, 'watch')
    assert.equal(session.events[0].fatal, true)
    assert(session.events[0].error instanceof core.IconctlError)
    assert.deepEqual(session.events[1], { type: 'stopped', reason: 'error' })
    assert.equal(await exists(join(cwd, 'icons.json')), false)
  })

  await scenario('process-context', async ({ write, start, cwd, cleanup }) => {
    const key = `ICONCTL_CONFIG_CONSUMER_${process.pid}_${mode.toUpperCase()}`
    const previous = process.env[key]
    cleanup.push(() => {
      if (previous === undefined) {
        delete process.env[key]
      }
      else {
        process.env[key] = previous
      }
    })
    const source = published => `
      import process from 'node:process'
      import { writeFile } from 'node:fs/promises'
      await writeFile(new URL('./environment.json', import.meta.url), JSON.stringify({ value: process.env[${JSON.stringify(key)}], argv: process.argv, cwd: process.cwd() }))
      process.env[${JSON.stringify(key)}] = ${JSON.stringify(published)}
      export default ${settings('\'environment\'')}
    `
    process.env[key] = 'parent-before'
    await write('iconctl.config.mjs', source('worker-first'))
    const session = start()
    await until(() => results(session).length === 1, 'configuration process context', session)
    const context = async () => JSON.parse(await readFile(join(cwd, 'environment.json'), 'utf8'))
    assert.deepEqual(await context(), { value: 'parent-before', argv: process.argv, cwd: process.cwd() })
    assert.equal(process.env[key], 'worker-first')
    process.env[key] = 'parent-edited'
    await write('iconctl.config.mjs', source('worker-second'))
    await until(() => results(session).length === 2, 'updated process environment', session)
    assert.deepEqual(await context(), { value: 'parent-edited', argv: process.argv, cwd: process.cwd() })
    assert.equal(process.env[key], 'worker-second')
    assert.deepEqual(session.events.filter(event => event.type === 'error'), [])
  })

  await scenario('cancel-pending-config', async ({ write, start, cwd, cleanup }) => {
    cleanup.push(() => write('release', 'released'))
    await write('iconctl.config.mjs', `
      import { access, writeFile } from 'node:fs/promises'
      import { setTimeout } from 'node:timers/promises'
      const release = new URL('./release', import.meta.url)
      await writeFile(new URL('./entered', import.meta.url), 'entered')
      const deadline = Date.now() + 15000
      while (!await access(release).then(() => true, () => false)) {
        if (Date.now() > deadline) throw new Error('Fixture release was not received')
        await setTimeout(20)
      }
      await writeFile(new URL('./drained', import.meta.url), 'drained')
      export default ${settings('\'cancelled\'')}
    `)
    const session = start()
    await until(() => exists(join(cwd, 'entered')), 'configuration reached its TLA gate', session)
    const reason = { message: 'cancel while configuration is pending' }
    session.controller.abort(reason)
    await delay(100)
    assert.equal(session.settled, false, 'Cancellation must wait for pending configuration evaluation to drain')
    assert.equal(await exists(join(cwd, 'drained')), false)
    await write('release', 'released')
    const outcome = await bounded(session.finished, 'cancelled configuration drain')
    assert(outcome instanceof core.IconctlAbortError)
    assert.equal(outcome.code, 'ABORT_ERR')
    assert.equal(outcome.cause, reason)
    assert.equal(await readFile(join(cwd, 'drained'), 'utf8'), 'drained')
    assert.deepEqual(session.events, [{ type: 'stopped', reason: 'aborted' }])
    assert.equal(await exists(join(cwd, 'icons.json')), false)
    await delay(100)
    assert.deepEqual(session.events, [{ type: 'stopped', reason: 'aborted' }])
    assert.equal(await exists(join(cwd, 'icons.json')), false)
  })

  await scenario('cancel-during-transaction', async ({ write, start, cwd, cleanup }) => {
    cleanup.push(() => write('release', 'released'))
    await mkdir(join(cwd, '.iconctl-cache'))
    await write('icons.json', JSON.stringify({ prefix: 'previous', icons: { previous: { body: '<path d="M0 0h8v8H0z"/>' } } }))
    await write('types.d.ts', 'previous types')
    await write('.iconctl-cache/meta.json', '{"validationVersion":1}')
    await write('iconctl.config.mjs', `
      import fs from 'node:fs'
      import { access, writeFile } from 'node:fs/promises'
      import { syncBuiltinESMExports } from 'node:module'
      import { sep } from 'node:path'
      import { setTimeout } from 'node:timers/promises'
      import { fileURLToPath } from 'node:url'
      const target = fileURLToPath(new URL('./icons.json', import.meta.url))
      const release = new URL('./release', import.meta.url)
      const rename = fs.promises.rename
      let entered = false
      fs.promises.rename = async (...args) => {
        if (!entered && String(args[1]) === target && String(args[0]).endsWith(sep + 'output')) {
          entered = true
          await writeFile(new URL('./entered', import.meta.url), 'commit entered')
          const deadline = Date.now() + 15000
          while (!await access(release).then(() => true, () => false)) {
            if (Date.now() > deadline) throw new Error('Fixture commit release was not received')
            await setTimeout(20)
          }
        }
        return rename(...args)
      }
      syncBuiltinESMExports()
      export default {
        ...${settings('\'transaction\'')},
        output: { json: 'icons.json', svg: 'published', types: 'types.d.ts' },
      }
    `)
    const session = start()
    await until(() => exists(join(cwd, 'entered')), 'transaction passed its final cancellation checkpoint', session)
    assert.equal(await exists(join(cwd, 'icons.json')), false, 'The old output has already moved to its transaction backup')
    assert((await readdir(cwd)).some(name => name.startsWith('.iconctl-stage-')))
    session.controller.abort('cancel while committing')
    await delay(100)
    assert.equal(session.settled, false, 'An active commit must drain before the generation can be disposed')
    await write('release', 'released')
    assert(await bounded(session.finished, 'transaction cancellation drain') instanceof core.IconctlAbortError)
    const snapshot = {
      json: await readFile(join(cwd, 'icons.json'), 'utf8'),
      svg: await readFile(join(cwd, 'published', 'home.svg'), 'utf8'),
      types: await readFile(join(cwd, 'types.d.ts'), 'utf8'),
    }
    assert.equal(JSON.parse(snapshot.json).prefix, 'transaction')
    assert.deepEqual(Object.keys(JSON.parse(snapshot.json).icons), ['home'])
    assert(snapshot.svg.includes('<svg'))
    assert(snapshot.types.includes('home'))
    // A local-source commit invalidates any old remote completion metadata.
    assert.equal(await exists(join(cwd, '.iconctl-cache', 'meta.json')), false)
    for (const directory of [cwd, join(cwd, '.iconctl-cache')]) {
      assert.equal((await readdir(directory)).some(name => name.startsWith('.iconctl-stage-')), false)
    }
    assert.deepEqual(session.events.map(event => event.type), ['ready', 'start', 'stopped'])
    await delay(100)
    assert.deepEqual(session.events.map(event => event.type), ['ready', 'start', 'stopped'])
    assert.deepEqual({
      json: await readFile(join(cwd, 'icons.json'), 'utf8'),
      svg: await readFile(join(cwd, 'published', 'home.svg'), 'utf8'),
      types: await readFile(join(cwd, 'types.d.ts'), 'utf8'),
    }, snapshot)
  })

  console.log(JSON.stringify({ mode, runtime: process.version, scenarios: completed, passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const [consumer, mode, scenario] = process.argv.slice(2)
const cwd = await realpath(await mkdtemp(join(consumer, 'project-')))
const requireConsumer = createRequire(join(consumer, 'package.json'))
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const output = join(cwd, 'icons.json')
const originalReaddir = fs.promises.readdir
const originalWatch = fs.watch
const observers = new Set()
const events = []
let transportError
let injected = false
let sawEnotdir = false
let release
let intercepted
let pending
const controller = new AbortController()

async function source(directory, name) {
  await mkdir(join(cwd, directory), { recursive: true })
  await writeFile(join(cwd, directory, `${name}.svg`), svg)
}
async function config(directory) {
  await writeFile(join(cwd, 'iconctl.config.ts'), `export default ${JSON.stringify({ prefix: directory, sources: [{ type: 'directory', dir: directory }], output: { json: 'icons.json' } })}`)
}
async function until(predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (transportError) {
      throw transportError
    }
    assert(Date.now() < deadline, `${message}: ${JSON.stringify(events)}`)
    await setTimeout(10)
  }
}
function resultEvents() {
  return events.filter(event => event.type === 'result')
}
function arm(directory) {
  const gate = new Promise((resolve) => {
    release = resolve
  })
  fs.promises.readdir = async (...args) => {
    if (!injected && String(args[0]) === join(cwd, directory) && args[1]?.encoding === 'utf8' && args[1]?.withFileTypes === false) {
      injected = true
      const read = (async () => {
        await rm(join(cwd, directory), { recursive: true })
        await writeFile(join(cwd, directory), 'replaced directory')
        await gate
        try {
          return await originalReaddir(...args)
        }
        catch (error) {
          sawEnotdir = error.code === 'ENOTDIR'
          throw error
        }
      })()
      intercepted = read.catch(() => {})
      return read
    }
    return originalReaddir(...args)
  }
  syncBuiltinESMExports()
}

async function api() {
  // Instrument only public native handles, retaining real Chokidar lifecycle.
  fs.watch = (...args) => {
    const handle = originalWatch(...args)
    observers.add(handle)
    handle.once('close', () => observers.delete(handle))
    return handle
  }
  if (scenario !== 'healthy' && scenario !== 'handover') {
    arm('raw')
  }
  syncBuiltinESMExports()
  const entry = mode === 'cjs' ? requireConsumer.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
  assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
  const core = mode === 'cjs' ? requireConsumer('@iconctl/core') : await import('@iconctl/core')
  const imported = await import('@iconctl/core')
  const required = scenario === 'unpatched' ? undefined : requireConsumer('@iconctl/core')
  if (required) {
    assert.deepEqual(Object.keys(required).sort(), Object.keys(imported).sort())
    for (const name of Object.keys(imported)) {
      assert.equal(required[name], imported[name])
    }
    const cli = await import('iconctl')
    const cjsCli = requireConsumer('iconctl')
    assert.deepEqual(Object.keys(cjsCli).sort(), Object.keys(cli).sort())
    assert.equal(cjsCli.IconctlAbortError, cli.IconctlAbortError)
    assert.equal(typeof cjsCli.runCli, 'function')
    const oauth = await import('@iconctl/core/figma/oauth')
    const cjsOauth = requireConsumer('@iconctl/core/figma/oauth')
    assert.deepEqual(Object.keys(cjsOauth).sort(), Object.keys(oauth).sort())
    for (const name of Object.keys(oauth)) {
      assert.equal(cjsOauth[name], oauth[name])
    }
  }
  pending = core.watch({ cwd, signal: controller.signal, onEvent: event => events.push(event) }).catch(error => error)
  if (scenario === 'healthy') {
    await until(() => resultEvents().length === 1, 'healthy initial sync')
  }
  else {
    if (scenario === 'handover') {
      await until(() => resultEvents().length === 1, 'initial sync before handover')
      arm('next')
      await config('next')
    }
    await until(() => injected, 'real traversal boundary')
    if (scenario === 'cancel') {
      controller.abort('cancel pending traversal')
      assert((await pending) instanceof core.IconctlAbortError)
      release()
      await intercepted
    }
    else {
      release()
      await until(() => sawEnotdir, 'actual ENOTDIR response')
      if (scenario === 'unpatched') {
        await setTimeout(1000)
        assert.equal(events.length, 0, 'unpatched traversal must remain before ready')
      }
      else {
        await until(() => events.some(event => event.type === 'error' && event.phase === 'sync'), 'failed source validation after ready')
        assert.equal(resultEvents().length, scenario === 'handover' ? 1 : 0)
        if (scenario !== 'handover') {
          assert.equal(await readFile(output, 'utf8'), 'previous output')
        }
        const directory = scenario === 'handover' ? 'next' : 'raw'
        await rm(join(cwd, directory))
        await source(directory, 'restored')
        await until(() => resultEvents().length === (scenario === 'handover' ? 2 : 1), 'parent observer recovers')
        assert.deepEqual(Object.keys(resultEvents().at(-1).result.json.icons), ['restored'])
      }
    }
  }
  controller.abort('consumer completed')
  assert((await pending) instanceof core.IconctlAbortError)
  await until(() => observers.size === 0, 'all native handles closed')
  assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'aborted' })
}

async function binary() {
  const entry = join(consumer, 'node_modules', 'iconctl', 'bin', 'index.js')
  const child = spawn(process.execPath, ['--import', new URL('./watch-consumer-preload.mjs', import.meta.url).href, entry, 'watch', '--json'], {
    cwd,
    env: { ...process.env, ICONCTL_TEST_RACE_ROOT: join(cwd, 'raw') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  let buffer = ''
  child.stderr.on('data', (data) => {
    stderr += data
  })
  child.stdout.on('data', (data) => {
    buffer += data
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n')
      try {
        events.push(JSON.parse(buffer.slice(0, newline)))
      }
      catch (error) {
        transportError = error
      }
      buffer = buffer.slice(newline + 1)
    }
  })
  child.on('message', (message) => {
    if (message === 'ENOTDIR') {
      sawEnotdir = true
    }
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  try {
    await until(() => sawEnotdir && events.some(event => event.type === 'error'), 'installed bin reports invalid source after ready')
    assert(events.some(event => event.type === 'ready'))
    assert.equal(await readFile(output, 'utf8'), 'previous output')
    await rm(join(cwd, 'raw'))
    await source('raw', 'restored')
    await until(() => resultEvents().length === 1, 'installed bin recovers')
    child.kill('SIGTERM')
    assert.deepEqual(await closed, { code: 143, signal: null })
    assert.equal(stderr, '')
    assert.equal(buffer, '')
    assert.equal(events.at(-1).type, 'stopped')
  }
  finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
    }
    await closed
  }
}

try {
  await source('raw', 'original')
  await source('next', 'replacement')
  await config('raw')
  await writeFile(output, 'previous output')
  if (mode === 'bin') {
    await binary()
  }
  else {
    await api()
  }
  console.log(JSON.stringify({ mode, scenario, injected: mode === 'bin' ? sawEnotdir : injected, sawEnotdir, ...(mode === 'bin' ? { exitCode: 143 } : { nativeHandles: observers.size }), runtime: process.version, passed: true }))
}
finally {
  controller.abort()
  release?.()
  await pending
  await intercepted
  fs.promises.readdir = originalReaddir
  fs.watch = originalWatch
  syncBuiltinESMExports()
  await rm(cwd, { recursive: true, force: true })
}

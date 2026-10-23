import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
// Release automation runs directly in Node, outside application Vitest workspaces.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const repoctlEntry = require.resolve('repoctl')
const implementationEntry = createRequire(repoctlEntry).resolve('@icebreakers/monorepo')
const dist = path.dirname(implementationEntry)
for (const entry of [repoctlEntry, implementationEntry]) {
  const manifest = JSON.parse(readFileSync(path.resolve(entry, '../../package.json'), 'utf8'))
  assert.equal(manifest.version, '6.0.1', 'Review the nightly patch and private test seam when upgrading repoctl')
}

// repoctl does not export its consumer parser. Load the installed, patched code
// instead of copying its implementation into a test. Pin the version and require
// each private region exactly once so upstream changes cannot silently skip it.
const regionNames = ['run', 'missing-version', 'install']
const regionMarker = name => `//#region src/commands/release/nightly/consumer/${name}.ts\n`
const bundles = readdirSync(dist)
  .filter(file => /^commands-.*\.mjs$/u.test(file))
  .map(file => ({ file, source: readFileSync(path.join(dist, file), 'utf8') }))
  .filter(({ source }) => source.includes(regionMarker('missing-version')))
assert.equal(bundles.length, 1, 'Expected one pinned repoctl consumer bundle')
const { file: bundleName, source: bundle } = bundles[0]
const consumerSource = regionNames.map((name) => {
  const marker = regionMarker(name)
  const parts = bundle.split(marker)
  assert.equal(parts.length, 2, `Expected exactly one ${name} region`)
  const end = parts[1].indexOf('//#endregion')
  assert.ok(end > 0, `Missing end of ${name} region`)
  return parts[1].slice(0, end)
}).join('\n')

function loadConsumer({ visibilityTimeoutMs = 900_000, sleepAdvancesClock = false, removalError } = {}) {
  let now = 0
  const waits = []
  const removed = []
  const api = runInNewContext(`${consumerSource}\n({ ConsumerCommandError, consumerRunner, missingBatchVersion, installNightlyConsumer })`, {
    Error,
    path$1: path,
    performance: { now: () => now },
    registrySettings: () => ({ visibilityTimeoutMs }),
    // These collaborators are unrelated to parsing; no external commands or
    // filesystem mutations are performed by this regression suite.
    consumerPnpmOptions: ['--config.ignore-pnpmfile=true'],
    failureMessage: command => command.output,
    sleep: async (duration) => {
      waits.push(duration)
      if (sleepAdvancesClock) {
        now += duration
      }
    },
    rm: async (target, options) => {
      removed.push({ target, options: { ...options } })
      if (removalError) {
        throw removalError
      }
    },
  }, { filename: `${bundleName}:nightly-consumer-regression` })
  return {
    ...api,
    waits,
    removed,
    advance: (duration) => {
      now += duration
    },
  }
}

const version = '0.4.1-snapshot.nightly.c8cc3cbacd518a25197593e89dbca726939032a6d.b63360f3e27b1c3a5b2209c08e1eded4d92e0e28eedbbcecc7fbe105d469bb810'
const batch = {
  provider: 'npm',
  confirmed: true,
  packages: ['@iconctl/core', 'iconctl'].map(name => ({ name, version, published: true })),
}
const debugRecord = JSON.stringify({ level: 'debug', name: 'pnpm:scope', selected: 1 })
// Captured fatal layout from icelib/iconctl Actions run 39950614340 (pnpm 12.6.0).
// --reporter=ndjson still emits this miette diagnostic after JSON progress.
const nativeFatal = `Error: ERR_PNPM_NO_MATCHING_VERSION

  × installing dependencies
  ╰─▶ Failed to resolve dependency tree: No matching version found for
      iconctl@snapshot-nightly while fetching it from https://
      registry.npmjs.org/
  help: The latest release of iconctl is "0.4.0". Published at 10/16/2026
${' '.repeat(8)}
        If you need the full list of all 6 published versions run "pnpm view
        iconctl versions".

`

function nativeOutput(target = 'iconctl@snapshot-nightly') {
  const name = target.slice(0, target.lastIndexOf('@'))
  return nativeFatal
    .replace('iconctl@snapshot-nightly', target)
    .replace('release of iconctl', `release of ${name}`)
    .replace('iconctl versions', `${name} versions`)
}

function structuredRecord(target = 'iconctl@snapshot-nightly', overrides = {}) {
  return {
    level: 'error',
    code: 'ERR_PNPM_NO_MATCHING_VERSION',
    message: `No matching version found for ${target} while fetching it from https://registry.npmjs.org/`,
    ...overrides,
  }
}

function commandError(api, { stdout = debugRecord, stderr = nativeFatal, exitCode = 1 } = {}) {
  return new api.ConsumerCommandError({ stdout, stderr, exitCode, output: `${stdout}\n${stderr}` })
}

const parser = loadConsumer()

test('pnpm 12.6 mixed JSON progress and wrapped native fatal accepts only batch tags or exact versions', () => {
  for (const pkg of batch.packages) {
    for (const suffix of ['snapshot-nightly', pkg.version]) {
      const stderr = `${debugRecord}\n${nativeOutput(`${pkg.name}@${suffix}`)}`
      assert.equal(parser.missingBatchVersion(commandError(parser, { stderr }), batch), true)
      assert.equal(parser.missingBatchVersion(commandError(parser, { stdout: '', stderr }), batch), true)
      assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: stderr.replaceAll('\n', '\r\n') }), batch), true)
    }
  }
  const target = `@iconctl/core@${version}`
  const wrapped = nativeOutput(target).replace(target, `${target.slice(0, 62)}\n      ${target.slice(62)}`)
  assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: wrapped }), batch), true)
  const noHelp = nativeFatal.slice(0, nativeFatal.indexOf('  help:'))
  assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: noHelp }), batch), true)
})

test('existing NDJSON missing-version records retain strict top-level and nested support', () => {
  for (const pkg of batch.packages) {
    for (const suffix of ['snapshot-nightly', pkg.version]) {
      const record = structuredRecord(`${pkg.name}@${suffix}`)
      for (const output of [record, { level: 'error', err: { code: record.code, message: record.message } }, { ...record, err: record }]) {
        assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: JSON.stringify(output) }), batch), true)
      }
    }
  }
  const context = '\nThis error happened while installing the dependencies of iconctl@0.4.1'
  const alias = structuredRecord(`alias@npm:@iconctl/core@${version}`)
  alias.message += context
  alias.pkgsStack = [{ name: 'iconctl', version: '0.4.1' }]
  assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: JSON.stringify(alias) }), batch), true)
})

const rejectedOutputs = [
  ['unrelated package', nativeOutput('@types/node@snapshot-nightly')],
  ['retired icons package', nativeOutput('@iconctl/icons@snapshot-nightly')],
  ['different tag', nativeOutput('iconctl@latest')],
  ['different version', nativeOutput('iconctl@0.4.0')],
  ['other registry', nativeFatal.replace('registry.npmjs.org/', 'registry.example.com/')],
  ['registry lookalike', nativeFatal.replace('registry.npmjs.org/', 'registry.npmjs.org.evil.example/')],
  ['registry path', nativeFatal.replace('registry.npmjs.org/', 'registry.npmjs.org/private/')],
  ['authentication fatal', nativeFatal.replaceAll('ERR_PNPM_NO_MATCHING_VERSION', 'ERR_PNPM_FETCH_401')],
  ['integrity fatal', nativeFatal.replaceAll('ERR_PNPM_NO_MATCHING_VERSION', 'ERR_PNPM_TARBALL_INTEGRITY')],
  ['unrecognized prefix', `unexpected output\n${nativeFatal}`],
  ['unrecognized suffix', `${nativeFatal}unexpected output\n`],
  ['additional indented cause', nativeFatal.replace('  help:', '      caused by authentication failure\n  help:')],
  ['unknown help', nativeFatal.replace('  help:', '  help: another failure\n        ')],
  ['wrong help package', nativeFatal.replace('release of iconctl', 'release of another-package')],
  ['wrong help command', nativeFatal.replace('iconctl versions', 'another-package versions')],
  ['second missing-version fatal', `${nativeFatal}${nativeFatal}`],
  ['second auth fatal', `${nativeFatal}Error: ERR_PNPM_FETCH_401\n`],
  ['second integrity fatal', `${nativeFatal}Error: ERR_PNPM_TARBALL_INTEGRITY\n`],
  ['unexpected install phase', nativeFatal.replace('installing dependencies', 'publishing packages')],
  ['malformed JSON before fatal', `{"level":"debug"\n${nativeFatal}`],
  ['JSON scalar before fatal', `null\n${nativeFatal}`],
  ['JSON array before fatal', `[]\n${nativeFatal}`],
  ['JSON error after native fatal', `${nativeFatal}${JSON.stringify(structuredRecord())}\n`],
  ['auth record before fatal', `${JSON.stringify(structuredRecord(undefined, { code: 'ERR_PNPM_FETCH_401' }))}\n${nativeFatal}`],
  ['integrity record before fatal', `${JSON.stringify(structuredRecord(undefined, { code: 'ERR_PNPM_TARBALL_INTEGRITY' }))}\n${nativeFatal}`],
  ['unrelated missing record before fatal', `${JSON.stringify(structuredRecord('@types/node@26.6.5'))}\n${nativeFatal}`],
  ['nested conflicting code', JSON.stringify(structuredRecord(undefined, { err: { code: 'ERR_PNPM_FETCH_403' } }))],
  ['nested conflicting message', JSON.stringify(structuredRecord(undefined, { err: { message: 'integrity mismatch' } }))],
  ['top-level cause', JSON.stringify(structuredRecord(undefined, { cause: 'authentication failed' }))],
  ['nested cause', JSON.stringify(structuredRecord(undefined, { err: { cause: 'integrity mismatch' } }))],
  ['malformed nested error', JSON.stringify(structuredRecord(undefined, { err: 'authentication failed' }))],
  ['missing JSON message', JSON.stringify(structuredRecord(undefined, { message: undefined }))],
  ['structured other registry', JSON.stringify(structuredRecord()).replace('registry.npmjs.org', 'registry.example.com')],
  ['no fatal error', debugRecord],
  ['no output', ''],
]

for (const [label, stderr] of rejectedOutputs) {
  test(`missing-version classifier fails closed for ${label}`, () => {
    assert.equal(parser.missingBatchVersion(commandError(parser, { stderr }), batch), false)
  })
}

test('unknown stdout, spawn failures and signal exits cannot be treated as visibility lag', () => {
  assert.equal(parser.missingBatchVersion(commandError(parser, { stdout: 'unexpected stdout' }), batch), false)
  assert.equal(parser.missingBatchVersion(commandError(parser, { exitCode: null }), batch), false)
  assert.equal(parser.missingBatchVersion(new Error(nativeFatal), batch), false)
})

function installation({ outputs = [{ status: 1, stderr: nativeFatal }, { status: 0 }], commandDuration = 0, provider = 'npm', ...runtime } = {}) {
  const api = loadConsumer(runtime)
  const calls = []
  const result = { commands: [] }
  const report = structuredClone({ ...batch, provider })
  const before = structuredClone(report)
  const directory = path.resolve('/tmp/iconctl-nightly-consumer-test')
  const options = {
    spawn: (executable, args, settings) => {
      calls.push({ executable, args: Array.from(args), settings })
      api.advance(commandDuration)
      return outputs[Math.min(calls.length - 1, outputs.length - 1)]
    },
  }
  const run = api.consumerRunner(result, options, directory, {})
  return {
    ...api,
    calls,
    result,
    report,
    before,
    directory,
    install: () => api.installNightlyConsumer(report, options, directory, run),
  }
}

test('visibility retry runs install only, preserves accepted uploads and isolates each attempt', async () => {
  const runtime = installation()
  await runtime.install()
  assert.equal(runtime.calls.length, 2)
  assert.deepEqual(runtime.waits, [2000])
  assert.deepEqual(runtime.report, runtime.before)
  for (const [attempt, call] of runtime.calls.entries()) {
    assert.equal(call.executable, 'pnpm')
    assert.equal(call.args.filter(arg => !arg.startsWith('--')).join(' '), 'install')
    for (const flag of ['--ignore-scripts', '--no-frozen-lockfile', '--no-prefer-frozen-lockfile', '--no-prefer-offline', '--no-offline', '--registry=https://registry.npmjs.org/', '--reporter=ndjson']) {
      assert.ok(call.args.includes(flag), `Missing installation safeguard: ${flag}`)
    }
    const state = path.join(runtime.directory, `.pnpm-attempt-${attempt}`)
    for (const [flag, child] of [['--store-dir', 'store'], ['--state-dir', 'state'], ['--config.cache-dir', 'cache']]) {
      assert.ok(call.args.includes(`${flag}=${path.join(state, child)}`))
    }
    assert.equal(call.settings.cwd, runtime.directory)
    assert.equal(call.settings.shell, false)
  }
  assert.deepEqual(runtime.removed, ['node_modules', 'pnpm-lock.yaml', '.pnpm-attempt-0'].map(name => ({
    target: path.join(runtime.directory, name),
    options: { recursive: true, force: true },
  })))
  assert.deepEqual(runtime.result.commands.map(command => command.exitCode), [1, 0])
})

test('unrelated, authentication, integrity, timeout and signal failures stop after one install', async () => {
  for (const output of [
    ...rejectedOutputs.map(([, stderr]) => ({ status: 1, stderr })),
    { status: 1, stderr: nativeFatal, stdout: 'unexpected stdout' },
    { status: 1, stderr: nativeFatal, error: new Error('spawn ETIMEDOUT') },
    { status: null, signal: 'SIGTERM', stderr: nativeFatal },
  ]) {
    const runtime = installation({ outputs: [output] })
    await assert.rejects(runtime.install(), runtime.ConsumerCommandError)
    assert.equal(runtime.calls.length, 1)
    assert.deepEqual(runtime.waits, [])
    assert.deepEqual(runtime.removed, [])
  }
})

test('non-npm providers never retry a missing version', async () => {
  const runtime = installation({ provider: 'pkg-pr-new' })
  await assert.rejects(runtime.install(), runtime.ConsumerCommandError)
  assert.equal(runtime.calls.length, 1)
  assert.deepEqual(runtime.waits, [])
})

test('persistent missing versions stop at the visibility budget with real or virtual waits', async () => {
  for (const sleepAdvancesClock of [false, true]) {
    const runtime = installation({
      outputs: [{ status: 1, stderr: nativeFatal }],
      visibilityTimeoutMs: 7000,
      sleepAdvancesClock,
    })
    await assert.rejects(runtime.install(), (error) => {
      assert.match(error.message, /visibility timed out/u)
      assert.ok(error.cause instanceof runtime.ConsumerCommandError)
      return true
    })
    assert.deepEqual(runtime.waits, [2000, 4000, 1000])
    assert.deepEqual(runtime.calls.map(call => call.settings.timeout), [7000, 5000, 1000])
    assert.equal(runtime.removed.length, 9)
    assert.deepEqual(runtime.report, runtime.before)
  }
})

test('installation time consumes the same budget and no individual install exceeds ten minutes', async () => {
  const runtime = installation({ outputs: [{ status: 1, stderr: nativeFatal }], visibilityTimeoutMs: 5000, commandDuration: 1000 })
  await assert.rejects(runtime.install(), /visibility timed out/u)
  assert.deepEqual(runtime.calls.map(call => call.settings.timeout), [5000, 2000])
  assert.deepEqual(runtime.waits, [2000, 1000])

  const capped = installation({ outputs: [{ status: 1, stderr: nativeFatal }], visibilityTimeoutMs: 1_800_000 })
  await assert.rejects(capped.install(), /visibility timed out/u)
  assert.equal(capped.waits.reduce((sum, duration) => sum + duration, 0), 900_000)
  assert.equal(Math.max(...capped.waits), 30_000)
  assert.ok(capped.calls.every(call => call.settings.timeout > 0 && call.settings.timeout <= 600_000))
})

test('cleanup failure stops retries and preserves the cleanup error', async () => {
  const removalError = new Error('Cannot remove the previous attempt store')
  const runtime = installation({ removalError })
  await assert.rejects(runtime.install(), error => error === removalError)
  assert.equal(runtime.calls.length, 1)
  assert.deepEqual(runtime.waits, [])
})

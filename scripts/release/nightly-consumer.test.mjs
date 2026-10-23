import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function compiledFunction(name) {
  const marker = `function ${name}(`
  assert.equal(bundle.split(marker).length, 2, `Expected exactly one ${name} function`)
  let start = bundle.indexOf(marker)
  if (bundle.slice(start - 6, start) === 'async ') {
    start -= 6
  }
  const end = bundle.indexOf('\n}', start)
  assert.ok(end > start, `Missing end of ${name} function`)
  return bundle.slice(start, end + 2)
}

// Include the actual identity validator and inspection boundary as well as the
// consumer. Registry responses and filesystem reads remain controlled fixtures.
const publicationSource = ['snapshotMetadata', 'matchesSnapshotMetadata', 'snapshotIdentity', 'object$1', 'validPublishedIdentity', 'inspectNpmNightly']
  .map(compiledFunction)
  .join('\n')

function loadConsumer({
  visibilityTimeoutMs = 900_000,
  sleepAdvancesClock = false,
  removalError,
  readFile = async () => { throw new Error('Unexpected manifest read') },
  realpath = async target => target,
  publication = async () => { throw new Error('Unexpected registry request') },
} = {}) {
  let now = 0
  const waits = []
  const removed = []
  const api = runInNewContext(`${consumerSource}\n${publicationSource}\n({
    ConsumerCommandError, consumerRunner, missingBatchVersion, installNightlyConsumer,
    previousNightlyPublications, readInstalledNightlyManifest, nightlyConsumerVisible,
    snapshotIdentity, inspectNpmNightly
  })`, {
    Error,
    createHash,
    path$1: path,
    readFile,
    realpath,
    tag: 'snapshot-nightly',
    createNightlyRegistry: () => ({ publication }),
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

const parser = loadConsumer()
const version = '0.4.1-snapshot.nightly.c8cc3cbacd518a25197593e89dbca726939032a6d.b63360f3e27b1c3a5b2209c08e1eded4d92e0e28eedbbcecc7fbe105d469bb810'
const currentIdentity = parser.snapshotIdentity({ identity: { kind: 'nightly', commit: '8cc3cbacd518a25197593e89dbca726939032a6d', buildId: '39950614340-1' } })
const currentPublication = { version, identity: currentIdentity.identity, identityKey: currentIdentity.key, tag: currentIdentity.tag }
const priorIdentity = parser.snapshotIdentity({ identity: { kind: 'nightly', commit: 'a'.repeat(40), buildId: '39800000000-1' } })
const priorPublication = {
  version: `0.4.1-snapshot.nightly.c${priorIdentity.identity.commit}.b${priorIdentity.key}`,
  identity: priorIdentity.identity,
  identityKey: priorIdentity.key,
  tag: priorIdentity.tag,
}
const batch = {
  provider: 'npm',
  confirmed: true,
  commit: currentIdentity.identity.commit,
  snapshot: { identity: currentPublication.identity, identityKey: currentPublication.identityKey, tag: currentPublication.tag },
  packages: ['@iconctl/core', 'iconctl'].map(name => ({ name, version, published: true })),
}

function installedManifest(name, publication = currentPublication) {
  return {
    name,
    version: publication.version,
    repoctlSnapshot: { ...publication.identity, identityKey: publication.identityKey, tag: publication.tag },
  }
}

function installedBatch(publication = currentPublication) {
  return Object.fromEntries(batch.packages.map(pkg => [pkg.name, installedManifest(pkg.name, publication)]))
}

function previousBatch() {
  return new Map(batch.packages.map(pkg => [pkg.name, structuredClone(priorPublication)]))
}

function registryPublication(name, publication = priorPublication) {
  return {
    latest: '0.4.0',
    version: publication.version,
    metadata: { ...installedManifest(name, publication), dist: { integrity: `sha512-${'A'.repeat(86)}==` } },
  }
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

// Captured from an isolated pnpm 12.6.0 install after snapshot-nightly existed.
// Substitute the confirmed batch version for the deliberately absent probe
// version; preserve the actual wrapped dates, help version and bullet layout.
const wrappedCoreTarget = `@iconctl/core@${version.slice(0, 50)}\n      ${version.slice(50)}`
const nativeOtherReleasesFatal = `Error: ERR_PNPM_NO_MATCHING_VERSION

  × installing dependencies
  ╰─▶ Failed to resolve dependency tree: No matching version found for
      ${wrappedCoreTarget} while
      fetching it from https://registry.npmjs.org/
  help: The latest release of @iconctl/core is "0.4.0". Published at
        10/17/2026
${' '.repeat(8)}
        Other releases are:
          * snapshot-nightly: 0.4.1-
        snapshot.nightly.c8cc3cbacd518a25197593e89dbca726939032a6d.b63360f3e27
        b1c3a5b2209c08e1eded4d92e0e28eedbbcecc7fbe105d469bb810 published at
        10/23/2026 8:12:51 PM
${' '.repeat(8)}
        If you need the full list of all 7 published versions run "pnpm view
        @iconctl/core versions".

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

test('native Other releases help accepts wrapped exact versions and publication dates', () => {
  for (const stderr of [
    nativeOtherReleasesFatal,
    nativeOtherReleasesFatal.replace(wrappedCoreTarget, '@iconctl/core@snapshot-nightly'),
  ]) {
    assert.equal(parser.missingBatchVersion(commandError(parser, { stderr: `${debugRecord}\n${stderr}` }), batch), true)
  }
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
  ['malformed other-release tag', nativeOtherReleasesFatal.replace('* snapshot-nightly:', '* invalid tag:')],
  ['malformed other-release version', nativeOtherReleasesFatal.replace('snapshot-nightly: 0.4.1-', 'snapshot-nightly: not-a-version-')],
  ['malformed other-release date', nativeOtherReleasesFatal.replace('10/23/2026 8:12:51 PM', 'unknown-date')],
  ['malformed other-release bullet', nativeOtherReleasesFatal.replace('* snapshot-nightly:', '- snapshot-nightly:')],
  ['other-release extra cause', nativeOtherReleasesFatal.replace('10/23/2026 8:12:51 PM', '10/23/2026 8:12:51 PM\n        caused by authentication failure')],
  ['other-release cause before date', nativeOtherReleasesFatal.replace('published at\n        10/23/2026', 'caused by authentication failure published at\n        10/23/2026')],
  ['other-release indented fatal', nativeOtherReleasesFatal.replace('Other releases are:', 'Other releases are:\n        Error: ERR_PNPM_FETCH_401')],
  ['other-release unindented fatal', nativeOtherReleasesFatal.replace('Other releases are:', 'Other releases are:\nError: ERR_PNPM_FETCH_401')],
  ['other-release appended fatal', `${nativeOtherReleasesFatal}Error: ERR_PNPM_TARBALL_INTEGRITY\n`],
  ['other-release unrelated exact target', nativeOtherReleasesFatal.replace(wrappedCoreTarget, '@iconctl/core@0.0.0-unconfirmed')],
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

function installation({
  outputs = [{ status: 1, stderr: nativeFatal }, { status: 0 }],
  manifests = [installedBatch()],
  previous,
  commandDuration = 0,
  provider = 'npm',
  ...runtime
} = {}) {
  const calls = []
  const reads = []
  const result = { commands: [] }
  const report = structuredClone({ ...batch, provider })
  const before = structuredClone(report)
  const directory = path.resolve('/tmp/iconctl-nightly-consumer-test')
  const api = loadConsumer({
    readFile: async (filename) => {
      reads.push(filename)
      const name = batch.packages.find(pkg => filename.endsWith(`${pkg.name}/package.json`))?.name
      const selected = manifests[Math.min(calls.length - 1, manifests.length - 1)]?.[name]
      if (selected === undefined) {
        throw new Error('ENOENT: installed package manifest is missing')
      }
      return typeof selected === 'string' ? selected : JSON.stringify(selected)
    },
    ...runtime,
  })
  if (previous) {
    api.previousNightlyPublications.set(report, previous)
  }
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
    reads,
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

test('Other releases help still retries installation when the exact core version is not yet visible', async () => {
  const runtime = installation({ outputs: [{ status: 1, stderr: nativeOtherReleasesFatal }, { status: 0 }] })
  await runtime.install()
  assert.equal(runtime.calls.length, 2)
  assert.deepEqual(runtime.waits, [2000])
  assert.deepEqual(runtime.report, runtime.before)
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

test('inspection copies verified previous publications without adding them to the public report', async () => {
  const publications = new Map(batch.packages.map(pkg => [pkg.name, registryPublication(pkg.name)]))
  const requested = []
  const runtime = loadConsumer({
    publication: async (name) => {
      requested.push(name)
      return publications.get(name)
    },
  })
  const report = structuredClone(batch)
  assert.equal(await runtime.inspectNpmNightly(report, {}), false)
  assert.deepEqual(requested, batch.packages.map(pkg => pkg.name))
  assert.deepEqual(Object.keys(report).sort(), [...Object.keys(batch), 'latest'].sort())
  assert.deepEqual(structuredClone(report.latest), { '@iconctl/core': '0.4.0', 'iconctl': '0.4.0' })

  const previous = runtime.previousNightlyPublications.get(report)
  for (const pkg of batch.packages) {
    assert.deepEqual(structuredClone(previous.get(pkg.name)), structuredClone(priorPublication))
    const publication = publications.get(pkg.name)
    publication.version = '0.0.0-replaced'
    publication.metadata.repoctlSnapshot.commit = 'b'.repeat(40)
    publication.metadata.repoctlSnapshot.identityKey = 'c'.repeat(64)
    publication.metadata.repoctlSnapshot.buildId = 'modified-after-inspection'
    assert.deepEqual(structuredClone(previous.get(pkg.name)), structuredClone(priorPublication))
  }
  assert.equal(runtime.previousNightlyPublications.has(structuredClone(report)), false)
})

test('inspection never remembers missing or invalid previous snapshot evidence', async () => {
  const invalidMetadata = [
    null,
    { ...registryPublication('iconctl').metadata, repoctlSnapshot: undefined },
    { ...registryPublication('iconctl').metadata, dist: { integrity: 'invalid' } },
    ...[
      { identityKey: 'c'.repeat(64) },
      { commit: 'not-a-commit' },
      { kind: 'pr' },
      { tag: 'latest' },
      { unexpected: true },
    ].map(overrides => ({
      ...registryPublication('iconctl').metadata,
      repoctlSnapshot: { ...installedManifest('iconctl', priorPublication).repoctlSnapshot, ...overrides },
    })),
  ]
  for (const metadata of invalidMetadata) {
    const runtime = loadConsumer({
      publication: async name => name === 'iconctl'
        ? { latest: '0.4.0', version: metadata ? priorPublication.version : null, metadata }
        : registryPublication(name),
    })
    const report = structuredClone(batch)
    assert.equal(await runtime.inspectNpmNightly(report, {}), false)
    const previous = runtime.previousNightlyPublications.get(report)
    assert.equal(previous.has('@iconctl/core'), true)
    assert.equal(previous.has('iconctl'), false)
  }
})

test('inspection preserves complete-channel detection and keeps separate reports isolated', async () => {
  let publication = currentPublication
  const runtime = loadConsumer({ publication: async name => registryPublication(name, publication) })
  const first = structuredClone(batch)
  assert.equal(await runtime.inspectNpmNightly(first, {}), true)
  publication = priorPublication
  const second = structuredClone(batch)
  assert.equal(await runtime.inspectNpmNightly(second, {}), false)
  assert.deepEqual(structuredClone(runtime.previousNightlyPublications.get(first).get('iconctl')), structuredClone(currentPublication))
  assert.deepEqual(structuredClone(runtime.previousNightlyPublications.get(second).get('iconctl')), structuredClone(priorPublication))
})

test('inspection rejects mixed builds even when both existing packages share the current commit', async () => {
  const identity = parser.snapshotIdentity({ identity: { ...currentPublication.identity, buildId: '39950614340-2' } })
  const otherBuild = {
    version: `0.4.1-snapshot.nightly.c${identity.identity.commit}.b${identity.key}`,
    identity: identity.identity,
    identityKey: identity.key,
    tag: identity.tag,
  }
  const runtime = loadConsumer({ publication: async name => registryPublication(name, name === 'iconctl' ? otherBuild : currentPublication) })
  assert.equal(await runtime.inspectNpmNightly(structuredClone(batch), {}), false)
})

test('a successful install of the inspected previous batch retries until the current batch is installed', async () => {
  const runtime = installation({
    outputs: [{ status: 0 }, { status: 0 }],
    manifests: [installedBatch(priorPublication), installedBatch()],
    publication: async name => registryPublication(name),
  })
  assert.equal(await runtime.inspectNpmNightly(runtime.report, {}), false)
  const before = structuredClone(runtime.report)
  await runtime.install()
  assert.equal(runtime.calls.length, 2)
  assert.deepEqual(runtime.result.commands.map(command => command.exitCode), [0, 0])
  assert.deepEqual(runtime.waits, [2000])
  assert.deepEqual(structuredClone(runtime.report), before)
  assert.equal(runtime.reads.length, 4)
  assert.deepEqual(runtime.removed.map(entry => entry.target), ['node_modules', 'pnpm-lock.yaml', '.pnpm-attempt-0'].map(name => path.join(runtime.directory, name)))
  for (const [attempt, call] of runtime.calls.entries()) {
    assert.equal(call.executable, 'pnpm')
    assert.equal(call.args.filter(arg => !arg.startsWith('--')).join(' '), 'install')
    assert.ok(call.args.includes(`--store-dir=${path.join(runtime.directory, `.pnpm-attempt-${attempt}`, 'store')}`))
  }
})

test('mixed current core and verified previous CLI cannot pass until both packages are current', async () => {
  const mixed = { ...installedBatch(), iconctl: installedManifest('iconctl', priorPublication) }
  const runtime = installation({ outputs: [{ status: 0 }], manifests: [mixed, installedBatch()], previous: previousBatch() })
  await runtime.install()
  assert.equal(runtime.calls.length, 2)
  assert.equal(runtime.reads.length, 4)
  assert.deepEqual(runtime.waits, [2000])
  assert.deepEqual(runtime.report, runtime.before)
})

test('missing-version and successful stale installations share one retry budget and fresh state sequence', async () => {
  const runtime = installation({
    outputs: [{ status: 1, stderr: nativeFatal }, { status: 0 }, { status: 0 }],
    manifests: [installedBatch(), installedBatch(priorPublication), installedBatch()],
    previous: previousBatch(),
    visibilityTimeoutMs: 7000,
  })
  await runtime.install()
  assert.deepEqual(runtime.calls.map(call => call.settings.timeout), [7000, 5000, 1000])
  assert.deepEqual(runtime.waits, [2000, 4000])
  assert.deepEqual(runtime.removed.map(entry => path.basename(entry.target)), [
    'node_modules',
    'pnpm-lock.yaml',
    '.pnpm-attempt-0',
    'node_modules',
    'pnpm-lock.yaml',
    '.pnpm-attempt-1',
  ])
})

test('a persistently stale successful install stops at the original visibility deadline', async () => {
  const runtime = installation({
    outputs: [{ status: 0 }],
    manifests: [installedBatch(priorPublication)],
    previous: previousBatch(),
    visibilityTimeoutMs: 7000,
  })
  await assert.rejects(runtime.install(), /visibility timed out/u)
  assert.deepEqual(runtime.result.commands.map(command => command.exitCode), [0, 0, 0])
  assert.deepEqual(runtime.calls.map(call => call.settings.timeout), [7000, 5000, 1000])
  assert.deepEqual(runtime.waits, [2000, 4000, 1000])
  assert.equal(runtime.removed.length, 9)
  assert.deepEqual(runtime.report, runtime.before)
})

test('successful installs reject unknown versions, identity conflicts, package mismatches and invalid manifests immediately', async () => {
  const current = installedManifest('iconctl')
  const prior = installedManifest('iconctl', priorPublication)
  const conflicts = [
    { ...current, version: '0.4.1-unrecognized-snapshot' },
    { ...current, version: prior.version },
    { ...prior, version: current.version },
    { ...current, name: 'another-package' },
    { ...current, repoctlSnapshot: undefined },
    { ...current, repoctlSnapshot: { ...current.repoctlSnapshot, extra: true } },
    { ...prior, repoctlSnapshot: { ...prior.repoctlSnapshot, tag: 'latest' } },
    { ...prior, repoctlSnapshot: { ...prior.repoctlSnapshot, identityKey: 'b'.repeat(64) } },
    '{malformed-json',
    undefined,
  ]
  for (const manifest of conflicts) {
    // A recognized stale package earlier in the batch must not hide a later
    // conflicting package by returning from the visibility check too early.
    const manifests = { ...installedBatch(priorPublication), iconctl: manifest }
    const runtime = installation({ outputs: [{ status: 0 }], manifests: [manifests], previous: previousBatch() })
    await assert.rejects(runtime.install())
    assert.equal(runtime.calls.length, 1)
    assert.deepEqual(runtime.waits, [])
    assert.deepEqual(runtime.removed, [])
  }
})

test('a previous version requires evidence for that exact package and report', async () => {
  for (const previous of [undefined, new Map(), new Map([['@iconctl/core', priorPublication]])]) {
    const runtime = installation({
      outputs: [{ status: 0 }],
      manifests: [{ ...installedBatch(), iconctl: installedManifest('iconctl', priorPublication) }],
      previous,
    })
    runtime.previousNightlyPublications.set(structuredClone(runtime.report), previousBatch())
    await assert.rejects(runtime.install(), /unexpected version or identity/u)
    assert.equal(runtime.calls.length, 1)
    assert.deepEqual(runtime.waits, [])
  }
})

test('installed symlinks cannot escape the isolated consumer or resolve to its root', async () => {
  for (const escaped of [
    path.resolve('/tmp/iconctl-nightly-consumer-test'),
    path.resolve('/tmp'),
    path.resolve('/tmp/iconctl-nightly-consumer-test-sibling/node_modules/iconctl'),
    path.resolve('/elsewhere/node_modules/iconctl'),
  ]) {
    const runtime = installation({ outputs: [{ status: 0 }], realpath: async () => escaped, previous: previousBatch() })
    await assert.rejects(runtime.install(), /outside its isolated directory/u)
    assert.equal(runtime.calls.length, 1)
    assert.deepEqual(runtime.reads, [])
    assert.deepEqual(runtime.waits, [])
    assert.deepEqual(runtime.removed, [])
  }
})

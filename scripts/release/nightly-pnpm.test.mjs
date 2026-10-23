import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
// Exercise the release process independently of the application test workspaces.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Worker } from 'node:worker_threads'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const repoctlEntry = require.resolve('repoctl')
const implementationEntry = createRequire(repoctlEntry).resolve('@icebreakers/monorepo')
const dist = path.dirname(implementationEntry)
for (const entry of [repoctlEntry, implementationEntry]) {
  assert.equal(JSON.parse(readFileSync(path.resolve(entry, '../../package.json'), 'utf8')).version, '6.0.1')
}
const marker = name => `//#region src/commands/release/nightly/consumer/${name}.ts\n`
const bundles = readdirSync(dist)
  .filter(filename => /^commands-.*\.mjs$/u.test(filename))
  .map(filename => readFileSync(path.join(dist, filename), 'utf8'))
  .filter(source => source.includes(marker('install')))
assert.equal(bundles.length, 1, 'Review the private consumer seam when upgrading repoctl')
const [bundle] = bundles
const consumerSource = ['environment', 'run', 'missing-version', 'install'].map((name) => {
  const parts = bundle.split(marker(name))
  assert.equal(parts.length, 2, `Expected one ${name} region`)
  const end = parts[1].indexOf('//#endregion')
  assert.ok(end > 0)
  return parts[1].slice(0, end)
}).join('\n')
const identitySource = ['snapshotMetadata', 'matchesSnapshotMetadata', 'snapshotIdentity'].map((name) => {
  const start = bundle.indexOf(`function ${name}(`)
  assert.equal(bundle.split(`function ${name}(`).length, 2)
  const end = bundle.indexOf('\n}', start)
  assert.ok(end > start)
  return bundle.slice(start, end + 2)
}).join('\n')

function loadConsumer() {
  const waits = []
  const api = runInNewContext(`${consumerSource}\n${identitySource}\n({
    consumerEnvironment, consumerPnpmOptions, consumerRunner, installNightlyConsumer,
    nightlyConsumerWorkspace, previousNightlyPublications, snapshotIdentity
  })`, {
    Error,
    createHash,
    path$1: path,
    readFile,
    realpath,
    rm,
    writeFile,
    performance,
    tag: 'snapshot-nightly',
    registrySettings: () => ({ visibilityTimeoutMs: 30_000 }),
    failureMessage: command => command.output,
    // The real installer still accounts for these waits in its bounded budget.
    sleep: async duration => waits.push(duration),
  })
  return { ...api, waits }
}

function publication(api, commit, buildId) {
  const snapshot = api.snapshotIdentity({ identity: { kind: 'nightly', commit, buildId } })
  return {
    version: `0.4.1-snapshot.nightly.c${commit}.b${snapshot.key}`,
    identity: snapshot.identity,
    identityKey: snapshot.key,
    tag: snapshot.tag,
  }
}

function manifest(name, published, dependencies = {}) {
  return {
    name,
    version: published.version,
    dependencies,
    repoctlSnapshot: { ...published.identity, identityKey: published.identityKey, tag: published.tag },
  }
}

// A package.json-only POSIX tar archive is sufficient for a real installation.
// No build, package-manager packing command, or third-party test dependency is needed.
function tarball(value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`)
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  const octal = (offset, length, number) => header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length)
  octal(100, 8, 0o644)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, body.length)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8)
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512 + 1024)]))
}

function catalogFor(previous, current) {
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
  const recent = new Date(Date.now() - 60 * 1000).toISOString()
  const thirdParty = 'repoctl-nightly-age-fixture'
  const entries = [
    { name: '@iconctl/core', previous: previous.version, current: current.version, versions: [
      [manifest('@iconctl/core', previous), old],
      [manifest('@iconctl/core', current), recent],
      // A transitive range for the same package must not inherit its batch exemption.
      [{ name: '@iconctl/core', version: '9.0.0' }, old],
      [{ name: '@iconctl/core', version: '9.1.0' }, recent],
    ] },
    { name: 'iconctl', previous: previous.version, current: current.version, versions: [
      [manifest('iconctl', previous, { '@iconctl/core': previous.version, [thirdParty]: '^1.0.0' }), old],
      [manifest('iconctl', current, { '@iconctl/core': current.version, [thirdParty]: '^1.0.0' }), recent],
    ] },
    { name: thirdParty, previous: '1.0.0', current: '1.1.0', versions: [
      [{ name: thirdParty, version: '1.0.0', dependencies: { '@iconctl/core': '^9.0.0' } }, old],
      [{ name: thirdParty, version: '1.1.0', dependencies: { '@iconctl/core': '^9.0.0' } }, recent],
    ] },
  ]
  return entries.map((entry, packageIndex) => ({
    ...entry,
    versions: entry.versions.map(([value, publishedAt], versionIndex) => {
      const bytes = tarball(value)
      return {
        manifest: value,
        publishedAt,
        archive: `/tarballs/${packageIndex}-${versionIndex}.tgz`,
        bytes,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      }
    }),
  }))
}

async function startRegistry(catalog) {
  const phase = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  // spawnSync blocks this test's event loop, so the HTTP server needs its own worker.
  const worker = new Worker(`
    const { createServer } = require('node:http');
    const { parentPort, workerData } = require('node:worker_threads');
    const phase = new Int32Array(workerData.phase);
    const requests = [];
    let origin;
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
      const currentPhase = Atomics.load(phase, 0);
      requests.push({ pathname, phase: currentPhase, accept: request.headers.accept,
        ifNoneMatch: request.headers['if-none-match'] });
      for (const entry of workerData.catalog) {
        const archive = entry.versions.find(version => version.archive === pathname);
        if (archive) {
          response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          response.end(Buffer.from(archive.bytes));
          return;
        }
        if (pathname !== '/' + entry.name) continue;
        const versions = Object.fromEntries(entry.versions.map(version => [version.manifest.version, {
          ...version.manifest,
          dist: { tarball: origin + version.archive, integrity: version.integrity },
        }]));
        const value = {
          name: entry.name,
          'dist-tags': { latest: entry.previous,
            'snapshot-nightly': currentPhase === 0 ? entry.previous : entry.current },
          versions,
          time: Object.fromEntries(entry.versions.map(version => [version.manifest.version, version.publishedAt])),
        };
        const etag = '"' + entry.name + '-' + currentPhase + '"';
        response.writeHead(200, { 'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400', ETag: etag });
        response.end(JSON.stringify(value));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unexpected fixture registry path: ' + pathname }));
    });
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port;
      parentPort.postMessage({ ready: origin });
    });
    parentPort.on('message', message => {
      if (message.action === 'requests') parentPort.postMessage({ id: message.id, requests });
      if (message.action === 'close') server.close(() => {
        parentPort.postMessage({ id: message.id });
        parentPort.close();
      });
    });
  `, { eval: true, workerData: { catalog, phase: phase.buffer } })
  const pending = new Map()
  let nextId = 0
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  worker.on('message', (message) => {
    if (message.ready) {
      readyResolve(message.ready)
    }
    else {
      pending.get(message.id)?.resolve(message)
      pending.delete(message.id)
    }
  })
  worker.on('error', (error) => {
    readyReject(error)
    for (const promise of pending.values()) {
      promise.reject(error)
    }
    pending.clear()
  })
  const rpc = action => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    worker.postMessage({ action, id })
  })
  try {
    const origin = await ready
    return {
      origin,
      setPhase: value => Atomics.store(phase, 0, value),
      requests: async () => (await rpc('requests')).requests,
      close: async () => {
        try {
          await rpc('close')
        }
        finally {
          await worker.terminate()
        }
      },
    }
  }
  catch (error) {
    await worker.terminate()
    throw error
  }
}

async function createConsumer(root, name, api, report) {
  const directory = await realpath(await mkdtemp(path.join(root, `${name}-`)))
  await Promise.all([
    writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name: 'repoctl-nightly-pnpm-regression',
      private: true,
      packageManager: 'pnpm@12.6.0',
      dependencies: Object.fromEntries(report.packages.map(pkg => [pkg.name, 'snapshot-nightly'])),
    })}\n`),
    writeFile(path.join(directory, 'pnpm-workspace.yaml'), api.nightlyConsumerWorkspace(report)),
    writeFile(path.join(directory, 'user.npmrc'), ''),
    writeFile(path.join(directory, 'global.npmrc'), ''),
  ])
  return directory
}

function consumerRun(api, directory, registry, onInstall = () => {}) {
  const result = { commands: [] }
  const options = {
    spawn: (executable, args, settings) => {
      const localArgs = Array.from(args, arg => arg === '--registry=https://registry.npmjs.org/' ? `--registry=${registry.origin}/` : arg)
      const completed = spawnSync(executable, localArgs, {
        ...settings,
        timeout: Math.min(settings.timeout, 20_000),
        maxBuffer: 1024 * 1024,
      })
      if (args.includes('install')) {
        onInstall(completed)
      }
      return completed
    },
  }
  const env = api.consumerEnvironment(process.env, directory)
  // The only transport substitution: every other option comes from repoctl.
  env.npm_config_registry = `${registry.origin}/`
  return { result, options, run: api.consumerRunner(result, options, directory, env) }
}

async function assertInstalled(directory, report) {
  for (const pkg of report.packages) {
    const value = JSON.parse(await readFile(path.join(directory, 'node_modules', pkg.name, 'package.json'), 'utf8'))
    assert.equal(value.version, pkg.version)
    assert.equal(value.repoctlSnapshot.identityKey, report.snapshot.identityKey)
  }
  const fromCLI = createRequire(await realpath(path.join(directory, 'node_modules/iconctl/package.json')))
  const thirdPartyPath = fromCLI.resolve('repoctl-nightly-age-fixture/package.json')
  assert.equal(JSON.parse(await readFile(thirdPartyPath, 'utf8')).version, '1.0.0', 'Third-party recent releases must remain age protected')
  const transitiveCore = createRequire(thirdPartyPath).resolve('@iconctl/core/package.json')
  assert.equal(JSON.parse(await readFile(transitiveCore, 'utf8')).version, '9.0.0', 'The batch exception must not exempt other versions of the same package')
}

test('real pnpm 12.6 respects exact nightly exceptions and refreshes retry metadata', { timeout: 90_000 }, async (t) => {
  const api = loadConsumer()
  const previous = publication(api, '1'.repeat(40), 'nightly-pnpm-old')
  const current = publication(api, '2'.repeat(40), 'nightly-pnpm-current')
  const reportFor = () => structuredClone({
    provider: 'npm',
    confirmed: true,
    snapshot: { identity: current.identity, identityKey: current.identityKey, tag: current.tag },
    packages: ['@iconctl/core', 'iconctl'].map(name => ({ name, version: current.version, published: true })),
  })
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'iconctl-nightly-pnpm-')))
  let registry
  try {
    registry = await startRegistry(catalogFor(previous, current))
    await t.test('recent dist-tag requires an exception under the native default age policy', async () => {
      registry.setPhase(1)
      const report = reportFor()
      report.packages = report.packages.filter(pkg => pkg.name === 'iconctl')
      const directory = await createConsumer(root, 'default-age', api, report)
      await writeFile(path.join(directory, 'pnpm-workspace.yaml'), `${JSON.stringify({ packages: [], cacheDir: path.join(directory, 'cache') })}\n`)
      const { run } = consumerRun(api, directory, registry)
      assert.equal(await run('pnpm', [...api.consumerPnpmOptions, '--version']), '12.6.0')
      await run('pnpm', [...api.consumerPnpmOptions, 'install', '--ignore-scripts', '--registry=https://registry.npmjs.org/', `--store-dir=${path.join(directory, 'store')}`, `--state-dir=${path.join(directory, 'state')}`])
      const installed = JSON.parse(await readFile(path.join(directory, 'node_modules/iconctl/package.json'), 'utf8'))
      assert.equal(installed.version, previous.version, 'The control must exercise native release-age fallback')
    })

    await t.test('only the exact confirmed versions bypass release age', async () => {
      registry.setPhase(1)
      const report = reportFor()
      const directory = await createConsumer(root, 'current', api, report)
      const { run, options, result } = consumerRun(api, directory, registry)
      await api.installNightlyConsumer(report, options, directory, run)
      assert.equal(result.commands.length, 1)
      assert.equal(result.commands[0].exitCode, 0)
      await assertInstalled(directory, report)
    })

    await t.test('a stale first tag refreshes metadata and cannot retain pnpm-written exceptions', async () => {
      registry.setPhase(0)
      const requestOffset = (await registry.requests()).length
      const report = reportFor()
      const directory = await createConsumer(root, 'retry', api, report)
      const expectedWorkspace = { packages: [], minimumReleaseAgeExclude: report.packages.map(pkg => `${pkg.name}@${pkg.version}`) }
      assert.deepEqual(JSON.parse(api.nightlyConsumerWorkspace(report)), expectedWorkspace)
      api.previousNightlyPublications.set(report, new Map(report.packages.map(pkg => [pkg.name, previous])))
      let installs = 0
      const { run, options, result } = consumerRun(api, directory, registry, (completed) => {
        installs += 1
        assert.equal(completed.status, 0, completed.stderr)
        if (installs === 1) {
          registry.setPhase(1)
          // Emulate mutable installer state left by a previous attempt. The next
          // production install must regenerate the exact confirmed-batch policy.
          writeFileSync(path.join(directory, 'pnpm-workspace.yaml'), `${JSON.stringify({
            ...expectedWorkspace,
            minimumReleaseAgeExclude: [...expectedWorkspace.minimumReleaseAgeExclude, 'repoctl-nightly-age-fixture@1.1.0', '@iconctl/core@9.1.0'],
          })}\n`)
        }
      })
      await api.installNightlyConsumer(report, options, directory, run)
      assert.equal(installs, 2)
      assert.deepEqual(result.commands.map(command => command.exitCode), [0, 0])
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8')), {
        ...expectedWorkspace,
        cacheDir: path.join(directory, '.pnpm-attempt-1/cache'),
      })
      await assertInstalled(directory, report)
      const requests = (await registry.requests()).slice(requestOffset)
      for (const phase of [0, 1]) {
        for (const pkg of report.packages) {
          assert.ok(requests.some(request => request.phase === phase && request.pathname === `/${pkg.name}`), `Attempt ${phase + 1} must fetch ${pkg.name} metadata from the HTTP registry`)
        }
      }
      t.diagnostic(`pnpm 12.6.0 performed ${requests.filter(request => !request.pathname.startsWith('/tarballs/')).length} metadata requests across two successful installs`)
    })
  }
  finally {
    try {
      await registry?.close()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

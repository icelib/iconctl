import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const mode = process.argv[2]
const compiler = process.argv[3]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
assert(compiler, 'Expected an installed TypeScript compiler path')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('iconctl'), { code: 'MODULE_NOT_FOUND' })
assert.throws(() => import.meta.resolve('iconctl'), { code: 'ERR_MODULE_NOT_FOUND' })
assert.deepEqual(Object.keys(JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')).dependencies), ['@iconctl/core'])
const entry = mode === 'cjs' ? require.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
assert((await realpath(entry)).startsWith(join(consumer, 'node_modules')))
assert(entry.endsWith(mode === 'cjs' ? '.cjs' : '.mjs'))
const core = mode === 'cjs' ? require('@iconctl/core') : await import('@iconctl/core')

for (const name of ['loadConfig', 'defineConfig', 'resolveConfig', 'sync', 'IconctlError', 'IconctlSyncError', 'IconctlAbortError', 'serializeIconctlError', 'inspectFigmaAuth']) {
  assert.equal(typeof core[name], 'function', `Missing SDK export: ${name}`)
}

const exec = promisify(execFile)
const fixture = await realpath(await mkdtemp(join(consumer, `sdk-${mode}-`)))
const originalFetch = globalThis.fetch
let requests = 0
globalThis.fetch = async () => {
  requests++
  throw new Error('The core-only SDK regression must stay offline')
}

try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: mode === 'esm' ? 'module' : 'commonjs' }))
  await mkdir(join(fixture, 'raw'))
  await writeFile(join(fixture, 'raw/home.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
  const settings = `{ prefix: 'sdk-${mode}', sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'output/icons.json' } }`
  const configFile = join(fixture, 'iconctl.config.ts')
  await writeFile(configFile, `import type { IconctlConfig } from '@iconctl/core'\nexport default ${settings} satisfies IconctlConfig\n`)
  const config = await core.loadConfig({ cwd: fixture, configFile })
  assert.equal(config.prefix, `sdk-${mode}`)
  const events = []
  const result = await core.sync({ cwd: fixture, config, requestTimeoutMs: 1000, oauthTimeoutMs: 1000, onProgress: event => events.push(event) })
  assert.equal(result.complete, true)
  assert.deepEqual(Object.keys(result.json.icons), ['home'])
  assert.deepEqual(JSON.parse(await readFile(join(fixture, 'output/icons.json'), 'utf8')), JSON.parse(JSON.stringify(result.json)))
  assert.deepEqual([...new Set(events.map(event => event.stage))], ['prepare', 'source', 'process', 'validate', 'export', 'complete'])
  assert.equal(events.at(-1).complete, true)
  assert(events.every(event => Object.isFrozen(event) && Number.isFinite(Date.parse(event.timestamp))))

  // Runtime helpers in a TypeScript configuration also resolve from core alone.
  const helperConfigFile = join(fixture, 'helper.config.ts')
  await writeFile(helperConfigFile, `import { defineConfig } from '@iconctl/core'\nexport default defineConfig(${settings})\n`)
  assert.equal((await core.loadConfig({ cwd: fixture, configFile: helperConfigFile })).prefix, config.prefix)

  const secret = 'synthetic-sdk-credential'
  const error = new core.IconctlSyncError([{
    name: 'home',
    message: `Failed with token=${secret}`,
    stage: 'download',
    sourceType: 'figma',
    sourceIndex: 0,
    fileKey: 'design-file',
    nodeId: '1:2',
    code: 'FIGMA_HTTP_ERROR',
    httpStatus: 429,
    retryable: true,
    retryAfterMs: 1000,
    operation: 'figma-svg',
  }], 'SDK failure', { code: 'SYNC_FAILED', cause: new Error(`Bearer ${secret}; open '${join(fixture, 'private.json')}'\nFetch https://cdn.example/icons/home.svg?sig=azure-private-signature&code=oauth-private-code#code=fragment-private-code`) })
  const safe = core.serializeIconctlError(error, { secrets: [secret] })
  assert.equal(safe.code, 'SYNC_FAILED')
  assert.equal(safe.issues[0].httpStatus, 429)
  assert.equal(safe.issues[0].retryAfterMs, 1000)
  assert.equal(safe.issues[0].operation, 'figma-svg')
  assert.equal(safe.issues[0].nodeId, '1:2')
  assert(!JSON.stringify(safe).includes(secret))
  assert(!JSON.stringify(safe).includes(fixture))
  for (const credential of ['azure-private-signature', 'oauth-private-code', 'fragment-private-code']) {
    assert(!JSON.stringify(safe).includes(credential))
  }
  assert(safe.cause.message.includes('https://cdn.example/icons/home.svg'))
  assert.equal('stack' in safe, false)
  assert.equal('stack' in safe.cause, false)
  assert.equal(core.serializeIconctlError(new Error('x'.repeat(5000))).truncated, true)
  assert.equal(new core.IconctlAbortError().code, 'ABORT_ERR')

  const before = await readdir(fixture)
  const inspection = await core.inspectFigmaAuth({ token: secret, env: { ICONCTL_FIGMA_CREDENTIALS_FILE: join(fixture, 'absent/figma.json'), FIGMA_CLIENT_ID: 'incomplete-client' } })
  assert.equal(inspection.source, 'config-token')
  assert.equal(inspection.sources[0].selected, true)
  assert.equal(inspection.sources[0].validity, 'unknown')
  assert.equal(inspection.sources[2].error.code, 'INCOMPLETE_FIGMA_OAUTH')
  assert(!JSON.stringify(inspection).includes(secret))
  assert(!JSON.stringify(inspection).includes(fixture))
  assert.deepEqual(await readdir(fixture), before)
  assert.equal(requests, 0)

  const probe = join(fixture, `consumer.${mode === 'esm' ? 'mts' : 'cts'}`)
  await writeFile(probe, `import {
  IconctlError, IconctlSyncError, inspectFigmaAuth, serializeIconctlError, sync, resolveConfig,
  type IconctlErrorOptions, type SerializedIconctlError, type SerializeIconctlErrorOptions, type SyncIssue,
  type RequestOptions, type FigmaAuthOptions, type SyncOptions, type SyncProgressEvent, type SyncProgressHandler, type SyncProgressStage,
  type FigmaAuthInspection, type FigmaAuthSource, type FigmaAuthSourceInspection, type InspectFigmaAuthOptions,
} from '@iconctl/core'
const request: RequestOptions = { requestTimeoutMs: 1000, oauthTimeoutMs: 1000 }
const auth: FigmaAuthOptions = { ...request, signal: new AbortController().signal }
const errorOptions: IconctlErrorOptions = { code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 1000, sourceType: 'figma', sourceIndex: 0, operation: 'figma-svg', cause: new Error('cause') }
const error = new IconctlError('failure', errorOptions)
error.sourceIndex ??= 0
const issue: SyncIssue = { name: 'home', message: 'retry', stage: 'download', ...errorOptions, fileKey: 'design-file', nodeId: '1:2' }
const failure = new IconctlSyncError([issue], 'sync failed', errorOptions)
const serialization: SerializeIconctlErrorOptions = { secrets: ['secret'] as const }
const safe: SerializedIconctlError = serializeIconctlError(failure, serialization)
const onProgress: SyncProgressHandler = (event: SyncProgressEvent) => { const stage: SyncProgressStage = event.stage; void stage }
const options: SyncOptions = { ...auth, config: resolveConfig(${settings}), onProgress }
const running = sync(options)
const inspectOptions: InspectFigmaAuthOptions = { ...auth, token: 'secret', verify: false, env: {}, file: 'design-file' }
const inspection: Promise<FigmaAuthInspection> = inspectFigmaAuth(inspectOptions)
const source: FigmaAuthSource = 'config-token'
const entry: FigmaAuthSourceInspection = { source, configured: true, selected: true, validity: 'unknown', expiresAt: null, error: safe }
// @ts-expect-error Request deadlines accept numbers only.
const invalidRequest: RequestOptions = { requestTimeoutMs: '1000' }
// @ts-expect-error Progress stages are a closed union.
const invalidStage: SyncProgressStage = 'headers'
// @ts-expect-error Public diagnostics do not expose a stack.
safe.stack
void running; void inspection; void entry; void invalidRequest; void invalidStage
`)
  try {
    await exec(process.execPath, [compiler, '--module', 'nodenext', '--target', 'es2022', '--strict', '--noEmit', '--skipLibCheck', probe, configFile, helperConfigFile], { cwd: fixture, timeout: 20000 })
  }
  catch (error) {
    throw new Error(`Core-only SDK TypeScript failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error })
  }
  console.log(JSON.stringify({ scenario: 'core-only-sdk', mode, runtime: process.version, cliAbsent: true, typescriptConfig: true, runtimeConfigHelper: true, directorySync: true, progress: true, safeErrors: true, offlineInspection: true, types: true, passed: true }))
}
finally {
  globalThis.fetch = originalFetch
  await rm(fixture, { recursive: true, force: true })
}

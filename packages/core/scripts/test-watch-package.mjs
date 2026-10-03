import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'tsdown'

const exec = promisify(execFile)
const core = fileURLToPath(new URL('..', import.meta.url))
const cli = resolve(core, '../../apps/cli')
const node = process.argv[2] ?? process.execPath
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-pack-watch-')))
const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.NODE_PATH
async function run(command, args, cwd) {
  try {
    return await exec(command, args, { cwd, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  }
  catch (error) {
    throw new Error(`${command} ${args.join(' ')}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error })
  }
}
async function pack(directory, destination) {
  await mkdir(destination, { recursive: true })
  await run('pnpm', ['pack', '--pack-destination', destination], directory)
  const files = (await readdir(destination)).filter(file => file.endsWith('.tgz'))
  assert.equal(files.length, 1)
  return join(destination, files[0])
}
async function install(name, packages) {
  const consumer = join(fixture, name)
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, name: `consumer-${name}`, version: '0.0.0' }))
  await writeFile(join(consumer, 'empty.npmrc'), '')
  await writeFile(join(consumer, 'global.npmrc'), '')
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--userconfig', join(consumer, 'empty.npmrc'), '--globalconfig', join(consumer, 'global.npmrc'), ...packages], consumer)
  assert.equal((await readFile(join(consumer, 'package.json'), 'utf8')).includes('patchedDependencies'), false)
  for (const file of ['watch-consumer.mjs', 'watch-consumer-preload.mjs', 'figma-consumer.mjs', 'config-watch-consumer.mjs']) {
    await copyFile(join(core, 'scripts', file), join(consumer, file))
  }
  return consumer
}
async function check(consumer, mode, scenario) {
  const result = await run(node, [join(consumer, 'watch-consumer.mjs'), consumer, mode, scenario], consumer)
  process.stdout.write(result.stdout)
}
try {
  // Actual package-manager artifacts, including publishConfig and files filtering.
  const coreTarball = await pack(core, join(fixture, 'core-package'))
  const cliTarball = await pack(cli, join(fixture, 'cli-package'))
  const consumer = await install('fixed', [coreTarball, cliTarball])
  const typeProbe = `import { watch, IconctlAbortError, type WatchEvent } from '@iconctl/core'
import { requestFigmaToken } from '@iconctl/core/figma/oauth'
const event: WatchEvent = { type: 'stopped', reason: 'aborted' }
void watch; void IconctlAbortError; void event; void requestFigmaToken
`
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), typeProbe)
  }
  await run(node, [resolve(core, '../../node_modules/typescript/bin/tsc'), '--module', 'nodenext', '--target', 'es2022', '--noEmit', '--skipLibCheck', 'consumer.mts', 'consumer.cts'], consumer)
  const installedCore = join(consumer, 'node_modules/@iconctl/core')
  assert((await readFile(join(installedCore, 'THIRD_PARTY_NOTICES'), 'utf8')).includes('Thorsten Lorenz'))
  const cliManifest = JSON.parse(await readFile(join(consumer, 'node_modules/iconctl/package.json'), 'utf8'))
  assert.equal(cliManifest.bin.iconctl, './bin/index.js')
  for (const mode of ['esm', 'cjs']) {
    for (const scenario of ['healthy', 'startup', 'handover', 'cancel']) {
      await check(consumer, mode, scenario)
    }
    const figma = await run(node, [join(consumer, 'figma-consumer.mjs'), mode], consumer)
    process.stdout.write(figma.stdout)
    const configuration = await run(node, [join(consumer, 'config-watch-consumer.mjs'), mode], consumer)
    process.stdout.write(configuration.stdout)
  }
  await check(consumer, 'bin', 'startup')
  const evaluated = await run(node, ['--input-type=module', '--eval', `
    const { fileURLToPath } = await import('node:url')
    process.argv = [process.execPath, fileURLToPath(new URL('./watch-consumer.mjs', import.meta.url)), ${JSON.stringify(consumer)}, 'esm', 'healthy']
    await import('./watch-consumer.mjs')
    console.log(JSON.stringify({ scenario: 'eval-entry', runtime: process.version, passed: true }))
  `], consumer)
  process.stdout.write(evaluated.stdout)

  // Control: workspace patch alone, with the original external dependency boundary.
  const comparison = join(fixture, 'patch-only-package')
  await mkdir(comparison)
  await copyFile(join(core, 'package.json'), join(comparison, 'package.json'))
  await copyFile(join(core, 'THIRD_PARTY_NOTICES'), join(comparison, 'THIRD_PARTY_NOTICES'))
  await build({ cwd: core, config: join(core, 'tsdown.config.ts'), outDir: join(comparison, 'dist'), dts: false, logLevel: 'error', deps: { alwaysBundle: [], onlyBundle: [] } })
  const unpatched = await install('patch-only', [await pack(comparison, join(fixture, 'comparison-package'))])
  for (const mode of ['esm', 'cjs']) {
    await check(unpatched, mode, 'unpatched')
  }
}
finally {
  await rm(fixture, { recursive: true, force: true })
}

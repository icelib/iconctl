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
  for (const file of ['watch-consumer.mjs', 'watch-consumer-preload.mjs', 'figma-consumer.mjs', 'config-watch-consumer.mjs', 'sprite-consumer.mjs', 'preview-consumer.mjs', 'init-consumer.mjs', 'standalone-sprite-consumer.mjs', 'types-consumer.mjs']) {
    await copyFile(join(core, 'scripts', file), join(consumer, file))
  }
  await copyFile(join(core, 'test/fixtures/standalone-sprite.json'), join(consumer, 'standalone-sprite.json'))
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
  const typeProbe = `import { watch, IconctlAbortError, defineConfig, resolveConfig, exportOutputs, sync, type IconctlOutputConfig, type SyncResult, type WatchEvent } from '@iconctl/core'
import { renderIconNameTypes, writeIconNameTypes, type IconNameTypesSummary, type WriteIconNameTypesOptions } from '@iconctl/core'
import { renderIconNameTypes as renderTypes, writeIconNameTypes as writeTypes, type IconNameTypesSummary as TypesSummary, type WriteIconNameTypesOptions as TypesOptions } from 'iconctl'
const typesOptions: WriteIconNameTypesOptions = { inputs: ['icons.json'] as const, dryRun: true }
const facadeTypesOptions: TypesOptions = typesOptions
const typesJson = { prefix: 'brand', icons: {} }
const typesSource: string = renderIconNameTypes(typesJson)
const facadeTypesSource: string = renderTypes(typesJson)
const typesWritten: Promise<IconNameTypesSummary> = writeIconNameTypes('icons.d.ts', typesJson, typesOptions)
const facadeTypesWritten: Promise<TypesSummary> = writeTypes('icons.ts', typesJson, facadeTypesOptions)
// @ts-expect-error Type output input protection requires file paths in an array.
const invalidTypes: WriteIconNameTypesOptions = { inputs: 'icons.json' }
// @ts-expect-error Type output dry-run must be boolean.
const invalidFacadeTypes: TypesOptions = { dryRun: 'true' }
void typesSource; void facadeTypesSource; void typesWritten; void facadeTypesWritten; void invalidTypes; void invalidFacadeTypes
import { requestFigmaToken } from '@iconctl/core/figma/oauth'
import { renderPreviewHtml, writePreviewHtml, type WritePreviewHtmlOptions } from '@iconctl/core'
import { renderPreviewHtml as renderPreview, writePreviewHtml as writePreview, type WritePreviewHtmlOptions as PreviewOptions } from 'iconctl'
import { renderSvgSprite, writeSvgSprite, type SvgSpriteSummary, type WriteSvgSpriteOptions } from '@iconctl/core'
import { renderSvgSprite as renderSprite, writeSvgSprite as writeSprite, type SvgSpriteSummary as SpriteSummary, type WriteSvgSpriteOptions as SpriteOptions } from 'iconctl'
const spriteOptions: WriteSvgSpriteOptions = { inputs: ['icons.json'] as const, dryRun: true }
const spriteFacadeOptions: SpriteOptions = spriteOptions
const spriteJson = { prefix: 'brand', icons: {} }
const svg: Promise<string> = renderSvgSprite(spriteJson)
const facadeSvg: Promise<string> = renderSprite(spriteJson)
const spriteWriter: Promise<SvgSpriteSummary> = writeSvgSprite('icons.svg', spriteJson)
const facadeSpriteWriter: Promise<SpriteSummary> = writeSprite('icons.svg', spriteJson, spriteFacadeOptions)
// @ts-expect-error Sprite input protection requires an array of file paths.
const invalidSprite: WriteSvgSpriteOptions = { inputs: 'icons.json' }
// @ts-expect-error Sprite dryRun is boolean.
const invalidSpriteFacade: SpriteOptions = { dryRun: 'true' }
void svg; void facadeSvg; void spriteWriter; void facadeSpriteWriter; void invalidSprite; void invalidSpriteFacade
const previewOptions: WritePreviewHtmlOptions = { inputs: ['icons.json'] as const, dryRun: true }
const facadeOptions: PreviewOptions = previewOptions
const json = { prefix: 'brand', icons: {} }
const rendered: string = renderPreviewHtml(json)
const facadeRendered: string = renderPreview(json)
const originalWriter: Promise<void> = writePreviewHtml('preview.html', json)
const writer: Promise<void> = writePreviewHtml('preview.html', json, previewOptions)
const facadeWriter: Promise<void> = writePreview('preview.html', json, facadeOptions)
// @ts-expect-error Input protection accepts an array of file paths.
const invalidPreview: WritePreviewHtmlOptions = { inputs: 'icons.json' }
void rendered; void facadeRendered; void originalWriter; void writer; void facadeWriter; void invalidPreview
const event: WatchEvent = { type: 'stopped', reason: 'aborted' }
const output: IconctlOutputConfig = { sprite: 'sprite.svg' }
const config = resolveConfig(defineConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }], output }))
const sprite: string | undefined = config.output.sprite
const synced: Promise<SyncResult> = sync({ config, dryRun: true })
// @ts-expect-error Sprite output must be a path rather than a boolean.
const invalid: IconctlOutputConfig = { sprite: true }
void watch; void IconctlAbortError; void event; void requestFigmaToken; void exportOutputs; void sprite; void synced; void invalid
`
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), typeProbe)
  }
  await run(node, [resolve(core, '../../node_modules/typescript/bin/tsc'), '--module', 'nodenext', '--target', 'es2022', '--noEmit', '--skipLibCheck', 'consumer.mts', 'consumer.cts'], consumer)
  const installedCore = join(consumer, 'node_modules/@iconctl/core')
  assert((await readFile(join(installedCore, 'THIRD_PARTY_NOTICES'), 'utf8')).includes('Thorsten Lorenz'))
  const cliManifest = JSON.parse(await readFile(join(consumer, 'node_modules/iconctl/package.json'), 'utf8'))
  assert.equal(cliManifest.bin.iconctl, './bin/index.js')
  const installedCliFiles = await readdir(join(consumer, 'node_modules/iconctl'))
  assert(!installedCliFiles.includes('src'))
  assert(!installedCliFiles.includes('dev'))
  await writeFile(join(consumer, 'version-esm.mjs'), `import { runCli } from 'iconctl'; await runCli(process.argv)`)
  await writeFile(join(consumer, 'version-cjs.cjs'), `const { runCli } = require('iconctl'); runCli(process.argv).catch(() => { process.exitCode ||= 1 })`)
  const versionCwd = join(consumer, 'version-cwd')
  await mkdir(versionCwd)
  const runtime = (await run(node, ['--version'], versionCwd)).stdout.trim()
  for (const [mode, entry] of [
    ['bin', join(consumer, 'node_modules/iconctl/bin/index.js')],
    ['esm', join(consumer, 'version-esm.mjs')],
    ['cjs', join(consumer, 'version-cjs.cjs')],
  ]) {
    for (const flag of ['--version', '-v']) {
      const result = await exec(node, [entry, flag], { cwd: versionCwd, env: { ...env, npm_package_version: 'unrelated-consumer' }, timeout: 10000 })
      assert.equal(result.stderr, '')
      assert.equal(result.stdout.trim(), `iconctl/${cliManifest.version} ${process.platform}-${process.arch} node-${runtime}`)
    }
    process.stdout.write(`${JSON.stringify({ scenario: 'installed-cli-version', mode, version: cliManifest.version, runtime, passed: true })}\n`)
  }
  for (const mode of ['esm', 'cjs']) {
    for (const scenario of ['healthy', 'startup', 'handover', 'cancel']) {
      await check(consumer, mode, scenario)
    }
    const figma = await run(node, [join(consumer, 'figma-consumer.mjs'), mode], consumer)
    process.stdout.write(figma.stdout)
    const configuration = await run(node, [join(consumer, 'config-watch-consumer.mjs'), mode], consumer)
    process.stdout.write(configuration.stdout)
    const sprite = await run(node, [join(consumer, 'sprite-consumer.mjs'), mode], consumer)
    process.stdout.write(sprite.stdout)
    const types = await run(node, [join(consumer, 'types-consumer.mjs'), mode, resolve(core, '../../node_modules/typescript/bin/tsc')], consumer)
    process.stdout.write(types.stdout)
    const standalone = await run(node, [join(consumer, 'standalone-sprite-consumer.mjs'), mode], consumer)
    process.stdout.write(standalone.stdout)
    const preview = await run(node, [join(consumer, 'preview-consumer.mjs'), mode], consumer)
    process.stdout.write(preview.stdout)
    const initialized = await run(node, [join(consumer, 'init-consumer.mjs'), mode], consumer)
    process.stdout.write(initialized.stdout)
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

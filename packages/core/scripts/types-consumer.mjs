import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const mode = process.argv[2]
const compiler = process.argv[3]
assert(['esm', 'cjs'].includes(mode), 'Expected the consumer mode: esm or cjs')
assert(compiler, 'Expected an installed TypeScript compiler path')
const consumer = await realpath(fileURLToPath(new URL('.', import.meta.url)))
const require = createRequire(import.meta.url)
const coreEntry = mode === 'cjs' ? require.resolve('@iconctl/core') : fileURLToPath(import.meta.resolve('@iconctl/core'))
assert((await realpath(coreEntry)).startsWith(join(consumer, 'node_modules')))
const core = mode === 'cjs' ? require('@iconctl/core') : await import('@iconctl/core')
const cli = mode === 'cjs' ? require('iconctl') : await import('iconctl')

const exec = promisify(execFile)
const fixture = await realpath(await mkdtemp(join(consumer, 'types-')))
const cases = [
  { kind: 'generator', prefix: 'brand', names: ['home', 'rotated'] },
  { kind: 'escaped', prefix: 'brand\'\\\n\u2028\u2029', names: ['folder/home', 'alias\'\\\n', 'line\u2028\u2029separator'] },
  { kind: 'empty', prefix: 'empty', names: [] },
  { kind: 'core-sync', prefix: 'brand', names: ['home', 'rotated'], api: core },
  { kind: 'cli-sync', prefix: 'brand', names: ['home', 'rotated'], api: cli },
  { kind: 'standalone-render', prefix: 'brand', names: ['hidden', 'home', 'rotated'], typesApi: core },
  { kind: 'standalone-write', prefix: 'brand', names: ['hidden', 'home', 'rotated'], typesApi: cli, write: true },
  { kind: 'standalone-escaped', prefix: 'brand\'\\\n\u2028\u2029', names: ['folder/home', 'alias\'\\\n', 'line\u2028\u2029separator'], typesApi: core, write: true },
  { kind: 'standalone-empty', prefix: 'empty', names: [], typesApi: cli },
]

try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const files = []
  const runtime = []
  for (const item of cases) {
    for (const extension of ['d.ts', 'ts']) {
      const cwd = join(fixture, `${item.kind}-${extension}`)
      await mkdir(cwd)
      const output = join(cwd, `icons.${extension}`)
      if (item.typesApi) {
        const json = item.prefix === 'brand'
          ? { prefix: item.prefix, icons: { home: { body: '<path/>' }, hidden: { body: '<path/>', hidden: true } }, aliases: { rotated: { parent: 'home', rotate: 1 } } }
          : { prefix: item.prefix, icons: Object.fromEntries(item.names.map(name => [name, { body: 'not XML' }])) }
        if (item.write) {
          assert.deepEqual(await item.typesApi.writeIconNameTypes(output, json), { prefix: item.prefix, count: item.names.length })
          assert.equal(await readFile(output, 'utf8'), item.typesApi.renderIconNameTypes(json))
        }
        else {
          await writeFile(output, item.typesApi.renderIconNameTypes(json))
        }
      }
      else if (item.api) {
        await writeFile(join(cwd, 'input.json'), JSON.stringify({
          prefix: 'vendor',
          icons: { home: { body: '<path d="M0 0h16v16H0z"/>' } },
          aliases: { rotated: { parent: 'home', rotate: 1 } },
        }))
        const config = item.api.resolveConfig({ prefix: item.prefix, sources: [{ type: 'iconify', file: 'input.json' }], output: { json: 'icons.json', types: `icons.${extension}` } })
        const result = await item.api.sync({ cwd, config })
        assert.equal(result.complete, true)
        assert.equal(result.processed, 2)
        assert(result.files.includes(output))
        assert.equal(await readFile(output, 'utf8'), item.api.renderIconNameTypes(result.json))
      }
      else {
        await writeFile(output, core.generateIconNameTypes(item.prefix, item.names))
      }
      const source = join(cwd, 'consumer.ts')
      await writeFile(source, `import { ICONIFY_PREFIX } from './icons.js'
import type { IconName } from './icons.js'
const prefix: ${JSON.stringify(item.prefix)} = ICONIFY_PREFIX
const names: IconName[] = ${JSON.stringify(item.names)}
// @ts-expect-error The prefix keeps its exact literal type.
const wrongPrefix: typeof ICONIFY_PREFIX = 'not-the-prefix'
// @ts-expect-error Unknown names stay rejected, including for an empty set.
const missing: IconName = '__not_an_icon__'
void prefix; void names; void wrongPrefix; void missing
`)
      if (!item.names.length) {
        assert((await readFile(output, 'utf8')).includes('export type IconName = never'))
      }
      files.push(output, source)
      if (extension === 'ts') {
        runtime.push({ file: output, prefix: item.prefix })
      }
    }
  }
  await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [] },
    files,
  }))
  try {
    await exec(process.execPath, [compiler, '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false'], { cwd: fixture, timeout: 20000 })
  }
  catch (error) {
    throw new Error(`Generated TypeScript failed consumer compilation:\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error })
  }
  for (const item of runtime) {
    const script = `const { ICONIFY_PREFIX } = await import(${JSON.stringify(pathToFileURL(item.file).href)}); process.stdout.write(JSON.stringify(ICONIFY_PREFIX))`
    const result = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], { cwd: fixture, timeout: 10000 })
    assert.equal(JSON.parse(result.stdout), item.prefix)
  }
  const cwd = join(fixture, 'standalone-cli')
  await mkdir(cwd)
  const input = join(cwd, 'collection.json')
  const output = join(cwd, 'icons.d.ts')
  const json = { prefix: 'brand', icons: { home: { body: 'not XML' }, hidden: { body: '', hidden: true } }, aliases: { alias: { parent: 'home' } } }
  const bytes = `\uFEFF${JSON.stringify(json)}`
  await writeFile(input, bytes)
  await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("types must not execute configuration")')
  const bin = join(consumer, 'node_modules/iconctl/bin/index.js')
  const run = args => exec(process.execPath, [bin, 'types', ...args, '--json'], { cwd, timeout: 10000 })
  const dry = await run(['--input', input, '--output', 'new/types.ts', '--dry-run'])
  assert.deepEqual(JSON.parse(dry.stdout), { input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [], dryRun: true })
  assert.deepEqual(await readdir(cwd), ['collection.json', 'iconctl.config.mjs'])
  assert.deepEqual(await cli.writeIconNameTypes(join(cwd, 'new/types.ts'), json, { inputs: [input], dryRun: true }), { prefix: 'brand', count: 3 })
  assert.deepEqual(await readdir(cwd), ['collection.json', 'iconctl.config.mjs'])
  const written = await run(['--input', input])
  assert.deepEqual(JSON.parse(written.stdout), { input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [output] })
  assert.equal(await readFile(output, 'utf8'), core.renderIconNameTypes(json))
  await link(input, join(cwd, 'hardlink.ts'))
  await assert.rejects(core.writeIconNameTypes(join(cwd, 'hardlink.ts'), json, { inputs: [input] }), /conflicts with input/)
  await assert.rejects(run(['--input', input, '--output', input]), (error) => {
    assert.equal(error.code, 1)
    assert.equal(error.stderr, '')
    const failure = JSON.parse(error.stdout)
    assert.equal(failure.command, 'types')
    assert.equal(failure.error.phase, 'execution')
    return true
  })
  assert.equal(await readFile(input, 'utf8'), bytes)
  await writeFile(input, JSON.stringify({ ...json, aliases: { bad: { parent: 'missing' } } }))
  await assert.rejects(run(['--input', input]), error => error.code === 1 && JSON.parse(error.stdout).error.phase === 'execution')
  assert.equal(await readFile(output, 'utf8'), core.renderIconNameTypes(json))
  assert.deepEqual(await readdir(cwd), ['collection.json', 'hardlink.ts', 'iconctl.config.mjs', 'icons.d.ts'])
  console.log(JSON.stringify({ mode, runtime: process.version, scenario: 'generated-type-consumers', cases: cases.map(item => item.kind), declarationAndSourceModules: cases.length * 2, skipLibCheck: false, runtimeModules: runtime.length, standaloneCli: true, inputProtection: true, passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}

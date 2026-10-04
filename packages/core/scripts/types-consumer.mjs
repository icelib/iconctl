import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
      if (item.api) {
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
  console.log(JSON.stringify({ mode, runtime: process.version, scenario: 'generated-type-consumers', cases: cases.map(item => item.kind), declarationAndSourceModules: cases.length * 2, skipLibCheck: false, runtimeModules: runtime.length, passed: true }))
}
finally {
  await rm(fixture, { recursive: true, force: true })
}

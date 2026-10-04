import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { generateIconNameTypes, renderIconNameTypes, resolveConfig, sync, writeIconNameTypes } from '../src'

const exec = promisify(execFile)
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc')
let cwd: string

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-type-output-')))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

it('compiles generated declarations and source modules with exact literal types and runs the source modules', async () => {
  const files: string[] = []
  const runtime: { file: string, prefix: string }[] = []
  const cases = [
    { kind: 'generator', prefix: 'brand', names: ['home', 'rotated'] },
    { kind: 'escaped', prefix: 'brand\'\\\n\u2028\u2029', names: ['folder/home', 'alias\'\\\n', 'line\u2028\u2029separator'] },
    { kind: 'empty', prefix: 'empty', names: [] },
    { kind: 'sync', prefix: 'brand', names: ['home', 'rotated'] },
    { kind: 'standalone', prefix: 'brand', names: ['hidden', 'home', 'rotated'] },
    { kind: 'standalone-escaped', prefix: 'brand\'\\\n\u2028\u2029', names: ['folder/home', 'alias\'\\\n', 'line\u2028\u2029separator'] },
    { kind: 'standalone-empty', prefix: 'empty', names: [] },
  ]
  for (const item of cases) {
    for (const extension of ['d.ts', 'ts']) {
      const directory = join(cwd, `${item.kind}-${extension}`)
      await mkdir(directory)
      const filename = `icons.${extension}`
      const output = join(directory, filename)
      if (item.kind === 'sync') {
        await writeFile(join(directory, 'input.json'), JSON.stringify({
          prefix: 'vendor',
          icons: { home: { body: '<path d="M0 0h16v16H0z"/>' } },
          aliases: { rotated: { parent: 'home', rotate: 1 } },
        }))
        const config = resolveConfig({ prefix: item.prefix, sources: [{ type: 'iconify', file: 'input.json' }], output: { json: 'icons.json', types: filename } })
        expect(await sync({ cwd: directory, config })).toMatchObject({ complete: true, processed: 2 })
      }
      else if (item.kind.startsWith('standalone')) {
        const json = item.kind === 'standalone'
          ? { prefix: item.prefix, icons: { home: { body: '<path/>' }, hidden: { body: '<path/>', hidden: true } }, aliases: { rotated: { parent: 'home', rotate: 1 } } }
          : { prefix: item.prefix, icons: Object.fromEntries(item.names.map(name => [name, { body: 'not XML' }])) }
        expect(await writeIconNameTypes(output, json)).toEqual({ prefix: item.prefix, count: item.names.length })
        expect(await readFile(output, 'utf8')).toBe(renderIconNameTypes(json))
      }
      else {
        await writeFile(output, generateIconNameTypes(item.prefix, item.names))
      }
      const consumer = join(directory, 'consumer.ts')
      await writeFile(consumer, `import { ICONIFY_PREFIX } from './icons.js'
import type { IconName } from './icons.js'
const prefix: ${JSON.stringify(item.prefix)} = ICONIFY_PREFIX
const names: IconName[] = ${JSON.stringify(item.names)}
// @ts-expect-error The prefix remains its exact literal type.
const wrongPrefix: typeof ICONIFY_PREFIX = 'not-the-prefix'
// @ts-expect-error Unknown names stay rejected, including for an empty set.
const missing: IconName = '__not_an_icon__'
void prefix; void names; void wrongPrefix; void missing
`)
      if (!item.names.length) {
        expect(await readFile(output, 'utf8')).toContain('export type IconName = never')
      }
      files.push(output, consumer)
      if (extension === 'ts') {
        runtime.push({ file: output, prefix: item.prefix })
      }
    }
  }
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: [] },
    files,
  }))
  try {
    await exec(process.execPath, [compiler, '--project', join(cwd, 'tsconfig.json'), '--pretty', 'false'], { cwd, timeout: 20000 })
  }
  catch (error) {
    const failure = error as Error & { stdout?: string, stderr?: string }
    throw new Error(`Generated TypeScript failed consumer compilation:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`, { cause: error })
  }
  for (const item of runtime) {
    const script = `const { ICONIFY_PREFIX } = await import(${JSON.stringify(pathToFileURL(item.file).href)}); process.stdout.write(JSON.stringify(ICONIFY_PREFIX))`
    const result = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], { cwd, timeout: 10000 })
    expect(JSON.parse(result.stdout)).toBe(item.prefix)
  }
}, 30000)

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const core = fileURLToPath(new URL('..', import.meta.url))
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-pack-naming-')))
const consumer = join(fixture, 'consumer')
const installed = join(consumer, 'node_modules/@iconctl/core')
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

async function assertLocalGraph(file, visited = new Set()) {
  if (visited.has(file)) {
    return visited
  }
  visited.add(file)
  const source = await readFile(file, 'utf8')
  // Check both the public entries and any shared chunks/declarations they load.
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
    assert(match[1].startsWith('./'), `${file} imports a non-local dependency: ${match[1]}`)
    await assertLocalGraph(resolve(dirname(file), match[1]), visited)
  }
  return visited
}

try {
  const packed = join(fixture, 'packed')
  await mkdir(packed)
  await run('pnpm', ['pack', '--pack-destination', packed], core)
  const tarballs = (await readdir(packed)).filter(file => file.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  await mkdir(installed, { recursive: true })
  // Deliberately install no dependencies: naming must work by itself in configs.
  await run('tar', ['-xf', join(packed, tarballs[0]), '--strip-components=1', '-C', installed], consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./naming'].import.types, './dist/naming.d.mts')
  assert.equal(manifest.exports['./naming'].require.types, './dist/naming.d.cts')
  for (const entry of ['naming.mjs', 'naming.cjs', 'naming.d.mts', 'naming.d.cts']) {
    await assertLocalGraph(join(installed, 'dist', entry))
  }

  const assertions = `
const node = { id: '34:1698', name: 'Bell', type: 'COMPONENT', parents: [] }
if (toIconName('XMLHttpRequest') !== 'xmlhttp-request') throw new Error('Normalization changed')
if (defaultIconNameForNode(node) !== 'bell') throw new Error('Default naming failed')
if (!shouldSkipName('_hidden')) throw new Error('Default filtering failed')
`
  await writeFile(join(consumer, 'consumer.mjs'), `import { toIconName, defaultIconNameForNode, shouldSkipName } from '@iconctl/core/naming'\n${assertions}`)
  await writeFile(join(consumer, 'consumer.cjs'), `const { toIconName, defaultIconNameForNode, shouldSkipName } = require('@iconctl/core/naming')\n${assertions}`)
  for (const extension of ['mjs', 'cjs']) {
    await run(process.execPath, [`consumer.${extension}`], consumer)
  }

  const types = `import { defaultIconNameForNode, toIconName, shouldSkipName,
  type FigmaNamingNode, type FigmaNamingParentNode, type FigmaNameTransform, type FigmaNamingOptions, type IconNameOptions } from '@iconctl/core/naming'
const parent: FigmaNamingParentNode = { id: '1:1', name: 'Icons', type: 'CANVAS' }
const node: FigmaNamingNode = { id: '34:1698', name: 'Bell', type: 'COMPONENT', parents: [parent] as const }
const transform: FigmaNameTransform = (name, current) => current.name ? name : null
const options: FigmaNamingOptions = { duplicates: 'suffix-node-id', preserveNames: true, namespace: 'system', transform }
const filters: IconNameOptions = { skipPrefix: ['_'] }
const name: string | null = defaultIconNameForNode(node, filters)
const normalized: string = toIconName('HTTPServer')
const skipped: boolean = shouldSkipName('_hidden')
// @ts-expect-error Unknown duplicate strategies are rejected.
const invalid: FigmaNamingOptions = { duplicates: 'skip' }
// @ts-expect-error A transform must explicitly return a string or null.
const invalidTransform: FigmaNameTransform = () => undefined
void options; void name; void normalized; void skipped; void invalid; void invalidTransform
`
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(consumer, `consumer.${extension}`), types)
  }
  await run(process.execPath, [resolve(core, '../../node_modules/typescript/bin/tsc'), '--module', 'nodenext', '--target', 'es2022', '--strict', '--noEmit', 'consumer.mts', 'consumer.cts'], consumer)
  process.stdout.write(`${JSON.stringify({ scenario: 'packed-naming-without-dependencies', esm: true, cjs: true, types: true, localDependencyGraph: true, passed: true })}\n`)
}
finally {
  await rm(fixture, { recursive: true, force: true })
}

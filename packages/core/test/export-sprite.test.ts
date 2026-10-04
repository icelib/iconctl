import type { IconctlOutputConfig } from '../src'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconSet } from '@iconify/tools'
import { exportOutputs, resolveConfig, sync } from '../src'
import { generateIconNameTypes } from '../src/export'

let cwd: string
const body = '<path fill="currentColor" d="M0 0h24v24H0z"/>'
function icons(value = body) {
  return new IconSet({ prefix: 'brand', width: 24, height: 24, icons: { home: { body: value } }, aliases: { pure: { parent: 'home' }, rotated: { parent: 'home', rotate: 1 } } })
}
function config(output: IconctlOutputConfig = {}) {
  return resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json', sprite: 'sprite.svg', types: 'icons.d.ts', ...output } })
}
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-export-sprite-')))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

it('exports a declared sprite and includes all resolvable names in types without enabling individual SVGs', async () => {
  const result = await exportOutputs(icons(), config(), { cwd })
  expect(result.files).toEqual(['icons.json', 'sprite.svg', 'icons.d.ts'].map(file => join(cwd, file)))
  expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toContain('export type IconName = \'home\' | \'pure\' | \'rotated\'')
  const sprite = await readFile(join(cwd, 'sprite.svg'), 'utf8')
  for (const name of ['home', 'pure', 'rotated']) {
    expect(sprite).toContain(`id="iconctl-brand-${name}"`)
  }
  await exportOutputs(icons(), config(), { cwd })
  expect(await readFile(join(cwd, 'sprite.svg'), 'utf8')).toBe(sprite)
  expect((await readdir(cwd)).sort()).toEqual(['icons.d.ts', 'icons.json', 'sprite.svg'])
})

it('does not apply SVG filename restrictions to a type-only export', async () => {
  const set = new IconSet({ prefix: 'brand', icons: { 'folder/home': { body } }, aliases: { 'folder/alias': { parent: 'folder/home' } } })
  const cfg = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }], output: { types: 'names.d.ts' } })
  await exportOutputs(set, cfg, { cwd })
  expect(await readFile(join(cwd, 'names.d.ts'), 'utf8')).toContain('\'folder/alias\' | \'folder/home\'')
})

it('escapes prefix and custom names as literal values in generated TypeScript', () => {
  expect(generateIconNameTypes('brand\'\\\n', ['alias\'\\\n', 'line\u2028separator'])).toBe(
    'export const ICONIFY_PREFIX = \'brand\\\'\\\\\\n\'\nexport type IconName = \'alias\\\'\\\\\\n\' | \'line\\u2028separator\'\n',
  )
})

it.each([false, true])('commits a sprite nested with SVG and JSON package outputs with clean:%s', async (clean) => {
  await mkdir(join(cwd, 'pkg/svg'), { recursive: true })
  await writeFile(join(cwd, 'pkg/README.md'), 'User documentation')
  await writeFile(join(cwd, 'pkg/package.json'), JSON.stringify({ name: '@brand/icons', version: '1.2.3', private: true, custom: 'kept' }))
  const cfg = config({ json: 'pkg/icons.json', sprite: 'pkg/svg/sprite.svg', svg: 'pkg/svg', jsonPackage: { dir: 'pkg', clean }, types: 'pkg/names.d.ts' })
  await exportOutputs(icons(), cfg, { cwd })
  expect(await readFile(join(cwd, 'pkg/svg/sprite.svg'), 'utf8')).toContain('<symbol')
  expect(await readFile(join(cwd, 'pkg/svg/pure.svg'), 'utf8')).toContain('<svg')
  expect(JSON.parse(await readFile(join(cwd, 'pkg/svg/.iconctl-manifest.json'), 'utf8')).files).toEqual(['home.svg', 'pure.svg', 'rotated.svg'])
  if (!clean) {
    expect(await readFile(join(cwd, 'pkg/README.md'), 'utf8')).toBe('User documentation')
    expect(JSON.parse(await readFile(join(cwd, 'pkg/package.json'), 'utf8'))).toMatchObject({ version: '1.2.3', private: true, custom: 'kept' })
  }
})

it('retains custom package metadata as own properties while explicit configuration and generated entry points win', async () => {
  await mkdir(join(cwd, 'pkg'))
  const existing = JSON.parse('{"custom":{"enabled":true},"constructor":"user data","__proto__":{"polluted":true},"main":"stale.js","nullable":null,"private":true}')
  await writeFile(join(cwd, 'pkg/package.json'), JSON.stringify(existing))
  const cfg = config({ jsonPackage: { dir: 'pkg', clean: false, package: { private: false, custom: { enabled: false } } } })
  await exportOutputs(icons(), cfg, { cwd })
  const pkg = JSON.parse(await readFile(join(cwd, 'pkg/package.json'), 'utf8'))
  expect(pkg).toMatchObject({ custom: { enabled: false }, constructor: 'user data', nullable: null, private: false, main: 'index.js' })
  expect(Object.hasOwn(pkg, '__proto__')).toBe(true)
  expect(Object.getOwnPropertyDescriptor(pkg, '__proto__')?.value).toEqual({ polluted: true })
  expect(Object.hasOwn(pkg, 'polluted')).toBe(false)
  expect(Object.getPrototypeOf(pkg)).toBe(Object.prototype)
})

it.each(['icons.json', 'icons.d.ts', 'svg/home.svg', 'pkg/icons.json', 'pkg/index.js'])('rejects sprite collision at %s before changing any output', async (sprite) => {
  const cfg = config({ svg: 'svg', jsonPackage: { dir: 'pkg', clean: false } })
  await exportOutputs(icons(), cfg, { cwd })
  const paths = ['icons.json', 'icons.d.ts', 'sprite.svg', 'svg/home.svg', 'pkg/icons.json', 'pkg/index.js']
  const before = await Promise.all(paths.map(file => readFile(join(cwd, file), 'utf8')))
  await expect(exportOutputs(icons(), { ...cfg, output: { ...cfg.output, sprite } }, { cwd })).rejects.toThrow('Conflicting output targets')
  expect(await Promise.all(paths.map(file => readFile(join(cwd, file), 'utf8')))).toEqual(before)
  expect((await readdir(cwd)).some(file => file.startsWith('.iconctl-stage-'))).toBe(false)
})

it('rejects a sprite target symlink without changing its destination', async () => {
  await writeFile(join(cwd, 'external.svg'), 'User-owned content')
  await symlink(join(cwd, 'external.svg'), join(cwd, 'sprite.svg'))
  await expect(exportOutputs(icons(), config(), { cwd })).rejects.toThrow('wrong file type')
  expect(await readFile(join(cwd, 'external.svg'), 'utf8')).toBe('User-owned content')
})

it('validates unsupported sprite input in dry-run without creating output directories', async () => {
  const cfg = config({ json: 'new/icons.json', sprite: 'new/sprite.svg', types: 'new/types.d.ts' })
  expect((await exportOutputs(icons(), cfg, { cwd, dryRun: true })).files).toEqual([])
  await expect(exportOutputs(icons('<use href="remote.svg#x"/>'), cfg, { cwd, dryRun: true })).rejects.toThrow('SVG sprite icon')
  expect(await readdir(cwd)).toEqual([])
})

it('keeps all existing outputs when static sprite generation is rejected', async () => {
  const cfg = config()
  await exportOutputs(icons(), cfg, { cwd })
  const paths = ['icons.json', 'sprite.svg', 'icons.d.ts']
  const before = await Promise.all(paths.map(file => readFile(join(cwd, file), 'utf8')))
  await expect(exportOutputs(icons('<path fill="url(#missing)"/>'), cfg, { cwd })).rejects.toThrow('dangling')
  expect(await Promise.all(paths.map(file => readFile(join(cwd, file), 'utf8')))).toEqual(before)
  expect((await readdir(cwd)).some(file => file.startsWith('.iconctl-stage-'))).toBe(false)
})

it('reports sprite in sync results, updates it, and respects dry-run', async () => {
  await mkdir(join(cwd, 'raw'))
  await writeFile(join(cwd, 'raw/home.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)
  const cfg = config()
  const first = await sync({ cwd, config: cfg, dryRun: true })
  expect(first.files).toEqual([])
  expect(await readdir(cwd)).toEqual(['raw'])
  const result = await sync({ cwd, config: cfg })
  expect(result.files).toContain(join(cwd, 'sprite.svg'))
  const before = await readFile(join(cwd, 'sprite.svg'), 'utf8')
  await writeFile(join(cwd, 'raw/home.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body.replace('h24', 'h12')}</svg>`)
  await sync({ cwd, config: cfg, dryRun: true })
  expect(await readFile(join(cwd, 'sprite.svg'), 'utf8')).toBe(before)
  const second = await sync({ cwd, config: cfg })
  expect(second.diff.changed).toEqual(['home'])
  expect(await readFile(join(cwd, 'sprite.svg'), 'utf8')).not.toBe(before)
})

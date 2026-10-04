import type { IconifyJSON } from '@iconify/types'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { IconSet } from '@iconify/tools'
import { exportOutputs, resolveConfig } from '../src'
import { managedOutputFiles } from '../src/export'

const roots: string[] = []
const body = '<path fill="currentColor" d="M0 0h24v24H0z"/>'
const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }], output: { json: 'icons.json', svg: 'svg' } })
function icons(...names: string[]) {
  return new IconSet({ prefix: 'brand', width: 24, height: 24, icons: Object.fromEntries(names.map(name => [name, { body }])) })
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'iconctl-export-ownership-'))
  roots.push(cwd)
  return cwd
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('lists every generated artifact without scanning directories and deduplicates shared package JSON', () => {
  const cwd = join(tmpdir(), 'not-created-iconctl-roster')
  const cfg = resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'directory', dir: 'raw' }],
    output: {
      json: 'pkg/icons.json',
      svg: 'pkg/svg',
      jsonPackage: { dir: 'pkg', clean: false },
      types: 'pkg/svg/types.ts',
      preview: 'pkg/preview.html',
      changelog: 'pkg/CHANGELOG.md',
    },
  })
  const json: IconifyJSON = {
    prefix: 'brand',
    icons: { home: { body } },
    aliases: { pure: { parent: 'home' }, flipped: { parent: 'home', hFlip: true } },
  }
  const before = JSON.stringify(json)
  const files = managedOutputFiles(cfg, json, cwd).map(file => ({ ...file, path: relative(cwd, file.path) }))
  expect(files).toEqual([
    { path: 'pkg/CHANGELOG.md', optional: true },
    ...[
      'chars.json',
      'icons.json',
      'index.d.ts',
      'index.js',
      'index.mjs',
      'info.json',
      'metadata.json',
      'package.json',
      'preview.html',
      'svg/.iconctl-manifest.json',
      'svg/flipped.svg',
      'svg/home.svg',
      'svg/pure.svg',
      'svg/types.ts',
    ].map(file => ({ path: `pkg/${file}` })),
  ])
  expect(JSON.stringify(json)).toBe(before)
})

it.each(['../escape', 'nested\\escape', 'null\0escape'])('rejects unsafe alias filenames in both roster and export: %s', async (name) => {
  const cwd = await fixture()
  const json: IconifyJSON = { prefix: 'brand', icons: { home: { body } }, aliases: { [name]: { parent: 'home' } } }
  expect(() => managedOutputFiles(config, json, cwd)).toThrow('escapes the output directory')
  await expect(exportOutputs(new IconSet(json), config, { cwd })).rejects.toThrow('escapes the output directory')
  expect(await readdir(cwd)).toEqual([])
})

it('writes pure aliases and variations into the ownership manifest and removes their unchanged retired files', async () => {
  const cwd = await fixture()
  const first = new IconSet({
    prefix: 'brand',
    icons: { home: { body } },
    aliases: { pure: { parent: 'home' }, flipped: { parent: 'home', hFlip: true } },
  })
  await exportOutputs(first, config, { cwd })
  expect(JSON.parse(await readFile(join(cwd, 'svg/.iconctl-manifest.json'), 'utf8'))).toEqual({
    version: 1,
    files: ['flipped.svg', 'home.svg', 'pure.svg'],
  })
  expect(await readFile(join(cwd, 'svg/pure.svg'), 'utf8')).toBe(first.toString('pure', { width: 'auto', height: 'auto' }))
  await exportOutputs(icons('new'), config, { cwd })
  expect((await readdir(join(cwd, 'svg'))).sort()).toEqual(['.iconctl-manifest.json', 'new.svg'])
})

it('preserves files claimed by a forged manifest when the old JSON does not own their names', async () => {
  const cwd = await fixture()
  await exportOutputs(icons('old'), config, { cwd })
  const old = await readFile(join(cwd, 'svg/old.svg'), 'utf8')
  const forged = ['manual.svg', 'constructor.svg', 'toString.svg', '__proto__.svg']
  for (const file of forged) {
    await writeFile(join(cwd, 'svg', file), old)
  }
  await writeFile(join(cwd, 'svg/.iconctl-manifest.json'), JSON.stringify({ version: 1, files: ['old.svg', ...forged] }))
  await exportOutputs(icons('new'), config, { cwd })
  for (const file of forged) {
    expect(await readFile(join(cwd, 'svg', file), 'utf8')).toBe(old)
  }
  await expect(readFile(join(cwd, 'svg/old.svg'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves edited retired SVGs but removes unchanged retired SVGs', async () => {
  const cwd = await fixture()
  await exportOutputs(icons('old', 'edited'), config, { cwd })
  await writeFile(join(cwd, 'svg/edited.svg'), 'user-maintained content')
  await exportOutputs(icons('new'), config, { cwd })
  expect(await readFile(join(cwd, 'svg/edited.svg'), 'utf8')).toBe('user-maintained content')
  await expect(readFile(join(cwd, 'svg/old.svg'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires ownership manifest membership when a valid manifest is present', async () => {
  const cwd = await fixture()
  await exportOutputs(icons('old'), config, { cwd })
  const old = await readFile(join(cwd, 'svg/old.svg'), 'utf8')
  await writeFile(join(cwd, 'svg/.iconctl-manifest.json'), JSON.stringify({ version: 1, files: [] }))
  await exportOutputs(icons('new'), config, { cwd })
  expect(await readFile(join(cwd, 'svg/old.svg'), 'utf8')).toBe(old)
})

it.each([
  undefined,
  '{broken',
  'null',
  JSON.stringify({ prefix: 'brand', icons: [] }),
  JSON.stringify({ prefix: 'brand', width: '24', icons: { old: { body } } }),
  ...['constructor', 'toString', '__proto__'].map(parent => JSON.stringify({ prefix: 'brand', icons: { old: { body } }, aliases: { forged: { parent } } })),
])('preserves old SVGs when prior JSON cannot prove ownership: %s', async (previous) => {
  const cwd = await fixture()
  await exportOutputs(icons('old'), config, { cwd })
  const old = await readFile(join(cwd, 'svg/old.svg'), 'utf8')
  if (previous === undefined) {
    await rm(join(cwd, 'icons.json'))
  }
  else {
    await writeFile(join(cwd, 'icons.json'), previous)
  }
  await exportOutputs(icons('new'), config, { cwd })
  expect(await readFile(join(cwd, 'svg/old.svg'), 'utf8')).toBe(old)
})

it.each(['{broken', JSON.stringify({ version: 1, files: ['../escape.svg'] })])('rejects malformed ownership manifests before changing outputs: %s', async (manifest) => {
  const cwd = await fixture()
  await exportOutputs(icons('old'), config, { cwd })
  const old = await readFile(join(cwd, 'svg/old.svg'), 'utf8')
  await writeFile(join(cwd, 'svg/.iconctl-manifest.json'), manifest)
  await expect(exportOutputs(icons('new'), config, { cwd })).rejects.toThrow('Invalid SVG output manifest')
  expect(await readFile(join(cwd, 'svg/old.svg'), 'utf8')).toBe(old)
  expect(await readFile(join(cwd, 'svg/.iconctl-manifest.json'), 'utf8')).toBe(manifest)
  expect((await readdir(cwd)).some(file => file.startsWith('.iconctl-stage-'))).toBe(false)
})

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconSet } from '@iconify/tools'
import { generateIconNameTypes, renderIconNameTypes, resolveConfig, sync } from '../src'

it('sorts every original name, including hidden icons and resolved alias chains, without changing input', () => {
  const json = {
    prefix: 'Brand / 雪',
    icons: { zebra: { body: 'not XML' }, 10: { body: '<path/>', hidden: true }, 2: { body: '<path/>' } },
    aliases: { alias: { parent: 'zebra', rotate: 1 }, chain: { parent: 'alias', hFlip: true } },
  }
  const before = structuredClone(json)
  expect(renderIconNameTypes(json)).toBe(generateIconNameTypes(json.prefix, ['10', '2', 'alias', 'chain', 'zebra']))
  expect(renderIconNameTypes({ ...json, icons: Object.fromEntries(Object.entries(json.icons).reverse()) })).toBe(renderIconNameTypes(json))
  expect(json).toEqual(before)
})

it('preserves escaped prefix and arbitrary literal names and accepts an empty set', () => {
  const prefix = 'brand\'\\\n\u2028\u2029'
  const names = ['folder/home', 'alias\'\\\n', 'line\u2028\u2029separator']
  const icons = Object.fromEntries(names.map(name => [name, { body: '<path/>' }]))
  expect(renderIconNameTypes({ prefix, icons })).toBe(generateIconNameTypes(prefix, names.toSorted()))
  expect(renderIconNameTypes({ prefix: 'empty', icons: {} })).toBe('export const ICONIFY_PREFIX = \'empty\'\nexport type IconName = never\n')
})

it.each([
  null,
  {},
  { prefix: 'brand', icons: [], aliases: {} },
  { prefix: 'brand', width: 0, icons: {} },
  { prefix: 'brand', icons: { broken: { body: 3 } } },
  { prefix: 'brand', icons: { broken: { body: '', rotate: 1.5 } } },
  { prefix: 'brand', icons: {}, not_found: ['missing'] },
  { prefix: 'brand', icons: {}, aliases: { missing: { parent: 'absent' } } },
  { prefix: 'brand', icons: {}, aliases: { a: { parent: 'b' }, b: { parent: 'a' } } },
])('rejects the complete invalid collection %j', (json) => {
  expect(() => renderIconNameTypes(json as Parameters<typeof renderIconNameTypes>[0])).toThrow()
})

it('matches the same processed sync collection rather than reapplying source naming or cleanup', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-types-parity-')))
  try {
    const iconSet = new IconSet({ prefix: 'brand', icons: { home: { body: '<path d="M0 0h16v16H0z"/>' }, hidden: { body: '<path d="M1 1h8v8H1z"/>', hidden: true } }, aliases: { alias: { parent: 'home' }, rotated: { parent: 'alias', rotate: 1 } } })
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'unused' }], output: { json: 'icons.json', types: 'names.ts' } })
    const result = await sync({ cwd, config, iconSet })
    expect(result.complete).toBe(true)
    expect(renderIconNameTypes(result.json)).toBe(await readFile(join(cwd, 'names.ts'), 'utf8'))
  }
  finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

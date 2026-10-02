import { IconctlError } from '../src/errors'
import { createIconifyJsonResolver, normalizeIconifyJson } from '../src/iconify-json'

const body = '<path d="M0 0h4v8H0z"/>'

it('flattens aliases and applies dimensions, rotations, flips and hidden inheritance', () => {
  const value = {
    prefix: 'vendor',
    width: 24,
    height: 32,
    icons: { base: { body, hFlip: true, hidden: true }, plain: { body } },
    aliases: {
      first: { parent: 'base', width: 20, rotate: 1 },
      second: { parent: 'first', hFlip: true, rotate: 3, hidden: false },
    },
  }
  const original = structuredClone(value)
  const { json, issues } = normalizeIconifyJson(value)
  expect(issues).toEqual([])
  expect(json.icons['second']).toEqual({ body, left: 0, top: 0, width: 20, height: 32, hidden: false })
  expect(json.icons['first']).toMatchObject({ width: 32, height: 20, hidden: true, body: expect.stringContaining('transform=') })
  expect(json.icons['plain']).toMatchObject({ width: 24, height: 32, hidden: false })
  expect(value).toEqual(original)
})

it('uses Iconify 16x16 defaults and makes full-turn rotation equivalent', () => {
  const { json } = normalizeIconifyJson({ prefix: 'vendor', icons: { base: { body }, rotated: { body, rotate: -4 } } })
  expect(json.icons['base']).toEqual({ body, left: 0, top: 0, width: 16, height: 16, hidden: false })
  expect(json.icons['rotated']).toEqual(json.icons['base'])
})

it('reports bad entries and dependent aliases while retaining valid entries', () => {
  const result = normalizeIconifyJson({
    prefix: 'vendor',
    icons: { good: { body }, bad: { body: 42 }, dimensions: { body, width: 0 }, rotation: { body, rotate: 0.5 } },
    aliases: { missing: { parent: 'absent' }, cycle: { parent: 'other' }, other: { parent: 'cycle' }, dependent: { parent: 'bad' } },
    not_found: ['requested'],
  })
  expect(Object.keys(result.json.icons)).toEqual(['good'])
  expect(result.issues.map(issue => issue.name)).toEqual(['bad', 'cycle', 'dependent', 'dimensions', 'missing', 'other', 'requested', 'rotation'])
})

it('selects exact original names, including aliases, and diagnoses absent selections', () => {
  const value = { prefix: 'vendor', icons: { good: { body }, bad: null }, aliases: { alias: { parent: 'good' } } }
  const result = normalizeIconifyJson(value, { include: ['alias', 'alias', 'absent'] })
  expect(Object.keys(result.json.icons)).toEqual(['alias'])
  expect(result.issues).toEqual([{ name: 'absent', message: expect.stringContaining('not found') }])
  expect(normalizeIconifyJson(value, { include: [] })).toMatchObject({ json: { icons: {} }, issues: [] })
})

it.each([null, [], { prefix: 'x', icons: [] }, { prefix: 'x', icons: {}, aliases: [] }, { prefix: 42, icons: {} }, { prefix: 'x', icons: {}, width: 0 }, { prefix: 'x', icons: {}, height: Number.POSITIVE_INFINITY }])('rejects malformed collection structure and defaults %#', (value) => {
  expect(() => normalizeIconifyJson(value)).toThrow(IconctlError)
})

it('uses own properties for icon names and alias parents', () => {
  const result = normalizeIconifyJson(JSON.parse('{"prefix":"x","icons":{"__proto__":{"body":"<path/>"}},"aliases":{"bad":{"parent":"constructor"}}}'))
  expect(Object.hasOwn(result.json.icons, '__proto__')).toBe(true)
  expect(result.issues).toEqual([{ name: 'bad', message: expect.stringContaining('constructor') }])
})

it('resolves long alias chains without recursive stack growth', () => {
  const aliases: Record<string, { parent: string }> = {}
  for (let i = 0; i < 15000; i++) {
    aliases[`alias-${i}`] = { parent: i === 0 ? 'base' : `alias-${i - 1}` }
  }
  const resolver = createIconifyJsonResolver({ prefix: 'vendor', icons: { base: { body } }, aliases })
  expect(resolver.resolve('alias-14999')).toMatchObject({ icon: { body, width: 16, height: 16 } })
})

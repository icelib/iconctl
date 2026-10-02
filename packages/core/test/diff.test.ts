import type { IconifyJSON } from '@iconify/types'
import { compareIconSets, diffIconSets } from '../src/diff'

describe('diffIconSets', () => {
  it('reports added removed and changed icons', () => {
    const diff = diffIconSets(
      {
        prefix: 'brand',
        icons: {
          'arrow-left': { body: '<path d="old"/>' },
          'user': { body: '<path d="user"/>' },
        },
      },
      {
        prefix: 'brand',
        icons: {
          'arrow-left': { body: '<path d="new"/>' },
          'arrow-right': { body: '<path d="right"/>' },
        },
      },
    )

    expect(diff.added).toEqual(['arrow-right'])
    expect(diff.removed).toEqual(['user'])
    expect(diff.changed).toEqual(['arrow-left'])
  })
})

describe('compareIconSets', () => {
  const body = '<path d="M1 2h8v4H1z"/>'
  const iconSet = { prefix: 'brand', icons: { arrow: { body } } }

  it('compares inherited and explicit dimensions using Iconify defaults', () => {
    expect(compareIconSets(iconSet, {
      ...iconSet,
      width: 16,
      height: 16,
      icons: { arrow: { body, left: 0, top: 0, hidden: false, rotate: 4, hFlip: false } },
    }).diff.unchanged).toEqual(['arrow'])
    expect(compareIconSets({ ...iconSet, width: 24, height: 32 }, {
      ...iconSet,
      icons: { arrow: { body, width: 24, height: 32 } },
    }).hasChanges).toBe(false)
  })

  it.each([
    { width: 24 },
    { height: 24 },
    { left: 1 },
    { top: 1 },
    { rotate: 1 },
    { hFlip: true },
    { vFlip: true },
    { hidden: true },
  ])('detects effective icon property changes: %j', (properties) => {
    expect(compareIconSets(iconSet, {
      ...iconSet,
      icons: { arrow: { body, ...properties } },
    }).diff.changed).toEqual(['arrow'])
  })

  it('resolves chained aliases and their inherited transforms before comparison', () => {
    const before = {
      ...iconSet,
      icons: { arrow: { body, width: 24, height: 16, hFlip: true } },
      aliases: { mirror: { parent: 'arrow', hFlip: true }, chain: { parent: 'mirror', rotate: 5 } },
    }
    const after = {
      ...iconSet,
      icons: {
        arrow: before.icons.arrow,
        mirror: { body, width: 24, height: 16 },
        chain: { body, width: 24, height: 16, rotate: 1 },
      },
    }
    expect(compareIconSets(before, after).diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: ['arrow', 'chain', 'mirror'],
    })
    after.icons.arrow = { ...after.icons.arrow, body: '<path d="M0 0h4v4z"/>' }
    expect(compareIconSets(before, { ...before, icons: after.icons }).diff.changed).toEqual(['arrow'])
    expect(compareIconSets(before, { ...before, icons: { arrow: after.icons.arrow } }).diff.changed).toEqual(['arrow', 'chain', 'mirror'])
  })

  it('reports namespace changes separately while preserving the legacy diff shape', () => {
    const after = { ...iconSet, prefix: 'renamed' }
    expect(compareIconSets(iconSet, after)).toMatchObject({
      beforePrefix: 'brand',
      afterPrefix: 'renamed',
      prefixChanged: true,
      hasChanges: true,
      diff: { added: [], removed: [], changed: [], unchanged: ['arrow'] },
    })
    expect(diffIconSets(iconSet, after)).toEqual({ added: [], removed: [], changed: [], unchanged: ['arrow'] })
    expect(compareIconSets(undefined, iconSet)).toMatchObject({ beforePrefix: null, prefixChanged: false, diff: { added: ['arrow'] } })
  })

  it('includes hidden entries and handles prototype-like names without mutating inputs', () => {
    const before = JSON.parse('{"prefix":"brand","icons":{"__proto__":{"body":"<path/>"},"constructor":{"body":"<path/>"}},"aliases":{"alias":{"parent":"__proto__"}}}') as IconifyJSON
    const original = JSON.stringify(before)
    const result = compareIconSets(before, { ...before, icons: { ...before.icons, constructor: { body: '<path/>', hidden: true } } })
    expect(result.diff.changed).toEqual(['constructor'])
    expect(result.diff.unchanged).toEqual(['__proto__', 'alias'])
    expect(JSON.stringify(before)).toBe(original)
  })

  it.each([
    null,
    false,
    { prefix: 'brand', icons: [] },
    { prefix: 'brand', icons: { bad: { body: 1 } } },
    { prefix: 'brand', icons: {}, aliases: { missing: { parent: 'absent' } } },
    { prefix: 'brand', icons: {}, aliases: { a: { parent: 'b' }, b: { parent: 'a' } } },
    { prefix: 'brand', icons: {}, not_found: ['missing'] },
    { prefix: 'brand', width: 0, icons: {} },
  ])('rejects invalid sets instead of producing a partial comparison: %j', (invalid) => {
    expect(() => compareIconSets(iconSet, invalid as IconifyJSON)).toThrow(/Invalid/)
    expect(() => compareIconSets(invalid as IconifyJSON, iconSet)).toThrow(/Invalid/)
  })
})

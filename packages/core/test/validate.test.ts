import { IconSet } from '@iconify/tools'
import { resolveConfig, validateIconSet } from '../src'
import { validateIconSetAsync } from '../src/validate'

describe.each([
  ['sync', validateIconSet],
  ['async', validateIconSetAsync],
] as const)('%s name validation', (_mode, validate) => {
  it.each(['g', 'y'])('resets each %s match without mutating the caller regex', async (flags) => {
    const pattern = new RegExp('^[a-z]+$', flags)
    pattern.lastIndex = 3
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'unused' }], validate: { name: pattern } })
    const iconSet = new IconSet({ prefix: 'brand', icons: Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [name, { body: '<path d="M0 0h16v16H0z"/>' }])) })
    for (let run = 0; run < 2; run++) {
      expect((await validate(iconSet, config)).issues).toEqual([])
      expect(pattern.lastIndex).toBe(3)
      expect(config.validate.name).toBe(pattern)
    }
  })

  it('preserves sticky matching at the start of each name', async () => {
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'unused' }], validate: { name: /foo/y } })
    const iconSet = new IconSet({ prefix: 'brand', icons: { 'foo': { body: '<path d="M0 0h16v16H0z"/>' }, 'x-foo': { body: '<path d="M0 0h16v16H0z"/>' } } })
    expect((await validate(iconSet, config)).issues).toEqual([{ name: 'x-foo', message: expect.stringContaining('does not match /foo/y') }])
  })
})

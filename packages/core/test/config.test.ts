import { resolveConfig } from '../src/config'
import { IconctlError } from '../src/errors'
import { resolveFigmaToken } from '../src/token'

describe('config', () => {
  it('fills defaults for a figma source', () => {
    const resolved = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
    })
    expect(resolved.sources).toEqual([
      { type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv', depth: 3 },
    ])
    expect(resolved.color).toBe('currentColor')
    expect(resolved.output.json).toBe('icons.json')
    expect(resolved.cacheDir).toBe('.iconctl-cache')
    expect(resolved.validate.skipPrefix).toEqual(['_', '.'])
  })

  it('accepts a local svg directory source', () => {
    const resolved = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: './raw-svg' }],
    })
    expect(resolved.sources).toEqual([
      { type: 'directory', dir: './raw-svg' },
    ])
  })

  it('reads FIGMA_TOKEN from env', () => {
    expect(resolveFigmaToken(undefined, { FIGMA_TOKEN: 'figu_test' })).toBe('figu_test')
    expect(() => resolveFigmaToken(undefined, {})).toThrow(IconctlError)
  })
})

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

  it('accepts mastergo iconfont and jsdesign sources', () => {
    const resolved = resolveConfig({
      prefix: 'brand',
      sources: [
        { type: 'mastergo', file: 'https://mastergo.com/file/192644601973042?layer_id=40:015' },
        { type: 'iconfont', url: 'https://at.alicdn.com/t/c/font_1.js' },
        { type: 'jsdesign', dir: './js-export' },
      ],
    })
    expect(resolved.sources.map(item => item.type)).toEqual(['mastergo', 'iconfont', 'jsdesign'])
  })

  it('resolves jsonPackage objects', () => {
    const resolved = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: './raw-svg' }],
      output: {
        jsonPackage: { dir: 'packages/icons', name: '@acme/icons', clean: false },
      },
    })
    expect(resolved.output.jsonPackage).toEqual({
      dir: 'packages/icons',
      name: '@acme/icons',
      clean: false,
    })
  })

  it('reads FIGMA_TOKEN from env', () => {
    expect(resolveFigmaToken(undefined, { FIGMA_TOKEN: 'figu_test' })).toBe('figu_test')
    expect(() => resolveFigmaToken(undefined, {})).toThrow(IconctlError)
  })
})

import { resolveConfig } from '../src/config'
import { FigmaIconifyError } from '../src/errors'
import { resolveFigmaToken } from '../src/token'

describe('config', () => {
  it('fills defaults', () => {
    const resolved = resolveConfig({
      file: 'AbCdEfGhIjKlMnOpQrStUv',
      prefix: 'brand',
    })
    expect(resolved.depth).toBe(3)
    expect(resolved.color).toBe('currentColor')
    expect(resolved.output.json).toBe('icons.json')
    expect(resolved.validate.skipPrefix).toEqual(['_', '.'])
  })

  it('reads FIGMA_TOKEN from env', () => {
    expect(resolveFigmaToken(undefined, { FIGMA_TOKEN: 'figu_test' })).toBe('figu_test')
    expect(() => resolveFigmaToken(undefined, {})).toThrow(FigmaIconifyError)
  })
})

import { FigmaIconifyError } from '../src/errors'
import { parseFigmaFileKey } from '../src/file-key'

describe('parseFigmaFileKey', () => {
  it('parses design URLs', () => {
    expect(parseFigmaFileKey('https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Icons')).toBe('AbCdEfGhIjKlMnOpQrStUv')
  })

  it('parses file URLs', () => {
    expect(parseFigmaFileKey('https://www.figma.com/file/AbCdEfGhIjKlMnOpQrStUv/old')).toBe('AbCdEfGhIjKlMnOpQrStUv')
  })

  it('accepts a raw file key', () => {
    expect(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv')).toBe('AbCdEfGhIjKlMnOpQrStUv')
  })

  it('rejects empty or invalid values', () => {
    expect(() => parseFigmaFileKey('')).toThrow(FigmaIconifyError)
    expect(() => parseFigmaFileKey('https://example.com/x')).toThrow(FigmaIconifyError)
  })
})

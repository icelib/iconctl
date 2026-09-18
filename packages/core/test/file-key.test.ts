import { IconctlError } from '../src/errors'
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
    expect(() => parseFigmaFileKey('')).toThrow(IconctlError)
    expect(() => parseFigmaFileKey('https://example.com/x')).toThrow(IconctlError)
  })

  it('rejects Community file URLs with a duplicate hint', () => {
    expect(() => parseFigmaFileKey('https://www.figma.com/community/file/939851755929765537/Lucide-Icons')).toThrow(
      /Community file URLs cannot be used with the REST API/,
    )
  })
})

import { IconctlError } from './errors'

const fileUrlPattern = /figma\.com\/(?:file|design|board|proto)\/([a-z0-9]+)/i
const fileKeyPattern = /^[a-z0-9]{10,}$/i

export function parseFigmaFileKey(input: string): string {
  const value = input.trim()
  if (!value) {
    throw new IconctlError('Figma file is empty')
  }

  const fromUrl = value.match(fileUrlPattern)
  if (fromUrl?.[1]) {
    return fromUrl[1]
  }

  if (fileKeyPattern.test(value)) {
    return value
  }

  throw new IconctlError(`Invalid Figma file or URL: ${input}`)
}

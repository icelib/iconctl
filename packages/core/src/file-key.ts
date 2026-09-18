import { IconctlError } from './errors'

const fileUrlPattern = /figma\.com\/(?:file|design|board|proto)\/([a-z0-9]+)/i
const communityUrlPattern = /figma\.com\/community\/file\//i
const fileKeyPattern = /^[a-z0-9]{10,}$/i

export const FIGMA_COMMUNITY_FILE_HELP = 'Figma Community file URLs cannot be used with the REST API. Open the file in Figma to duplicate it, then pass the https://www.figma.com/design/{fileKey}/... URL.'

export function parseFigmaFileKey(input: string): string {
  const value = input.trim()
  if (!value) {
    throw new IconctlError('Figma file is empty')
  }

  if (communityUrlPattern.test(value)) {
    throw new IconctlError(FIGMA_COMMUNITY_FILE_HELP)
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

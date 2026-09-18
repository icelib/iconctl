import process from 'node:process'
import { IconctlError } from './errors'

export const FIGMA_TOKEN_HELP = 'Create a Figma personal access token at https://www.figma.com/developers/api#access-tokens and set FIGMA_TOKEN.'

export function resolveFigmaToken(
  configToken?: string,
  env: NodeJS.Dict<string> = process.env,
): string {
  const token = configToken?.trim() || env['FIGMA_TOKEN']?.trim()
  if (!token) {
    throw new IconctlError(`Missing FIGMA_TOKEN. ${FIGMA_TOKEN_HELP}`)
  }
  return token
}

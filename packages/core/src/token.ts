import process from 'node:process'
import { IconctlError } from './errors'

export const FIGMA_TOKEN_HELP = 'Create a Figma personal access token at https://www.figma.com/developers/api#access-tokens and set FIGMA_TOKEN.'
export const MASTERGO_TOKEN_HELP = 'Create a MasterGo personal access token in 个人设置 → 安全设置, then set MASTERGO_TOKEN. Team edition is required and files must be in a team project.'

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

export function resolveMastergoToken(
  configToken?: string,
  env: NodeJS.Dict<string> = process.env,
): string {
  const token = configToken?.trim() || env['MASTERGO_TOKEN']?.trim() || env['MG_MCP_TOKEN']?.trim()
  if (!token) {
    throw new IconctlError(`Missing MASTERGO_TOKEN. ${MASTERGO_TOKEN_HELP}`)
  }
  return token
}

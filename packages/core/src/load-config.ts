import type { FigmaIconifyConfig, ResolvedFigmaIconifyConfig } from './config'
import { loadConfig as loadC12 } from 'c12'
import { resolveConfig } from './config'
import { FigmaIconifyError } from './errors'

export interface LoadConfigOptions {
  cwd?: string
  configFile?: string
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedFigmaIconifyConfig> {
  const loaded = await loadC12<FigmaIconifyConfig>({
    name: 'figma-iconify',
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.configFile ? { configFile: options.configFile } : {}),
  })

  if (!loaded.config?.file?.trim()) {
    throw new FigmaIconifyError('No figma-iconify config found. Run `figma-iconify init` first.')
  }

  return resolveConfig(loaded.config, loaded.configFile)
}

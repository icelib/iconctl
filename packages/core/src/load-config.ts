import type { IconctlConfig, ResolvedIconctlConfig } from './config'
import { loadConfig as loadC12 } from 'c12'
import { resolveConfig } from './config'
import { IconctlError } from './errors'

export interface LoadConfigOptions {
  cwd?: string
  configFile?: string
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedIconctlConfig> {
  const loaded = await loadC12<IconctlConfig>({
    name: 'iconctl',
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.configFile ? { configFile: options.configFile } : {}),
  })

  if (!loaded.config?.prefix?.trim() || !loaded.config.sources?.length) {
    throw new IconctlError('No iconctl config found. Run `iconctl init` first.')
  }

  return resolveConfig(loaded.config, loaded.configFile)
}

import type { IconctlConfig, ResolvedIconctlConfig } from './config'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { loadConfig as loadC12 } from 'c12'
import { resolveConfig } from './config'
import { IconctlError } from './errors'

export interface LoadConfigOptions {
  cwd?: string
  configFile?: string
}

export async function loadConfigDetails(options: LoadConfigOptions = {}, fresh = false, onConfigFile?: (file: string) => void) {
  const loaded = await loadC12<IconctlConfig>({
    name: 'iconctl',
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    ...(fresh
      ? {
          jitiOptions: { moduleCache: false, tryNative: false },
          async resolve(source: string, context: { cwd?: string, configFile?: string }) {
            if (source === '.') {
              return
            }
            if (!isAbsolute(source) && !source.startsWith('./') && !source.startsWith('../')) {
              throw new IconctlError('Watch configuration extends must use local paths.')
            }
            const file = resolve(context.cwd ?? options.cwd ?? '.', source)
            const isDirectory = await stat(file).then(info => info.isDirectory(), () => !extname(source))
            const target = isDirectory ? join(file, basename(context.configFile ?? 'iconctl.config')) : file
            // c12 otherwise silently ignores missing extends layers. Load each layer
            // strictly, then let the outer loader preserve its normal merge order.
            onConfigFile?.(target)
            if (!extname(target) || target.endsWith('.config')) {
              for (const extension of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'jsonc', 'yaml', 'yml', 'toml']) {
                onConfigFile?.(`${target}.${extension}`)
              }
            }
            const layer = await loadC12<IconctlConfig>({
              name: 'iconctl',
              cwd: isDirectory ? file : dirname(file),
              configFile: target,
              configFileRequired: true,
              extend: false,
              rcFile: false,
              globalRc: false,
              packageJson: false,
              dotenv: false,
              jitiOptions: { moduleCache: false, tryNative: false },
            })
            onConfigFile?.(layer.configFile!)
            return { config: layer.config, configFile: layer.configFile!, cwd: dirname(layer.configFile!) }
          },
        }
      : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.configFile ? { configFile: options.configFile } : {}),
  })

  if (!loaded.config?.prefix?.trim() || !loaded.config.sources?.length) {
    throw new IconctlError('No iconctl config found. Run `iconctl init` first.')
  }

  const config = resolveConfig(loaded.config, loaded.configFile)
  const files = [...new Set([loaded.configFile, ...(loaded.layers ?? []).map(layer => layer.configFile)].filter((file): file is string => Boolean(file)))]
  return { config, files }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedIconctlConfig> {
  return (await loadConfigDetails(options)).config
}

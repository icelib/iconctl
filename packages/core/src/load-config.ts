import type { IconctlConfig, ResolvedIconctlConfig } from './config'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { loadConfig as loadC12, SUPPORTED_EXTENSIONS } from 'c12'
import { resolveConfig } from './config'
import { IconctlError } from './errors'

export interface LoadConfigOptions {
  cwd?: string
  configFile?: string
}

/** c12 resolves links before returning configFile; retain the selected entry for watch. */
async function configEntry(configFile: string, options: LoadConfigOptions) {
  const cwd = options.cwd ?? process.cwd()
  const source = options.configFile ?? 'iconctl.config'
  const target = await realpath(configFile)
  const candidates = [resolve(cwd, source), resolve(cwd, '.config', source.replace(/\.config$/, '')), resolve(cwd, '.config', source)]
  for (const candidate of candidates) {
    for (const suffix of ['', '/index']) {
      for (const extension of ['', ...SUPPORTED_EXTENSIONS]) {
        const file = `${candidate}${suffix}${extension}`
        if (await realpath(file).then(actual => actual === target, () => false)) {
          return file
        }
      }
    }
  }
  return configFile
}

export async function loadConfigDetails(options: LoadConfigOptions = {}, fresh = false, onConfigFile?: (file: string) => void) {
  const inputs = new Set<string>()
  const observe = (file: string) => {
    inputs.add(file)
    onConfigFile?.(file)
  }
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
            observe(target)
            if (!extname(target) || target.endsWith('.config')) {
              for (const extension of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json', 'jsonc', 'yaml', 'yml', 'toml']) {
                observe(`${target}.${extension}`)
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
            observe(layer.configFile!)
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
  const entryFile = fresh ? await configEntry(loaded.configFile!, options) : loaded.configFile!
  const files = [...new Set([entryFile, loaded.configFile, ...inputs, ...(loaded.layers ?? []).map(layer => layer.configFile)].filter((file): file is string => Boolean(file)))]
  return { config, files, entryFile }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedIconctlConfig> {
  return (await loadConfigDetails(options)).config
}

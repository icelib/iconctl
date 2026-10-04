import type { IconctlConfig, ResolvedIconctlConfig } from './config'
import type { WatchConfigSnapshot } from './watch-config-snapshot'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { loadConfig as loadC12, SUPPORTED_EXTENSIONS } from 'c12'
import { resolveConfig } from './config'
import { IconctlError } from './errors'
import { watchConfigSnapshot } from './watch-config-snapshot'

export interface LoadConfigOptions {
  cwd?: string
  configFile?: string
}

function configCandidates(cwd: string, source: string) {
  const candidates = [resolve(cwd, source), resolve(cwd, '.config', source.replace(/\.config$/, '')), resolve(cwd, '.config', source)]
  return [...new Set(candidates.flatMap(candidate => ['', '/index'].flatMap(suffix => ['', ...SUPPORTED_EXTENSIONS].map(extension => `${candidate}${suffix}${extension}`))))]
}

/** c12 resolves links before returning configFile; retain the selected entry for watch. */
async function configEntry(configFile: string, options: LoadConfigOptions) {
  const target = await realpath(configFile)
  for (const file of configCandidates(options.cwd ?? process.cwd(), options.configFile ?? 'iconctl.config')) {
    if (await realpath(file).then(actual => actual === target, () => false)) {
      return file
    }
  }
  return configFile
}

export async function loadConfigDetails(options: LoadConfigOptions = {}, fresh = false, onConfigFile?: (file: string) => void, onConfigRead?: (snapshot: WatchConfigSnapshot) => void) {
  const inputs = new Set<string>()
  const readFiles = new Set<string>()
  const readVersions = new Map<string, string>()
  const configReadSnapshot = (): WatchConfigSnapshot => ({ files: [...readFiles], versions: [...readVersions] })
  const capture = async (cwd: string, source: string) => {
    const snapshot = await watchConfigSnapshot(configCandidates(cwd, source))
    for (const file of snapshot.files) {
      readFiles.add(file)
    }
    for (const [file, version] of snapshot.versions) {
      // A layer can share ancestors or be referenced again. Keep its first read
      // boundary so an intervening edit cannot be adopted as the baseline.
      if (!readVersions.has(file)) {
        readVersions.set(file, version)
      }
    }
    onConfigRead?.(configReadSnapshot())
    return snapshot
  }
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
              await capture(context.cwd ?? options.cwd ?? process.cwd(), context.configFile ?? options.configFile ?? 'iconctl.config')
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
            const snapshot = await capture(isDirectory ? file : dirname(file), target)
            const directories = new Map<string, Promise<boolean>>()
            for (const candidate of snapshot.files) {
              const parent = dirname(candidate)
              let directory = directories.get(parent)
              if (!directory) {
                directory = stat(parent).then(info => info.isDirectory(), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
                directories.set(parent, directory)
              }
              // Resolution probes /index even for an explicit regular file.
              // Such impossible children must not become watch input paths.
              if (await directory) {
                observe(candidate)
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
  return { config, files, entryFile, configReadSnapshot: configReadSnapshot() }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedIconctlConfig> {
  return (await loadConfigDetails(options)).config
}

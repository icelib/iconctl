import type { ResolvedSourceConfig, SourceConfig } from './sources/types'
import { IconctlError } from './errors'

export interface IconctlOutputConfig {
  json?: string
  svg?: string
  jsonPackage?: string
  types?: string
  preview?: string
}

export interface IconctlValidateConfig {
  width?: number
  height?: number
  name?: string | RegExp
  skipPrefix?: string[]
}

export interface IconctlConfig {
  prefix: string
  sources: SourceConfig[]
  cacheDir?: string
  color?: string | false
  output?: IconctlOutputConfig
  validate?: IconctlValidateConfig
}

export interface ResolvedIconctlConfig {
  prefix: string
  sources: ResolvedSourceConfig[]
  cacheDir: string
  color: string | false
  output: Required<Pick<IconctlOutputConfig, 'json'>> & IconctlOutputConfig
  validate: {
    width?: number
    height?: number
    name: RegExp
    skipPrefix: string[]
  }
  configFile?: string
}

const defaultNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function defineConfig<T extends IconctlConfig>(config: T): T {
  return config
}

function resolveSource(source: SourceConfig): ResolvedSourceConfig {
  if (source.type === 'directory') {
    if (!source.dir?.trim()) {
      throw new IconctlError('iconctl directory source is missing `dir`')
    }
    return {
      type: 'directory',
      dir: source.dir.trim(),
    }
  }

  if (!source.file?.trim()) {
    throw new IconctlError('iconctl figma source is missing `file`')
  }

  const resolved: Extract<ResolvedSourceConfig, { type: 'figma' }> = {
    type: 'figma',
    file: source.file.trim(),
    depth: source.depth ?? 3,
  }
  if (source.pages) {
    resolved.pages = source.pages
  }
  if (source.ids) {
    resolved.ids = source.ids
  }
  if (source.token) {
    resolved.token = source.token
  }
  if (source.iconNameForNode) {
    resolved.iconNameForNode = source.iconNameForNode
  }
  return resolved
}

export function resolveConfig(config: IconctlConfig, configFile?: string): ResolvedIconctlConfig {
  if (!config.prefix?.trim()) {
    throw new IconctlError('iconctl config is missing `prefix`')
  }
  if (!config.sources?.length) {
    throw new IconctlError('iconctl config is missing `sources`')
  }

  const name = config.validate?.name
  const output: ResolvedIconctlConfig['output'] = {
    json: config.output?.json ?? 'icons.json',
  }
  if (config.output?.svg) {
    output.svg = config.output.svg
  }
  if (config.output?.jsonPackage) {
    output.jsonPackage = config.output.jsonPackage
  }
  if (config.output?.types) {
    output.types = config.output.types
  }
  if (config.output?.preview) {
    output.preview = config.output.preview
  }

  const validate: ResolvedIconctlConfig['validate'] = {
    name: name instanceof RegExp ? name : new RegExp(name ?? defaultNamePattern.source),
    skipPrefix: config.validate?.skipPrefix ?? ['_', '.'],
  }
  if (config.validate?.width != null) {
    validate.width = config.validate.width
  }
  if (config.validate?.height != null) {
    validate.height = config.validate.height
  }

  const resolved: ResolvedIconctlConfig = {
    prefix: config.prefix.trim(),
    sources: config.sources.map(source => resolveSource(source)),
    cacheDir: config.cacheDir ?? '.iconctl-cache',
    color: config.color === undefined ? 'currentColor' : config.color,
    output,
    validate,
  }
  if (configFile) {
    resolved.configFile = configFile
  }
  return resolved
}

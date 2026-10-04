import type { ResolvedSourceConfig, SourceConfig } from './sources/types'
import { IconctlError } from './errors'
import { parseMastergoRef } from './sources/mastergo'

export interface JsonPackageOutputConfig {
  dir: string
  name?: string
  package?: Record<string, unknown>
  clean?: boolean
}

export interface IconctlOutputConfig {
  json?: string
  svg?: string
  sprite?: string
  jsonPackage?: string | JsonPackageOutputConfig
  types?: string
  preview?: string
  changelog?: string
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
  output: Required<Pick<IconctlOutputConfig, 'json'>> & Omit<IconctlOutputConfig, 'jsonPackage'> & {
    jsonPackage?: JsonPackageOutputConfig
  }
  validate: {
    width?: number
    height?: number
    name: RegExp
    skipPrefix: string[]
  }
  configFile?: string
}

const defaultNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function resolveValidation(config: IconctlValidateConfig = {}): ResolvedIconctlConfig['validate'] {
  return {
    name: config.name instanceof RegExp ? config.name : new RegExp(config.name ?? defaultNamePattern.source),
    skipPrefix: config.skipPrefix ?? ['_', '.'],
    ...(config.width != null ? { width: config.width } : {}),
    ...(config.height != null ? { height: config.height } : {}),
  }
}

export function defineConfig<T extends IconctlConfig>(config: T): T {
  return config
}

export function resolveJsonPackage(prefix: string, value: string | JsonPackageOutputConfig): JsonPackageOutputConfig {
  if (typeof value === 'string') {
    const dir = value.trim()
    if (!dir) {
      throw new IconctlError('iconctl jsonPackage is empty')
    }
    return {
      dir,
      name: `@iconify-json/${prefix}`,
      clean: true,
    }
  }
  const dir = value.dir?.trim()
  if (!dir) {
    throw new IconctlError('iconctl jsonPackage is missing `dir`')
  }
  const resolved: JsonPackageOutputConfig = {
    dir,
    name: value.name?.trim() || `@iconify-json/${prefix}`,
    clean: value.clean !== false,
  }
  if (value.package) {
    resolved.package = value.package
  }
  return resolved
}

function resolveFigmaSource(source: Extract<SourceConfig, { type: 'figma' }>): Extract<ResolvedSourceConfig, { type: 'figma' }> {
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

function resolveSource(source: SourceConfig): ResolvedSourceConfig {
  switch (source.type) {
    case 'iconify': {
      if (typeof source.file !== 'string' || !source.file.trim() || /^[a-z][\w+.-]*:\/\//i.test(source.file)) {
        throw new IconctlError('iconctl iconify source needs a local `file` path')
      }
      if (source.include !== undefined && (!Array.isArray(source.include) || source.include.some(name => typeof name !== 'string' || !name))) {
        throw new IconctlError('iconctl iconify `include` must be an array of nonempty icon names')
      }
      if (source.namePrefix !== undefined && typeof source.namePrefix !== 'string') {
        throw new IconctlError('iconctl iconify `namePrefix` must be a string')
      }
      return {
        type: 'iconify',
        file: source.file.trim(),
        namePrefix: source.namePrefix ?? '',
        ...(source.include !== undefined ? { include: [...new Set(source.include)] } : {}),
      }
    }
    case 'directory': {
      if (!source.dir?.trim()) {
        throw new IconctlError('iconctl directory source is missing `dir`')
      }
      return { type: 'directory', dir: source.dir.trim() }
    }
    case 'figma':
      return resolveFigmaSource(source)
    case 'mastergo': {
      const ref = parseMastergoRef(source)
      const resolved: Extract<ResolvedSourceConfig, { type: 'mastergo' }> = {
        type: 'mastergo',
        fileId: ref.fileId,
        layerId: ref.layerId,
        baseUrl: source.baseUrl?.trim() || 'https://mastergo.com',
      }
      if (source.token) {
        resolved.token = source.token
      }
      return resolved
    }
    case 'jsdesign': {
      if (!source.dir?.trim() && !source.file?.trim()) {
        throw new IconctlError('iconctl jsdesign source needs `dir` (exported SVG folder) or `file`')
      }
      const resolved: Extract<ResolvedSourceConfig, { type: 'jsdesign' }> = { type: 'jsdesign' }
      if (source.dir?.trim()) {
        resolved.dir = source.dir.trim()
      }
      if (source.file?.trim()) {
        resolved.file = source.file.trim()
      }
      if (source.token) {
        resolved.token = source.token
      }
      return resolved
    }
    case 'iconfont': {
      if (!source.url?.trim() && !source.dir?.trim()) {
        throw new IconctlError('iconctl iconfont source needs `url` or `dir`')
      }
      const resolved: Extract<ResolvedSourceConfig, { type: 'iconfont' }> = {
        type: 'iconfont',
        stripPrefix: source.stripPrefix ?? 'icon-',
      }
      if (source.url?.trim()) {
        resolved.url = source.url.trim()
      }
      if (source.dir?.trim()) {
        resolved.dir = source.dir.trim()
      }
      return resolved
    }
  }
}

export function resolveConfig(config: IconctlConfig, configFile?: string): ResolvedIconctlConfig {
  if (!config.prefix?.trim()) {
    throw new IconctlError('iconctl config is missing `prefix`')
  }
  if (!config.sources?.length) {
    throw new IconctlError('iconctl config is missing `sources`')
  }

  const output: ResolvedIconctlConfig['output'] = {
    json: config.output?.json ?? 'icons.json',
  }
  if (config.output?.svg) {
    output.svg = config.output.svg
  }
  if (config.output?.sprite) {
    output.sprite = config.output.sprite
  }
  if (config.output?.jsonPackage) {
    output.jsonPackage = resolveJsonPackage(config.prefix, config.output.jsonPackage)
  }
  if (config.output?.types) {
    output.types = config.output.types
  }
  if (config.output?.preview) {
    output.preview = config.output.preview
  }
  if (config.output?.changelog) {
    output.changelog = config.output.changelog
  }

  const validate = resolveValidation(config.validate)

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

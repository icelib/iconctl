import type { FigmaImportNodeFilter } from '@iconify/tools/lib/import/figma/types/nodes'

export interface FigmaIconifyOutputConfig {
  json?: string
  svg?: string
  jsonPackage?: string
  types?: string
  preview?: string
}

export interface FigmaIconifyValidateConfig {
  width?: number
  height?: number
  name?: string | RegExp
  skipPrefix?: string[]
}

export interface FigmaIconifyConfig {
  file: string
  prefix: string
  pages?: string[]
  depth?: number
  ids?: string[]
  token?: string
  cacheDir?: string
  color?: string | false
  output?: FigmaIconifyOutputConfig
  validate?: FigmaIconifyValidateConfig
  iconNameForNode?: FigmaImportNodeFilter
}

export interface ResolvedFigmaIconifyConfig {
  file: string
  prefix: string
  pages?: string[]
  depth: number
  ids?: string[]
  token?: string
  cacheDir: string
  color: string | false
  output: Required<Pick<FigmaIconifyOutputConfig, 'json'>> & FigmaIconifyOutputConfig
  validate: {
    width?: number
    height?: number
    name: RegExp
    skipPrefix: string[]
  }
  iconNameForNode?: FigmaImportNodeFilter
  configFile?: string
}

const defaultNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function defineConfig<T extends FigmaIconifyConfig>(config: T): T {
  return config
}

export function resolveConfig(config: FigmaIconifyConfig, configFile?: string): ResolvedFigmaIconifyConfig {
  if (!config.file?.trim()) {
    throw new Error('figma-iconify config is missing `file`')
  }
  if (!config.prefix?.trim()) {
    throw new Error('figma-iconify config is missing `prefix`')
  }

  const name = config.validate?.name
  const output: ResolvedFigmaIconifyConfig['output'] = {
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

  const validate: ResolvedFigmaIconifyConfig['validate'] = {
    name: name instanceof RegExp ? name : new RegExp(name ?? defaultNamePattern.source),
    skipPrefix: config.validate?.skipPrefix ?? ['_', '.'],
  }
  if (config.validate?.width != null) {
    validate.width = config.validate.width
  }
  if (config.validate?.height != null) {
    validate.height = config.validate.height
  }

  const resolved: ResolvedFigmaIconifyConfig = {
    file: config.file.trim(),
    prefix: config.prefix.trim(),
    depth: config.depth ?? 3,
    cacheDir: config.cacheDir ?? '.figma-iconify-cache',
    color: config.color === undefined ? 'currentColor' : config.color,
    output,
    validate,
  }
  if (config.pages) {
    resolved.pages = config.pages
  }
  if (config.ids) {
    resolved.ids = config.ids
  }
  if (config.token) {
    resolved.token = config.token
  }
  if (config.iconNameForNode) {
    resolved.iconNameForNode = config.iconNameForNode
  }
  if (configFile) {
    resolved.configFile = configFile
  }
  return resolved
}

import type { SourceConfig } from '@iconctl/core'
import type { CommandContext } from './failure'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { IconctlError, parseFigmaFileKey, resolveConfig } from '@iconctl/core'
import { consola } from 'consola'
import { comparableInitPath, createInitFile, initLocation, inspectInitTarget, sameInitLocation } from './init-file'

export interface InitCommandOptions {
  config?: unknown
  source?: unknown
  input?: unknown
  url?: unknown
  prefix?: unknown
  jsonOutput?: unknown
  interactive?: boolean
  json?: boolean
  dryRun?: boolean
  continue?: boolean
}

const sourceTypes = ['directory', 'iconify', 'figma', 'mastergo', 'iconfont', 'jsdesign'] as const
type SourceType = typeof sourceTypes[number]

interface InitPlan {
  source: SourceConfig
  prefix: string
  json: string
}

export class InitCancelledError extends Error {
  constructor(cause: unknown) {
    super('Initialization cancelled. No config was written.', { cause })
    this.name = 'InitCancelledError'
  }
}

function text(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IconctlError(`--${option} must be a nonempty string and can only be supplied once.`)
  }
  return value
}

function localPath(value: unknown, option: string): string {
  const path = text(value, option)
  if (path.trim() === '-' || (/^[a-z][\w+.-]*:/i.test(path.trim()) && !/^[a-z]:[\\/]/i.test(path))) {
    throw new IconctlError(`--${option} must be a local path; URLs and stdin/stdout are not supported.`)
  }
  return path
}

function sourceType(value: unknown): SourceType {
  if (!sourceTypes.includes(value as SourceType)) {
    throw new IconctlError(`--source must be one of: ${sourceTypes.join(', ')}.`)
  }
  return value as SourceType
}

function symbolUrl(value: unknown): string {
  const url = text(value, 'url').trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url
    }
  }
  catch {}
  throw new IconctlError('--url must be an HTTP or HTTPS iconfont Symbol URL.')
}

function sourceConfig(type: SourceType, input: unknown, url: unknown): SourceConfig {
  switch (type) {
    case 'directory': return { type, dir: localPath(input, 'input') }
    case 'iconify': return { type, file: localPath(input, 'input') }
    case 'jsdesign': return { type, dir: localPath(input, 'input') }
    case 'figma': {
      const file = text(input, 'input')
      parseFigmaFileKey(file)
      return { type, file, pages: ['Icons'] }
    }
    case 'mastergo': return { type, file: text(input, 'input') }
    case 'iconfont': return { type, ...(url !== undefined ? { url: symbolUrl(url) } : { dir: localPath(input, 'input') }), stripPrefix: 'icon-' }
  }
}

async function prompt(message: string, options: Parameters<typeof consola.prompt>[1], context: CommandContext): Promise<string> {
  context.phase = 'execution'
  let answer: unknown
  try {
    answer = await consola.prompt(message, { ...options, cancel: 'reject' })
  }
  catch (error) {
    if (error instanceof Error && error.name === 'ConsolaPromptCancelledError') {
      throw new InitCancelledError(error)
    }
    throw error
  }
  context.phase = 'arguments'
  if (typeof answer !== 'string') {
    throw new IconctlError(`Invalid answer for ${message}.`)
  }
  return answer
}

async function collect(options: InitCommandOptions, interactive: boolean, context: CommandContext): Promise<InitPlan> {
  const ask = (message: string, settings: Parameters<typeof consola.prompt>[1]) => prompt(message, settings, context)
  let type = options.source === undefined ? undefined : sourceType(options.source)
  let prefix = options.prefix
  let json = options.jsonOutput
  let input = options.input
  let url = options.url
  if (!interactive) {
    const missing = [type === undefined && '--source', prefix === undefined && '--prefix', input === undefined && url === undefined && '--input (or --url for iconfont)'].filter(Boolean)
    if (missing.length) {
      throw new IconctlError(`Non-interactive init requires ${missing.join(', ')}.`)
    }
  }
  if (type === undefined) {
    type = sourceType(await ask('Icon source', {
      type: 'select',
      options: [
        { label: 'Figma file', value: 'figma' },
        { label: 'Local SVG directory', value: 'directory' },
        { label: 'Local Iconify JSON', value: 'iconify' },
        { label: 'MasterGo file', value: 'mastergo' },
        { label: 'iconfont Symbol URL or folder', value: 'iconfont' },
        { label: '即时设计 exported SVG folder', value: 'jsdesign' },
      ],
    }))
  }
  if (url !== undefined && type !== 'iconfont') {
    throw new IconctlError('--url is only supported with --source iconfont.')
  }
  if (prefix === undefined) {
    prefix = await ask('Iconify prefix', { type: 'text', placeholder: 'brand', default: 'brand' }) || 'brand'
  }
  if (json === undefined) {
    json = interactive ? await ask('JSON output path', { type: 'text', placeholder: 'icons.json', default: 'icons.json' }) || 'icons.json' : 'icons.json'
  }
  if (input === undefined && url === undefined) {
    if (type === 'iconfont') {
      url = await ask('iconfont Symbol JS URL (or leave empty for a folder)', { type: 'text' }) || undefined
    }
    if (url === undefined) {
      const fields: Record<SourceType, [string, string?]> = {
        directory: ['SVG directory', './raw-svg'],
        iconify: ['Iconify JSON file', './vendor/icons.json'],
        figma: ['Figma file URL or file key'],
        mastergo: ['MasterGo file URL (include layer_id)'],
        iconfont: ['iconfont download folder', './iconfont'],
        jsdesign: ['Exported SVG folder from 即时设计', './jsdesign-svg'],
      }
      const [label, fallback] = fields[type]
      input = await ask(label, { type: 'text', ...(fallback ? { placeholder: fallback, default: fallback } : {}) })
      if (input === '' && fallback) {
        input = fallback
      }
    }
  }
  const source = sourceConfig(type, input, url)
  const plan = { source, prefix: text(prefix, 'prefix'), json: localPath(json, 'json-output') }
  // Pure validation only: never load a config, contact a source, or read credentials.
  const resolved = resolveConfig({ prefix: plan.prefix, sources: [source], output: { json: plan.json } })
  return { ...plan, prefix: resolved.prefix }
}

function configTemplate(plan: InitPlan): string {
  const source = Object.entries(plan.source).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')
  const fixedSize = plan.source.type !== 'iconify'
  return `import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: ${JSON.stringify(plan.prefix)},
  sources: [
    { ${source} }
  ],
  output: {
    json: ${JSON.stringify(plan.json)},
    svg: 'svg',
    preview: 'preview.html',
    // Or ship an installable package:
    // jsonPackage: { dir: 'packages/icons', name: '@iconify-json/brand' },
  },
  validate: {
    ${fixedSize ? '' : '// '}width: 24,
    ${fixedSize ? '' : '// '}height: 24,
  },
})
`
}

function contains(parent: string, path: string) {
  const value = relative(comparableInitPath(parent), comparableInitPath(path))
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function validateLocations(plan: InitPlan, target: string) {
  const json = await initLocation(resolve(plan.json))
  const svg = await initLocation(resolve('svg'))
  const preview = await initLocation(resolve('preview.html'))
  if (await sameInitLocation(json, target) || await sameInitLocation(preview, target) || contains(svg, target)) {
    throw new IconctlError('--config conflicts with a generated output path. Choose a separate config location.')
  }
  if (plan.source.type === 'iconify') {
    const input = await initLocation(resolve(plan.source.file.trim()))
    if (await sameInitLocation(input, target) || await sameInitLocation(input, json) || await sameInitLocation(input, preview) || contains(svg, input)) {
      throw new IconctlError('Iconify --input conflicts with --config or a generated output path. Choose separate paths.')
    }
  }
  if ('dir' in plan.source && plan.source.dir) {
    const input = await initLocation(resolve(plan.source.dir.trim()))
    if (contains(input, svg) || contains(svg, input)) {
      throw new IconctlError('The source directory overlaps output.svg (svg). Choose a separate --input directory such as raw-svg.')
    }
  }
}

function hint(plan: InitPlan) {
  switch (plan.source.type) {
    case 'figma': return 'Run `iconctl auth figma login` or set FIGMA_TOKEN before syncing.'
    case 'mastergo': return 'Set MASTERGO_TOKEN before syncing. Team edition and a team-project file are required.'
    case 'iconfont': return 'Use a public Symbol URL or local download folder, then sync.'
    case 'jsdesign': return 'Export SVGs from 即时设计 into the configured folder, then sync.'
    case 'iconify': return 'Keep the vendor JSON separate from output paths, then sync or watch.'
    case 'directory': return 'Put SVGs in the configured source directory, then sync or watch.'
  }
}

export async function runInit(options: InitCommandOptions, context: CommandContext): Promise<void> {
  context.phase = 'arguments'
  for (const key of ['interactive', 'json', 'dryRun', 'continue'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new IconctlError(`--${key} must be a boolean and can only be supplied once.`)
    }
  }
  if (options.continue) {
    throw new IconctlError('--continue is not supported by init.')
  }
  for (const [key, value] of Object.entries({ 'source': options.source, 'input': options.input, 'url': options.url, 'prefix': options.prefix, 'json-output': options.jsonOutput })) {
    if (value !== undefined) {
      text(value, key)
    }
  }
  if (options.source !== undefined) {
    sourceType(options.source)
  }
  if (options.url !== undefined && options.source !== undefined && options.source !== 'iconfont') {
    throw new IconctlError('--url is only supported with --source iconfont.')
  }
  if (options.input !== undefined && options.url !== undefined) {
    throw new IconctlError('Use --input or --url, not both.')
  }
  const path = resolve(localPath(options.config ?? 'iconctl.config.ts', 'config'))
  if (extname(path) !== '.ts') {
    throw new IconctlError('--config must end in .ts; init generates a TypeScript config.')
  }
  context.phase = 'execution'
  const target = await inspectInitTarget(path)
  const interactive = !options.json && options.interactive !== false && Boolean(process.stdin.isTTY && process.stdout.isTTY)
  context.phase = 'arguments'
  let plan: InitPlan
  try {
    plan = await collect(options, interactive, context)
  }
  catch (error) {
    if (error instanceof InitCancelledError) {
      context.phase = 'execution'
      context.exitCode = 130
    }
    throw error
  }
  await validateLocations(plan, target.path)
  const contents = configTemplate(plan)
  context.phase = 'execution'
  if (!options.dryRun) {
    await createInitFile(target, contents)
  }
  const report = {
    configFile: target.path,
    sourceType: plan.source.type,
    prefix: plan.prefix,
    outputFiles: options.dryRun ? [] : [target.path],
    ...(options.dryRun ? { dryRun: true } : {}),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    consola.success(`${options.dryRun ? 'Would create' : 'Created'} ${target.path}`)
    consola.info(`${plan.source.type} source · prefix "${plan.prefix}". ${hint(plan)}`)
  }
}

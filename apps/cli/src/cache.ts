import type { CommandContext } from './failure.ts'
import process from 'node:process'
import { IconctlError, inspectIconifyCache, loadConfig } from '@iconctl/core'

export interface CacheDiagnoseOptions {
  config?: string
  cacheDir?: string
  json?: boolean
  url?: string
  strict?: boolean
}

function cacheUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IconctlError('--url must be a nonempty HTTPS URL without credentials.')
  }
  const candidate = value.trim()
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      throw new Error('invalid')
    }
  }
  catch {
    throw new IconctlError('--url must be a nonempty HTTPS URL without credentials.')
  }
  return candidate
}

function localPath(value: unknown, option: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '-' || /^[a-z][\w+.-]*:\/\//i.test(value.trim())) {
    throw new IconctlError(`--${option} must be a nonempty local path.`)
  }
  return value
}

export async function runCacheDiagnose(options: CacheDiagnoseOptions, context: CommandContext): Promise<void> {
  context.phase = 'arguments'
  if (options.config !== undefined && options.cacheDir !== undefined) {
    throw new IconctlError('Use --config or --cache-dir, not both.')
  }
  const url = options.url === undefined ? undefined : cacheUrl(options.url)
  const configFile = options.config === undefined ? undefined : localPath(options.config, 'config')

  let cacheDir: string
  if (options.cacheDir !== undefined) {
    cacheDir = localPath(options.cacheDir, 'cache-dir')
  }
  else {
    context.phase = 'configuration'
    const config = await loadConfig({
      cwd: process.cwd(),
      ...(configFile !== undefined ? { configFile } : {}),
    })
    cacheDir = config.cacheDir
  }
  context.phase = 'execution'
  const report = await inspectIconifyCache({ cwd: process.cwd(), cacheDir, ...(url !== undefined ? { url } : {}) })
  const output = url === undefined ? report : { ...report, url }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
  else {
    process.stdout.write(`Iconify cache: ${output.directory}\n`)
    process.stdout.write(`Valid ${output.valid} · Invalid ${output.invalid} · Missing ${output.missing}\n`)
    for (const entry of output.entries) {
      const detail = entry.status === 'valid'
        ? `${entry.url} (${entry.bodyBytes ?? 0} body bytes)`
        : `${entry.error ?? 'invalid cache entry'}`
      process.stdout.write(`${entry.status} ${entry.file}: ${detail}\n`)
    }
  }
  if (options.strict && (output.invalid > 0 || output.missing > 0)) {
    process.exitCode = 1
  }
}

export function runCacheCommand(operation: string, options: CacheDiagnoseOptions, context: CommandContext): Promise<void> {
  context.phase = 'arguments'
  if (operation !== 'diagnose') {
    throw new IconctlError('Use `iconctl cache diagnose`.')
  }
  return runCacheDiagnose(options, context)
}

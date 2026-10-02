import type { LoadedSource, ResolvedIconfontSourceConfig } from './types'
import { mkdir, writeFile } from 'node:fs/promises'
import { blankIconSet } from '@iconify/tools'
import { isAbsolute, join, resolve } from 'pathe'
import { IconctlError } from '../errors'
import { fetchText } from '../http'
import { addSvgToIconSet, applyNameTransform, stripIconPrefix } from '../icon-set'
import { loadDirectorySource } from './directory'
import { parseIconfontSymbolJs, parseIconfontSymbols, symbolToSvg } from './iconfont-symbol'

export interface IconfontJsToSvgOptions {
  stripPrefix?: string
  only?: string[]
}

export function iconfontJsToSvgs(js: string, options: IconfontJsToSvgOptions = {}): { name: string, svg: string }[] {
  const stripPrefix = options.stripPrefix ?? 'icon-'
  const only = options.only?.length ? new Set(options.only) : undefined
  const files: { name: string, svg: string }[] = []
  for (const symbol of parseIconfontSymbolJs(js)) {
    const name = stripIconPrefix(symbol.id, stripPrefix)
    if (!name || (only && !only.has(name))) {
      continue
    }
    files.push({ name, svg: symbolToSvg(symbol) })
  }
  return files
}

export async function writeIconfontJsToDirectory(
  js: string,
  dir: string,
  options: IconfontJsToSvgOptions = {},
): Promise<string[]> {
  const files = iconfontJsToSvgs(js, options)
  if (!files.length) {
    throw new IconctlError('No <symbol> icons found in iconfont JS')
  }
  await mkdir(dir, { recursive: true })
  const names: string[] = []
  for (const file of files) {
    await writeFile(join(dir, `${file.name}.svg`), `${file.svg}\n`, 'utf8')
    names.push(file.name)
  }
  return names
}

export async function loadIconfontSource(
  source: ResolvedIconfontSourceConfig,
  options: { cwd: string, prefix: string },
): Promise<LoadedSource> {
  if (source.url) {
    const js = await fetchText(source.url)
    const parsed = parseIconfontSymbols(js)
    const failures = parsed.failures.map(failure => ({ ...failure, name: stripIconPrefix(failure.name, source.stripPrefix) || failure.name }))
    if (!parsed.symbols.length && !failures.length) {
      throw new IconctlError(`No <symbol> icons found in ${source.url}`)
    }
    const iconSet = blankIconSet(options.prefix)
    for (const symbol of parsed.symbols) {
      const name = stripIconPrefix(symbol.id, source.stripPrefix)
      if (!name) {
        failures.push({ name: symbol.id, message: 'The iconfont symbol id cannot be converted to an icon name.' })
        continue
      }
      try {
        addSvgToIconSet(iconSet, name, symbolToSvg(symbol))
      }
      catch {
        failures.push({ name, message: 'The iconfont symbol contains an invalid SVG.' })
      }
    }
    return { type: 'iconfont', iconSet, notModified: false, ...(failures.length ? { failures } : {}) }
  }

  if (source.dir) {
    const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
    const loaded = await loadDirectorySource({ type: 'directory', dir }, options)
    const failures = (loaded.failures ?? []).map(failure => ({ ...failure, name: stripIconPrefix(failure.name, source.stripPrefix) || failure.name }))
    const iconSet = applyNameTransform(loaded.iconSet!, (name) => {
      const renamed = stripIconPrefix(name, source.stripPrefix)
      if (!renamed) {
        failures.push({ name, message: 'The iconfont filename cannot be converted to an icon name after removing its prefix.' })
      }
      return renamed || null
    })
    return { type: 'iconfont', iconSet, notModified: false, ...(failures.length ? { failures } : {}) }
  }

  throw new IconctlError('iconctl iconfont source needs `url` or `dir`')
}

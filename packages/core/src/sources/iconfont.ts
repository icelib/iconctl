import type { LoadedSource, ResolvedIconfontSourceConfig } from './types'
import { mkdir, writeFile } from 'node:fs/promises'
import { blankIconSet } from '@iconify/tools'
import { isAbsolute, join, resolve } from 'pathe'
import { IconctlError } from '../errors'
import { fetchText } from '../http'
import { addSvgToIconSet, applyNameTransform, stripIconPrefix } from '../icon-set'
import { importLocalSvgDirectory } from './directory'
import { parseIconfontSymbolJs, symbolToSvg } from './iconfont-symbol'

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
    const symbols = parseIconfontSymbolJs(js)
    if (!symbols.length) {
      throw new IconctlError(`No <symbol> icons found in ${source.url}`)
    }
    const iconSet = blankIconSet(options.prefix)
    for (const symbol of symbols) {
      const name = stripIconPrefix(symbol.id, source.stripPrefix)
      if (!name) {
        continue
      }
      addSvgToIconSet(iconSet, name, symbolToSvg(symbol))
    }
    return { type: 'iconfont', iconSet, notModified: false }
  }

  if (source.dir) {
    const dir = isAbsolute(source.dir) ? source.dir : resolve(options.cwd, source.dir)
    const imported = await importLocalSvgDirectory(dir, options.prefix)
    const iconSet = applyNameTransform(imported, name => stripIconPrefix(name, source.stripPrefix) || null)
    return { type: 'iconfont', iconSet, notModified: false }
  }

  throw new IconctlError('iconctl iconfont source needs `url` or `dir`')
}

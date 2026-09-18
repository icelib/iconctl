import type { LoadedSource, ResolvedIconfontSourceConfig } from './types'
import { blankIconSet } from '@iconify/tools'
import { isAbsolute, resolve } from 'pathe'
import { IconctlError } from '../errors'
import { fetchText } from '../http'
import { addSvgToIconSet, applyNameTransform, stripIconPrefix } from '../icon-set'
import { importLocalSvgDirectory } from './directory'
import { parseIconfontSymbolJs, symbolToSvg } from './iconfont-symbol'

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

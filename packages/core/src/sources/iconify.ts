import type { LoadedSource, ResolvedIconifySourceConfig } from './types'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { blankIconSet, cleanupSVG, SVG } from '@iconify/tools'
import { checkpoint, settleWithAbort } from '../abort'
import { IconctlError } from '../errors'
import { createIconifyJsonResolver } from '../iconify-json'
import { shouldSkipName } from '../naming'

export async function loadIconifySource(
  source: ResolvedIconifySourceConfig,
  options: { cwd: string, prefix: string, skipPrefix: string[], signal?: AbortSignal },
): Promise<LoadedSource> {
  const file = resolve(options.cwd, source.file)
  const content = await settleWithAbort(() => readFile(file, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) }), options.signal)
  let value: unknown
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ''))
  }
  catch {
    throw new IconctlError(`Cannot parse Iconify JSON: ${file}`)
  }
  const resolver = createIconifyJsonResolver(value)
  const names = source.include === undefined ? resolver.names : [...source.include].sort()
  const iconSet = blankIconSet(options.prefix)
  const issues: NonNullable<LoadedSource['issues']> = []
  for (const original of names) {
    await checkpoint(options.signal)
    if (shouldSkipName(original, options.skipPrefix)) {
      continue
    }
    const name = `${source.namePrefix}${original}`
    const result = resolver.resolve(original)
    if ('issue' in result) {
      issues.push({ name, message: result.issue.message, stage: 'import' })
      continue
    }
    try {
      const { body, left, top, width, height } = result.icon
      const svg = new SVG(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${body}</svg>`)
      cleanupSVG(svg)
      if (!iconSet.fromSVG(name, svg)) {
        throw new Error('Invalid icon name or SVG')
      }
    }
    catch {
      issues.push({ name, stage: 'import', message: 'Cannot import the Iconify SVG body. Check its markup and dimensions.' })
    }
  }
  await checkpoint(options.signal)
  return { type: 'iconify', iconSet, notModified: false, issues }
}

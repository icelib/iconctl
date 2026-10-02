import type { IconifyIcon, IconifyJSON } from '@iconify/types'
import { iconToSVG, mergeIconData } from '@iconify/utils'
import { IconctlError } from './errors'

export interface IconifyJsonIssue {
  name: string
  message: string
}

export interface NormalizedIconifyIcon {
  body: string
  left: number
  top: number
  width: number
  height: number
  hidden: boolean
}

type RawIcon = IconifyIcon & { hidden?: boolean }
type RawResult = { icon: RawIcon } | { message: string }
export type IconifyJsonResolution = { icon: NormalizedIconifyIcon } | { issue: IconifyJsonIssue }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function properties(value: Record<string, unknown>, dimensionsOnly = false): Omit<RawIcon, 'body'> {
  const props: Omit<RawIcon, 'body'> = {}
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const number = value[key]
    if (number === undefined) {
      continue
    }
    if (typeof number !== 'number' || !Number.isFinite(number) || ((key === 'width' || key === 'height') && number <= 0)) {
      throw new Error(`Invalid ${key}: expected a finite ${key === 'width' || key === 'height' ? 'positive ' : ''}number.`)
    }
    props[key] = number
  }
  if (!dimensionsOnly) {
    if (value['rotate'] !== undefined) {
      if (typeof value['rotate'] !== 'number' || !Number.isInteger(value['rotate'])) {
        throw new TypeError('Invalid rotate: expected an integer number of quarter turns.')
      }
      props.rotate = ((value['rotate'] % 4) + 4) % 4
    }
    for (const key of ['hFlip', 'vFlip', 'hidden'] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'boolean') {
          throw new TypeError(`Invalid ${key}: expected a boolean.`)
        }
        props[key] = value[key]
      }
    }
  }
  return props
}

/** Shared parsing boundary for imports and comparisons; does not mutate the input. */
export function createIconifyJsonResolver(value: unknown) {
  if (!record(value) || typeof value['prefix'] !== 'string' || !record(value['icons'])
    || (value['aliases'] !== undefined && !record(value['aliases']))) {
    throw new IconctlError('Invalid Iconify JSON: expected a prefix string, an icons object and an optional aliases object.')
  }
  if (value['not_found'] !== undefined && (!Array.isArray(value['not_found']) || value['not_found'].some(name => typeof name !== 'string' || !name))) {
    throw new IconctlError('Invalid Iconify JSON: not_found must be an array of icon names.')
  }
  let defaults: Omit<RawIcon, 'body'>
  try {
    defaults = { left: 0, top: 0, width: 16, height: 16, ...properties(value, true) }
  }
  catch (error) {
    throw new IconctlError(`Invalid Iconify JSON defaults: ${(error as Error).message}`)
  }
  const icons = value['icons']
  const aliases = (value['aliases'] ?? Object.create(null)) as Record<string, unknown>
  const missing = value['not_found'] as string[] | undefined
  const names = [...new Set([...Object.keys(icons), ...Object.keys(aliases), ...(missing ?? [])])].sort()
  const cache = new Map<string, RawResult>()
  const normalized = new Map<string, IconifyJsonResolution>()

  const raw = (name: string): RawResult => {
    const chain: { name: string, props: Omit<RawIcon, 'body'> }[] = []
    const visiting = new Set<string>()
    let current = name
    let result: RawResult
    // Iteration avoids recursive stack overflow for long vendor alias chains.
    while (true) {
      const cached = cache.get(current)
      if (cached) {
        result = cached
        break
      }
      if (visiting.has(current)) {
        result = { message: `Alias cycle includes "${current}".` }
        break
      }
      visiting.add(current)
      try {
        if (!current) {
          throw new Error('Icon names cannot be empty.')
        }
        if (Object.hasOwn(icons, current)) {
          const item = icons[current]
          if (!record(item) || typeof item['body'] !== 'string') {
            throw new Error(`Icon "${current}" must have a string body.`)
          }
          result = { icon: { ...defaults, ...properties(item), body: item['body'] } }
          cache.set(current, result)
          break
        }
        if (!Object.hasOwn(aliases, current)) {
          throw new Error(`Icon or alias "${current}" was not found.`)
        }
        const alias = aliases[current]
        if (!record(alias) || typeof alias['parent'] !== 'string' || !alias['parent']) {
          throw new Error(`Alias "${current}" must have a nonempty parent name.`)
        }
        chain.push({ name: current, props: properties(alias) })
        current = alias['parent']
      }
      catch (error) {
        result = { message: (error as Error).message }
        cache.set(current, result)
        break
      }
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      const item = chain[index]!
      if ('icon' in result) {
        result = { icon: mergeIconData(result.icon, item.props) }
      }
      cache.set(item.name, result)
    }
    return result
  }

  const resolve = (name: string): IconifyJsonResolution => {
    const cached = normalized.get(name)
    if (cached) {
      return cached
    }
    const result = raw(name)
    let resolved: IconifyJsonResolution
    if ('message' in result) {
      resolved = { issue: { name, message: result.message } }
    }
    else {
      const rendered = iconToSVG(result.icon, { width: 'auto', height: 'auto' })
      const [left, top, width, height] = rendered.viewBox
      resolved = { icon: { body: rendered.body, left, top, width, height, hidden: result.icon.hidden ?? false } }
    }
    normalized.set(name, resolved)
    return resolved
  }
  return { prefix: value['prefix'], names, resolve }
}

/** Synchronous for the public diff API; async importers can yield between resolver calls. */
export function normalizeIconifyJson(value: unknown, options: { include?: readonly string[] } = {}) {
  const resolver = createIconifyJsonResolver(value)
  const icons: IconifyJSON['icons'] = Object.create(null)
  const issues: IconifyJsonIssue[] = []
  const names = options.include === undefined ? resolver.names : [...new Set(options.include)].sort()
  for (const name of names) {
    const result = resolver.resolve(name)
    if ('issue' in result) {
      issues.push(result.issue)
    }
    else {
      icons[name] = result.icon
    }
  }
  return { json: { prefix: resolver.prefix, icons } satisfies IconifyJSON, issues }
}

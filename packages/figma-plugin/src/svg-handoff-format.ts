import type { PreflightItem } from './preflight'
import { DEFAULT_NAME_PATTERN } from './naming'
import { canSubmit } from './preflight'

export const MAX_HANDOFF_FILES = 5000
export const MAX_HANDOFF_FILE_BYTES = 1024 * 1024
export const MAX_HANDOFF_BYTES = 5 * 1024 * 1024
export const MAX_HANDOFF_ZIP_BYTES = 8 * 1024 * 1024

export interface HandoffFile {
  path: string
  svg: string
  bytes: number
}

export function handoffPath(name: string) {
  const path = `raw-svg/${name}.svg`
  if (!DEFAULT_NAME_PATTERN.test(name) || path.length > 240
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error(`Icon name "${name}" cannot be used as a portable SVG filename. Rename it and rescan.`)
  }
  return path
}

export function handoffItems(items: PreflightItem[], serverNaming: boolean) {
  if (serverNaming) {
    throw new Error('Custom names require a console sync. Download the confirmed SVG snapshot there.')
  }
  if (!canSubmit(items)) {
    throw new Error('Fix all preflight errors and include at least one icon before exporting SVGs.')
  }
  const selected = items.filter(item => !item.skipped)
  if (selected.length > MAX_HANDOFF_FILES) {
    throw new Error('SVG handoff exceeds the 5000 icon limit.')
  }
  const paths = new Set<string>()
  return selected.map((item) => {
    const path = handoffPath(item.iconName ?? '')
    if (paths.has(path)) {
      throw new Error(`Duplicate SVG filename: ${path}. Rename an icon and rescan.`)
    }
    paths.add(path)
    return { ...item, path }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/** Figma's host does not guarantee TextEncoder. Reject malformed UTF-16. */
export function svgByteLength(svg: string) {
  if (!svg || svg.length > MAX_HANDOFF_FILE_BYTES) {
    throw new Error('An SVG is empty or exceeds the 1 MiB file limit.')
  }
  let bytes = 0
  for (let index = 0; index < svg.length; index++) {
    const code = svg.charCodeAt(index)
    if (code < 0x80) {
      bytes++
    }
    else if (code < 0x800) {
      bytes += 2
    }
    else if (code >= 0xD800 && code <= 0xDBFF) {
      const next = svg.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new Error('An SVG contains invalid Unicode text.')
      }
      bytes += 4
    }
    else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new Error('An SVG contains invalid Unicode text.')
    }
    else {
      bytes += 3
    }
    if (bytes > MAX_HANDOFF_FILE_BYTES) {
      throw new Error('An SVG exceeds the 1 MiB file limit.')
    }
  }
  if (!/^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg[\s>/]/.test(svg)
    || !/(?:<\/svg>|\/>)\s*$/.test(svg) || /<!DOCTYPE/i.test(svg)) {
    throw new Error('Figma returned invalid SVG content.')
  }
  return bytes
}

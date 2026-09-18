// Keep in sync with packages/core/src/naming.ts (plugin cannot import @iconctl/core).

export const DEFAULT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const DEFAULT_SKIP_PREFIX = ['_', '.']
export const DEFAULT_SIZE = 24

export function toIconName(raw: string): string {
  let keyword = raw.replace(/[A-Z]+/g, chars => `_${chars.toLowerCase()}`)
  keyword = keyword.toLowerCase().trim().replace(/[\s_.:/\\]/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
  if (keyword.startsWith('-')) {
    keyword = keyword.slice(1)
  }
  if (keyword.endsWith('-')) {
    keyword = keyword.slice(0, -1)
  }
  return keyword
}

export function shouldSkipName(name: string, skipPrefix: string[] = DEFAULT_SKIP_PREFIX): boolean {
  const trimmed = name.trim()
  return !trimmed || skipPrefix.some(prefix => trimmed.startsWith(prefix))
}

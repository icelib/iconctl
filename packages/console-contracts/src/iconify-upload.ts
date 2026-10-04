/** Transport validation only: core resolves selected icons, aliases and transforms. */
export function validateIconifyUpload(bytes: Uint8Array): void {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch {
    throw new Error('Iconify JSON upload must contain valid UTF-8 JSON')
  }
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || typeof value['prefix'] !== 'string' || !object(value['icons'])
    || (value['aliases'] !== undefined && !object(value['aliases']))
    || (value['not_found'] !== undefined && (!Array.isArray(value['not_found']) || !value['not_found'].every(name => typeof name === 'string')))) {
    throw new Error('Iconify JSON upload requires prefix, icons and valid optional aliases/not_found fields')
  }
}

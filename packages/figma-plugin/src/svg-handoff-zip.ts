import type { HandoffFile } from './svg-handoff-format'
import { zipSync } from 'fflate/browser'
import { handoffPath, MAX_HANDOFF_BYTES, MAX_HANDOFF_FILES, MAX_HANDOFF_ZIP_BYTES, svgByteLength } from './svg-handoff-format'

/** Only the iframe calls this: browser encoding and ZIP never enter the host. */
export function createHandoffZip(files: HandoffFile[]) {
  if (!files.length || files.length > MAX_HANDOFF_FILES) {
    throw new Error('SVG handoff must contain between 1 and 5000 icons.')
  }
  const entries: Record<string, Uint8Array> = Object.create(null)
  let total = 0
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const name = /^raw-svg\/(.+)\.svg$/.exec(file.path)?.[1]
    if (!name || handoffPath(name) !== file.path || Object.hasOwn(entries, file.path)) {
      throw new Error('SVG handoff contains an unsafe or duplicate path.')
    }
    const length = svgByteLength(file.svg)
    total += length
    if (length !== file.bytes || total > MAX_HANDOFF_BYTES) {
      throw new Error('SVG handoff exceeds 5 MiB or contains inconsistent byte counts.')
    }
    const encoded = new TextEncoder().encode(file.svg)
    if (encoded.byteLength !== length) {
      throw new Error('SVG handoff encoding changed. Export again.')
    }
    entries[file.path] = encoded
  }
  const zip = zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) })
  if (zip.byteLength > MAX_HANDOFF_ZIP_BYTES) {
    throw new Error('SVG handoff exceeds the 8 MiB ZIP limit.')
  }
  return zip
}

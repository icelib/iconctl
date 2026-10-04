import { Buffer, isUtf8 } from 'node:buffer'

/** Decode bytes without replacing malformed UTF-8 sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  if (!isUtf8(bytes)) {
    throw new Error('Invalid UTF-8 input')
  }
  // Keep a leading BOM for callers that have an explicit BOM policy. The
  // standalone JSON readers remove exactly one BOM; optional history readers
  // intentionally retain the existing JSON.parse behavior.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}

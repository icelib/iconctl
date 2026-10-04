import { Buffer, isUtf8 } from 'node:buffer'
import { decodeUtf8 } from '../src/json-input'

it('rejects malformed UTF-8 while preserving valid replacement characters and BOMs', () => {
  expect(decodeUtf8(Buffer.from('\uFEFF{"k":"�"}'))).toBe('\uFEFF{"k":"�"}')
  const invalid = Buffer.from('{"k":"v"}')
  invalid[invalid.indexOf('v')] = 255
  expect(() => decodeUtf8(invalid)).toThrow('Invalid UTF-8 input')
})

it('respects a Uint8Array view instead of decoding bytes outside the view', () => {
  const bytes = new Uint8Array([255, 123, 34, 107, 34, 58, 34, 118, 34, 125, 255])
  const view = bytes.subarray(1, 10)
  expect(isUtf8(view)).toBe(true)
  expect(decodeUtf8(view)).toBe('{"k":"v"}')
})

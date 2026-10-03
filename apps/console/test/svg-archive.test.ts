import { strFromU8, unzipSync } from 'fflate/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_SVG_ARCHIVE_BYTES, MAX_SVG_ARCHIVE_FILE_BYTES, MAX_SVG_ARCHIVE_FILES, svgArchive } from '../worker/svg-archive'

const encoded = (value: string) => btoa(value)
async function archive(files: Record<string, string>) {
  return new Uint8Array(await new Response(svgArchive(files)).arrayBuffer())
}
afterEach(() => vi.restoreAllMocks())

it('preserves stored bytes and safe names, independently of generated icon naming', async () => {
  const files = {
    'svg/con.svg': encoded('<svg/>'),
    'svg/arrows/LEFT_右.SVG': encoded('\x00\xFF\x10'),
    [`svg/${'a'.repeat(100)}.svg`]: '',
    'svg/foo--bar.svg': encoded('raw'),
    'svg/constructor.svg': encoded('text'),
    'svg/%2e%2e.svg': encoded('literal'),
    'svg/.iconctl-manifest.json': encoded('private metadata'),
    'icons.json': encoded('{}'),
    'preview.html': encoded('<script>never</script>'),
  }
  const bytes = await archive(files)
  const entries = unzipSync(bytes)
  expect(Object.keys(entries)).toEqual(Object.keys(files).filter(name => /\.svg$/i.test(name)).sort())
  for (const [name, value] of Object.entries(entries)) {
    expect(Array.from(value)).toEqual(Array.from(atob(files[name]!), char => char.charCodeAt(0)))
  }
  expect(bytes[8]).toBe(0) // STORE, not DEFLATE.
})

it('creates byte-identical archives across file insertion order and wall clock changes', async () => {
  const a = { 'svg/b.svg': encoded('B'), 'svg/a.svg': encoded('A') }
  const first = await archive(a)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2040-07-09T12:45:00Z'))
    expect(await archive(Object.fromEntries(Object.entries(a).reverse()))).toEqual(first)
  }
  finally {
    vi.useRealTimers()
  }
})

it.each(['svg/../bad.svg', 'svg//bad.svg', 'svg/./bad.svg', 'svg/.git/bad.svg', 'svg/back\\bad.svg', 'svg/bad:bad.svg', 'svg/bad\n.svg', 'svg/\uD800.svg', 'svg/\uDFFF.svg'])('rejects unsafe selected path %j before returning a stream', (name) => {
  expect(() => svgArchive({ [name]: encoded('bad') })).toThrow('ICONCTL_ERROR:409:')
})

it('rejects file/directory conflicts and excludes non-SVG entries', () => {
  expect(() => svgArchive({ 'svg/a.svg': '', 'svg/a.svg/b.svg': '' })).toThrow('conflicting')
  expect(() => svgArchive({ 'icons.json': 'invalid', 'svg/notes.txt': 'invalid' })).toThrow('ICONCTL_ERROR:404:')
})

it.each(['A', 'AA=', '=AAA', 'A===', 'AA A', 'AB==', 'AAB=', '!!!!'])('rejects malformed or noncanonical base64 %j', (value) => {
  expect(() => svgArchive({ 'svg/a.svg': value })).toThrow('ICONCTL_ERROR:409:')
})

it.each([null, [], { 'svg/a.svg': 1 }])('rejects invalid stored file representation %j', (files) => {
  expect(() => svgArchive(files)).toThrow('ICONCTL_ERROR:409:')
})

it('enforces the actual decoded file, total and count boundaries before streaming', async () => {
  const one = encoded('x'.repeat(MAX_SVG_ARCHIVE_FILE_BYTES))
  expect(strFromU8(unzipSync(await archive({ 'svg/a.svg': one }))['svg/a.svg']!)).toHaveLength(MAX_SVG_ARCHIVE_FILE_BYTES)
  expect(() => svgArchive({ 'svg/a.svg': encoded('x'.repeat(MAX_SVG_ARCHIVE_FILE_BYTES + 1)) })).toThrow('ICONCTL_ERROR:413:')
  const files = Object.fromEntries(Array.from({ length: MAX_SVG_ARCHIVE_BYTES / MAX_SVG_ARCHIVE_FILE_BYTES }, (_, index) => [`svg/i-${index}.svg`, one]))
  const atLimit = svgArchive(files)
  expect(atLimit).toBeInstanceOf(ReadableStream)
  await atLimit.cancel()
  expect(() => svgArchive({ ...files, 'svg/extra.svg': encoded('x') })).toThrow('ICONCTL_ERROR:413:')
  const many = Object.fromEntries(Array.from({ length: MAX_SVG_ARCHIVE_FILES }, (_, index) => [`svg/i-${index}.svg`, '']))
  expect(Object.keys(unzipSync(await archive(many)))).toHaveLength(MAX_SVG_ARCHIVE_FILES)
  expect(() => svgArchive({ ...many, 'svg/extra.svg': '' })).toThrow('ICONCTL_ERROR:413:')
})

it('decodes only a demanded member and drops later work on cancellation', async () => {
  const decode = vi.spyOn(globalThis, 'atob')
  const stream = svgArchive({ 'svg/a.svg': encoded('A'), 'svg/b.svg': encoded('B') })
  expect(decode).not.toHaveBeenCalled()
  const reader = stream.getReader()
  await reader.read()
  expect(decode).toHaveBeenCalledTimes(1)
  await reader.cancel()
  await Promise.resolve()
  expect(decode).toHaveBeenCalledTimes(1)
  expect(await reader.read()).toEqual({ done: true, value: undefined })
})

it('releases pending members when the request aborts', async () => {
  const controller = new AbortController()
  const decode = vi.spyOn(globalThis, 'atob')
  const reader = svgArchive({ 'svg/a.svg': encoded('A') }, controller.signal).getReader()
  controller.abort()
  await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  expect(decode).not.toHaveBeenCalled()
})

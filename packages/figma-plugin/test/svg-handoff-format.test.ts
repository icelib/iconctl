import { inspectComponents } from '../src/preflight'
import { handoffItems, handoffPath, MAX_HANDOFF_BYTES, MAX_HANDOFF_FILE_BYTES, MAX_HANDOFF_ZIP_BYTES, svgByteLength } from '../src/svg-handoff-format'
import { createHandoffZip } from '../src/svg-handoff-zip'

function sizedSvg(bytes: number) {
  return `<svg>${' '.repeat(bytes - 11)}</svg>`
}
function file(name: string, svg: string) {
  return { path: handoffPath(name), svg, bytes: svgByteLength(svg) }
}
function items(count: number) {
  return inspectComponents(Array.from({ length: count }, (_, index) => ({
    id: String(index),
    name: `icon-${index}`,
    type: 'COMPONENT',
    width: 24,
    height: 24,
  })))
}

it.each(['ASCII', 'é', '中文', '🙂', '中文🙂é'])('counts valid UTF-8 %s without host encoding APIs', (value) => {
  const svg = `<svg><title>${value}</title></svg>`
  expect(svgByteLength(svg)).toBe(new TextEncoder().encode(svg).byteLength)
})

it.each(['\uD800', '\uDC00', '\uD800x', '\uD800\uD800'])('rejects unmatched UTF-16 surrogate %j', (value) => {
  expect(() => svgByteLength(`<svg>${value}</svg>`)).toThrow('invalid Unicode')
})

it('enforces one MiB using UTF-8 bytes rather than UTF-16 code units', () => {
  const svg = `<svg>${'中'.repeat(349521)}  </svg>`
  expect(svgByteLength(svg)).toBe(MAX_HANDOFF_FILE_BYTES)
  expect(() => svgByteLength(svg.replace('</svg>', 'x</svg>'))).toThrow('1 MiB')
  expect(svgByteLength(sizedSvg(MAX_HANDOFF_FILE_BYTES))).toBe(MAX_HANDOFF_FILE_BYTES)
  expect(() => svgByteLength(sizedSvg(MAX_HANDOFF_FILE_BYTES + 1))).toThrow('1 MiB')
})

it.each(['', '<html/>', '<svg>', '<!DOCTYPE svg><svg/>'])('rejects invalid native SVG %j', (svg) => {
  expect(() => svgByteLength(svg)).toThrow()
})

it.each(['../escape', 'a/b', 'a\\b', 'a.svg', 'UPPER', 'con', 'lpt9', 'nul', 'x\0y', 'a'.repeat(229)])('rejects unsafe or non-portable filename %j', (name) => {
  expect(() => handoffPath(name)).toThrow('portable SVG filename')
})

it('allows the longest portable filename and rejects duplicate or over-limit item sets', () => {
  expect(handoffPath('a'.repeat(228))).toHaveLength(240)
  expect(handoffItems(items(5000), false)).toHaveLength(5000)
  expect(() => handoffItems(items(5001), false)).toThrow('5000')
  const duplicates = items(2)
  duplicates[1]!.iconName = duplicates[0]!.iconName
  expect(() => handoffItems(duplicates, false)).toThrow('Duplicate SVG filename')
})

it('enforces aggregate byte/count limits in the iframe too, and keeps the maximum reachable ZIP below its cap', () => {
  const exact = Array.from({ length: 5 }, (_, index) => file(`large-${index}`, sizedSvg(MAX_HANDOFF_FILE_BYTES)))
  expect(exact.reduce((total, entry) => total + entry.bytes, 0)).toBe(MAX_HANDOFF_BYTES)
  expect(createHandoffZip(exact).byteLength).toBeLessThan(MAX_HANDOFF_ZIP_BYTES)
  expect(() => createHandoffZip([...exact, file('extra', '<svg/>')])).toThrow('5 MiB')
  const all = Array.from({ length: 5000 }, (_, index) => file(`icon-${String(index).padStart(4, '0')}-${'a'.repeat(218)}`, '<svg/>'))
  // Both paths occur in ZIP headers. Max payload + all maximum-length paths
  // remains below 8 MiB; no valid input can reach the final defensive cap.
  const remaining = MAX_HANDOFF_BYTES - all.reduce((total, entry) => total + entry.bytes, 0)
  for (let index = 0, left = remaining; left > 0; index++) {
    const current = all[index]!
    const add = Math.min(MAX_HANDOFF_FILE_BYTES - current.bytes, left)
    current.svg = sizedSvg(current.bytes + add)
    current.bytes += add
    left -= add
  }
  const zip = createHandoffZip(all)
  expect(zip.byteLength).toBe(MAX_HANDOFF_BYTES + 5000 * (76 + 240 * 2) + 22)
  expect(zip.byteLength).toBeLessThan(MAX_HANDOFF_ZIP_BYTES)
  expect(() => createHandoffZip([...all, file('extra', '<svg/>')])).toThrow('5000')
})

it('refuses unsafe paths, duplicate entries and altered byte counts in delivery', () => {
  const valid = file('arrow', '<svg/>')
  expect(() => createHandoffZip([{ ...valid, path: '../arrow.svg' }])).toThrow('unsafe')
  expect(() => createHandoffZip([valid, valid])).toThrow('duplicate')
  expect(() => createHandoffZip([{ ...valid, bytes: 7 }])).toThrow('byte counts')
})

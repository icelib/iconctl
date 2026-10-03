import type { LoadedSource } from '../src/sources/types'
import { IconSet } from '@iconify/tools'
import { IconctlAbortError, mergeIconSets } from '../src'
import { mergeLoadedSources } from '../src/sources/load'

const fileKey = 'AbCdEfGhIjKlMnOpQrStUv'
function source(type: LoadedSource['type'], names = ['shared'], width = 24): LoadedSource {
  return {
    type,
    notModified: false,
    iconSet: new IconSet({ prefix: 'fixture', width, height: 24, icons: Object.fromEntries(names.map(name => [name, { body: '<path d="M0 0h24v24H0z"/>' }])) }),
    ...(type === 'figma' ? { iconOrigins: new Map(names.map(name => [name, { fileKey, nodeId: '1:2' }])) } : {}),
  }
}
afterEach(() => vi.restoreAllMocks())

it('retains configured indices across sources with no icon set and handles object-like names safely', async () => {
  const names = ['constructor', '__proto__']
  const result = await mergeLoadedSources('brand', [{ type: 'directory', notModified: false }, source('figma', names)])
  expect(result.iconSet.list()).toEqual(names)
  for (const name of names) {
    expect(result.origins.get(name)).toEqual({ sourceType: 'figma', sourceIndex: 1, fileKey, nodeId: '1:2' })
  }
})

it.each(['unreadable', 'rejected'] as const)('retains the earlier icon and origin when its replacement is %s', async (failure) => {
  const first = source('figma')
  const last = source('directory', ['shared'], 32)
  if (failure === 'unreadable') {
    vi.spyOn(last.iconSet!, 'toSVG').mockReturnValue(null)
  }
  else {
    const fromSVG = IconSet.prototype.fromSVG
    vi.spyOn(IconSet.prototype, 'fromSVG').mockImplementation(function (this: IconSet, name, svg) {
      return svg.viewBox.width === 32 ? false : fromSVG.call(this, name, svg)
    })
  }
  const result = await mergeLoadedSources('brand', [first, last])
  expect(result.iconSet.toSVG('shared')!.viewBox.width).toBe(24)
  expect(result.origins.get('shared')).toEqual({ sourceType: 'figma', sourceIndex: 0, fileKey, nodeId: '1:2' })
})

it('yields and stops merging on cancellation without visiting later icons', async () => {
  const input = source('figma', ['first', 'second'])
  const controller = new AbortController()
  const toSVG = input.iconSet!.toSVG.bind(input.iconSet)
  const read = vi.spyOn(input.iconSet!, 'toSVG').mockImplementation((...args) => {
    globalThis.setImmediate(() => controller.abort('cancel merge'))
    return toSVG(...args)
  })
  await expect(mergeLoadedSources('brand', [input], controller.signal)).rejects.toBeInstanceOf(IconctlAbortError)
  expect(read).toHaveBeenCalledTimes(1)
})

it('keeps the public merge helper returning an IconSet with last-source precedence', () => {
  const merged = mergeIconSets('brand', [source('figma').iconSet!, source('directory', ['shared'], 32).iconSet!])
  expect(merged).toBeInstanceOf(IconSet)
  expect(merged.toSVG('shared')!.viewBox.width).toBe(32)
})

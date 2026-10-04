import type { IconifyJSON } from '@iconify/types'
import { SVG } from '@iconify/tools'
import { IconctlError } from '../src/errors'
import { renderSvgSprite } from '../src/sprite-output'
import fixture from './fixtures/standalone-sprite.json'

type Node = SVG['$svg']
function descendants(node: Node): Node[] {
  return [node, ...node.children.flatMap(child => child.type === 'tag' ? descendants(child) : [])]
}
function symbols(xml: string): Node[] {
  return new SVG(xml.replace('<svg ', '<svg viewBox="0 0 1 1" ')).$svg.children.filter((child): child is Node => child.type === 'tag')
}

it('resolves the full collection once without changing names, colors, hidden icons or geometry', async () => {
  const original = structuredClone(fixture)
  const xml = await renderSvgSprite(fixture)
  const result = symbols(xml)
  const names = ['_dot.name', 'default', 'flipped', 'hidden', 'repeated', 'rotated', 'twice', 'wide']
  expect(result.map(node => node.attribs['id'])).toEqual(names.map(name => `iconctl-brand-${name}`))
  const byName = Object.fromEntries(result.map((node, index) => [names[index]!, node]))
  expect(byName['default']!.attribs['viewBox']).toBe('0 0 16 16')
  expect(byName['wide']!.attribs['viewBox']).toBe('-2 3 32 16')
  expect(byName['rotated']!.attribs['viewBox']).toBe('3 -2 16 32')
  expect(byName['flipped']!.attribs['viewBox']).toBe('0 0 16 32')
  expect(byName['twice']!.attribs['viewBox']).toBe('-2 3 32 16')
  expect(descendants(byName['rotated']!).filter(node => node.attribs['transform']).map(node => node.attribs['transform'])).toEqual(['rotate(90 11 11)'])
  expect(descendants(byName['flipped']!).filter(node => node.attribs['transform']).map(node => node.attribs['transform'])).toEqual(['rotate(90 8 8) translate(30 -3) scale(-1 1)'])
  expect(descendants(byName['twice']!).filter(node => node.attribs['transform']).map(node => node.attribs['transform'])).toEqual(['rotate(180 14 11)'])
  expect(xml).toContain('fill="red"')
  expect(xml).toContain('stroke="currentColor"')
  expect(xml).toContain('stop-color="#abc"')
  expect(byName['hidden']!.attribs).not.toHaveProperty('hidden')
  expect(xml).not.toContain('visibility=')
  const allIds: string[] = []
  for (const symbol of result) {
    const nodes = descendants(symbol)
    const ids = new Set(nodes.flatMap(node => node.attribs['id'] ? [String(node.attribs['id'])] : []))
    allIds.push(...ids)
    for (const node of nodes) {
      for (const [key, raw] of Object.entries(node.attribs)) {
        const value = String(raw)
        if (key === 'href') {
          expect(ids.has(value.slice(1))).toBe(true)
        }
        if (key === 'aria-labelledby') {
          expect(ids.has(value)).toBe(true)
        }
        if (value.startsWith('url(#')) {
          expect(ids.has(value.slice(5, -1))).toBe(true)
        }
      }
    }
  }
  expect(new Set(allIds).size).toBe(allIds.length)
  expect(fixture).toEqual(original)
  expect(xml.endsWith('</svg>\n')).toBe(true)
  const reversed = { ...fixture, icons: Object.fromEntries(Object.entries(fixture.icons).reverse()), aliases: Object.fromEntries(Object.entries(fixture.aliases).reverse()) }
  expect(await renderSvgSprite(reversed)).toBe(xml)
  expect(await renderSvgSprite(fixture)).toBe(xml)
})

it('renders an empty collection and still validates its prefix', async () => {
  expect(await renderSvgSprite({ prefix: 'empty', icons: {} })).toBe('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>\n')
  await expect(renderSvgSprite({ prefix: '', icons: {} })).rejects.toThrow('Invalid SVG sprite prefix')
})

it.each([
  { prefix: 'brand', icons: {}, aliases: { z: { parent: 'absent' }, a: { parent: 'missing' } } },
  { prefix: 'brand', icons: { valid: { body: '<path/>' }, invalid: { body: '<path/>', width: 0 } } },
  { prefix: 'brand', icons: {}, not_found: ['missing'] },
])('rejects the entire collection on resolver issues', async (json) => {
  await expect(renderSvgSprite(json)).rejects.toThrow(IconctlError)
  await expect(renderSvgSprite(json)).rejects.toThrow('Invalid SVG sprite icon set:')
})

it('retains sorted issue diagnostics and runtime structure validation', async () => {
  await expect(renderSvgSprite({ prefix: 'brand', icons: {}, aliases: { z: { parent: 'absent' }, a: { parent: 'missing' } } })).rejects.toThrow('Invalid SVG sprite icon set:\n- a: Icon or alias "missing" was not found.\n- z: Icon or alias "absent" was not found.')
  for (const value of [null, [], {}, { prefix: 'brand', icons: {}, width: 0 }]) {
    await expect(renderSvgSprite(value as IconifyJSON)).rejects.toThrow(IconctlError)
  }
})

it.each(['<path style="fill:red"/>', '<animate attributeName="opacity"/>', '<use href="#missing"/>'])('keeps renderer rejection without source cleanup: %s', async (body) => {
  await expect(renderSvgSprite({ prefix: 'brand', icons: { valid: { body: '<path/>' }, invalid: { body } } })).rejects.toThrow('SVG sprite icon "brand:invalid"')
})

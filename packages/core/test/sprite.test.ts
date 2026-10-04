import type { IconifyJSON } from '@iconify/types'
import { IconSet, parseSVG, SVG } from '@iconify/tools'
import { SaxesParser } from 'saxes'
import { IconctlAbortError, IconctlError } from '../src/errors'
import { generateSvgSprite } from '../src/sprite'

type SVGNode = SVG['$svg']

const shape = '<path fill="currentColor" d="M0 0h12v8H0z"/>'
function icons(body = shape, extra: Partial<IconifyJSON> = {}) {
  return new IconSet({ prefix: 'brand', width: 24, height: 24, lastModified: 1700000000, icons: { home: { body } }, ...extra })
}
function document(output: string) {
  return new SVG(output.replace('<svg ', '<svg viewBox="0 0 1 1" '))
}
function descendants(root: SVGNode): SVGNode[] {
  return [root, ...root.children.flatMap(child => child.type === 'tag' ? descendants(child) : [])]
}
function symbols(output: string): SVGNode[] {
  return document(output).$svg.children.filter((child): child is SVGNode => child.type === 'tag' && child.tag === 'symbol')
}
function tag(root: SVGNode, name: string) {
  return descendants(root).find(node => node.tag === name)!
}

it('renders sorted icons, aliases and variations with their resolved viewports and transformations', async () => {
  const set = icons('<title>A &amp; B</title><path fill="currentColor" d="M0 0h12v8H0z"/>', {
    width: 32,
    height: 16,
    left: -2,
    top: 3,
    aliases: {
      rotated: { parent: 'plain', rotate: 1 },
      plain: { parent: 'home' },
      flipped: { parent: 'home', hFlip: true },
      vertical: { parent: 'home', vFlip: true },
    },
  })
  const before = structuredClone(set.export())
  const output = await generateSvgSprite(set)
  const result = symbols(output)
  expect(result.map(node => node.attribs['id'])).toEqual(['flipped', 'home', 'plain', 'rotated', 'vertical'].map(name => `iconctl-brand-${name}`))
  expect(result.map(node => node.attribs['viewBox'])).toEqual(['0 0 32 16', '-2 3 32 16', '-2 3 32 16', '3 -2 16 32', '0 0 32 16'])
  for (const symbol of result) {
    const name = String(symbol.attribs['id']).slice('iconctl-brand-'.length)
    const original = set.toSVG(name)!
    expect(symbol.children).toEqual(original.$svg.children)
    expect(symbol.attribs).not.toHaveProperty('width')
    expect(symbol.attribs).not.toHaveProperty('height')
  }
  expect(output).toContain('<title>A &amp; B</title>')
  expect(output).toContain('fill="currentColor"')
  expect(output).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" xmlns:xlink="http:\/\/www.w3.org\/1999\/xlink">/)
  expect(output.endsWith('</svg>\n')).toBe(true)
  expect(set.export()).toEqual(before)
})

it('is byte-deterministic across insertion order, unrelated exports and concurrent calls', async () => {
  const body = '<defs><linearGradient id="a"/></defs><path fill="url(#a)" d="M0 0h8v8H0z"/>'
  const first = icons(body, { icons: { z: { body }, a: { body } } })
  const second = icons(body, { icons: { a: { body }, z: { body } } })
  const before = structuredClone(first.export())
  const expected = await generateSvgSprite(first)
  await generateSvgSprite(icons(body, { prefix: 'unrelated' }))
  expect(await generateSvgSprite(second)).toBe(expected)
  expect(await Promise.all(Array.from({ length: 4 }, () => generateSvgSprite(first)))).toEqual(Array.from({ length: 4 }).fill(expected))
  expect(first.export()).toEqual(before)
})

it('maps gradients, filters, masks, clips, markers, hrefs and ARIA references within each symbol', async () => {
  const body = `
    <title id="title">A &amp; B</title><desc id="description">A description</desc>
    <defs>
      <linearGradient id="base"><stop offset="0" stop-color="#abc"/></linearGradient>
      <linearGradient id="paint" href="#base"/>
      <clipPath id="clip"><path d="M0 0h8v8H0z"/></clipPath>
      <mask id="mask"><path fill="#fff" d="M0 0h8v8H0z"/></mask>
      <filter id="filter"><feGaussianBlur stdDeviation="0"/></filter>
      <marker id="marker" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></marker>
    </defs>
    <path id="shape" aria-labelledby="title description" aria-describedby="description"
      aria-controls="shape" aria-activedescendant="shape" aria-details="description"
      aria-errormessage="description" aria-flowto="shape" aria-owns="shape"
      fill="url( #paint )" stroke="url('#paint')" filter="url(&quot;#filter&quot;)"
      clip-path="url(#clip)" mask="url(#mask)" marker-start="url(#marker)"
      marker-mid="url(#marker)" marker-end="url(#marker)" d="M0 0h8v8H0z"/>
    <use href="#shape"/><use xlink:href="#shape"/>
  `
  const output = await generateSvgSprite(icons(body, { icons: { first: { body }, second: { body } } }))
  const globalIds: string[] = []
  for (const symbol of symbols(output)) {
    const nodes = descendants(symbol)
    const ids = new Set(nodes.flatMap(node => node.attribs['id'] === undefined ? [] : [String(node.attribs['id'])]))
    globalIds.push(...ids)
    const local = String(symbol.attribs['id'])
    expect(tag(symbol, 'title').attribs['id']).toBe(`${local}-id-0`)
    expect(tag(symbol, 'stop').attribs['stop-color']).toBe('#abc')
    expect(tag(symbol, 'feGaussianBlur').attribs['stdDeviation']).toBe('0')
    const path = nodes.find(node => node.attribs['aria-labelledby'] !== undefined)!
    expect(path.attribs['aria-labelledby']).toBe(`${local}-id-0 ${local}-id-1`)
    for (const node of nodes) {
      for (const [key, rawValue] of Object.entries(node.attribs)) {
        const value = String(rawValue)
        if (key === 'href' || key === 'xlink:href') {
          expect(ids.has(value.slice(1)), value).toBe(true)
        }
        else if (value.startsWith('url(#')) {
          expect(ids.has(value.slice(5, -1)), value).toBe(true)
        }
        else if (key.startsWith('aria-')) {
          expect(value.split(' ').every(id => ids.has(id)), value).toBe(true)
        }
      }
    }
  }
  expect(new Set(globalIds).size).toBe(globalIds.length)
})

it('reserves every public symbol ID and never cascades replacements through original IDs', async () => {
  const body = '<g id="a"><path d="M0 0h8v8H0z"/></g><g id="svgID0"/><g id="iconctl-brand-a-id-1"/><use href="#a"/><use href="#svgID0"/><use href="#iconctl-brand-a-id-1"/>'
  const output = await generateSvgSprite(icons(body, { icons: { 'a': { body }, 'a-id-0': { body: shape }, 'a-id-2': { body: shape } } }))
  const [first] = symbols(output)
  const localIds = descendants(first!).filter(node => node !== first && node.attribs['id'] !== undefined).map(node => node.attribs['id'])
  expect(localIds).toEqual(['iconctl-brand-a-id-1', 'iconctl-brand-a-id-3', 'iconctl-brand-a-id-4'])
  expect(descendants(first!).filter(node => node.tag === 'use').map(node => node.attribs['href'])).toEqual(localIds.map(id => `#${id}`))
  const ids: string[] = []
  parseSVG(document(output), ({ node }) => {
    if (node.attribs['id'] !== undefined) {
      ids.push(String(node.attribs['id']))
    }
  })
  expect(new Set(ids).size).toBe(ids.length)
})

it('accepts ASCII digits, colons, dots and hyphens without normalizing public or internal names', async () => {
  const set = icons('<path id="9:a.b_c-d" d="M0 0h8v8H0z"/><use href="#9:a.b_c-d"/>', { prefix: '9:A.b_c-d', icons: { '0:B.c_d-e': { body: '<path id="9:a.b_c-d" d="M0 0h8v8H0z"/><use href="#9:a.b_c-d"/>' } } })
  const [symbol] = symbols(await generateSvgSprite(set))
  expect(symbol!.attribs['id']).toBe('iconctl-9:A.b_c-d-0:B.c_d-e')
  expect(tag(symbol!, 'use').attribs['href']).toBe(`#${tag(symbol!, 'path').attribs['id']}`)
})

it.each(['url(#a)', ' url( #a ) ', 'url(\'#a\')', 'url("#a")', '\tURL(\n"#a"\r)\t'])('accepts a complete local URL token: %s', async (value) => {
  const body = `<defs><linearGradient id="a"/></defs><path fill="${value.replaceAll('"', '&quot;')}" d="M0 0h8v8H0z"/>`
  const [symbol] = symbols(await generateSvgSprite(icons(body)))
  expect(tag(symbol!, 'path').attribs['fill']).toBe('url(#iconctl-brand-home-id-0)')
})

it('preserves literal text, ordinary attributes, empty styles and numeric zero attributes', async () => {
  const set = icons('<text aria-label="literal #a &amp; url(#a)" data-label="url(#a)" x="0" y="0" opacity="0" style=" ">A &amp; B #a</text><path fill="#abc" stroke="burlywood" d="M0 0h8v8H0z"/>')
  const [symbol] = symbols(await generateSvgSprite(set))
  const text = tag(symbol!, 'text')
  expect(text.attribs).toMatchObject({ 'aria-label': 'literal #a &amp; url(#a)', 'data-label': 'url(#a)', 'x': '0', 'y': '0', 'opacity': '0', 'style': ' ' })
  expect(text.children).toEqual([{ type: 'text', content: 'A &amp; B #a' }])
  expect(tag(symbol!, 'path').attribs).toMatchObject({ fill: '#abc', stroke: 'burlywood' })
})

it('retains resolved root presentation attributes and remaps references to an existing root ID', async () => {
  const set = icons()
  const rendered = new SVG('<svg xmlns="http://www.w3.org/2000/svg" id="root" viewBox="-2 3 32 16" width="32" height="16" transform="translate(1 2)" fill="currentColor" opacity="0" role="img" aria-labelledby="title"><title id="title">Root label</title><path d="M0 0h8v8H0z" aria-controls="root"/></svg>')
  rendered.$svg.attribs['opacity'] = 0
  vi.spyOn(set, 'toString').mockReturnValue(rendered.toString())
  const [symbol] = symbols(await generateSvgSprite(set))
  expect(symbol!.attribs).toMatchObject({ 'id': 'iconctl-brand-home', 'viewBox': '-2 3 32 16', 'transform': 'translate(1 2)', 'fill': 'currentColor', 'opacity': '0', 'role': 'img', 'aria-labelledby': 'iconctl-brand-home-id-0' })
  expect(tag(symbol!, 'path').attribs['aria-controls']).toBe('iconctl-brand-home')
})

it('produces a valid empty sprite', async () => {
  const output = await generateSvgSprite(icons(shape, { icons: {} }))
  expect(output).toBe('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>\n')
})

it('preserves valid XML attribute quoting and spacing, decoded entities and mixed text', async () => {
  const body = `<defs><linearGradient id = 'paint'/></defs><path id = 'a&#58;b' fill = 'url("&#35;paint")' data-label = 'A > B &amp; "C"' d = 'M0 0h8v8H0z'/><use href = '&#35;a:b'/><text xml:space = 'preserve'> A <tspan>B &amp; C</tspan> D </text><text><![CDATA[A < B & C]]></text><desc>&amp;quot; is literal</desc>`
  const output = await generateSvgSprite(icons(body))
  expect(output).toContain('fill="url(#iconctl-brand-home-id-0)"')
  expect(output).toContain('href="#iconctl-brand-home-id-1"')
  expect(output).toContain('data-label="A &gt; B &amp; &quot;C&quot;"')
  expect(output).toContain('<text xml:space="preserve"> A <tspan>B &amp; C</tspan> D </text>')
  expect(output).toContain('<text>A &lt; B &amp; C</text>')
  expect(output).toContain('<desc>&amp;quot; is literal</desc>')
})

it('canonicalizes approved namespace prefixes while keeping href and xml attributes', async () => {
  const output = await generateSvgSprite(icons('<s:g xmlns:s="http://www.w3.org/2000/svg" xmlns:l="http://www.w3.org/1999/xlink"><s:path id="shape"/><s:use l:href="#shape"/><s:text xml:lang="en" xml:space="preserve"> A </s:text></s:g>'))
  expect(output).toContain('<g><path id="iconctl-brand-home-id-0"/><use xlink:href="#iconctl-brand-home-id-0"/>')
  expect(output).toContain('<text xml:lang="en" xml:space="preserve"> A </text>')
  expect(output).not.toContain('<s:')
})

it('preserves decoded XML whitespace through serialization and an independent parse', async () => {
  const output = await generateSvgSprite(icons('<g aria-label="line&#13;&#10;&#9;end" data-text="A&#9;B&#10;C&#13;D"><text>one&#13;two&#10;three&#9;four</text></g>'))
  const parser = new SaxesParser({ xmlns: true })
  let attributes: Record<string, string> = {}
  let text = ''
  let insideText = false
  parser.on('opentag', (node) => {
    if (node.local === 'g') {
      attributes = Object.fromEntries(Object.entries(node.attributes).map(([key, value]) => [key, value.value]))
    }
    insideText = node.local === 'text'
  })
  parser.on('text', (value) => {
    if (insideText) {
      text += value
    }
  })
  parser.on('closetag', () => {
    insideText = false
  })
  parser.write(output).close()
  expect(attributes).toEqual({ 'aria-label': 'line\r\n\tend', 'data-text': 'A\tB\nC\rD' })
  expect(text).toBe('one\rtwo\nthree\tfour')
})

it('rejects xml:id in both repeated definitions and local references instead of leaving global XML IDs', async () => {
  const body = '<path xml:id="shared"/>'
  const repeated = icons(body, { icons: { first: { body }, second: { body } } })
  await expect(generateSvgSprite(repeated)).rejects.toThrow('SVG sprite icon "brand:first": xml:id is not supported')
  await expect(generateSvgSprite(icons(`${body}<use href="#shared"/>`))).rejects.toThrow('SVG sprite icon "brand:home": xml:id is not supported')
})

it.each([
  ['DOCTYPE declarations', '<!DOCTYPE svg [<!ENTITY custom "text">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'],
  ['processing instructions', '<?xml-stylesheet href="external.css"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'],
  ['XML declarations', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'],
])('rejects %s before processing resolved SVG', async (message, rendered) => {
  const set = icons()
  vi.spyOn(set, 'toString').mockReturnValue(rendered)
  await expect(generateSvgSprite(set)).rejects.toThrow(`SVG sprite icon "brand:home": ${message}`)
})

it.each([
  ['duplicate ID', '<path id="a"/><g id="a"/>'],
  ['duplicate ID', '<path id=\'a\'/><g id=\'&#97;\'/>'],
  ['dangling fill reference', '<path fill="url(#missing)"/>'],
  ['dangling href reference', '<use href="#missing"/>'],
  ['dangling xlink:href reference', '<use xlink:href="#missing"/>'],
  ['dangling aria-labelledby reference', '<title id="a">A</title><path aria-labelledby="a missing"/>'],
  ['unsupported aria-controls reference', '<path id="a"/><path aria-controls="\u00A0a"/>'],
  ['unsupported ID', '<path id=""/>'],
  ['unsupported ID', '<path id="a b"/>'],
  ['unsupported ID', '<path id="路径"/>'],
  ['unsupported ID', '<path id="a%3Ab"/>'],
  ['unsupported ID', '<path id="a\\b"/>'],
  ['unsupported href reference', '<path id="a:b"/><use href="#a%3Ab"/>'],
  ['unsupported href reference', '<path id="a"/><use href="#a "/>'],
  ['external href reference', '<use href="other.svg#a"/>'],
  ['external href reference', '<use href="https://example.com/icons.svg#a"/>'],
  ['external href reference', '<use href = \'https&#58;//example.com/icons.svg#a\'/>'],
  ['external href reference', '<image href="data:image/svg+xml;base64,PHN2Zz4="/>'],
  ['unsupported fill value', '<path fill="url(other.svg#a)"/>'],
  ['unsupported fill value', '<path fill=\'u&#114;l(https://example.com/a.svg#paint)\'/>'],
  ['unsupported fill value', '<path fill=\'v&#97;r(--paint)\'/>'],
  ['unsupported fill value', '<g id="a"/><path fill="url(#a) red"/>'],
  ['unsupported filter value', '<g id="a"/><path filter="url(#a) url(#a)"/>'],
  ['unsupported fill value', '<path fill="var(--paint)"/>'],
  ['unsupported fill value', '<path fill="env(paint)"/>'],
  ['unsupported fill value', '<g id="a"/><path fill="u\\72l(#a)"/>'],
  ['unsupported fill value', '<g id="a"/><path fill="url(/*comment*/#a)"/>'],
  ['unsupported fill value', '<g id="a"/><path fill="url(#a"/>'],
  ['unsupported fill value', '<g id="a"/><path fill="url(#a%3Ab)"/>'],
  ['nonempty style', '<path style="fill:red"/>'],
  ['nonempty style', '<path style = \'fill:red\'/>'],
  ['nonempty style', '<path style="--paint:url(#a);fill:var(--paint)"/>'],
  ['unsupported static SVG element', '<style>path{fill:red}</style>'],
  ['unsupported static SVG element', '<script>alert(1)</script>'],
  ['unsupported static SVG element', '<foreignObject><div/></foreignObject>'],
  ['unsupported static SVG element', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/>'],
  ['<title> must contain text only', '<title><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/></title>'],
  ['<desc> must contain text only', '<desc><img srcset="https://example.com/a.png"/></desc>'],
  ['<desc> must contain text only', '<desc><image srcset="https://example.com/a.png"/></desc>'],
  ['unsupported static SVG element', '<animate attributeName="opacity" dur="1s"/>'],
  ['unsupported static SVG element', '<animateMotion path="M0 0h8" dur="1s"/>'],
  ['unsupported static SVG element', '<animateTransform attributeName="transform" dur="1s"/>'],
  ['unsupported static SVG element', '<animateColor attributeName="fill" dur="1s"/>'],
  ['unsupported static SVG element', '<set attributeName="fill" to="red"/>'],
  ['unsupported static SVG element', '<discard begin="1s"/>'],
  ['invalid SVG XML', '<foreign:path/>'],
  ['unsupported static SVG attribute', '<path onload="alert(1)"/>'],
  ['unsupported static SVG attribute', '<path onClick="alert(1)"/>'],
  ['unsupported static SVG attribute', '<path begin="a.end"/>'],
  ['unsupported static SVG attribute', '<path end="a.begin"/>'],
  ['external or base-relative', '<g xml:base="https://example.com"><use href="#a"/></g>'],
  ['external or base-relative', '<image src="https://example.com/a.png"/>'],
  ['unsupported namespace', '<g xmlns="http://www.w3.org/1999/xhtml"/>'],
  ['unsupported namespace', '<g xmlns:h="http://www.w3.org/1999/xhtml"/>'],
  ['unsupported attribute namespace', '<g xmlns:s="http://www.w3.org/2000/svg" s:fill="red"/>'],
  ['invalid SVG XML', '<path id="a" id="b"/>'],
  ['invalid SVG XML', '<g xmlns:a="http://www.w3.org/1999/xlink" xmlns:b="http://www.w3.org/1999/xlink"><path id="shape"/><use a:href="#shape" b:href="#shape"/></g>'],
  ['invalid SVG XML', '<path fill="url(&unknown;)"/>'],
  ['invalid SVG XML', '<text>&unknown;</text>'],
  ['invalid SVG XML', '<path id="&#0;"/>'],
  ['invalid SVG XML', '<path id="&#xD800;"/>'],
  ['invalid SVG XML', '<path id="&#xFFFF;"/>'],
  ['unsupported attribute spelling', '<path ID="a"/>'],
  ['unsupported attribute spelling', '<path id="a"/><use HREF="#a"/>'],
])('rejects %s with icon-specific typed errors: %s', async (message, body) => {
  const task = generateSvgSprite(icons(body))
  await expect(task).rejects.toBeInstanceOf(IconctlError)
  await expect(task).rejects.toThrow(`SVG sprite icon "brand:home": ${message}`)
})

it('does not resolve a dangling local reference through another icon', async () => {
  const set = icons(shape, { icons: { first: { body: '<path id="shape"/>' }, second: { body: '<use href="#shape"/>' } } })
  await expect(generateSvgSprite(set)).rejects.toThrow('SVG sprite icon "brand:second": dangling href reference "shape"')
})

it.each(['中文', 'with space', 'slash/name', 'quote"name', '', 'line\nname', 'line\n'])('rejects unsupported prefixes and icon names without normalization: %s', async (value) => {
  await expect(generateSvgSprite(icons(shape, { prefix: value }))).rejects.toThrow('Invalid SVG sprite prefix')
  await expect(generateSvgSprite(icons(shape, { icons: { [value]: { body: shape } } }))).rejects.toThrow('Invalid SVG sprite icon name')
})

it('rejects unresolved aliases and wraps renderer failures with the icon identity', async () => {
  const unresolved = icons(shape, { aliases: { broken: { parent: 'absent' } } })
  await expect(generateSvgSprite(unresolved)).rejects.toThrow('SVG sprite icon "brand:broken": could not resolve its SVG')
  const set = icons()
  const failure = new Error('invalid source SVG')
  vi.spyOn(set, 'toString').mockImplementation(() => {
    throw failure
  })
  await expect(generateSvgSprite(set)).rejects.toMatchObject({ message: 'SVG sprite icon "brand:home" could not be rendered', cause: failure })
})

it.each([0, -1, Number.POSITIVE_INFINITY])('rejects a non-renderable resolved viewport width: %s', async (width) => {
  await expect(generateSvgSprite(icons(shape, { width }))).rejects.toThrow('SVG sprite icon "brand:home": invalid resolved viewBox')
})

it('cancels before rendering and between symbols without mutating the IconSet', async () => {
  const set = icons(shape, { icons: { first: { body: shape }, second: { body: shape } } })
  const before = structuredClone(set.export())
  const controller = new AbortController()
  controller.abort('already stopped')
  const render = vi.spyOn(set, 'toString')
  await expect(generateSvgSprite(set, controller.signal)).rejects.toBeInstanceOf(IconctlAbortError)
  expect(render).not.toHaveBeenCalled()
  const midRun = new AbortController()
  const original = set.toString.bind(set)
  render.mockRestore()
  const during = vi.spyOn(set, 'toString').mockImplementation((name) => {
    midRun.abort('between symbols')
    return original(name)
  })
  await expect(generateSvgSprite(set, midRun.signal)).rejects.toBeInstanceOf(IconctlAbortError)
  expect(during).toHaveBeenCalledTimes(1)
  expect(set.export()).toEqual(before)
})

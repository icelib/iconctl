import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { renderPreviewHtml } from '../src/preview'

function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' })[entity]!)
}

function iconData(html: string): { name: string, cssClass: string | null }[] {
  return [...html.matchAll(/<figure class="icon" data-icon="([^"]*)">/g)].map(match => JSON.parse(decodeAttribute(match[1]!)))
}

function contents(html: string, tag: 'style' | 'script'): string {
  return html.split(`<${tag}>`)[1]!.split(`</${tag}>`)[0]!
}

const body = '<path d="M0 0h8v8H0z"/>'

it('keeps every resolved icon and alias in the static document, including hidden metadata', () => {
  const html = renderPreviewHtml({
    prefix: 'brand',
    width: 24,
    height: 16,
    icons: { zebra: { body }, arrow: { body, hidden: true } },
    aliases: { rotated: { parent: 'arrow', rotate: 1 } },
  })
  expect(iconData(html)).toEqual([
    { name: 'brand:arrow', cssClass: 'i-brand-arrow' },
    { name: 'brand:rotated', cssClass: 'i-brand-rotated' },
    { name: 'brand:zebra', cssClass: 'i-brand-zebra' },
  ])
  expect(html).toContain('<p id="count" class="count" role="status">3 of 3 icons</p>')
  expect([...html.matchAll(/<figure[^>]+>/g)].every(([tag]) => !tag.includes(' hidden'))).toBe(true)
  expect(html).toContain('class="controls" data-enhance hidden')
  expect(html.match(/class="actions" data-enhance hidden/g)).toHaveLength(3)
  expect(html).toContain('<label for="search">Search icons<input id="search" type="search"')
  expect(html).toContain('<code>brand:arrow</code>')
  const images = [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)].map(match => Buffer.from(match[1]!, 'base64').toString())
  expect(images).toHaveLength(3)
  expect(images[1]).toContain('viewBox="0 0 16 24"')
  expect(images[1]).toContain('rotate(90')
})

it('provides a useful static empty collection with no copy actions', () => {
  const html = renderPreviewHtml({ prefix: 'empty', icons: {} })
  expect(iconData(html)).toEqual([])
  expect(html).toContain('>0 of 0 icons</p>')
  expect(html).toContain('<p id="empty">This collection has no icons.</p>')
  expect(html).not.toContain('data-copy="')
})

it.each([
  ['brand', 'arrow-left', 'i-brand-arrow-left'],
  ['brand2', '2-arrow', 'i-brand2-2-arrow'],
  ['Brand', 'arrow', null],
  ['brand', 'two words', null],
  ['brand', 'arrow_left', null],
  ['brand', 'arrow--left', null],
  ['brand', '-arrow', null],
  ['brand', 'arrow-', null],
  ['品牌', '箭头', null],
])('offers conventional CSS classes for supported names without renaming %s:%s', (prefix, name, cssClass) => {
  const html = renderPreviewHtml({ prefix, icons: { [name]: { body } } })
  expect(iconData(html)).toEqual([{ name: `${prefix}:${name}`, cssClass }])
  expect(html).toContain('type="button" data-copy="name"')
  if (cssClass) {
    expect(html).toContain('type="button" data-copy="class"')
    expect(html).toContain(`<code class="class-name">${cssClass}</code>`)
  }
  else {
    expect(html).not.toContain('data-copy="class"')
    expect(html).toContain('CSS class unavailable for this name.')
  }
})

it('round-trips adversarial names in inert JSON without inserting executable markup', () => {
  const prefix = 'brand\r\n\0"<&\'😀'
  const name = '</script><script>globalThis.previewInjected=true</script>" onload="bad [.*+?\\\r\n\0\uD800'
  const marker = '<script>document.body.dataset.injected="true"</script>'
  const svg = `${marker}<foreignObject><div>unsafe</div></foreignObject><image href="https://example.invalid/pixel"/>${body}`
  const html = renderPreviewHtml({ prefix, icons: { [name]: { body: svg } } })
  expect(iconData(html)).toEqual([{ name: `${prefix}:${name}`, cssClass: null }])
  expect(html).not.toContain(marker)
  expect(html).not.toContain('<foreignObject>')
  expect(html).not.toContain('https://example.invalid/pixel')
  expect(html).not.toContain('</script><script>')
  expect(html.match(/<script>/g)).toHaveLength(1)
  expect(html).not.toContain('<svg')
  expect(html).toContain('&lt;/script&gt;')
  const image = html.match(/src="data:image\/svg\+xml;base64,([^"]+)"/)![1]!
  expect(Buffer.from(image, 'base64').toString()).toContain(svg)
})

it('hashes the exact fixed script and style bytes without broadening the content policy', () => {
  const ordinary = renderPreviewHtml({ prefix: 'brand', icons: { arrow: { body } } })
  const hostile = renderPreviewHtml({ prefix: '</script>"', icons: { '<style>bad': { body } } })
  const policy = decodeAttribute(ordinary.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1]!)
  const hash = (value: string) => createHash('sha256').update(value).digest('base64')
  const script = contents(ordinary, 'script')
  const css = contents(ordinary, 'style')
  expect(contents(hostile, 'script')).toBe(script)
  expect(contents(hostile, 'style')).toBe(css)
  expect(policy).toBe(`default-src 'none'; img-src data:; style-src 'sha256-${hash(css)}'; script-src 'sha256-${hash(script)}'; base-uri 'none'; form-action 'none'; object-src 'none'`)
  expect(css).toContain('[hidden] { display: none !important; }')
})

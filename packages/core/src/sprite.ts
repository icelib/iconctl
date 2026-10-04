import type { IconSet } from '@iconify/tools'
import type { SpriteElement } from './sprite-xml'
import { checkpoint } from './abort'
import { IconctlError } from './errors'
import { parseSpriteSvg, serializeSpriteElement } from './sprite-xml'

const identifier = /^[\w.:-]+$/
const whitespace = /^[\t\n\f\r ]*$/
const localUrl = /^[\t\n\f\r ]*url\([\t\n\f\r ]*(?:#([\w.:-]+)|'#([\w.:-]+)'|"#([\w.:-]+)")[\t\n\f\r ]*\)[\t\n\f\r ]*$/i
const urlAttributes = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor', 'color-profile'])
const idRefAttributes = new Set(['aria-activedescendant', 'aria-controls', 'aria-describedby', 'aria-details', 'aria-errormessage', 'aria-flowto', 'aria-labelledby', 'aria-owns'])
const staticTags = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'title',
  'desc',
  'metadata',
  'switch',
  'image',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
])

/** A deterministic static exporter; source cleanup and general SVG sanitizing are separate. */
export async function generateSvgSprite(iconSet: IconSet, signal?: AbortSignal): Promise<string> {
  await checkpoint(signal)
  const prefix = iconSet.prefix
  if (!identifier.test(prefix)) {
    throw new IconctlError(`Invalid SVG sprite prefix "${prefix}": use only ASCII letters, digits, _, ., :, and -`)
  }
  const names = iconSet.list(['icon', 'variation', 'alias']).sort()
  const publicIds = new Map<string, string>()
  const usedIds = new Set<string>()
  for (const name of names) {
    if (!identifier.test(name)) {
      throw new IconctlError(`Invalid SVG sprite icon name "${prefix}:${name}": use only ASCII letters, digits, _, ., :, and -`)
    }
    const id = `iconctl-${prefix}-${name}`
    if (usedIds.has(id)) {
      throw new IconctlError(`Conflicting SVG sprite symbol ID "${id}"`)
    }
    publicIds.set(name, id)
    usedIds.add(id)
  }
  const symbols: string[] = []
  for (const name of names) {
    await checkpoint(signal)
    const fail = (message: string): never => {
      throw new IconctlError(`SVG sprite icon "${prefix}:${name}": ${message}`)
    }
    let rendered: string | null
    try {
      // toSVG() parses this same resolved XML with a lossy parser. Keep the
      // viewport and transformations while preserving all XML syntax and text.
      rendered = iconSet.toString(name)
    }
    catch (cause) {
      throw new IconctlError(`SVG sprite icon "${prefix}:${name}" could not be rendered`, { cause })
    }
    const { root, nodes } = parseSpriteSvg(rendered ?? fail('could not resolve its SVG'), fail)
    const viewBox = root.attribs['viewBox']?.trim().split(/[\s,]+/).map(Number)
    if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
      fail('invalid resolved viewBox')
    }
    const publicId = publicIds.get(name)!
    const ids = new Map<string, string>()
    let counter = 0
    // Reserve every public symbol before allocating anything local. Source IDs
    // that already resemble generated names still receive their own mapping.
    for (const node of nodes) {
      if (!staticTags.has(node.tag)) {
        fail(`unsupported static SVG element <${node.tag}>`)
      }
      if (Object.hasOwn(node.attribs, 'id')) {
        const original = node.attribs['id']!
        if (!identifier.test(original)) {
          fail(`unsupported ID "${original}": use only ASCII letters, digits, _, ., :, and -`)
        }
        if (ids.has(original)) {
          fail(`duplicate ID "${original}"`)
        }
        let next = publicId
        if (node !== root) {
          do {
            next = `${publicId}-id-${counter++}`
          } while (usedIds.has(next))
          usedIds.add(next)
        }
        ids.set(original, next)
      }
    }
    const reference = (original: string, attribute: string) => {
      if (!identifier.test(original)) {
        return fail(`unsupported ${attribute} reference "${original}"`)
      }
      const target = ids.get(original)
      return target ?? fail(`dangling ${attribute} reference "${original}"`)
    }
    // Rewrite once from the original attributes, after the complete map exists.
    for (const node of nodes) {
      for (const [attribute, rawValue] of Object.entries(node.attribs)) {
        const key = attribute.toLowerCase()
        const value = rawValue
        if (attribute !== key && (key === 'id' || key === 'href' || key === 'xlink:href' || urlAttributes.has(key) || idRefAttributes.has(key))) {
          fail(`unsupported attribute spelling "${attribute}": use "${key}"`)
        }
        if (key.startsWith('on') || key === 'begin' || key === 'end') {
          fail(`unsupported static SVG attribute "${attribute}"`)
        }
        if (key === 'style' && !whitespace.test(value)) {
          fail('nonempty style attributes are not supported')
        }
        if (key === 'xml:id') {
          fail('xml:id is not supported; use an unqualified id attribute')
        }
        if (key === 'xml:base' || key === 'src') {
          fail(`external or base-relative references in "${attribute}" are not supported`)
        }
        if (key === 'id') {
          node.attribs[attribute] = ids.get(value) ?? fail(`unsupported ID attribute "${attribute}"`)
        }
        else if (key === 'href' || key === 'xlink:href') {
          if (!value.startsWith('#')) {
            fail(`external ${attribute} reference "${value}" is not supported`)
          }
          node.attribs[attribute] = `#${reference(value.slice(1), attribute)}`
        }
        else if (idRefAttributes.has(key)) {
          const tokens = value.split(/[\t\n\f\r ]+/).filter(Boolean)
          node.attribs[attribute] = tokens.map(token => reference(token, attribute)).join(' ')
        }
        else if (urlAttributes.has(key)) {
          const match = localUrl.exec(value)
          if (match) {
            node.attribs[attribute] = `url(#${reference(match[1] ?? match[2] ?? match[3]!, attribute)})`
          }
          else if (/(?:^|\W)(?:url|var|env)\b/i.test(value) || /\\|\/\*/.test(value)) {
            fail(`unsupported ${attribute} value "${value}": expected a whole local url(#id) token`)
          }
        }
      }
    }
    const attributes: SpriteElement['attribs'] = { ...root.attribs, id: publicId }
    // Each symbol owns its viewport; the enclosing sprite has no shared size.
    delete attributes['width']
    delete attributes['height']
    symbols.push(serializeSpriteElement({ ...root, tag: 'symbol', attribs: attributes }))
  }
  await checkpoint(signal)
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${symbols.join('')}</svg>\n`
}

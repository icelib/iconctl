import { SaxesParser } from 'saxes'

export interface SpriteElement {
  type: 'tag'
  tag: string
  attribs: Record<string, string>
  children: SpriteNode[]
}
export type SpriteNode = SpriteElement | { type: 'text', content: string }

const svgNamespace = 'http://www.w3.org/2000/svg'
const xlinkNamespace = 'http://www.w3.org/1999/xlink'
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace'
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/'
const namespaces = new Set([svgNamespace, xlinkNamespace, xmlNamespace])

/** Parse resolved SVG without losing quoted attributes, entities or mixed text. */
export function parseSpriteSvg(source: string, fail: (message: string) => never): { root: SpriteElement, nodes: SpriteElement[] } {
  const parser = new SaxesParser({ xmlns: true })
  const nodes: SpriteElement[] = []
  const stack: SpriteElement[] = []
  let root: SpriteElement | undefined
  parser.on('error', error => fail(`invalid SVG XML: ${error.message}`))
  parser.on('doctype', () => fail('DOCTYPE declarations are not supported'))
  parser.on('processinginstruction', () => fail('processing instructions are not supported'))
  parser.on('xmldecl', () => fail('XML declarations are not supported inside resolved SVG'))
  parser.on('opentag', (tag) => {
    if (tag.uri !== svgNamespace) {
      fail(`unsupported namespace "${tag.uri}"`)
    }
    const node: SpriteElement = { type: 'tag', tag: tag.local, attribs: Object.create(null) as Record<string, string>, children: [] }
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === xmlnsNamespace) {
        if (!namespaces.has(attribute.value)) {
          fail(`unsupported namespace "${attribute.value}"`)
        }
        // The output declares SVG/xlink once; element prefixes are canonicalized.
        continue
      }
      const key = attribute.uri === ''
        ? attribute.local
        : attribute.uri === xlinkNamespace
          ? `xlink:${attribute.local}`
          : attribute.uri === xmlNamespace
            ? `xml:${attribute.local}`
            : fail(`unsupported attribute namespace "${attribute.uri}"`)
      node.attribs[key] = attribute.value
    }
    const parent = stack.at(-1)
    if (parent) {
      if (parent.tag === 'title' || parent.tag === 'desc') {
        fail(`<${parent.tag}> must contain text only`)
      }
      parent.children.push(node)
    }
    else {
      root = node
    }
    nodes.push(node)
    stack.push(node)
  })
  parser.on('closetag', () => stack.pop())
  const text = (content: string) => {
    stack.at(-1)?.children.push({ type: 'text', content })
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.write(source).close()
  if (!root || root.tag !== 'svg') {
    fail('expected an SVG root element')
  }
  return { root: root!, nodes }
}

function escape(value: string, attribute = false): string {
  const encoded = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\r', '&#13;')
  // XML normalizes literal attribute whitespace and literal CR in text. Entity
  // spellings preserve the decoded values through a second XML parse.
  return attribute ? encoded.replaceAll('\n', '&#10;').replaceAll('\t', '&#9;') : encoded
}

/** Iterative serialization also keeps deeply nested static groups off the stack. */
export function serializeSpriteElement(root: SpriteElement): string {
  const pieces: string[] = []
  const pending: (SpriteNode | string)[] = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (typeof node === 'string') {
      pieces.push(node)
    }
    else if (node.type === 'text') {
      pieces.push(escape(node.content))
    }
    else {
      const attributes = Object.entries(node.attribs).map(([key, value]) => ` ${key}="${escape(value, true)}"`).join('')
      pieces.push(`<${node.tag}${attributes}${node.children.length ? '>' : '/>'}`)
      if (node.children.length) {
        pending.push(`</${node.tag}>`)
        for (let index = node.children.length - 1; index >= 0; index--) {
          pending.push(node.children[index]!)
        }
      }
    }
  }
  return pieces.join('')
}

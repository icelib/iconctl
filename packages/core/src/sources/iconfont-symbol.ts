export interface ParsedIconfontSymbol {
  id: string
  viewBox: string
  body: string
}

const symbolPattern = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/gi

function attribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match?.[1]
}

export function parseIconfontSymbols(js: string): {
  symbols: ParsedIconfontSymbol[]
  failures: { name: string, message: string }[]
} {
  const symbols: ParsedIconfontSymbol[] = []
  const failures: { name: string, message: string }[] = []
  let index = 0
  for (const match of js.matchAll(symbolPattern)) {
    index++
    const attrs = match[1] ?? ''
    const body = (match[2] ?? '').trim()
    const id = attribute(attrs, 'id')
    if (!id?.trim()) {
      failures.push({ name: `symbol-${index}`, message: 'The iconfont symbol is missing its id.' })
      continue
    }
    if (!body) {
      failures.push({ name: id, message: 'The iconfont symbol has no SVG content.' })
      continue
    }
    symbols.push({
      id,
      viewBox: attribute(attrs, 'viewBox') ?? '0 0 1024 1024',
      body,
    })
  }
  return { symbols, failures }
}

export function parseIconfontSymbolJs(js: string): ParsedIconfontSymbol[] {
  return parseIconfontSymbols(js).symbols
}

export function symbolToSvg(symbol: ParsedIconfontSymbol): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol.viewBox}">${symbol.body}</svg>`
}

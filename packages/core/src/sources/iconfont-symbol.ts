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

export function parseIconfontSymbolJs(js: string): ParsedIconfontSymbol[] {
  const symbols: ParsedIconfontSymbol[] = []
  for (const match of js.matchAll(symbolPattern)) {
    const attrs = match[1] ?? ''
    const body = (match[2] ?? '').trim()
    const id = attribute(attrs, 'id')
    if (!id || !body) {
      continue
    }
    symbols.push({
      id,
      viewBox: attribute(attrs, 'viewBox') ?? '0 0 1024 1024',
      body,
    })
  }
  return symbols
}

export function symbolToSvg(symbol: ParsedIconfontSymbol): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol.viewBox}">${symbol.body}</svg>`
}

import type { IconifyJSON } from '@iconify/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'
import { compareIconSets } from './diff'
import { escapeHtml, htmlDocument, iconImage } from './html'

export function renderPreviewHtml(json: IconifyJSON): string {
  const comparison = compareIconSets(undefined, json)
  const icons = comparison.icons
    .map(({ name, after }) => `<figure class="icon">${iconImage(after!, `${json.prefix}:${name}`)}<figcaption>${escapeHtml(`${json.prefix}:${name}`)}</figcaption></figure>`)
    .join('\n')
  const css = `
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #172b3a; background: #f4f6f8; }
    h1 { font-size: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }
    .icon { margin: 0; padding: 12px; border: 1px solid #d3dde4; border-radius: 12px; background: white; }
    img { display: block; margin: 0 auto 8px; object-fit: contain; }
    figcaption { font-size: 12px; text-align: center; word-break: break-all; }
`
  return htmlDocument(`${json.prefix} icons`, `<h1>${escapeHtml(json.prefix)} · ${comparison.icons.length} icons</h1><div class="grid">${icons}</div>`, css)
}

export async function writePreviewHtml(file: string, json: IconifyJSON) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, renderPreviewHtml(json), 'utf8')
}

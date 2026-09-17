import type { IconifyJSON } from '@iconify/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'

export function renderPreviewHtml(json: IconifyJSON): string {
  const icons = Object.entries(json.icons)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, icon]) => {
      const width = icon.width ?? json.width ?? 24
      const height = icon.height ?? json.height ?? 24
      return `
        <figure class="icon">
          <svg viewBox="0 0 ${width} ${height}" width="32" height="32" aria-hidden="true">${icon.body}</svg>
          <figcaption>${json.prefix}:${name}</figcaption>
        </figure>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${json.prefix} icons</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; }
    h1 { font-size: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }
    .icon { margin: 0; padding: 12px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; }
    svg { display: block; margin: 0 auto 8px; }
    figcaption { font-size: 12px; text-align: center; word-break: break-all; }
  </style>
</head>
<body>
  <h1>${json.prefix} · ${Object.keys(json.icons).length} icons</h1>
  <div class="grid">${icons}</div>
</body>
</html>
`
}

export async function writePreviewHtml(file: string, json: IconifyJSON) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, renderPreviewHtml(json), 'utf8')
}

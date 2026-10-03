import type { NormalizedIconifyIcon } from './iconify-json'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]!)
}

/** SVG image documents do not execute scripts or share the report's DOM. */
export function iconImage(icon: NormalizedIconifyIcon, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.left} ${icon.top} ${icon.width} ${icon.height}" fill="currentColor">${icon.body}</svg>`
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" alt="${escapeHtml(label)}" width="64" height="64" loading="lazy">`
}

export function htmlDocument(title: string, body: string, css: string, script = ''): string {
  const hash = (value: string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`
  const policy = `default-src 'none'; img-src data:; style-src ${hash(css)}; script-src ${script ? hash(script) : '\'none\''}; base-uri 'none'; form-action 'none'; object-src 'none'`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>\n`
}

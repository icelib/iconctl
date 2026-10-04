import type { IconComparisonEntry, IconSetComparison } from './diff'
import { escapeHtml, htmlDocument, iconImage } from './html'
import { writeHtmlReport } from './html-output'
import { writeTextOutput } from './text-output'

const css = `
:root { font-family: system-ui, sans-serif; color: #172b3a; background: #f4f6f8; }
* { box-sizing: border-box; } body { max-width: 1240px; margin: auto; padding: 40px 24px; }
h1 { margin: 8px 0 12px; font-size: clamp(24px, 4vw, 36px); } .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: 12px; color: #536878; }
.meta, .count { color: #536878; } .prefix { padding: 16px; background: #fff3d4; border-left: 4px solid #9a6400; }
.summary { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 28px 0; }
.controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; margin: 24px 0; }
label { display: grid; gap: 6px; font-size: 13px; } input, select { font: inherit; padding: 10px 12px; border: 1px solid #aebdc8; border-radius: 6px; background: white; color: inherit; }
input { width: min(360px, 80vw); } .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.icon { background: white; border: 1px solid #d3dde4; border-radius: 8px; padding: 20px; min-width: 0; }
.icon[hidden] { display: none; } .icon h2 { font-size: 15px; overflow-wrap: anywhere; margin: 0 0 10px; }
.status { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #536878; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
figure { margin: 0; text-align: center; } .image { height: 88px; display: grid; place-items: center; background: #f6f8fa; border-radius: 6px; }
img { max-width: 100%; object-fit: contain; } figcaption { color: #536878; font-size: 12px; line-height: 1.6; margin-top: 8px; overflow-wrap: anywhere; }
.empty { padding: 24px 0; } footer { margin-top: 40px; color: #536878; font-size: 12px; }
`
const script = `
const search = document.getElementById('search');
const status = document.getElementById('status');
const cards = Array.from(document.querySelectorAll('.icon'));
function filter() {
  const query = search.value.toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const match = card.dataset.name.toLowerCase().includes(query) && (status.value === 'all' || card.dataset.status === status.value);
    card.hidden = !match;
    if (match) visible++;
  }
  document.getElementById('count').textContent = visible + ' of ' + cards.length + ' icons';
  document.getElementById('empty').hidden = visible !== 0;
}
search.addEventListener('input', filter);
status.addEventListener('change', filter);
filter();
`

function side(entry: IconComparisonEntry, position: 'before' | 'after', prefix: string | null) {
  const icon = entry[position]
  const label = `${position === 'before' ? 'Before' : 'After'} · ${prefix ?? '—'}:${entry.name}`
  return `<figure><div class="image">${icon ? iconImage(icon, label) : '<span aria-label="Not present">—</span>'}</div><figcaption>${position === 'before' ? 'Before' : 'After'}${icon ? `<br>${escapeHtml(String(icon.width))} × ${escapeHtml(String(icon.height))}${icon.hidden ? ' · hidden' : ''}` : '<br>Not present'}</figcaption></figure>`
}

/** Build a portable report with no external assets or executable icon markup. */
export function renderDiffHtml(comparison: IconSetComparison): string {
  const { diff } = comparison
  const prefix = `${comparison.beforePrefix ?? '(empty)'} → ${comparison.afterPrefix}`
  const cards = comparison.icons.map(entry => `<article class="icon" data-name="${escapeHtml(entry.name)}" data-status="${escapeHtml(entry.status)}"><h2>${escapeHtml(entry.name)}</h2><span class="status">${escapeHtml(entry.status)}</span><div class="pair">${side(entry, 'before', comparison.beforePrefix)}${side(entry, 'after', comparison.afterPrefix)}</div></article>`).join('\n')
  const body = `<header><p class="eyebrow">iconctl · offline review</p><h1>Icon changes</h1><p class="meta">${escapeHtml(prefix)}</p>
${comparison.prefixChanged ? '<p class="prefix">Prefix changed. Consumers must update the icon namespace even when individual icons are unchanged.</p>' : ''}
<div class="summary"><span>Added <strong>${diff.added.length}</strong></span><span>Changed <strong>${diff.changed.length}</strong></span><span>Removed <strong>${diff.removed.length}</strong></span><span>Unchanged <strong>${diff.unchanged.length}</strong></span></div></header>
<div class="controls"><label>Search icons<input id="search" type="search" placeholder="Icon name" autocomplete="off"></label><label>Filter changes<select id="status"><option value="all">All icons</option><option value="added">Added</option><option value="changed">Changed</option><option value="removed">Removed</option><option value="unchanged">Unchanged</option></select></label><span class="count" id="count" role="status"></span></div>
<main class="grid">${cards}</main><p id="empty" class="empty" hidden>No icons match this filter.</p><footer>Compared after resolving Iconify aliases, dimensions and transformations. SVG path text is compared as supplied; this is not a pixel comparison.</footer>`
  return htmlDocument('Icon changes · iconctl', body, css, script)
}

export interface WriteDiffHtmlOptions {
  /** Protect source files from replacement, including symlink and hard-link aliases. */
  inputs?: readonly string[]
  /** Validate the report and destination without creating files or directories. */
  dryRun?: boolean
}

export async function writeDiffHtml(file: string, comparison: IconSetComparison, options: WriteDiffHtmlOptions = {}): Promise<void> {
  await writeHtmlReport(file, renderDiffHtml(comparison), options)
}

function markdownCell(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function markdownIcon(icon: IconComparisonEntry['before'] | IconComparisonEntry['after']) {
  if (!icon) {
    return '—'
  }
  const dimensions = `${icon.width} × ${icon.height}${icon.hidden ? ' · hidden' : ''}`
  return `\`${markdownCell(dimensions)}\``
}

/** Render a deterministic Markdown summary for code review and offline archives. */
export function renderDiffMarkdown(comparison: IconSetComparison): string {
  const { diff } = comparison
  const lines = [
    '<!-- iconctl diff v1 -->',
    '# Icon changes',
    '',
    `- Before prefix: \`${markdownCell(comparison.beforePrefix ?? '(empty)')}\``,
    `- After prefix: \`${markdownCell(comparison.afterPrefix)}\``,
    `- Prefix changed: **${comparison.prefixChanged ? 'yes' : 'no'}**`,
    `- Added: **${diff.added.length}** · Changed: **${diff.changed.length}** · Removed: **${diff.removed.length}** · Unchanged: **${diff.unchanged.length}**`,
    '',
    '| Icon | Status | Before | After |',
    '| --- | --- | --- | --- |',
  ]
  for (const entry of comparison.icons) {
    lines.push(`| ${markdownCell(entry.name)} | ${entry.status} | ${markdownIcon(entry.before)} | ${markdownIcon(entry.after)} |`)
  }
  lines.push('', '_Compared after resolving Iconify aliases, dimensions and transformations; SVG path text is compared as supplied._', '')
  return lines.join('\n')
}

export async function writeDiffMarkdown(file: string, comparison: IconSetComparison, options: WriteDiffHtmlOptions = {}): Promise<void> {
  await writeTextOutput(file, renderDiffMarkdown(comparison), { ...options, label: 'Markdown report' })
}

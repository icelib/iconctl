import type { IconifyJSON } from '@iconify/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'pathe'
import { compareIconSets } from './diff'
import { escapeHtml, htmlDocument, iconImage } from './html'

const css = `
:root { font-family: system-ui, sans-serif; color: #172b3a; background: #f4f6f8; }
* { box-sizing: border-box; } body { max-width: 1240px; margin: auto; padding: 32px 24px; }
h1 { margin: 0 0 12px; font-size: clamp(24px, 4vw, 36px); overflow-wrap: anywhere; }
p { line-height: 1.6; } .note, .count { color: #536878; } .note { font-size: 13px; }
.controls { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: end; margin-top: 24px; }
label { display: grid; gap: 6px; font-size: 14px; } input, button { font: inherit; color: inherit; background: white; border: 1px solid #aebdc8; border-radius: 6px; padding: 9px 12px; }
input { width: 100%; max-width: 100%; } label { width: min(360px, 100%); max-width: 100%; }
button { cursor: pointer; font-size: 12px; } button:hover { background: #eef4f8; }
:focus-visible { outline: 3px solid #176a9a; outline-offset: 3px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 16px; margin-top: 24px; }
.icon { margin: 0; padding: 16px; min-width: 0; border: 1px solid #d3dde4; border-radius: 8px; background: white; }
img { display: block; margin: 0 auto 12px; object-fit: contain; max-width: 100%; }
figcaption { font-size: 13px; text-align: center; overflow-wrap: anywhere; } .class-name { display: block; margin-top: 8px; color: #536878; font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
.manual { padding: 16px; margin-top: 16px; border: 1px solid #aebdc8; border-radius: 8px; background: white; }
.manual p { margin-top: 0; } pre { padding: 12px; background: #f4f6f8; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
[hidden] { display: none !important; }
`

// Icon metadata is decoded from inert JSON attributes, never inserted into script.
const script = `
const search = document.getElementById('search');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const feedback = document.getElementById('copy-status');
const manual = document.getElementById('manual-copy');
const manualValue = document.getElementById('copy-value');
const dismiss = document.getElementById('dismiss-copy');
const records = Array.from(document.querySelectorAll('.icon')).map(card => {
  const data = JSON.parse(card.dataset.icon);
  return { card, name: data.name, cssClass: data.cssClass, search: [data.name, data.cssClass].filter(value => value !== null).map(value => value.toLowerCase()) };
});
let copyAction = 0;
let copyTrigger;
function filter() {
  const query = search.value.toLowerCase();
  let visible = 0;
  for (const record of records) {
    const match = record.search.some(value => value.includes(query));
    record.card.hidden = !match;
    if (match) visible++;
  }
  count.textContent = visible + ' of ' + records.length + ' icons';
  empty.hidden = visible !== 0;
  empty.textContent = records.length ? 'No icons match this search.' : 'This collection has no icons.';
}
async function copy(value, button) {
  const action = ++copyAction;
  copyTrigger = button;
  manual.hidden = true;
  feedback.textContent = 'Copying…';
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (action === copyAction) feedback.textContent = 'Copied ' + value;
  } catch {
    if (action !== copyAction) return;
    manualValue.textContent = value;
    manual.hidden = false;
    feedback.textContent = 'Automatic copy is unavailable. Select the value below and copy it manually.';
    if (document.activeElement === button) {
      manualValue.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(manualValue);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
}
for (const record of records) {
  for (const button of record.card.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copy(button.dataset.copy === 'name' ? record.name : record.cssClass, button));
  }
}
dismiss.addEventListener('click', () => {
  ++copyAction;
  manual.hidden = true;
  feedback.textContent = '';
  window.getSelection()?.removeAllRanges();
  if (copyTrigger && !copyTrigger.closest('.icon').hidden) copyTrigger.focus();
  else search.focus();
});
search.addEventListener('input', filter);
filter();
for (const control of document.querySelectorAll('[data-enhance]')) control.hidden = false;
`

function utilityClass(prefix: string, name: string): string | null {
  const part = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  return part.test(prefix) && part.test(name) ? `i-${prefix}-${name}` : null
}

export function renderPreviewHtml(json: IconifyJSON): string {
  const comparison = compareIconSets(undefined, json)
  const icons = comparison.icons.map(({ name, after }) => {
    const fullName = `${json.prefix}:${name}`
    const cssClass = utilityClass(json.prefix, name)
    // JSON escapes control characters that HTML parsing would otherwise normalize.
    const data = escapeHtml(JSON.stringify({ name: fullName, cssClass }))
    return `<figure class="icon" data-icon="${data}">${iconImage(after!, fullName)}<figcaption><code>${escapeHtml(fullName)}</code>${cssClass ? `<code class="class-name">${escapeHtml(cssClass)}</code>` : '<span class="class-name">CSS class unavailable for this name.</span>'}</figcaption>
<div class="actions" data-enhance hidden><button type="button" data-copy="name" aria-label="Copy Iconify name: ${escapeHtml(fullName)}">Copy Iconify name</button>${cssClass ? `<button type="button" data-copy="class" aria-label="Copy CSS class: ${escapeHtml(cssClass)}">Copy CSS class</button>` : ''}</div></figure>`
  }).join('\n')
  const total = comparison.icons.length
  const body = `<header><h1>${escapeHtml(json.prefix)} icons</h1><p class="note">CSS classes use the i-prefix-name convention for configured icon utilities. Names outside lowercase letters, digits and single hyphens have no class shortcut.</p></header>
<div class="controls" data-enhance hidden><label for="search">Search icons<input id="search" type="search" placeholder="Iconify name or CSS class" autocomplete="off" spellcheck="false"></label></div>
<p id="count" class="count" role="status">${total} of ${total} icons</p>
<p id="copy-status" role="status" aria-live="polite" aria-atomic="true"></p>
<section id="manual-copy" class="manual" aria-label="Manual copy" hidden><p>Select the value and press your usual copy shortcut, or use the browser’s Copy command.</p><pre id="copy-value" tabindex="0" aria-label="Value to copy"></pre><button id="dismiss-copy" type="button">Dismiss manual copy</button></section>
<main class="grid">${icons}</main><p id="empty"${total ? ' hidden' : ''}>This collection has no icons.</p>`
  return htmlDocument(`${json.prefix} icons`, body, css, script)
}

export async function writePreviewHtml(file: string, json: IconifyJSON) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, renderPreviewHtml(json), 'utf8')
}

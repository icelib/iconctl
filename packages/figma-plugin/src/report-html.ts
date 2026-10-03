import type { PreflightDocument } from './report'

function text(value: string | number) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[character]!)
}

function field(label: string, value: string | number) {
  return `<div><dt>${text(label)}</dt><dd>${text(value)}</dd></div>`
}

/** A static document: all untrusted scan data is rendered as literal text. */
export function renderPreflightHtml(report: PreflightDocument): string {
  const { rules, summary } = report
  const source = report.rulesSource === 'project' ? 'Project rules' : report.rulesSource === 'legacy-defaults' ? 'Legacy GitHub defaults' : 'Unpaired defaults'
  const naming = rules.namingMode === 'server'
    ? 'Names are provisional until custom server naming runs.'
    : 'Default local naming. Duplicate names are checked on this page.'
  const components = report.items.map((item, index) => {
    const status = item.skipped ? 'Skipped draft' : item.issues.length ? 'Needs fixes' : 'Passed local checks'
    const issues = item.issues.length
      ? `<ul class="issues">${item.issues.map(issue => `<li>${text(issue)}</li>`).join('')}</ul>`
      : `<p class="muted">${item.skipped ? 'Excluded by a skip prefix.' : 'No local issues.'}</p>`
    return `<article aria-labelledby="component-${index}">
      <div class="component-title"><h3 id="component-${index}">${text(item.name || '(empty name)')}</h3><span class="badge ${item.skipped ? 'skipped' : item.issues.length ? 'problem' : 'passed'}">${status}</span></div>
      <dl class="component-meta">${field('Node ID', item.id)}${field(rules.namingMode === 'server' ? 'Provisional icon name' : 'Icon name', item.iconName ?? '(none)')}${field('Canvas', `${item.width} × ${item.height}`)}</dl>
      ${issues}
    </article>`
  }).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <title>${text(report.page.name)} · iconctl preflight</title>
  <style>
    :root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; color: #1d2939; background: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1000px; padding: 48px 28px; margin: auto; }
    header { border-bottom: 2px solid #243e56; padding-bottom: 24px; }
    h1 { font-size: clamp(1.8rem, 5vw, 2.6rem); line-height: 1.15; letter-spacing: -.035em; margin: 12px 0; }
    h2 { font-size: 1.25rem; margin: 0 0 16px; }
    h3 { font-size: 1rem; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    p { margin: 10px 0; }
    .eyebrow { color: #40576b; font-weight: 700; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; }
    .muted, dt { color: #526276; }
    .page-name { font-size: 1.2rem; overflow-wrap: anywhere; }
    .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; padding: 24px 0; }
    .summary div { background: white; border: 1px solid #d8e0e7; border-radius: 8px; padding: 16px; }
    .summary strong { font-size: 1.8rem; display: block; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .summary span { font-size: .8rem; color: #526276; }
    section { margin: 28px 0; }
    dl { margin: 0; }
    .metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; }
    dt { font-size: .8rem; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .notice { background: #e8eef4; padding: 16px 20px; border-left: 3px solid #405f7a; border-radius: 4px; }
    article { padding: 20px; margin: 12px 0; border: 1px solid #d8e0e7; border-radius: 8px; background: white; break-inside: avoid; }
    .component-title { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .component-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr); gap: 12px; margin-top: 14px; }
    .badge { font-size: .75rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .passed { color: #175c42; background: #e7f3eb; }
    .problem { color: #8a321c; background: #fff0e8; }
    .skipped { color: #526276; background: #edf0f3; }
    .issues { padding-left: 20px; margin-bottom: 0; color: #8a321c; overflow-wrap: anywhere; white-space: pre-wrap; }
    footer { border-top: 1px solid #d8e0e7; padding-top: 16px; font-size: .8rem; color: #526276; }
    @media (max-width: 640px) { main { padding: 28px 16px; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metadata, .component-meta { grid-template-columns: 1fr; } .component-title { align-items: flex-start; flex-direction: column; gap: 8px; } }
    @media print { :root { background: white; font-size: 11pt; } main { max-width: none; padding: 0; } .summary div, article { border-color: #aeb9c3; } h2 { break-after: avoid; } .summary { break-inside: avoid; } }
  </style>
</head>
<body>
<main>
  <header><div class="eyebrow">iconctl · Figma</div><h1>Preflight report</h1><p class="page-name">${text(report.page.name)}</p><p class="muted">Complete captured page scan · ${text(report.generatedAt)}</p></header>
  <div class="summary" aria-label="Scan summary">
    <div><strong>${text(summary.total)}</strong><span>Total components</span></div>
    <div><strong>${text(summary.checked)}</strong><span>Checked</span></div>
    <div><strong>${text(summary.skipped)}</strong><span>Skipped drafts</span></div>
    <div><strong>${text(summary.withIssues)}</strong><span>Components with issues</span></div>
    <div><strong>${text(summary.issueCount)}</strong><span>Total issues</span></div>
  </div>
  <aside class="notice"><strong>${summary.canSubmit ? 'Local preflight passed.' : 'Local preflight is not ready for submission.'}</strong><p>Server validation is still required. ${text(naming)}</p></aside>
  <section aria-labelledby="rules"><h2 id="rules">Applied rules and scan</h2><dl class="metadata">
    ${report.project ? field('Project', report.project.name) + field('Project revision', report.project.revision) : ''}
    ${field('Rule source', source)}${field('Connection mode', report.mode)}${field('Page ID', report.page.id)}${field('Scan ID', report.scanId)}
    ${field('Width', rules.width ?? 'Unrestricted')}${field('Height', rules.height ?? 'Unrestricted')}${field('Name pattern', rules.name)}${field('Skip prefixes', rules.skipPrefix.length ? rules.skipPrefix.map(prefix => JSON.stringify(prefix)).join(', ') : 'None')}
  </dl></section>
  <section aria-labelledby="components"><h2 id="components">All components</h2><p class="muted">Includes skipped drafts and results hidden by plugin filters. Use your browser’s Find to locate a component or node ID.</p>
    ${components || '<p>No components were found in this scan.</p>'}
  </section>
  <footer>Captured ${text(report.generatedAt)} · Report schema ${text(report.schemaVersion)} · Current page only. This file can be read and printed offline.</footer>
</main>
</body>
</html>`
}

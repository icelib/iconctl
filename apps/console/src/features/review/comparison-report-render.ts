import type { SnapshotIssue } from '@iconctl/console-contracts'
import type { ComparisonReport, ReportEntry, ReportFormat, ReportIcon } from './comparison-report'
import { captureComparisonReport, REPORT_LIMITS, reportFilename } from './comparison-report'

const encoder = new TextEncoder()
const labels = { added: '新增', changed: '修改', removed: '删除' }
const css = `
:root{font-family:system-ui,sans-serif;color:#172b3a;background:#f4f6f8;color-scheme:light}
*{box-sizing:border-box}body{max-width:1120px;margin:auto;padding:32px 24px;overflow-wrap:anywhere}
h1{font-size:28px}h2{font-size:21px;margin-top:32px}h3{font-size:16px;margin:0 0 16px}
p,dd{white-space:pre-wrap}dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 16px}dt{color:#536878}dd{margin:0}
.summary{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}.notice{padding:16px;background:#fff3d4;border-left:4px solid #9a6400}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}
article{min-width:0;padding:20px;background:white;border:1px solid #d3dde4;border-radius:8px;break-inside:avoid}
.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}figure{min-width:0;margin:0;text-align:center}
.image{height:96px;display:grid;place-items:center;background:#f6f8fa}img{width:64px;height:64px;max-width:100%;object-fit:contain}
figcaption{font-size:12px;color:#536878;margin-top:8px}.diagnostic{margin:12px 0}.meta,footer{font-size:12px;color:#536878}footer{margin-top:32px}
@media(max-width:480px){body{padding:20px 12px}dl{grid-template-columns:minmax(0,1fr)}dd{margin-bottom:8px}}
@media print{:root{background:white;color:black}body{max-width:none;padding:0}article{border-radius:0}.grid{display:block}article{margin-bottom:12px}.notice{background:white}h2,h3{break-after:avoid}a{color:inherit}}
`

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]!)
}
function image(icon: ReportIcon | null, label: string): string {
  if (!icon) {
    return '<div class="image">—</div><figcaption>不存在</figcaption>'
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width} ${icon.height}" fill="currentColor">${icon.body}</svg>`
  const bytes = encoder.encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return `<div class="image"><img src="data:image/svg+xml;base64,${btoa(binary)}" alt="${escape(label)}" width="64" height="64"></div><figcaption>${escape(icon.width)} × ${escape(icon.height)}</figcaption>`
}
function card(entry: ReportEntry, report: ComparisonReport): string {
  return `<article data-status="${entry.status}"><h3>${escape(entry.name)}</h3><div class="pair"><figure>${image(entry.before, `之前 · ${report.prefixes.before ?? '空集'}:${entry.name}`)}<figcaption>之前</figcaption></figure><figure>${image(entry.after, `之后 · ${report.prefixes.after}:${entry.name}`)}<figcaption>之后</figcaption></figure></div></article>\n`
}
function metadata(snapshot: ComparisonReport['snapshot']): string {
  return `<dl><dt>快照</dt><dd>${escape(snapshot.id)}</dd><dt>项目</dt><dd>${escape(snapshot.projectId)}</dd><dt>生成任务</dt><dd>${escape(snapshot.jobId)}</dd><dt>尝试</dt><dd>${snapshot.attempt}</dd><dt>创建时间（UTC）</dt><dd>${new Date(snapshot.createdAt).toISOString()}</dd><dt>SHA-256</dt><dd>${escape(snapshot.digest)}</dd><dt>图标 / 问题</dt><dd>${snapshot.iconCount} / ${snapshot.issues}</dd></dl>`
}
function diagnostic(issue: SnapshotIssue): string {
  return `<article class="diagnostic"><h3>${escape(issue.name)}</h3><p>${escape(issue.message)}</p><p class="meta">阶段：${escape(issue.stage ?? '未记录')} · 来源：${escape(issue.sourceType ?? '未记录')}${issue.sourceIndex === undefined ? '' : ` #${issue.sourceIndex + 1}`}${issue.fileKey === undefined ? '' : ` · 文件 ${escape(issue.fileKey)}`}${issue.nodeId === undefined ? '' : ` · 节点 ${escape(issue.nodeId)}`}</p></article>\n`
}
function* htmlParts(report: ComparisonReport): Generator<string> {
  const baseline = report.comparison.snapshot
  const baselineLabel = report.comparison.mode === 'release'
    ? report.comparison.release ? `发布版本 v${report.comparison.release.version}` : '首次发布 · 空图标集'
    : baseline ? report.comparison.mode === 'snapshot' ? '指定快照' : '上次同步' : '无历史快照 · 空图标集'
  yield `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>快照比较报告 · iconctl</title><style>${css}</style></head><body><header><p class="meta">iconctl · 离线审核 · 格式版本 1</p><h1>快照比较报告</h1><p>完整增删改与全部诊断，不包含未变化图标。可使用浏览器打印功能保存或打印本报告。</p></header><main><section aria-label="当前快照"><h2>当前快照</h2>${metadata(report.snapshot)}</section><section aria-label="比较基准"><h2>比较基准</h2><p>${escape(baselineLabel)}</p>${report.comparison.release ? `<p>发布 ID：${escape(report.comparison.release.id)}</p>` : ''}${baseline ? metadata(baseline) : '<p>之前没有图标。</p>'}</section><section aria-label="变化摘要"><h2>变化摘要</h2><p>Prefix：${escape(report.prefixes.before ?? '（空集）')} → ${escape(report.prefixes.after)}</p>${report.prefixes.changed ? '<p class="notice">命名空间已变化。即使图像相同，调用方也需要更新图标 prefix。</p>' : ''}<div class="summary"><span>新增 ${report.diff.added.length}</span><span>修改 ${report.diff.changed.length}</span><span>删除 ${report.diff.removed.length}</span></div>${report.icons.length ? '' : '<p>没有新增、修改或删除的图标。</p>'}</section>\n`
  for (const status of ['added', 'changed', 'removed'] as const) {
    yield `<section aria-label="${labels[status]}图标"><h2>${labels[status]}（${report.diff[status].length}）</h2><div class="grid">\n`
    for (const entry of report.icons) {
      if (entry.status === status) {
        yield card(entry, report)
      }
    }
    yield '</div></section>\n'
  }
  yield `<section aria-label="快照诊断"><h2>全部诊断</h2><p>问题 ${report.diagnostics.issues.length} · 处理失败 ${report.diagnostics.failed.length}</p>\n`
  for (const issue of report.diagnostics.issues) {
    yield diagnostic(issue)
  }
  for (const name of report.diagnostics.failed) {
    yield `<p>处理失败：${escape(name)}</p>\n`
  }
  yield '</section></main><footer>分类直接采用在线审核结果；图像沿用在线的原始 SVG body 与有效尺寸。扩展元数据变化可能被列为修改，即使图像相同。本报告不是图标集、发布确认或工作空间备份。</footer></body></html>\n'
}

/** Serialize the small allowlisted object graph without first making one unbounded string. */
function* jsonParts(value: unknown, depth = 0): Generator<string> {
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value)
    return
  }
  const array = Array.isArray(value)
  const entries = Object.entries(value)
  yield array ? '[' : '{'
  for (let index = 0; index < entries.length; index++) {
    const [key, entry] = entries[index]!
    yield `${index ? ',' : ''}\n${'  '.repeat(depth + 1)}${array ? '' : `${JSON.stringify(key)}: `}`
    yield* jsonParts(entry, depth + 1)
  }
  yield `${entries.length ? `\n${'  '.repeat(depth)}` : ''}${array ? ']' : '}'}`
  if (depth === 0) {
    yield '\n'
  }
}

function nextTask(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 0)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function renderComparisonReport(report: ComparisonReport, format: ReportFormat, signal: AbortSignal): Promise<Blob> {
  const parts: string[] = []
  const group: string[] = []
  let bytes = 0
  let groupBytes = 0
  let steps = 0
  signal.throwIfAborted()
  // A real task yield lets navigation/cancellation run even for a small report.
  await nextTask(signal)
  const chunks = format === 'json' ? jsonParts(report) : htmlParts(report)
  for (const chunk of chunks) {
    signal.throwIfAborted()
    const length = encoder.encode(chunk).byteLength
    bytes += length
    if (bytes > REPORT_LIMITS.outputBytes) {
      throw new Error('比较报告超过文件 8 MiB 限制，未生成文件')
    }
    group.push(chunk)
    groupBytes += length
    steps++
    if (groupBytes >= 64 * 1024 || steps >= 1000) {
      parts.push(group.join(''))
      group.length = 0
      groupBytes = 0
      steps = 0
      await nextTask(signal)
    }
  }
  signal.throwIfAborted()
  parts.push(group.join(''))
  return new Blob(parts, { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' })
}

export async function createComparisonReport(preview: Parameters<typeof captureComparisonReport>[0], format: ReportFormat, signal: AbortSignal) {
  signal.throwIfAborted()
  const report = captureComparisonReport(preview)
  const blob = await renderComparisonReport(report, format, signal)
  signal.throwIfAborted()
  return { blob, filename: reportFilename(report, format) }
}

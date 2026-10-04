import type { IconJSON, Snapshot, SnapshotPreview } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { captureComparisonReport, REPORT_LIMITS, reportFilename } from '../src/features/review/comparison-report'
import { createComparisonReport, renderComparisonReport } from '../src/features/review/comparison-report-render'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
function snapshot(value = 1): Snapshot {
  return { id: id(value), jobId: id(10), projectId: id(20), digest: 'a'.repeat(64), createdAt: 1_700_000_000_000, iconCount: 4, issues: 1 }
}
function fixture(): SnapshotPreview {
  return {
    snapshot: { ...snapshot(), baselineId: id(99) },
    previous: { prefix: 'before', width: 24, height: 32, icons: { changed: { body: '<path/>', width: 12 }, removed: { body: '<circle/>' }, metadata: { body: '<path/>' }, unchanged: { body: '<g/>' } } },
    content: {
      json: { prefix: 'after', icons: { added: { body: '<rect/>' }, changed: { body: '<path d="M1 1"/>', width: 48, height: 48 }, metadata: { body: '<path/>' }, unchanged: { body: '<g/>' } } },
      files: { 'private.json': 'SECRET_FILE_MARKER' },
      sources: [{ type: 'directory', notModified: false }],
      issues: [{ name: 'absent', message: 'Failed before producing an icon', stage: 'download', sourceType: 'figma', sourceIndex: 0, fileKey: 'file-1', nodeId: '1:2' }, { name: 'old', message: 'Legacy issue' }],
      failed: ['missing-output'],
    },
    diff: { added: ['added'], changed: ['changed', 'metadata'], removed: ['removed'] },
    comparison: { mode: 'release', snapshot: snapshot(2), release: { id: id(30), version: '1.2.3', snapshotId: id(2) } },
  }
}
function added(names: string[], body = ''): SnapshotPreview {
  const value = fixture()
  value.previous = undefined
  value.comparison = { mode: 'previous', snapshot: null, release: null }
  value.content = { json: { prefix: 'p', icons: Object.fromEntries(names.map(name => [name, { body }])) }, files: {}, issues: [], failed: [], sources: [] }
  value.diff = { added: names, changed: [], removed: [] }
  return value
}
const render = (preview: SnapshotPreview, format: 'json' | 'html' = 'json') => createComparisonReport(preview, format, new AbortController().signal)

it('preserves the API classifications, exact release baseline, legacy attempt and online dimension inheritance', () => {
  const input = fixture()
  const report = captureComparisonReport(input)
  expect(report.diff).toEqual(input.diff)
  expect(report.snapshot).toMatchObject({ id: id(1), attempt: 1 })
  expect(report.snapshot).not.toHaveProperty('baselineId')
  expect(report.comparison).toMatchObject({ mode: 'release', snapshot: { id: id(2), attempt: 1 }, release: { id: id(30), version: '1.2.3' } })
  expect(report.prefixes).toEqual({ before: 'before', after: 'after', changed: true })
  expect(report.icons).toEqual([
    { name: 'added', status: 'added', before: null, after: { body: '<rect/>', width: 16, height: 16 } },
    { name: 'changed', status: 'changed', before: { body: '<path/>', width: 12, height: 32 }, after: { body: '<path d="M1 1"/>', width: 48, height: 48 } },
    { name: 'metadata', status: 'changed', before: { body: '<path/>', width: 24, height: 32 }, after: { body: '<path/>', width: 16, height: 16 } },
    { name: 'removed', status: 'removed', before: { body: '<circle/>', width: 24, height: 32 }, after: null },
  ])
  expect(report.diagnostics).toEqual({ issues: input.content.issues, failed: input.content.failed })
})

it('never normalizes or reclassifies a metadata-only change whose visible images are equal', () => {
  const input = fixture()
  input.previous!.width = 16
  input.previous!.height = 16
  Object.assign(input.content.json.icons.metadata!, { extension: 'PRIVATE_EXTENSION', rotate: 1 })
  Object.defineProperty(input.content, 'files', { get: () => {
    throw new Error('Must not read files')
  } })
  Object.defineProperty(input.content, 'sources', { get: () => {
    throw new Error('Must not read sources')
  } })
  const report = captureComparisonReport(input)
  const entry = report.icons.find(icon => icon.name === 'metadata')!
  expect(entry.status).toBe('changed')
  expect(entry.before).toEqual(entry.after)
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_EXTENSION|unchanged|SECRET_FILE_MARKER|rotate/)
})

it.each(['previous', 'release'] as const)('represents a %s empty baseline explicitly', (mode) => {
  const input = added(['one'])
  input.comparison.mode = mode
  expect(captureComparisonReport(input)).toMatchObject({ comparison: { mode, snapshot: null, release: null }, prefixes: { before: null, after: 'p', changed: false }, icons: [{ before: null }] })
})

it('keeps zero-change, self-comparison and prefix-only reports without inventing entries', async () => {
  const input = fixture()
  input.diff = { added: [], changed: [], removed: [] }
  input.comparison = { mode: 'snapshot', snapshot: input.snapshot, release: null }
  input.previous = input.content.json
  const noChanges = captureComparisonReport(input)
  expect(noChanges.icons).toEqual([])
  expect(noChanges.prefixes.changed).toBe(false)
  input.previous = { ...input.content.json, prefix: 'old-prefix' }
  const changed = captureComparisonReport(input)
  expect(changed.icons).toEqual([])
  const html = await (await render(input, 'html')).blob.text()
  expect(html).toContain('命名空间已变化')
  expect(html).toContain('没有新增、修改或删除的图标')
  expect(html).toContain('missing-output')
})

it('uses own icon properties for prototype-like names and ignores inherited records', () => {
  const input = added(['__proto__', 'constructor'])
  expect(captureComparisonReport(input).icons.map(icon => icon.name)).toEqual(['__proto__', 'constructor'])
  input.content.json.icons = Object.create({ constructor: { body: '<g/>' } }) as IconJSON['icons']
  input.diff.added = ['constructor']
  expect(() => captureComparisonReport(input)).toThrow('不一致')
})

it.each([
  (value: SnapshotPreview) => { value.previous = undefined },
  (value: SnapshotPreview) => { value.comparison.snapshot = null },
  (value: SnapshotPreview) => { value.comparison.snapshot!.projectId = id(21) },
  (value: SnapshotPreview) => { value.comparison.release!.snapshotId = id(99) },
  (value: SnapshotPreview) => { value.comparison.mode = 'previous' },
  (value: SnapshotPreview) => { value.comparison.release = null },
  (value: SnapshotPreview) => { value.diff.added.push('added') },
  (value: SnapshotPreview) => { value.diff.changed.push('added') },
  (value: SnapshotPreview) => { delete value.content.json.icons.changed },
  (value: SnapshotPreview) => { value.content.json.icons.removed = { body: '<path/>' } },
  (value: SnapshotPreview) => { value.snapshot.attempt = 0 },
  (value: SnapshotPreview) => { value.content.json.icons.added!.width = Number.NaN },
  (value: SnapshotPreview) => { value.previous!.height = -1 },
])('rejects an inconsistent response without silently dropping or reclassifying entries (%#)', (corrupt) => {
  const input = fixture()
  corrupt(input)
  expect(() => captureComparisonReport(input)).toThrow('不一致')
})

it('rejects absent explicit baselines and invalid metadata instead of inventing valid identities', () => {
  const input = added([])
  input.comparison.mode = 'snapshot'
  expect(() => captureComparisonReport(input)).toThrow('不一致')
  input.comparison.mode = 'previous'
  input.snapshot.attempt = null as unknown as number
  expect(() => captureComparisonReport(input)).toThrow('不一致')
  input.snapshot.attempt = 1
  input.snapshot.digest = 'not-a-digest'
  expect(() => captureComparisonReport(input)).toThrow('不一致')
})

it('makes detached deterministic output before the first async yield, without copying arbitrary fields', async () => {
  const input = fixture()
  const report = captureComparisonReport(input)
  const expected = `${JSON.stringify(report, null, 2)}\n`
  const pending = render(input)
  input.content.json.icons.added!.body = 'late mutation'
  input.diff.added.length = 0
  input.comparison.release!.version = '9.9.9'
  const first = await pending
  expect(await first.blob.text()).toBe(expected)
  expect(first.blob.type).toBe('application/json;charset=utf-8')
  expect(first.filename).toBe(`iconctl-comparison-${id(1)}-${'a'.repeat(12)}-release-${id(30)}.json`)
  expect(await (await render(fixture())).blob.text()).toBe(expected)
  expect(reportFilename(report, 'html')).toMatch(/\.html$/)
})

it('renders only script-free HTML with escaped text and isolated SVG images, retaining all diagnostics', async () => {
  const input = fixture()
  const hostile = '<script data-injected="yes">alert(1)</script>'
  input.content.json.prefix = hostile
  input.content.issues[0]!.message = hostile
  input.content.json.icons.added!.body = '<g onload="alert(1)"><script>alert(1)</script><rect width="16" height="16"/></g>'
  const { blob } = await render(input, 'html')
  const html = await blob.text()
  expect(blob.type).toBe('text/html;charset=utf-8')
  expect(html).not.toMatch(/<script|<svg|<iframe|<object|<embed|<a\s|\sonload=/)
  expect(html).toContain('&lt;script data-injected=&quot;yes&quot;&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('default-src \'none\'; img-src data:;')
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'))
  expect(html).toContain('@media print')
  expect(html).toContain('missing-output')
  expect(html).toContain('来源：figma #1')
  expect(html).not.toContain('loading="lazy"')
  const sources = [...html.matchAll(/src="data:image\/svg\+xml;base64,([^"]+)"/g)]
  expect(sources).toHaveLength(6)
  expect(atob(sources[0]![1]!)).toContain('viewBox="0 0 16 16"')
  expect(atob(sources[0]![1]!)).toContain(input.content.json.icons.added!.body)
  expect(await (await render(input, 'html')).blob.text()).toBe(html)
})

it('accepts exactly 5,000 changes and diagnostic items, rejecting the next item before rendering', () => {
  const input = added(Array.from({ length: REPORT_LIMITS.changes }, (_, index) => `icon-${index}`))
  input.content.failed = Array.from<string>({ length: REPORT_LIMITS.diagnostics }).fill('missing')
  expect(captureComparisonReport(input).icons).toHaveLength(5000)
  input.diff.added.push('overflow')
  expect(() => captureComparisonReport(input)).toThrow('5,000 条变化')
  input.diff.added.pop()
  input.content.issues.push({ name: 'extra', message: 'extra' })
  expect(() => captureComparisonReport(input)).toThrow('5,000 项诊断')
})

it('counts UTF-8 body bytes and accepts the exact single-body bound', () => {
  const body = '界'.repeat(Math.floor(REPORT_LIMITS.bodyBytes / 3)) + 'x'.repeat(REPORT_LIMITS.bodyBytes % 3)
  const input = added(['one'], body)
  expect(captureComparisonReport(input).icons[0]!.after!.body).toBe(body)
  input.content.json.icons.one!.body += 'x'
  expect(() => captureComparisonReport(input)).toThrow('单个图标 512 KiB')
})

it('rejects rather than truncates selected text above 4 MiB, with the exact limit allowed', () => {
  const input = added(Array.from({ length: 8 }, (_, index) => `i${index}`), 'x'.repeat(REPORT_LIMITS.bodyBytes))
  // Snapshot identity has three UUIDs and a digest; names and prefix are also selected text.
  const metadataBytes = 36 * 3 + 64 + 8 * 2 + 1
  input.content.json.icons.i7!.body = input.content.json.icons.i7!.body.slice(metadataBytes)
  expect(captureComparisonReport(input).icons).toHaveLength(8)
  input.content.json.icons.i7!.body += 'x'
  expect(() => captureComparisonReport(input)).toThrow('所选文本 4 MiB')
})

it('bounds encoded output, including JSON escaping, at exactly 8 MiB', async () => {
  const input = added(['a', 'b', 'c'])
  const overhead = new TextEncoder().encode(`${JSON.stringify(captureComparisonReport(input), null, 2)}\n`).byteLength
  const needed = REPORT_LIMITS.outputBytes - overhead
  let zeros = Math.floor(needed / 6)
  for (const icon of Object.values(input.content.json.icons)) {
    const length = Math.min(zeros, REPORT_LIMITS.bodyBytes)
    icon.body = '\0'.repeat(length)
    zeros -= length
  }
  input.content.json.icons.c!.body += 'x'.repeat(needed % 6)
  expect((await render(input)).blob.size).toBe(REPORT_LIMITS.outputBytes)
  input.content.json.icons.c!.body += 'x'
  await expect(render(input)).rejects.toThrow('文件 8 MiB')
})

it('yields real tasks and stops generation when cancellation arrives during a large report', async () => {
  const report = captureComparisonReport(added(Array.from({ length: 200 }, (_, index) => `icon-${index}`), '<path/>'))
  const controller = new AbortController()
  const pending = renderComparisonReport(report, 'html', controller.signal)
  const cancel = setTimeout(() => controller.abort(new Error('navigation changed')), 0)
  try {
    await expect(pending).rejects.toThrow('navigation changed')
  }
  finally {
    clearTimeout(cancel)
  }
  await expect(renderComparisonReport(report, 'json', controller.signal)).rejects.toThrow('navigation changed')
})

it('applies the final file bound after HTML escaping and image framing, without partial output', async () => {
  const input = added(Array.from({ length: 5000 }, (_, index) => `${'&'.repeat(192)}${String(index).padStart(8, '0')}`))
  expect(captureComparisonReport(input).icons).toHaveLength(5000)
  await expect(render(input, 'html')).rejects.toThrow('文件 8 MiB')
})

it('retains all removed records when the current collection is empty', () => {
  const input = fixture()
  input.content.json.icons = {}
  input.snapshot.iconCount = 0
  input.diff = { added: [], changed: [], removed: Object.keys(input.previous!.icons) }
  const report = captureComparisonReport(input)
  expect(report.icons).toHaveLength(4)
  expect(report.icons.every(icon => icon.before && icon.after === null && icon.status === 'removed')).toBe(true)
})

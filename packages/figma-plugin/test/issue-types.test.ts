import type { PreflightItem } from '../src/preflight'
import type { IssueType } from '../src/preflight-view'
import type { PreflightDocument } from '../src/report'
import { captureDiagnostics } from '../src/diagnostics'
import { canSubmit, inspectComponent, inspectComponents } from '../src/preflight'
import { issueType, PreflightView } from '../src/preflight-view'
import { PreflightReport } from '../src/report'
import { renderPreflightHtml } from '../src/report-html'
import { handoffItems } from '../src/svg-handoff-format'

const input = { id: '1:1', name: 'Arrow Left', type: 'COMPONENT', width: 24, height: 24 }
function legacy(issues = ['Legacy issue']): PreflightItem {
  return { id: 'old:1', name: 'Old icon', iconName: 'old-icon', skipped: false, width: 24, height: 24, issues }
}
function visible(view: PreflightView, type: IssueType = 'all', search = '', problemsOnly = false) {
  return view.visible({ issueType: type, search, problemsOnly })
}
function grouped() {
  return inspectComponents([
    { ...input, width: 48 },
    { ...input, id: '1:2', name: 'arrow_left' },
    { ...input, id: '1:3', name: 'brand-valid' },
    { ...input, id: '1:4', name: '_draft', width: 999 },
  ], { name: '^brand-', width: 24, height: 24 })
}

it('creates stable codes at the checks while preserving the existing issue messages and order', () => {
  const items = grouped()
  expect(items[0]!.issues).toEqual([
    'Name "Arrow Left" does not match the naming rule (got arrow-left)',
    'Canvas is 48×24, expected 24×24',
    'Duplicate icon name "arrow-left" on this page (2 components). Rename a component and rescan.',
  ])
  expect(items[0]!.diagnostics?.map(diagnostic => diagnostic.code)).toEqual(['name-rule', 'canvas-size', 'duplicate-name'])
  expect(items[1]!.diagnostics?.map(diagnostic => diagnostic.code)).toEqual(['name-rule', 'duplicate-name'])
  for (const item of items) {
    expect(item.diagnostics?.map(diagnostic => diagnostic.message)).toEqual(item.issues)
  }
  expect(items[2]!.diagnostics).toEqual([])
  expect(items[3]!.diagnostics).toEqual([])
  expect(canSubmit(items)).toBe(false)
  expect(inspectComponents([
    { ...input, name: 'Filled', parentName: 'Arrow', parentType: 'COMPONENT_SET' },
    { ...input, id: '1:2', name: 'arrow-filled' },
  ]).map(item => item.diagnostics?.[0]?.code)).toEqual(['duplicate-name', 'duplicate-name'])
})

it('keeps server naming, drafts, unrestricted dimensions and fresh-scan recovery unchanged', () => {
  const nodes = [input, { ...input, id: '1:2', name: 'arrow_left' }]
  const server = inspectComponents(nodes, { name: '^brand-', width: 32, namingMode: 'server' })
  expect(server.map(item => item.diagnostics?.map(diagnostic => diagnostic.code))).toEqual([['canvas-size'], ['canvas-size']])
  expect(inspectComponents(nodes, { namingMode: 'server' }).every(item => item.diagnostics?.length === 0)).toBe(true)
  expect(inspectComponent({ ...input, width: 32, height: 16 }, {}).diagnostics).toEqual([])
  expect(inspectComponent({ ...input, name: 'draft-new' }, { skipPrefix: ['draft-'] }).diagnostics).toEqual([])
  const first = inspectComponents(nodes)
  nodes[1]!.name = 'Different'
  expect(inspectComponents(nodes).every(item => item.diagnostics?.length === 0)).toBe(true)
  expect(first.every(item => item.diagnostics?.[0]?.code === 'duplicate-name')).toBe(true)
})

it('intersects category, literal search and Problems only without changing the full scan or its eligibility', () => {
  const items = grouped()
  const original = JSON.stringify(items)
  const view = new PreflightView()
  view.capture(items)
  expect(view.options('all')).toEqual([
    { value: 'all', label: 'All issue types' },
    { value: 'name-rule', label: 'Naming (2 components)' },
    { value: 'canvas-size', label: 'Canvas size (1 component)' },
    { value: 'duplicate-name', label: 'Duplicate names (2 components)' },
  ])
  expect(visible(view).map(item => item.id)).toEqual(['1:1', '1:2', '1:3'])
  expect(visible(view, 'duplicate-name', '  ARROW  ', true).map(item => item.id)).toEqual(['1:1', '1:2'])
  expect(visible(view, 'canvas-size', '1:2', true)).toEqual([])
  expect(visible(view, 'name-rule', '48×24').map(item => item.id)).toEqual(['1:1'])
  expect(visible(view, 'all', 'brand-valid', false).map(item => item.id)).toEqual(['1:3'])
  expect(visible(view, 'all', 'brand-valid', true)).toEqual([])
  expect(visible(view, 'name-rule', 'name-rule')).toEqual([])
  expect(JSON.stringify(items)).toBe(original)
  expect(canSubmit(items)).toBe(false)
  expect(() => handoffItems(items, false)).toThrow('Fix all preflight errors')
  const healthy = [inspectComponent(input)]
  view.capture(healthy)
  expect(visible(view, 'canvas-size')).toEqual([])
  expect(handoffItems(healthy, false)).toHaveLength(1)
  expect(canSubmit(healthy)).toBe(true)
})

it.each([
  undefined,
  null,
  {},
  [],
  [{ code: 'name-rule', message: 'Wrong message' }],
  [{ code: 'name-rule', message: 'Legacy issue' }, { code: 'canvas-size', message: 'Extra' }],
  [{ code: '', message: 'Legacy issue' }],
  [{ code: '   ', message: 'Legacy issue' }],
  [{ code: 1, message: 'Legacy issue' }],
  [{ code: 'name-rule', message: 1 }],
  [null],
  [undefined],
  [42],
])('keeps issues visible as Other when metadata is absent or inconsistent: %j', (metadata) => {
  const item = { ...legacy(), diagnostics: metadata } as PreflightItem
  const view = new PreflightView()
  view.capture([item])
  expect(visible(view)).toEqual([item])
  expect(visible(view, 'other', '', true)).toEqual([item])
  expect(visible(view, 'name-rule')).toEqual([])
  expect(view.options('all').at(-1)).toEqual({ value: 'other', label: 'Other (1 component)' })
  expect(canSubmit([item])).toBe(false)
  expect(captureDiagnostics(item.issues, metadata)).toBeUndefined()
})

it('falls back for reordered diagnostics and preserves known plus unknown categories without parsing messages', () => {
  const item = { ...legacy(['Canvas is actually a naming message', 'Unknown check', 'Another naming message']), diagnostics: [
    { code: 'name-rule', message: 'Canvas is actually a naming message' },
    { code: 'future-rule', message: 'Unknown check' },
    { code: 'name-rule', message: 'Another naming message' },
  ] }
  const view = new PreflightView()
  view.capture([item])
  expect(visible(view, 'name-rule')).toEqual([item])
  expect(visible(view, 'other')).toEqual([item])
  expect(visible(view, 'canvas-size')).toEqual([])
  expect(view.options('all').find(option => option.value === 'name-rule')?.label).toBe('Naming (1 component)')
  view.capture([{ ...item, diagnostics: [...item.diagnostics].reverse() }])
  expect(visible(view, 'name-rule')).toEqual([])
  expect(visible(view, 'other')).toHaveLength(1)
})

it('retains selected Other with zero matches after a new scan and never invents issues from metadata', () => {
  const view = new PreflightView()
  view.capture([legacy()])
  expect(visible(view, 'other')).toHaveLength(1)
  const healthy = { ...legacy([]), diagnostics: [{ code: 'canvas-size', message: 'Metadata-only issue' }] }
  view.capture([healthy])
  expect(visible(view, 'other')).toEqual([])
  expect(view.options('other').at(-1)).toEqual({ value: 'other', label: 'Other (0 components)' })
  expect(view.options('all').some(option => option.value === 'other')).toBe(false)
  expect(visible(view, 'all', '', true)).toEqual([])
  expect(canSubmit([healthy])).toBe(true)
  expect(handoffItems([healthy], false)).toHaveLength(1)
  expect(issueType('constructor')).toBe('all')
  expect(issueType('name-rule')).toBe('name-rule')
})

it('classifies once per accepted scan and keeps complete counts independent of repeated view changes', () => {
  let reads = 0
  const item = { ...legacy(), get diagnostics() {
    reads++
    return [{ code: 'canvas-size', message: 'Legacy issue' }]
  } }
  const view = new PreflightView()
  view.capture([item])
  expect(reads).toBe(1)
  for (let index = 0; index < 100; index++) {
    visible(view, 'canvas-size', String(index), true)
    expect(view.options('canvas-size').find(option => option.value === 'canvas-size')?.label).toBe('Canvas size (1 component)')
  }
  expect(reads).toBe(1)
  view.capture([item])
  expect(reads).toBe(2)
})

it('projects only additive diagnostic fields into the frozen schema-1 report and leaves HTML unchanged', () => {
  const messages: Record<string, unknown>[] = []
  const page = { id: 'page:1', name: 'Icons' }
  const reporter = new PreflightReport({ currentPage: () => page, post: message => messages.push(message) })
  const items = grouped()
  const code = '<script>future-code</script>'
  const future = { ...legacy(), diagnostics: [{ code, message: 'Legacy issue', privateContext: 'must-not-leak' }] }
  const inconsistent = { ...legacy(), id: 'old:2', diagnostics: [{ code: 'canvas-size', message: 'Wrong issue', token: 'must-not-leak' }] }
  items.push(future, inconsistent, { ...legacy(), id: 'old:3' })
  reporter.capture(7, page, items, { mode: 'github', rulesSource: 'legacy-defaults' })
  reporter.send({ scanId: 7, requestId: 1 })
  const original = messages[0]!['json'] as string
  const report = JSON.parse(original) as PreflightDocument
  expect(report.schemaVersion).toBe(1)
  expect(report.summary).toEqual({ total: 7, checked: 6, skipped: 1, withIssues: 5, issueCount: 8, canSubmit: false })
  expect(Object.keys(report).sort()).toEqual(['generatedAt', 'items', 'mode', 'page', 'rules', 'rulesSource', 'scanId', 'schemaVersion', 'scope', 'serverValidationRequired', 'summary'].sort())
  expect(report.items[4]!.diagnostics).toEqual([{ code, message: 'Legacy issue' }])
  expect(report.items[5]).not.toHaveProperty('diagnostics')
  expect(report.items[6]).not.toHaveProperty('diagnostics')
  expect(original).not.toContain('must-not-leak')
  future.diagnostics[0]!.code = 'changed'
  items[0]!.diagnostics![0]!.message = 'Mutated after capture'
  reporter.send({ scanId: 7, requestId: 2 })
  expect(messages[1]!['json']).toBe(original)
  reporter.send({ scanId: 7, requestId: 3, format: 'html' })
  const html = messages[2]!['html'] as string
  const legacyReport = { ...report, items: report.items.map(({ diagnostics: _diagnostics, ...item }) => item) }
  expect(html).toBe(renderPreflightHtml(legacyReport))
  expect(html).not.toContain('future-code')
  expect(html).toContain('Legacy issue')
})

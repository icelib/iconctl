import type { PreflightItem } from '../src/preflight'
import { visibleNamesJson, visibleNodeIdsJson } from '../src/copy-visible-json-format'
import { canSubmit, inspectComponents } from '../src/preflight'
import { preflightSort, PreflightView } from '../src/preflight-view'
import { PreflightReport } from '../src/report'

function item(id: string, name: string, iconName: string | null): PreflightItem {
  return { id, name, iconName, skipped: false, width: 24, height: 24, issues: [] }
}

function view(items: PreflightItem[]) {
  const result = new PreflightView()
  result.capture(items)
  return result
}

function ids(result: PreflightView, sort: 'page' | 'local-name' | 'original-name') {
  return result.visible({ search: '', problemsOnly: false, issueType: 'all', sort }).map(item => item.id)
}

it('keeps page order by default and sorts derived arrays without mutating the captured scan', () => {
  const items = [item('3', 'Zed', 'zeta'), item('1', 'Alpha', 'alpha'), item('2', 'Middle', 'middle')]
  const original = [...items]
  const result = view(items)

  expect(ids(result, 'page')).toEqual(['3', '1', '2'])
  expect(ids(result, 'local-name')).toEqual(['1', '2', '3'])
  expect(items).toEqual(original)
  expect(ids(result, 'page')).toEqual(['3', '1', '2'])
})

it('uses exact case-sensitive names, keeps blanks last, and applies deterministic tie breakers', () => {
  const items = [
    item('z', 'same', 'same'),
    item('a', 'same', 'same'),
    item('b', 'Alpha', 'same'),
    item('c', 'blank', ''),
    item('d', 'spaces', '   '),
    item('e', 'Upper', 'A'),
    item('f', 'lower', 'a'),
  ]
  const result = view(items)

  expect(ids(result, 'local-name')).toEqual(['e', 'f', 'b', 'a', 'z', 'c', 'd'])
  expect(ids(result, 'original-name')).toEqual(['b', 'e', 'c', 'f', 'a', 'z', 'd'])
})

it('uses original name before ID for local-name ties and preserves page order for complete ties', () => {
  const first = item('1', 'Alpha', 'same')
  const second = { ...first, width: 48 }
  const items = [item('2', 'Zulu', 'same'), first, item('3', 'Alpha', 'same'), second]
  const result = view(items)
  for (const sort of ['local-name', 'original-name'] as const) {
    const sorted = result.visible({ search: '', problemsOnly: false, issueType: 'all', sort })
    expect(sorted.map(item => item.id)).toEqual(['1', '1', '3', '2'])
    expect(sorted[0]).toBe(first)
    expect(sorted[1]).toBe(second)
  }
})

it('compares raw UTF-16 values without trimming, normalizing or applying a locale', () => {
  const items = [
    item('composed', 'é', 'é'),
    item('chinese', '图标', '图标'),
    item('decomposed', 'e\u0301', 'e\u0301'),
    item('astral', '𐀀', '𐀀'),
    item('bmp', '\uE000', '\uE000'),
    item('space', ' z', ' z'),
    item('punctuation', '!', '!'),
    item('blank', '', ''),
    item('missing', 'missing', null),
  ]
  const result = view(items)
  expect(ids(result, 'local-name')).toEqual(['space', 'punctuation', 'decomposed', 'composed', 'chinese', 'astral', 'bmp', 'blank', 'missing'])
  expect(ids(result, 'original-name')).toEqual(['blank', 'space', 'punctuation', 'decomposed', 'missing', 'composed', 'chinese', 'astral', 'bmp'])
})

it('sorts the intersection while leaving issues, drafts, report bytes and copy payloads unchanged', () => {
  const items = inspectComponents([
    { id: '2', name: 'Zed', type: 'COMPONENT', width: 48, height: 24 },
    { id: '1', name: 'Alpha', type: 'COMPONENT', width: 48, height: 24 },
    { id: '3', name: 'Good', type: 'COMPONENT', width: 24, height: 24 },
    { id: '4', name: '_draft', type: 'COMPONENT', width: 24, height: 24 },
  ])
  const result = view(items)
  const original = JSON.stringify(items)
  const page = { id: 'page', name: 'Page' }
  const messages: Record<string, unknown>[] = []
  const report = new PreflightReport({ currentPage: () => page, post: message => messages.push(message) })
  report.capture(1, page, items, { mode: 'github', rulesSource: 'legacy-defaults' })
  report.send({ scanId: 1, requestId: 1 })
  const filter = { search: '48', problemsOnly: true, issueType: 'canvas-size' as const }
  const before = result.visible(filter)
  const sorted = result.visible({ ...filter, sort: 'local-name' })
  expect(sorted.map(item => item.id)).toEqual(['1', '2'])
  expect(visibleNamesJson(sorted)).toEqual(visibleNamesJson(before))
  expect(visibleNodeIdsJson(sorted)).toEqual(visibleNodeIdsJson(before))
  expect(canSubmit(items)).toBe(false)
  expect(JSON.stringify(items)).toBe(original)
  report.send({ scanId: 1, requestId: 2 })
  expect(messages[1]!['json']).toBe(messages[0]!['json'])
  expect(result.visible({ ...filter, search: 'no match', sort: 'original-name' })).toEqual([])
})

it('keeps illegal and provisional local names sortable and uses the latest captured page order', () => {
  const invalid = { ...item('2', 'Z', '!invalid'), issues: ['Name does not match'] }
  const provisional = item('1', 'A', 'temporary')
  const result = view([provisional, invalid])
  expect(ids(result, 'local-name')).toEqual(['2', '1'])
  result.capture([invalid, provisional])
  expect(ids(result, 'page')).toEqual(['2', '1'])
})

it('keeps sorting outside the scan state and rejects unknown UI values', () => {
  const itemA = item('a', 'A', 'a')
  const itemB = item('b', 'B', 'b')
  const result = view([itemB, itemA])
  expect(preflightSort('local-name')).toBe('local-name')
  expect(preflightSort('original-name')).toBe('original-name')
  expect(preflightSort('unexpected')).toBe('page')
  expect(result.visible({ search: 'a', problemsOnly: false, issueType: 'all', sort: 'local-name' })).toEqual([itemA])
  expect(result.visible({ search: '', problemsOnly: false, issueType: 'all', sort: 'page' })).toEqual([itemB, itemA])
})

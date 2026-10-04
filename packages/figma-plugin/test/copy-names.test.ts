import type { PreflightItem } from '../src/preflight'
import { visibleNamesJson } from '../src/copy-names-format'
import { CopyNamesUI } from '../src/copy-names-ui'
import { canSubmit, inspectComponents } from '../src/preflight'
import { PreflightView } from '../src/preflight-view'

function item(iconName: string | null, id = '1:1'): PreflightItem {
  return { id, name: iconName ?? 'Unnamed', iconName, skipped: false, width: 24, height: 24, issues: [] }
}

it('preserves exact local names, deduplicates and sorts independently of locale with a final newline', () => {
  const items = ['z', 'A', 'a', 'a', 'con', 'not/a-file', ' x ', '💡', 'é', '<script>\n"name"'].map(name => item(name))
  const original = JSON.stringify(items)
  const result = visibleNamesJson(items)
  expect(result).toEqual({
    json: '[\n  " x ",\n  "<script>\\n\\\"name\\\"",\n  "A",\n  "a",\n  "con",\n  "not/a-file",\n  "z",\n  "é",\n  "💡"\n]\n',
    componentCount: 10,
    uniqueCount: 9,
    duplicateCount: 1,
  })
  expect(JSON.stringify(items)).toBe(original)
})

it('uses the shared intersection view and allows review of names with errors without changing submission eligibility', () => {
  const input = { id: '1:1', name: 'Arrow Left', type: 'COMPONENT', width: 48, height: 24 }
  const items = inspectComponents([
    input,
    { ...input, id: '1:2', name: 'arrow_left', width: 24 },
    { ...input, id: '1:3', name: 'brand-ok', width: 24 },
    { ...input, id: '1:4', name: '_draft' },
    { ...input, id: '1:5', name: 'Filled', parentName: 'Arrow', parentType: 'COMPONENT_SET' },
  ], { name: '^brand-', width: 24 })
  const original = JSON.stringify(items)
  const view = new PreflightView()
  view.capture(items)
  const filtered = view.visible({ issueType: 'duplicate-name', search: 'ARROW', problemsOnly: true })
  expect(visibleNamesJson(filtered)).toMatchObject({ json: '[\n  "arrow-left"\n]\n', componentCount: 2, uniqueCount: 1, duplicateCount: 1 })
  expect(JSON.parse(visibleNamesJson(view.visible({ issueType: 'all', search: '', problemsOnly: false })).json))
    .toEqual(['arrow-filled', 'arrow-left', 'brand-ok'])
  expect(canSubmit(items)).toBe(false)
  expect(JSON.stringify(items)).toBe(original)
})

it.each([null, '', '   ', undefined])('rejects the entire view when any local name is missing: %j', (name) => {
  expect(() => visibleNamesJson([item('valid'), item(name as string | null)])).toThrow('1 visible component has no local name')
})

it('rejects an empty view and enforces the visible component count before deduplication', () => {
  expect(() => visibleNamesJson([])).toThrow('No visible components')
  expect(visibleNamesJson(Array.from({ length: 5000 }, () => item('same')))).toMatchObject({ componentCount: 5000, uniqueCount: 1 })
  expect(() => visibleNamesJson(Array.from({ length: 5001 }, () => item('same')))).toThrow('exceeds 5000 components')
})

it('enforces the exact UTF-8 JSON byte boundary including JSON escaping and the final newline', () => {
  const limit = 1024 * 1024
  const name = '界'.repeat(Math.floor((limit - 9) / 3)) + 'a'.repeat((limit - 9) % 3)
  const result = visibleNamesJson([item(name)])
  expect(new TextEncoder().encode(result.json).byteLength).toBe(limit)
  expect(() => visibleNamesJson([item(`${name}a`)])).toThrow('exceeds 1 MiB')
  expect(() => visibleNamesJson([item('"'.repeat(limit / 2))])).toThrow('exceeds 1 MiB')
})

class Control extends EventTarget {
  disabled = false
  hidden = false
  textContent = ''
  className = ''
  value = ''
  focus = vi.fn()
  select = vi.fn()
  click() { this.dispatchEvent(new Event('click')) }
}
function deferred() {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = () => no(new Error('denied'))
  })
  return { promise, resolve, reject }
}
function fixture(writer: ((text: string) => Promise<void>) | null = () => Promise.resolve()) {
  const current = { active: true, current: true, scanId: 1 as number | undefined, items: [item('b'), item('a'), item('a')], serverNaming: false }
  const controls = {
    button: new Control(),
    summary: new Control(),
    help: new Control(),
    warning: new Control(),
    status: new Control(),
    fallback: new Control(),
    text: new Control(),
    select: new Control(),
  }
  const clipboard = writer ? { writeText: vi.fn(writer) } : undefined
  const controller = new CopyNamesUI({
    current: () => current,
    clipboard: () => clipboard,
    button: controls.button as unknown as HTMLButtonElement,
    summary: controls.summary as unknown as HTMLElement,
    help: controls.help as unknown as HTMLElement,
    warning: controls.warning as unknown as HTMLElement,
    status: controls.status as unknown as HTMLElement,
    fallback: controls.fallback as unknown as HTMLElement,
    text: controls.text as unknown as HTMLTextAreaElement,
    select: controls.select as unknown as HTMLButtonElement,
  })
  return { current, controls, clipboard, controller }
}

it('invokes clipboard synchronously in the click, captures immutable JSON and ignores forced double clicks', async () => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  expect(f.controls.summary.textContent).toBe('3 visible components → 2 unique local names. 1 duplicate name entry merged.')
  f.controls.button.click()
  expect(f.clipboard!.writeText).toHaveBeenCalledExactlyOnceWith('[\n  "a",\n  "b"\n]\n')
  expect(f.controls.button.disabled).toBe(true)
  f.controls.button.click()
  f.current.items[0]!.iconName = 'mutated'
  expect(f.clipboard!.writeText).toHaveBeenCalledTimes(1)
  gate.resolve()
  await gate.promise
  expect(f.controls.status.textContent).toBe('Copied 2 unique local names from 3 visible components.')
  expect(f.controls.button.disabled).toBe(false)
  f.controller.dispose()
})

it.each(['missing', 'throw', 'reject'] as const)('offers exact manual JSON for %s without automatic focus or another native call', async (failure) => {
  const gate = deferred()
  const f = fixture(failure === 'missing'
    ? null
    : () => {
        if (failure === 'throw') {
          throw new Error('blocked')
        }
        return gate.promise
      })
  f.controls.button.click()
  if (failure === 'reject') {
    gate.reject()
    await gate.promise.catch(() => {})
  }
  expect(f.controls.status.textContent).toBe('Automatic copy is unavailable. Select the JSON and copy it manually.')
  expect(f.controls.fallback.hidden).toBe(false)
  expect(f.controls.text.value).toBe('[\n  "a",\n  "b"\n]\n')
  expect(f.controls.text.focus).not.toHaveBeenCalled()
  f.controls.select.click()
  expect(f.controls.text.focus).toHaveBeenCalledTimes(1)
  expect(f.controls.text.select).toHaveBeenCalledTimes(1)
  f.controller.change()
  expect(f.controls.fallback.hidden).toBe(true)
  expect(f.controls.text.value).toBe('')
  f.controls.select.click()
  expect(f.controls.text.focus).toHaveBeenCalledTimes(1)
  f.controller.dispose()
})

it.each(['resolve', 'reject'] as const)('keeps the physical lock through view/scan ABA and discards stale %s feedback', async (outcome) => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  f.controls.button.click()
  f.current.items = [item('new')]
  f.controller.change()
  f.controls.button.click()
  f.current.current = false
  f.controller.change()
  f.current.current = true
  f.current.scanId = 2
  f.controller.change()
  f.current.scanId = 1
  f.controller.change()
  expect(f.controls.status.textContent).toBe('')
  expect(f.controls.button.disabled).toBe(true)
  expect(f.clipboard!.writeText).toHaveBeenCalledTimes(1)
  gate[outcome]()
  await gate.promise.catch(() => {})
  expect(f.controls.status.textContent).toBe('')
  expect(f.controls.fallback.hidden).toBe(true)
  expect(f.controls.text.value).toBe('')
  expect(f.controls.text.focus).not.toHaveBeenCalled()
  expect(f.controls.button.disabled).toBe(false)
  f.controls.button.click()
  expect(f.clipboard!.writeText).toHaveBeenLastCalledWith('[\n  "new"\n]\n')
  await Promise.resolve()
  f.controller.dispose()
})

it('clears fallback for a new accepted scan, rule invalidation or late restored view without filtering the full source', async () => {
  const f = fixture(() => Promise.reject(new Error('unavailable')))
  for (const change of ['scan', 'rules', 'preferences']) {
    f.controls.button.click()
    await Promise.resolve()
    expect(f.controls.fallback.hidden).toBe(false)
    if (change === 'scan') {
      f.current.scanId = f.current.scanId! + 1
    }
    if (change === 'rules') {
      f.current.current = false
    }
    if (change === 'preferences') {
      f.current.items = [item('visible')]
    }
    f.controller.change()
    expect(f.controls.status.textContent).toBe('')
    expect(f.controls.text.value).toBe('')
    expect(f.controls.fallback.hidden).toBe(true)
    f.current.current = true
    f.controller.change()
  }
  f.controller.dispose()
})

it('blocks stale, unaccepted, empty and missing-name views even on forced clicks; server names remain provisional', async () => {
  const f = fixture()
  const valid = [item('con')]
  for (const current of [
    { active: false, current: true, scanId: 1, items: valid },
    { active: true, current: false, scanId: 1, items: valid },
    { active: true, current: true, scanId: undefined, items: valid },
    { active: true, current: true, scanId: 1, items: [] },
    { active: true, current: true, scanId: 1, items: [item(null), ...valid] },
  ]) {
    Object.assign(f.current, current)
    f.controller.change()
    expect(f.controls.button.disabled).toBe(true)
    f.controls.button.click()
  }
  expect(f.clipboard!.writeText).not.toHaveBeenCalled()
  Object.assign(f.current, { items: valid, serverNaming: true })
  f.controller.change()
  expect(f.controls.warning.hidden).toBe(false)
  expect(f.controls.button.disabled).toBe(false)
  f.controls.button.click()
  await Promise.resolve()
  expect(f.clipboard!.writeText).toHaveBeenCalledExactlyOnceWith('[\n  "con"\n]\n')
  f.controller.dispose()
})

it.each(['resolve', 'reject'] as const)('releases local references on disposal and never changes DOM/focus after late %s', async (outcome) => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  f.controls.button.click()
  f.controller.dispose()
  const disposed = JSON.stringify(f.controls)
  gate[outcome]()
  await gate.promise.catch(() => {})
  f.controller.update()
  f.controller.change()
  f.controls.button.click()
  f.controls.select.click()
  expect(JSON.stringify(f.controls)).toBe(disposed)
  expect(f.controls.text.focus).not.toHaveBeenCalled()
  expect(f.clipboard!.writeText).toHaveBeenCalledTimes(1)
})

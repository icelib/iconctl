import type { PreflightItem } from '../src/preflight'
import { visibleNamesJson, visibleNodeIdsJson } from '../src/copy-visible-json-format'
import { CopyVisibleJsonUI } from '../src/copy-visible-json-ui'
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
  expect(visibleNodeIdsJson(filtered)).toEqual({ json: '[\n  "1:1",\n  "1:2"\n]\n', componentCount: 2 })
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
    content: new Control(),
    scope: new Control(),
    textLabel: new Control(),
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
  const controller = new CopyVisibleJsonUI({
    current: () => current,
    clipboard: () => clipboard,
    content: controls.content as unknown as HTMLSelectElement,
    scope: controls.scope as unknown as HTMLElement,
    textLabel: controls.textLabel as unknown as HTMLElement,
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
  f.controls.content.dispatchEvent(new Event('change'))
  expect(JSON.stringify(f.controls)).toBe(disposed)
  expect(f.controls.text.focus).not.toHaveBeenCalled()
  expect(f.clipboard!.writeText).toHaveBeenCalledTimes(1)
})

it('copies exact sorted node IDs even with missing or duplicate names without modifying the view', () => {
  const ids = ['2:10', '1:2', 'I1:2;3:4', '"<script>\n界💡', ' 5:6 ']
  const items = ids.map(id => item(null, id))
  const before = JSON.stringify(items)
  expect(visibleNodeIdsJson(items)).toEqual({ json: `${JSON.stringify([...ids].sort(), null, 2)}\n`, componentCount: 5 })
  expect(JSON.stringify(items)).toBe(before)
  expect(() => visibleNamesJson(items)).toThrow('no local name')
})

it.each([null, undefined, 5, '', ' \n '])('rejects the whole ID view for a missing ID: %j', (id) => {
  expect(() => visibleNodeIdsJson([item('valid', '1:1'), { ...item('invalid'), id } as PreflightItem])).toThrow('missing or duplicate node IDs')
})

it('rejects duplicate IDs without changing the existing name format contract', () => {
  const items = [item('same', '1:1'), item('same', '1:1')]
  expect(() => visibleNodeIdsJson(items)).toThrow('duplicate node IDs')
  expect(visibleNamesJson(items)).toMatchObject({ componentCount: 2, uniqueCount: 1, duplicateCount: 1 })
})

it('enforces ID item and exact UTF-8 JSON byte limits without truncation', () => {
  expect(() => visibleNodeIdsJson([])).toThrow('No visible components')
  const items = Array.from({ length: 5000 }, (_, index) => item(null, `1:${index}`))
  expect(visibleNodeIdsJson(items).componentCount).toBe(5000)
  expect(() => visibleNodeIdsJson([...items, item(null, '1:5000')])).toThrow('exceeds 5000')
  const limit = 1024 * 1024
  const id = '界'.repeat(Math.floor((limit - 9) / 3)) + 'a'.repeat((limit - 9) % 3)
  expect(new TextEncoder().encode(visibleNodeIdsJson([item(null, id)]).json).byteLength).toBe(limit)
  expect(() => visibleNodeIdsJson([item(null, `${id}a`)])).toThrow('exceeds 1 MiB')
  expect(() => visibleNodeIdsJson([item(null, '"'.repeat(limit / 2))])).toThrow('exceeds 1 MiB')
})

function content(f: ReturnType<typeof fixture>, mode: 'names' | 'node-ids') {
  f.controls.content.value = mode
  f.controls.content.dispatchEvent(new Event('change'))
}

it('recomputes the same scan for IDs when names are missing and restores name restrictions on return', async () => {
  const f = fixture()
  f.current.items = [item(null, '1:2'), item('same', '1:1')]
  f.current.serverNaming = true
  f.controller.change()
  expect(f.controls.button.disabled).toBe(true)
  content(f, 'node-ids')
  expect(f.controls.button.disabled).toBe(false)
  expect(f.controls.button.textContent).toBe('Copy visible node IDs JSON')
  expect(f.controls.summary.textContent).toBe('2 visible components → 2 Figma node IDs.')
  expect(f.controls.scope.textContent).toContain('same file')
  expect(f.controls.warning.hidden).toBe(true)
  f.controls.button.click()
  expect(f.clipboard!.writeText).toHaveBeenCalledExactlyOnceWith('[\n  "1:1",\n  "1:2"\n]\n')
  await Promise.resolve()
  expect(f.controls.status.textContent).toBe('Copied 2 Figma node IDs from the current filtered view.')
  content(f, 'names')
  expect(f.controls.status.textContent).toBe('')
  expect(f.controls.button.disabled).toBe(true)
  expect(f.controls.warning.hidden).toBe(false)
  expect(f.controls.help.textContent).toContain('no local name')
  f.controller.dispose()
})

it.each(['names', 'node-ids'] as const)('retains one physical write through %s content ABA and stale rejection', async (mode) => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  f.current.items = [item('two', '1:2'), item('one', '1:1')]
  content(f, mode)
  f.controls.button.click()
  content(f, mode === 'names' ? 'node-ids' : 'names')
  f.controls.button.click()
  content(f, mode)
  f.controls.button.click()
  expect(f.clipboard!.writeText).toHaveBeenCalledTimes(1)
  expect(f.controls.button.disabled).toBe(true)
  gate.reject()
  await gate.promise.catch(() => {})
  expect(f.controls.status.textContent).toBe('')
  expect(f.controls.fallback.hidden).toBe(true)
  expect(f.controls.button.disabled).toBe(false)
  f.controller.dispose()
})

it('a late successful name write only unlocks the new ID mode, then an explicit click copies IDs', async () => {
  const gate = deferred()
  const f = fixture(() => gate.promise)
  f.current.items = [item('home', '2:1')]
  f.controller.change()
  f.controls.button.click()
  content(f, 'node-ids')
  expect(f.controls.button.disabled).toBe(true)
  expect(f.controls.text.value).toBe('')
  gate.resolve()
  await gate.promise
  expect(f.controls.status.textContent).toBe('')
  expect(f.controls.button.disabled).toBe(false)
  f.controls.button.click()
  expect(f.clipboard!.writeText).toHaveBeenLastCalledWith('[\n  "2:1"\n]\n')
  await Promise.resolve()
  expect(f.controls.status.textContent).toBe('Copied 1 Figma node ID from the current filtered view.')
  f.controller.dispose()
})

it('manual fallback always matches current content and mode switching does not move focus', () => {
  const f = fixture(null)
  f.current.items = [item('home', '1:2')]
  f.controller.change()
  f.controls.button.click()
  expect(f.controls.text.value).toBe('[\n  "home"\n]\n')
  content(f, 'node-ids')
  expect(f.controls.text.value).toBe('')
  expect(f.controls.fallback.hidden).toBe(true)
  expect(f.controls.textLabel.textContent).toBe('Visible Figma node IDs JSON')
  f.controls.button.click()
  expect(f.controls.text.value).toBe('[\n  "1:2"\n]\n')
  expect(f.controls.fallback.hidden).toBe(false)
  expect(f.controls.text.focus).not.toHaveBeenCalled()
  f.controls.select.click()
  expect(f.controls.text.select).toHaveBeenCalledTimes(1)
  content(f, 'names')
  expect(f.controls.text.value).toBe('')
  expect(f.controls.textLabel.textContent).toBe('Visible local names JSON')
  f.controller.dispose()
})

it('stale ID scans and duplicate IDs refuse forced copy clicks', () => {
  const f = fixture()
  content(f, 'node-ids')
  expect(f.controls.help.textContent).toContain('duplicate node IDs')
  f.controls.button.click()
  f.current.items = [item(null, '1:1')]
  f.current.current = false
  f.controller.change()
  expect(f.controls.help.textContent).toBe('Rescan with current rules before copying node IDs.')
  f.controls.button.click()
  expect(f.clipboard!.writeText).not.toHaveBeenCalled()
  f.controller.dispose()
})

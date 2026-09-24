import { parseRepo } from '@/github'
import { shouldSkipName, toIconName } from '@/naming'
import { canSubmit, inspectComponent } from '@/preflight'

describe('figma plugin preflight', () => {
  it('converts mixed names to kebab-case', () => {
    expect(toIconName('Arrow Left')).toBe('arrow-left')
    expect(toIconName('userFilled')).toBe('user-filled')
  })

  it('skips draft prefixes', () => {
    expect(shouldSkipName('_hidden')).toBe(true)
    expect(shouldSkipName('.draft')).toBe(true)
    expect(shouldSkipName('arrow-left')).toBe(false)
  })

  it('rejects non kebab-case English names', () => {
    const result = inspectComponent({
      id: '1:1',
      name: '箭头',
      type: 'COMPONENT',
      width: 24,
      height: 24,
    })
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.skipped).toBe(false)
  })

  it('accepts a 24px kebab-case component', () => {
    const result = inspectComponent({
      id: '1:2',
      name: 'arrow-left',
      type: 'COMPONENT',
      width: 24,
      height: 24,
    })
    expect(result.iconName).toBe('arrow-left')
    expect(result.issues).toEqual([])
  })

  it('flags the wrong canvas size', () => {
    const result = inspectComponent({
      id: '1:3',
      name: 'arrow-left',
      type: 'COMPONENT',
      width: 48,
      height: 48,
    })
    expect(result.issues.some(issue => issue.includes('48×48'))).toBe(true)
  })

  it('skips drafts without issues', () => {
    const result = inspectComponent({
      id: '1:4',
      name: '_draft',
      type: 'COMPONENT',
      width: 24,
      height: 24,
    })
    expect(result.skipped).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('names variants from the component set', () => {
    const result = inspectComponent({
      id: '1:5',
      name: 'Filled',
      type: 'COMPONENT',
      width: 24,
      height: 24,
      parentName: 'user',
      parentType: 'COMPONENT_SET',
    })
    expect(result.iconName).toBe('user-filled')
  })

  it('parses owner/repo', () => {
    expect(parseRepo('sonofmagic/app')).toEqual({ owner: 'sonofmagic', repo: 'app' })
    expect(parseRepo('https://github.com/sonofmagic/app.git')).toEqual({ owner: 'sonofmagic', repo: 'app' })
    expect(() => parseRepo('nope')).toThrow(/owner\/name/)
  })
})

it('blocks empty or invalid preflight submissions', () => {
  expect(canSubmit([])).toBe(false)
  const invalid = inspectComponent({ id: '1:1', name: 'bad', type: 'COMPONENT', width: 48, height: 48 })
  expect(canSubmit([invalid])).toBe(false)
  const valid = inspectComponent({ id: '1:2', name: 'good', type: 'COMPONENT', width: 24, height: 24 })
  expect(canSubmit([valid])).toBe(true)
  expect(canSubmit([valid, invalid])).toBe(false)
})

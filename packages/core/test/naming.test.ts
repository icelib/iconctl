import type { FigmaImportNodeData } from '@iconify/tools/lib/import/figma/types/nodes'
import { cleanupIconKeyword } from '@iconify/tools'
import { defaultIconNameForNode, shouldSkipName, toIconName } from '../src/naming'

function node(partial: Partial<FigmaImportNodeData> & Pick<FigmaImportNodeData, 'name' | 'type'>): FigmaImportNodeData {
  return {
    id: '1:1',
    width: 24,
    height: 24,
    parents: [],
    ...partial,
  }
}

describe('naming', () => {
  it('converts mixed names to kebab-case', () => {
    expect(toIconName('Arrow Left')).toBe('arrow-left')
    expect(toIconName('userFilled')).toBe('user-filled')
    expect(toIconName('Style=Filled, Size=24')).toBe('style-filled-size24')
  })

  it('preserves the established Iconify normalization at word and punctuation boundaries', () => {
    const names = [
      '',
      ' \t\r\n ',
      'HTTPServer',
      'XMLHttpRequest',
      'userURLValue',
      'A1B2C3',
      'Style=Filled, Size=24',
      ' icon.name/path\\variant:state ',
      '--User___Filled--',
      '图标-Éclair-😀',
      '.!?+@#$%^&*(){}[]',
      '\u00A0Bell\u2003Filled\uFEFF',
    ]
    const fragments = ['a', 'Z', 'HTTP', '12', '_', '-', '.', ':', '/', '\\', '=', ',', ' ', '\t', '图', 'É']
    for (const first of fragments) {
      for (const middle of fragments) {
        for (const last of fragments) {
          names.push(`${first}${middle}${last}`)
        }
      }
    }
    for (const name of names) {
      expect(toIconName(name), JSON.stringify(name)).toBe(cleanupIconKeyword(name, true))
    }
    expect(toIconName('HTTPServer')).toBe('httpserver')
    expect(toIconName('XMLHttpRequest')).toBe('xmlhttp-request')
  })

  it('skips draft prefixes', () => {
    expect(shouldSkipName('_hidden')).toBe(true)
    expect(shouldSkipName('.draft')).toBe(true)
    expect(shouldSkipName('arrow-left')).toBe(false)
  })

  it('names component variants from the parent set', () => {
    const result = defaultIconNameForNode(node({
      name: 'Style=Filled',
      type: 'COMPONENT',
      parents: [
        { id: '0:1', type: 'CANVAS', name: 'Icons' },
        { id: '1:2', type: 'COMPONENT_SET', name: 'user' },
      ],
    }))
    expect(result).toBe('user-style-filled')
  })

  it('ignores non-icon node types', () => {
    expect(defaultIconNameForNode(node({ name: 'user', type: 'INSTANCE' }))).toBeNull()
  })

  it('ignores blank, skipped and normalization-empty names', () => {
    for (const name of ['', ' \t ', '_hidden', '.draft', '图标', '!?']) {
      expect(defaultIconNameForNode(node({ name, type: 'COMPONENT' }))).toBeNull()
    }
    expect(defaultIconNameForNode(node({ name: '_hidden', type: 'FRAME' }), { skipPrefix: [] })).toBe('hidden')
    expect(defaultIconNameForNode(node({ name: 'draft-user', type: 'FRAME' }), { skipPrefix: ['draft-'] })).toBeNull()
  })

  it('accepts minimal structural nodes and uses the nearest component set', () => {
    expect(defaultIconNameForNode({
      id: '3:1',
      name: 'Filled',
      type: 'COMPONENT',
      parents: [
        { id: '1:1', name: 'Outer', type: 'COMPONENT_SET' },
        { id: '2:1', name: 'Inner', type: 'COMPONENT_SET' },
      ] as const,
    })).toBe('inner-filled')
  })
})

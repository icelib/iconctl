import type { FigmaImportNodeData } from '@iconify/tools/lib/import/figma/types/nodes'
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
})

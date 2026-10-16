import type { IconctlConfig } from '../src/config'
import { resolveConfig } from '../src/config'

describe('Figma naming configuration', () => {
  it('resolves opt-in policies and preserves the exact transform function', () => {
    const transform = (name: string) => `brand-${name}`
    const resolved = resolveConfig({
      prefix: 'brand',
      namingManifest: ' names.json ',
      sources: [{ type: 'figma', file: 'fixture', naming: { duplicates: 'suffix-node-id', preserveNames: false, namespace: ' outline ', transform } }],
    })
    expect(resolved.namingManifest).toBe('names.json')
    expect(resolved.sources[0]).toMatchObject({ naming: { duplicates: 'suffix-node-id', preserveNames: false, namespace: 'outline', transform } })
  })

  it.each([
    null,
    [],
    { duplicates: 'ignore' },
    { preserveNames: 'true' },
    { namespace: '' },
    { namespace: '   ' },
    { namespace: 1 },
    { transform: true },
  ])('rejects invalid naming options: %j', (naming) => {
    expect(() => resolveConfig({ prefix: 'brand', sources: [{ type: 'figma', file: 'fixture', naming }] } as unknown as IconctlConfig)).toThrow('Invalid Figma naming options')
  })

  it('rejects competing legacy and composable callbacks while allowing a legacy callback with the duplicate policy', () => {
    const iconNameForNode = () => 'custom'
    expect(() => resolveConfig({ prefix: 'brand', sources: [{
      type: 'figma',
      file: 'fixture',
      iconNameForNode,
      naming: { transform: name => name },
    }] })).toThrow('either legacy iconNameForNode or naming.transform')
    expect(resolveConfig({ prefix: 'brand', sources: [{
      type: 'figma',
      file: 'fixture',
      iconNameForNode,
      naming: { duplicates: 'suffix-node-id' },
    }] }).sources[0]).toMatchObject({ iconNameForNode, naming: { duplicates: 'suffix-node-id' } })
  })

  it.each(['', '  ', 1, null])('rejects invalid manifest paths: %j', (namingManifest) => {
    expect(() => resolveConfig({ prefix: 'brand', namingManifest, sources: [{ type: 'figma', file: 'fixture' }] } as unknown as IconctlConfig)).toThrow(/namingManifest/)
  })
})

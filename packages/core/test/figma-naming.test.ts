import type { FigmaNameCandidate, FigmaNameEntry } from '../src/figma-naming'
import { allocateFigmaNames } from '../src/figma-naming'

function node(nodeId: string, baseName: string, originalName = baseName): FigmaNameCandidate {
  return { nodeId, baseName, originalName, parentPath: ['Icons'] }
}

const duplicates = [
  node('34:1698', 'bell'),
  node('34:1779', 'more'),
  node('34:1970', 'data-board'),
  node('34:2231', 'eleme'),
  node('34:2238', 'eleme'),
  node('5398:44', 'bell'),
  node('5398:45', 'data-board'),
  node('78:1939', 'more'),
]

function allocate(candidates: FigmaNameCandidate[], previous?: Record<string, FigmaNameEntry>) {
  return allocateFigmaNames(candidates, { duplicates: 'suffix-node-id', ...(previous ? { previous } : {}) })
}

it('keeps the four existing base names and allocates stable node ID suffixes', () => {
  const result = allocate(duplicates)
  expect(result.names).toEqual({
    '34:1698': 'bell',
    '34:1779': 'more',
    '34:1970': 'data-board',
    '34:2231': 'eleme',
    '34:2238': 'eleme-34-2238',
    '5398:44': 'bell-5398-44',
    '5398:45': 'data-board-5398-45',
    '78:1939': 'more-78-1939',
  })
  expect(new Set(Object.values(result.names)).size).toBe(8)
  expect(result.collisions.map(group => group.baseName)).toEqual(['bell', 'data-board', 'eleme', 'more'])
  expect(result.renamed).toEqual([
    { nodeId: '34:2238', from: 'eleme', to: 'eleme-34-2238' },
    { nodeId: '5398:44', from: 'bell', to: 'bell-5398-44' },
    { nodeId: '5398:45', from: 'data-board', to: 'data-board-5398-45' },
    { nodeId: '78:1939', from: 'more', to: 'more-78-1939' },
  ])
})

it('returns the same allocation and diagnostics after traversal order changes', () => {
  expect(allocate([...duplicates].reverse())).toEqual(allocate(duplicates))
})

it('does not transfer an existing base name to a newly inserted earlier node', () => {
  const initial = allocate([node('2:1', 'bell'), node('2:2', 'bell')])
  const result = allocate([node('1:1', 'bell'), node('2:2', 'bell'), node('2:1', 'bell')], initial.entries)
  expect(result.names).toEqual({ '1:1': 'bell-1-1', '2:1': 'bell', '2:2': 'bell-2-2' })
})

it('reserves deleted nodes as tombstones and restores their original names', () => {
  const original = [node('1:1', 'bell'), node('1:2', 'bell')]
  const initial = allocate(original)
  const deleted = allocate([node('1:2', 'bell'), node('1:3', 'bell')], initial.entries)
  expect(deleted.names).toEqual({ '1:2': 'bell-1-2', '1:3': 'bell-1-3' })
  expect(deleted.entries['1:1']).toEqual({ name: 'bell', baseName: 'bell' })
  const restored = allocate([...original, node('1:3', 'bell')], deleted.entries)
  expect(restored.names).toEqual({ '1:1': 'bell', '1:2': 'bell-1-2', '1:3': 'bell-1-3' })
})

it('keeps a renamed layer attached to its public name', () => {
  const initial = allocate([node('1:1', 'bell')])
  const result = allocate([node('1:1', 'alarm'), node('1:2', 'bell')], initial.entries)
  expect(result.names).toEqual({ '1:1': 'bell', '1:2': 'bell-1-2' })
  expect(result.entries['1:1']).toEqual({ name: 'bell', baseName: 'alarm' })
  expect(result.renamed).toContainEqual({ nodeId: '1:1', from: 'alarm', to: 'bell' })
})

it('reserves all natural names before assigning suffixes and numbers later conflicts', () => {
  const result = allocate([
    node('1:1', 'bell'),
    node('1:2', 'bell'),
    node('1:3', 'bell-1-2'),
    node('1:4', 'bell-1-2-2'),
  ])
  expect(result.names).toEqual({
    '1:1': 'bell',
    '1:2': 'bell-1-2-3',
    '1:3': 'bell-1-2',
    '1:4': 'bell-1-2-2',
  })
})

it('handles distinct node IDs whose cleaned suffixes collide', () => {
  const result = allocate([node('0:1', 'bell'), node('node-1', 'bell'), node('node:1', 'bell')])
  expect(result.names).toEqual({ '0:1': 'bell', 'node-1': 'bell-node-1', 'node:1': 'bell-node-1-2' })
})

it('uses normalized base names supplied by the caller without normalizing custom keywords again', () => {
  const result = allocate([
    node('1:1', 'arrow-left', 'Arrow Left'),
    node('1:2', 'arrow-left', 'arrow_left'),
    node('1:3', 'Custom Name', 'Custom Name'),
  ])
  expect(result.names).toEqual({ '1:1': 'arrow-left', '1:2': 'arrow-left-1-2', '1:3': 'Custom Name' })
  expect(result.collisions[0]?.nodes.map(item => item.originalName)).toEqual(['Arrow Left', 'arrow_left'])
})

it('strictly excludes current duplicate groups even when one node has a saved name', () => {
  const previous = { '1:1': { name: 'bell', baseName: 'bell' } }
  const result = allocateFigmaNames([node('1:1', 'bell'), node('1:2', 'bell'), node('1:3', 'check')], {
    duplicates: 'error',
    previous,
  })
  expect(result.names).toEqual({ '1:3': 'check' })
  expect(result.entries).toEqual({ ...previous, '1:3': { name: 'check', baseName: 'check' } })
  expect(result.collisions).toEqual([{ baseName: 'bell', nodes: [node('1:1', 'bell'), node('1:2', 'bell')] }])
  expect(result.renamed).toEqual([])
})

it('does not transfer a historical name to an independent node under the strict duplicate policy', () => {
  const result = allocateFigmaNames([node('1:2', 'bell')], {
    duplicates: 'error',
    previous: { '1:1': { name: 'bell', baseName: 'bell' } },
  })
  expect(result.names).toEqual({ '1:2': 'bell-1-2' })
  expect(result.collisions).toEqual([])
})

it('can explicitly reset ownership without depending on traversal order', () => {
  const previous = { '2:1': { name: 'bell', baseName: 'bell' }, 'deleted': { name: 'check', baseName: 'check' } }
  const candidates = [node('2:1', 'bell'), node('1:1', 'bell')]
  const options = { duplicates: 'suffix-node-id' as const, preserveNames: false, previous }
  const result = allocateFigmaNames(candidates, options)
  expect(result.names).toEqual({ '1:1': 'bell', '2:1': 'bell-2-1' })
  expect(result.entries).not.toHaveProperty('deleted')
  expect(allocateFigmaNames([...candidates].reverse(), options)).toEqual(result)
})

it('rejects saved entries that assign a public name to two nodes', () => {
  expect(() => allocate([], {
    '1:1': { name: 'bell', baseName: 'bell' },
    '1:2': { name: 'bell', baseName: 'alarm' },
  })).toThrow('Saved Figma name "bell" is assigned to both nodes "1:1" and "1:2".')
})

it('rejects malformed saved entries and repeated candidate IDs without silently overwriting', () => {
  expect(() => allocate([], { '1:1': { name: '', baseName: 'bell' } })).toThrow('Invalid saved Figma name entry for node "1:1".')
  expect(() => allocate([node('1:1', 'bell'), node('1:1', 'alarm')])).toThrow('Duplicate Figma name candidate node ID "1:1".')
  expect(() => allocate([node('1:1', '')])).toThrow('non-empty nodeId and baseName')
})

it('is stateless and does not mutate candidates or saved entries', () => {
  const candidate = Object.freeze(node('1:2', 'bell'))
  const previous = Object.freeze({ '1:1': Object.freeze({ name: 'bell', baseName: 'bell' }) })
  const first = allocate([candidate], previous)
  first.entries['1:1']!.name = 'changed-result'
  expect(previous['1:1'].name).toBe('bell')
  expect(allocate([candidate], previous).names).toEqual({ '1:2': 'bell-1-2' })
  expect(allocate(duplicates)).toEqual(allocate(duplicates))
  expect(allocate([])).toEqual({ names: {}, entries: {}, collisions: [], renamed: [] })
})

it('handles object prototype keys as ordinary node IDs and names', () => {
  const result = allocate([node('__proto__', 'constructor'), node('constructor', '__proto__')])
  expect(Object.keys(result.names)).toEqual(['__proto__', 'constructor'])
  expect(Reflect.get(result.names, '__proto__')).toBe('constructor')
  expect(result.names.constructor).toBe('__proto__')
})

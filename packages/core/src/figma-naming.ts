import { toIconName } from './naming'

export interface FigmaNameCandidate {
  nodeId: string
  originalName: string
  baseName: string
  parentPath: string[]
}

export interface FigmaNameEntry {
  name: string
  baseName: string
}

export interface FigmaNameAllocationOptions {
  duplicates: 'error' | 'suffix-node-id'
  previous?: Record<string, FigmaNameEntry>
  preserveNames?: boolean
}

export interface FigmaNameAllocation {
  names: Record<string, string>
  entries: Record<string, FigmaNameEntry>
  collisions: { baseName: string, nodes: FigmaNameCandidate[] }[]
  renamed: { nodeId: string, from: string, to: string }[]
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Assign public names without relying on Figma's document traversal order. */
export function allocateFigmaNames(
  candidates: readonly FigmaNameCandidate[],
  options: FigmaNameAllocationOptions,
): FigmaNameAllocation {
  const ordered = [...candidates].sort((left, right) => compareStrings(left.nodeId, right.nodeId))
  const groups = new Map<string, FigmaNameCandidate[]>()
  const nodeIds = new Set<string>()
  for (const candidate of ordered) {
    if (!candidate.nodeId || !candidate.baseName) {
      throw new Error('Figma name candidates require a non-empty nodeId and baseName.')
    }
    if (nodeIds.has(candidate.nodeId)) {
      throw new Error(`Duplicate Figma name candidate node ID "${candidate.nodeId}".`)
    }
    nodeIds.add(candidate.nodeId)
    const group = groups.get(candidate.baseName) ?? []
    group.push(candidate)
    groups.set(candidate.baseName, group)
  }

  const entries = new Map<string, FigmaNameEntry>()
  const owners = new Map<string, string>()
  if (options.preserveNames !== false) {
    for (const [nodeId, entry] of Object.entries(options.previous ?? {})) {
      if (!nodeId || !entry || typeof entry.name !== 'string' || !entry.name
        || typeof entry.baseName !== 'string' || !entry.baseName) {
        throw new Error(`Invalid saved Figma name entry for node "${nodeId}".`)
      }
      const owner = owners.get(entry.name)
      if (owner !== undefined) {
        throw new Error(`Saved Figma name "${entry.name}" is assigned to both nodes "${owner}" and "${nodeId}".`)
      }
      entries.set(nodeId, { ...entry })
      owners.set(entry.name, nodeId)
    }
  }

  const collisions = [...groups]
    .filter(([, nodes]) => nodes.length > 1)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([baseName, nodes]) => ({ baseName, nodes }))
  const excluded = new Set(options.duplicates === 'error'
    ? collisions.flatMap(group => group.nodes.map(node => node.nodeId))
    : [])
  const naturalNames = new Set(groups.keys())
  const names = new Map<string, string>()
  const renamed: FigmaNameAllocation['renamed'] = []

  for (const candidate of ordered) {
    if (excluded.has(candidate.nodeId)) {
      continue
    }

    const previous = entries.get(candidate.nodeId)
    let name = previous?.name ?? candidate.baseName
    if (!previous && owners.has(name)) {
      const nodeSuffix = toIconName(candidate.nodeId.replaceAll(':', '-')) || 'node'
      const stem = `${candidate.baseName}-${nodeSuffix}`
      name = stem
      let index = 2
      // A generated suffix must never claim another node's natural name.
      while (owners.has(name) || naturalNames.has(name)) {
        name = `${stem}-${index++}`
      }
    }

    owners.set(name, candidate.nodeId)
    names.set(candidate.nodeId, name)
    entries.set(candidate.nodeId, { name, baseName: candidate.baseName })
    if (name !== candidate.baseName) {
      renamed.push({ nodeId: candidate.nodeId, from: candidate.baseName, to: name })
    }
  }

  return {
    names: Object.fromEntries(names),
    entries: Object.fromEntries([...entries].sort(([left], [right]) => compareStrings(left, right))),
    collisions,
    renamed,
  }
}

// A product limit on one selection operation, not a Figma API limit.
export const MAX_VISIBLE_SELECTION = 500

export function selectionError(nodeIds: unknown): string | undefined {
  if (!Array.isArray(nodeIds) || !nodeIds.length) {
    return 'No visible components. Adjust or clear the filters before selecting.'
  }
  if (nodeIds.length > MAX_VISIBLE_SELECTION) {
    return `This view exceeds ${MAX_VISIBLE_SELECTION} components. Narrow the filters before selecting.`
  }
  if ([...nodeIds].some(id => typeof id !== 'string' || !id.trim()) || new Set(nodeIds).size !== nodeIds.length) {
    return 'The component list contains missing or duplicate IDs. Rescan and try again.'
  }
}

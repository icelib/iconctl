/// <reference types="@figma/plugin-typings" />

import type { PreflightInput } from './preflight'
import { inspectComponents } from './preflight'

const STORAGE_KEY = 'iconctl-settings'

function collectComponents(node: SceneNode, parent?: BaseNode): PreflightInput[] {
  const items: PreflightInput[] = []
  if (node.type === 'COMPONENT') {
    items.push({
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width,
      height: node.height,
      ...(parent
        ? { parentName: parent.name, parentType: parent.type }
        : {}),
    })
    return items
  }
  if ('children' in node) {
    for (const child of node.children) {
      items.push(...collectComponents(child, node))
    }
  }
  return items
}

function scanPage() {
  const nodes: PreflightInput[] = []
  for (const child of figma.currentPage.children) {
    nodes.push(...collectComponents(child))
  }
  return inspectComponents(nodes)
}

figma.showUI(__html__, { width: 420, height: 560 })

figma.ui.postMessage({ type: 'preflight', items: scanPage() })

void figma.clientStorage.getAsync(STORAGE_KEY).then((value) => {
  figma.ui.postMessage({ type: 'settings', settings: value ?? {} })
})

figma.ui.onmessage = (message: { type: string, settings?: unknown }) => {
  if (message.type === 'rescan') {
    figma.ui.postMessage({ type: 'preflight', items: scanPage() })
    return
  }
  if (message.type === 'save-settings' && message.settings) {
    void figma.clientStorage.setAsync(STORAGE_KEY, message.settings)
  }
}

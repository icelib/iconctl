/// <reference types="@figma/plugin-typings" />

import type { PreflightInput, PreflightRules } from './preflight'
import { PluginConsole } from './console'
import { inspectComponents } from './preflight'

const STORAGE_KEY = 'iconctl-settings'

function collectComponents(
  node: SceneNode,
  parent?: BaseNode,
): PreflightInput[] {
  const items: PreflightInput[] = []
  if (node.type === 'COMPONENT') {
    items.push({
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width,
      height: node.height,
      ...(parent ? { parentName: parent.name, parentType: parent.type } : {}),
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

function scanPage(rules?: PreflightRules) {
  const nodes: PreflightInput[] = []
  for (const child of figma.currentPage.children) {
    nodes.push(...collectComponents(child))
  }
  return inspectComponents(nodes, rules)
}

figma.showUI(__html__, { width: 420, height: 560 })

const consoleSession = new PluginConsole({
  storage: figma.clientStorage,
  post: message => figma.ui.postMessage(message),
  scan: scanPage,
})
consoleSession.rescan()
figma.on('close', () => consoleSession.dispose())

void figma.clientStorage.getAsync(STORAGE_KEY).then((value) => {
  figma.ui.postMessage({ type: 'settings', settings: value ?? {} })
})

figma.ui.onmessage = async (message: {
  type: string
  settings?: unknown
  origin?: string
  mode?: 'console' | 'github'
}) => {
  if (message.type.startsWith('console-')) {
    await consoleSession.handle(message)
    return
  }
  if (message.type === 'rescan') {
    consoleSession.rescan(message.mode)
    return
  }
  if (message.type === 'save-settings' && message.settings) {
    void figma.clientStorage.setAsync(STORAGE_KEY, message.settings)
  }
}

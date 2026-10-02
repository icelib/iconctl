/// <reference types="@figma/plugin-typings" />

import type { PreflightInput, PreflightRules } from './preflight'
import { PluginConsole } from './console'
import { PreflightNavigation } from './navigation'
import { inspectComponents } from './preflight'
import { PluginSettings } from './settings'

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

figma.showUI(__html__, { width: 420, height: 560 })

const navigation = new PreflightNavigation({
  currentPage: () => figma.currentPage,
  lookup: id => figma.getNodeByIdAsync(id),
  focus(node) {
    figma.currentPage.selection = [node]
    figma.viewport.scrollAndZoomIntoView([node])
  },
  post: message => figma.ui.postMessage(message),
})
function scanPage(rules?: PreflightRules) {
  const page = figma.currentPage
  const nodes: PreflightInput[] = []
  for (const child of page.children) {
    nodes.push(...collectComponents(child))
  }
  const items = inspectComponents(nodes, rules)
  navigation.capture(page.id, items)
  return items
}

const consoleSession = new PluginConsole({
  storage: figma.clientStorage,
  post: message => figma.ui.postMessage(message['type'] === 'preflight'
    ? { ...message, scanId: navigation.scanId }
    : message),
  scan: scanPage,
})
consoleSession.rescan()
const settings = new PluginSettings({ storage: figma.clientStorage, post: message => figma.ui.postMessage(message) })
let closed = false
figma.on('currentpagechange', () => navigation.invalidate())
figma.on('close', () => {
  closed = true
  navigation.dispose()
  consoleSession.dispose()
  settings.dispose()
})

figma.ui.onmessage = async (message: {
  type: string
  settings?: unknown
  preferences?: unknown
  scope?: unknown
  origin?: string
  mode?: 'console' | 'github'
  nodeId?: string
  scanId?: number
  requestId?: number
}) => {
  if (closed) {
    return
  }
  if (message.type === 'cancel-navigation') {
    navigation.cancel(message.scanId)
    return
  }
  if (message.type === 'locate') {
    await navigation.locate(message)
    return
  }
  if (message.type.startsWith('console-')) {
    await consoleSession.handle(message)
    return
  }
  if (message.type === 'rescan') {
    consoleSession.rescan(message.mode)
    return
  }
  await settings.handle(message)
}

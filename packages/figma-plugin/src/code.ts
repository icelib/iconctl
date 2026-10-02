/// <reference types="@figma/plugin-typings" />

import type { PreflightInput, PreflightItem, PreflightRules } from './preflight'
import type { ScanMetadata } from './report'
import { PluginConsole } from './console'
import { PreflightNavigation } from './navigation'
import { inspectComponents } from './preflight'
import { PreflightReport } from './report'
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
let closed = false

const navigation = new PreflightNavigation({
  currentPage: () => figma.currentPage,
  lookup: id => figma.getNodeByIdAsync(id),
  focus(node) {
    figma.currentPage.selection = [node]
    figma.viewport.scrollAndZoomIntoView([node])
  },
  post: message => figma.ui.postMessage(message),
})
const reports = new PreflightReport({ currentPage: () => figma.currentPage, post: message => figma.ui.postMessage(message) })
function invalidateScan(text: string, error = false) {
  reports.invalidate()
  navigation.invalidate(text, error)
}
function scanPage(rules?: PreflightRules) {
  const page = figma.currentPage
  const nodes: PreflightInput[] = []
  for (const child of page.children) {
    nodes.push(...collectComponents(child))
  }
  const items = inspectComponents(nodes, rules)
  return items
}

const consoleSession = new PluginConsole({
  storage: figma.clientStorage,
  post(message) {
    if (closed) {
      return
    }
    if (message['type'] === 'preflight') {
      const items = message['items'] as PreflightItem[]
      const page = figma.currentPage
      navigation.capture(page.id, items)
      reports.capture(navigation.scanId, page, items, message['metadata'] as ScanMetadata)
      figma.ui.postMessage({ type: 'preflight', items, scanId: navigation.scanId, reportAvailable: true })
      return
    }
    figma.ui.postMessage(message)
  },
  scan: scanPage,
  invalidate: invalidateScan,
  resetProject() {
    if (reports.invalidateProject()) {
      navigation.invalidate('Project connection changed. Rescan to use the current rules.')
    }
  },
})
function rescan(mode?: 'console' | 'github') {
  try {
    consoleSession.rescan(mode)
  }
  catch {
    // publishScan already invalidated the old scan and sent recovery feedback.
  }
}
rescan()
const settings = new PluginSettings({ storage: figma.clientStorage, post: message => figma.ui.postMessage(message) })
figma.on('currentpagechange', () => {
  reports.invalidate()
  navigation.invalidate()
})
figma.on('close', () => {
  closed = true
  navigation.dispose()
  reports.dispose()
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
  if (message.type === 'export-report') {
    reports.send(message)
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
    rescan(message.mode)
    return
  }
  await settings.handle(message)
}

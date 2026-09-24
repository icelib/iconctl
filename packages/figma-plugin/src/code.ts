/// <reference types="@figma/plugin-typings" />

import type { PreflightInput } from './preflight'
import { canSubmit, inspectComponents } from './preflight'

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

figma.ui.onmessage = async (message: {
  type: string
  settings?: unknown
  origin?: string
}) => {
  if (message.type.startsWith('console-')) {
    try {
      await handleConsole(message)
    }
    catch (error) {
      figma.ui.postMessage({
        type: 'console-status',
        text: error instanceof Error ? error.message : 'Console request failed',
        error: true,
      })
    }
    return
  }
  if (message.type === 'rescan') {
    figma.ui.postMessage({ type: 'preflight', items: scanPage() })
    return
  }
  if (message.type === 'save-settings' && message.settings) {
    void figma.clientStorage.setAsync(STORAGE_KEY, message.settings)
  }
}

interface ConsoleDevice {
  origin: string
  deviceId: string
  projectId: string
  token: string
}
const CONSOLE_KEY = 'iconctl-console-device'
let pairingGeneration = 0
function consoleOrigin(value: string | undefined) {
  const url = new URL(value || 'https://iconctl.icebreaker.top')
  if (
    url.protocol !== 'https:'
    || (url.hostname !== 'iconctl.icebreaker.top'
      && !url.hostname.endsWith('.workers.dev'))
    || url.pathname !== '/'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    throw new Error('Use the iconctl console HTTPS origin')
  }
  return url.origin
}
async function consoleRequest<T>(
  origin: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${origin}/api/plugin/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': uuid(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    throw new Error(
      `Console request failed (${response.status}). Check the connection or pair again.`,
    )
  }
  return response.json() as Promise<T>
}
function uuid() {
  // Idempotency, not an authentication credential. Figma's sandbox has no WebCrypto.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}
async function handleConsole(message: { type: string, origin?: string }) {
  if (message.type === 'console-disconnect') {
    pairingGeneration++
    await figma.clientStorage.deleteAsync(CONSOLE_KEY)
    figma.ui.postMessage({
      type: 'console-status',
      text: 'Local connection removed. Revoke the device in the console to invalidate its credential.',
    })
    return
  }
  if (message.type === 'console-pair') {
    const origin = consoleOrigin(message.origin)
    const generation = ++pairingGeneration
    const pair = await consoleRequest<{
      id: string
      code: string
      pollToken: string
      expiresAt: number
    }>(origin, 'pair', undefined, {})
    figma.ui.postMessage({
      type: 'console-status',
      text: `Pairing code: ${pair.code} · Confirm in ${origin}/app/?view=connections within 5 minutes`,
    })
    while (Date.now() < pair.expiresAt) {
      if (generation !== pairingGeneration) {
        return
      }
      await new Promise(resolve => setTimeout(resolve, 3000))
      const result = await consoleRequest<{
        pending: boolean
        deviceId?: string
        projectId?: string
        token?: string
      }>(origin, `pair/${pair.id}`, pair.pollToken)
      if (
        !result.pending
        && result.token
        && result.deviceId
        && result.projectId
      ) {
        if (generation !== pairingGeneration) {
          return
        }
        await figma.clientStorage.setAsync(CONSOLE_KEY, {
          origin,
          token: result.token,
          deviceId: result.deviceId,
          projectId: result.projectId,
        } satisfies ConsoleDevice)
        figma.ui.postMessage({
          type: 'console-status',
          text: 'Console connected. Sync is enabled; publishing requires approval in the console.',
        })
        return
      }
    }
    if (generation === pairingGeneration) {
      throw new Error('Pairing expired. Request a new code.')
    }
    return
  }
  const device = (await figma.clientStorage.getAsync(CONSOLE_KEY)) as
    ConsoleDevice | undefined
  if (!device) {
    throw new Error('Connect the console first')
  }
  if (message.type === 'console-status') {
    figma.ui.postMessage({
      type: 'console-status',
      text: `Connected to ${device.origin}`,
      origin: device.origin,
    })
    return
  }
  if (message.type === 'console-sync') {
    const latest = scanPage()
    figma.ui.postMessage({ type: 'preflight', items: latest })
    if (!canSubmit(latest)) {
      throw new Error(
        'Fix all preflight errors and include at least one icon before syncing',
      )
    }
    const task = await consoleRequest<{ id: string, url: string }>(
      device.origin,
      `devices/${device.deviceId}/jobs`,
      device.token,
      {},
    )
    figma.ui.postMessage({
      type: 'console-status',
      text: `Sync started: ${task.url}`,
      url: task.url,
    })
    for (let attempts = 0; attempts < 240; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const status = await consoleRequest<{ status: string, stage: string }>(
        device.origin,
        `devices/${device.deviceId}/jobs/${task.id}`,
        device.token,
      )
      figma.ui.postMessage({
        type: 'console-status',
        text: `${status.status} · ${status.stage} · ${task.url}`,
        url: task.url,
      })
      if (status.status === 'succeeded' || status.status === 'failed') {
        break
      }
    }
  }
}

import type { PreflightItem } from './preflight'
import { actionsUrl, dispatchPublish, parseRepo } from './github'

interface PluginMessage {
  type: string
  items?: PreflightItem[]
  settings?: {
    repo?: string
    token?: string
    eventType?: string
  }
}

const repoInput = document.querySelector<HTMLInputElement>('#repo')!
const tokenInput = document.querySelector<HTMLInputElement>('#token')!
const eventInput = document.querySelector<HTMLInputElement>('#event')!
const statusEl = document.querySelector('#status')!
const listEl = document.querySelector('#list')!
const publishBtn = document.querySelector<HTMLButtonElement>('#publish')!
const rescanBtn = document.querySelector<HTMLButtonElement>('#rescan')!

let items: PreflightItem[] = []

function setStatus(text: string, kind: 'ok' | 'err' | '' = '') {
  statusEl.textContent = text
  statusEl.className = kind
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[char] || char))
}

function render() {
  const visible = items.filter(item => !item.skipped)
  const skipped = items.filter(item => item.skipped).length
  const errors = visible.filter(item => item.issues.length)
  listEl.innerHTML = visible.map((item) => {
    const state = item.issues.length ? 'err' : 'ok'
    const detail = item.issues.length ? item.issues.join(' · ') : item.iconName
    return `<li class="${state}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail || '')}</span></li>`
  }).join('')
  const summary = errors.length
    ? `${errors.length} of ${visible.length} icons need fixes`
    : `${visible.length} icons ready`
  setStatus(skipped ? `${summary} · ${skipped} drafts skipped` : summary, errors.length ? 'err' : 'ok')
  publishBtn.disabled = visible.length === 0
}

function readSettings() {
  const { owner, repo } = parseRepo(repoInput.value)
  const token = tokenInput.value.trim()
  const eventType = eventInput.value.trim() || 'iconctl-publish'
  if (!token) {
    throw new Error('GitHub token is required')
  }
  return { owner, repo, token, eventType }
}

parent.postMessage({ pluginMessage: { type: 'rescan' } }, '*')

rescanBtn.addEventListener('click', () => {
  parent.postMessage({ pluginMessage: { type: 'rescan' } }, '*')
})

publishBtn.addEventListener('click', async () => {
  try {
    const settings = readSettings()
    parent.postMessage({
      pluginMessage: {
        type: 'save-settings',
        settings: { repo: repoInput.value.trim(), token: settings.token, eventType: settings.eventType },
      },
    }, '*')
    publishBtn.disabled = true
    setStatus('Dispatching GitHub Action…')
    await dispatchPublish(settings)
    setStatus(`Workflow started. ${actionsUrl(settings)}`, 'ok')
  }
  catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'err')
  }
  finally {
    publishBtn.disabled = false
  }
})

window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginMessage }>) => {
  const message = event.data.pluginMessage
  if (!message) {
    return
  }
  if (message.type === 'preflight' && message.items) {
    items = message.items
    render()
  }
  if (message.type === 'settings' && message.settings) {
    repoInput.value = message.settings.repo ?? ''
    tokenInput.value = message.settings.token ?? ''
    eventInput.value = message.settings.eventType ?? 'iconctl-publish'
  }
}

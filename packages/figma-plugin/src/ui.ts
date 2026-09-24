import type { PreflightItem } from './preflight'
import { actionsUrl, dispatchPublish, parseRepo } from './github'
import { canSubmit } from './preflight'

interface PluginMessage {
  type: string
  text?: string
  origin?: string
  url?: string
  error?: boolean
  items?: PreflightItem[]
  settings?: {
    repo?: string
    token?: string
    eventType?: string
  }
}

const modeInput = document.querySelector<HTMLSelectElement>('#mode')!
const originInput = document.querySelector<HTMLInputElement>('#origin')!
const consoleStatus = document.querySelector<HTMLElement>('#console-status')!
const githubFields = document.querySelector<HTMLElement>('#github-fields')!
const consoleFields = document.querySelector<HTMLElement>('#console-fields')!
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
  return value.replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
      })[char] || char,
  )
}

function render() {
  const visible = items.filter(item => !item.skipped)
  const skipped = items.filter(item => item.skipped).length
  const errors = visible.filter(item => item.issues.length)
  listEl.innerHTML = visible
    .map((item) => {
      const state = item.issues.length ? 'err' : 'ok'
      const detail = item.issues.length
        ? item.issues.join(' · ')
        : item.iconName
      return `<li class="${state}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail || '')}</span></li>`
    })
    .join('')
  const summary = errors.length
    ? `${errors.length} of ${visible.length} icons need fixes`
    : `${visible.length} icons ready`
  setStatus(
    skipped ? `${summary} · ${skipped} drafts skipped` : summary,
    errors.length ? 'err' : 'ok',
  )
  publishBtn.disabled = !canSubmit(items)
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
    if (!canSubmit(items)) {
      throw new Error('Fix all preflight errors before submitting')
    }
    if (modeInput.value === 'console') {
      parent.postMessage({ pluginMessage: { type: 'console-sync' } }, '*')
      return
    }
    const settings = readSettings()
    parent.postMessage(
      {
        pluginMessage: {
          type: 'save-settings',
          settings: {
            repo: repoInput.value.trim(),
            token: settings.token,
            eventType: settings.eventType,
          },
        },
      },
      '*',
    )
    publishBtn.disabled = true
    setStatus('Dispatching GitHub Action…')
    await dispatchPublish(settings)
    setStatus(`Workflow started. ${actionsUrl(settings)}`, 'ok')
  }
  catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'err')
  }
  finally {
    publishBtn.disabled = !canSubmit(items)
  }
})

window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginMessage }>) => {
  if (event.source !== parent) {
    return
  }
  const message = event.data.pluginMessage
  if (!message) {
    return
  }
  if (message.type === 'console-status') {
    consoleStatus.textContent = message.text ?? ''
    if (message.origin) {
      originInput.value = message.origin
    }
    if (message.url) {
      const url = new URL(message.url)
      if (
        url.protocol === 'https:'
        && url.origin === new URL(originInput.value).origin
      ) {
        const link = document.createElement('a')
        link.href = url.href
        link.textContent = ' Open task ↗'
        link.target = '_blank'
        link.rel = 'noopener'
        consoleStatus.appendChild(link)
      }
    }
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

modeInput.addEventListener('change', () => {
  const consoleMode = modeInput.value === 'console'
  consoleFields.hidden = !consoleMode
  githubFields.hidden = consoleMode
  publishBtn.textContent = consoleMode
    ? 'Sync to console'
    : 'Dispatch GitHub Action'
})
document
  .querySelector('#connect')!
  .addEventListener('click', () =>
    parent.postMessage(
      { pluginMessage: { type: 'console-pair', origin: originInput.value } },
      '*',
    ))
document
  .querySelector('#disconnect')!
  .addEventListener('click', () =>
    parent.postMessage({ pluginMessage: { type: 'console-disconnect' } }, '*'))
parent.postMessage({ pluginMessage: { type: 'console-status' } }, '*')

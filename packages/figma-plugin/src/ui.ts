import type { PreflightItem } from './preflight'
import type { LegacySettings, ViewPreferences } from './settings'
import { actionsUrl, dispatchPublish, parseRepo } from './github'
import { canSubmit } from './preflight'

interface PluginMessage {
  type: string
  text?: string
  origin?: string
  url?: string
  error?: boolean
  busy?: boolean
  connected?: boolean
  items?: PreflightItem[]
  scanId?: number
  requestId?: number
  reportAvailable?: boolean
  json?: string
  rescan?: boolean
  serverNamingPending?: boolean
  settings?: LegacySettings
  preferences?: ViewPreferences
  scope?: 'settings' | 'preferences'
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
const navigationStatus = document.querySelector<HTMLElement>('#navigation-status')!
const searchInput = document.querySelector<HTMLInputElement>('#search')!
const problemsInput = document.querySelector<HTMLInputElement>('#problems-only')!
const viewCount = document.querySelector<HTMLElement>('#view-count')!
const emptyView = document.querySelector<HTMLElement>('#empty-view')!
const clearFilters = document.querySelector<HTMLButtonElement>('#clear-filters')!
const reportBtn = document.querySelector<HTMLButtonElement>('#export-report')!
const reportStatus = document.querySelector<HTMLElement>('#report-status')!
const editedSettings = new Set<keyof LegacySettings>()
const settingsInputs = { repo: repoInput, token: tokenInput, eventType: eventInput }
let editedPreferences = false
let items: PreflightItem[] = []
let scanId: number | undefined
let navigationRequest = 0
let consoleBusy = false
let consoleConnected = false
let githubBusy = false
let currentPreflight = false
let reportAvailable = false
let reportRequest = 0
let reportPending: { scanId: number, requestId: number } | undefined
let uiActive = true
const reportUrls = new Map<string, number | undefined>()
function updateReport() {
  reportBtn.disabled = !uiActive || !reportAvailable || scanId === undefined || reportPending !== undefined
}
function setReportStatus(text: string, kind: 'ok' | 'err' | '' = '') {
  reportStatus.textContent = text
  reportStatus.className = kind
}
function invalidateReport(text: string, error = false) {
  reportAvailable = false
  reportPending = undefined
  reportRequest++
  setReportStatus(text, error ? 'err' : '')
  updateReport()
}
function releaseReportUrl(url: string) {
  const timer = reportUrls.get(url)
  if (timer !== undefined) {
    window.clearTimeout(timer)
  }
  if (reportUrls.delete(url)) {
    URL.revokeObjectURL(url)
  }
}
reportBtn.addEventListener('click', () => {
  if (!uiActive || !reportAvailable || scanId === undefined || reportPending) {
    return
  }
  reportPending = { scanId, requestId: ++reportRequest }
  setReportStatus('Preparing the complete scan report…')
  updateReport()
  parent.postMessage({ pluginMessage: { type: 'export-report', ...reportPending } }, '*')
})
function receiveReport(message: PluginMessage) {
  if (!reportPending || message.scanId !== reportPending.scanId || message.requestId !== reportPending.requestId) {
    return
  }
  // Consume the request before creating a Blob: replayed responses cannot download twice.
  reportPending = undefined
  if (message.error || typeof message.json !== 'string') {
    if (message.rescan) {
      reportAvailable = false
    }
    setReportStatus(message.text ?? 'Could not prepare the report. Try exporting again.', 'err')
    updateReport()
    return
  }
  let url: string | undefined
  let anchor: HTMLAnchorElement | undefined
  try {
    url = URL.createObjectURL(new Blob([message.json, '\n'], { type: 'application/json' }))
    reportUrls.set(url, undefined)
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `iconctl-preflight-${message.scanId}.json`
    anchor.hidden = true
    document.body.appendChild(anchor)
    anchor.click()
    setReportStatus(`Report downloaded. This is a local page preflight; server validation is still required.${message.serverNamingPending ? ' Names are provisional until server naming runs.' : ''}`, 'ok')
    const ownedUrl = url
    reportUrls.set(ownedUrl, window.setTimeout(releaseReportUrl, 0, ownedUrl))
    url = undefined
  }
  catch {
    setReportStatus('Could not download the report. Try exporting again.', 'err')
  }
  finally {
    anchor?.remove()
    if (url) {
      releaseReportUrl(url)
    }
    updateReport()
  }
}
function updateSubmit() {
  publishBtn.disabled = !uiActive || !currentPreflight || !canSubmit(items) || (modeInput.value === 'console'
    ? consoleBusy || !consoleConnected
    : githubBusy)
}
window.addEventListener('pagehide', () => {
  uiActive = false
  updateSubmit()
  reportPending = undefined
  for (const url of [...reportUrls.keys()]) {
    releaseReportUrl(url)
  }
  updateReport()
})

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
  })[char] || char)
}
function renderList() {
  const available = items.filter(item => !item.skipped)
  const query = searchInput.value.trim().toLowerCase()
  const visible = available.filter(item => (!problemsInput.checked || item.issues.length > 0)
    && [item.name, item.iconName ?? '', ...item.issues].some(value => value.toLowerCase().includes(query)))
  viewCount.textContent = `Showing ${visible.length} of ${available.length} icons`
  emptyView.hidden = visible.length > 0
  emptyView.textContent = available.length ? 'No icons match these filters.' : 'No icons to display on this page.'
  clearFilters.disabled = !searchInput.value && !problemsInput.checked
  listEl.innerHTML = visible
    .map((item) => {
      const state = item.issues.length ? 'err' : 'ok'
      const detail = item.issues.length
        ? item.issues.join(' · ')
        : item.iconName
      return `<li class="${state}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail || '')}</span><button class="secondary locate" type="button" data-node-id="${escapeHtml(item.id)}"${scanId === undefined ? ' disabled' : ''} aria-label="Locate ${escapeHtml(item.name)}">Locate</button></li>`
    })
    .join('')
}
function render() {
  renderList()
  const visible = items.filter(item => !item.skipped)
  const skipped = items.filter(item => item.skipped).length
  const errors = visible.filter(item => item.issues.length)
  const summary = errors.length
    ? `${errors.length} of ${visible.length} icons need fixes`
    : `${visible.length} icons ready`
  setStatus(skipped ? `${summary} · ${skipped} drafts skipped` : summary, errors.length ? 'err' : 'ok')
  updateSubmit()
}
function changeView() {
  navigationRequest++
  navigationStatus.textContent = ''
  navigationStatus.className = ''
  if (scanId !== undefined) {
    parent.postMessage({ pluginMessage: { type: 'cancel-navigation', scanId } }, '*')
  }
  renderList()
}
function savePreferences() {
  editedPreferences = true
  parent.postMessage({ pluginMessage: { type: 'save-preferences', preferences: { problemsOnly: problemsInput.checked } } }, '*')
}
searchInput.addEventListener('input', changeView)
problemsInput.addEventListener('change', () => {
  changeView()
  savePreferences()
})
clearFilters.addEventListener('click', () => {
  searchInput.value = ''
  problemsInput.checked = false
  changeView()
  savePreferences()
})
for (const key of ['repo', 'token', 'eventType'] as const) {
  settingsInputs[key].addEventListener('input', () => editedSettings.add(key))
}
for (const scope of ['settings', 'preferences'] as const) {
  document.querySelector(`#retry-${scope}`)!.addEventListener('click', () => {
    parent.postMessage({
      pluginMessage: {
        type: 'retry-storage',
        scope,
        ...(scope === 'settings'
          ? { settings: { repo: repoInput.value, token: tokenInput.value, eventType: eventInput.value } }
          : { preferences: { problemsOnly: problemsInput.checked } }),
      },
    }, '*')
  })
}
function invalidatePreflight(text: string, error = false) {
  currentPreflight = false
  updateSubmit()
  scanId = undefined
  navigationRequest++
  navigationStatus.textContent = text
  navigationStatus.className = error ? 'err' : ''
  listEl.querySelectorAll<HTMLButtonElement>('button[data-node-id]').forEach((button) => {
    button.disabled = true
  })
  invalidateReport(text, error)
}
listEl.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-node-id]') : null
  if (!button || !listEl.contains(button) || button.disabled || scanId === undefined) {
    return
  }
  navigationStatus.textContent = 'Locating component…'
  navigationStatus.className = ''
  parent.postMessage({ pluginMessage: { type: 'locate', nodeId: button.dataset['nodeId'], scanId, requestId: ++navigationRequest } }, '*')
})
function readSettings() {
  const { owner, repo } = parseRepo(repoInput.value)
  const token = tokenInput.value.trim()
  const eventType = eventInput.value.trim() || 'iconctl-publish'
  if (!token) {
    throw new Error('GitHub token is required')
  }
  return { owner, repo, token, eventType }
}
parent.postMessage({ pluginMessage: { type: 'rescan', mode: modeInput.value } }, '*')
rescanBtn.addEventListener('click', () => {
  invalidatePreflight('Rescanning page…')
  parent.postMessage({ pluginMessage: { type: 'rescan', mode: modeInput.value } }, '*')
})
publishBtn.addEventListener('click', async () => {
  if (!uiActive) {
    return
  }
  try {
    if (!currentPreflight) {
      throw new Error('Rescan this page before submitting')
    }
    if (!canSubmit(items)) {
      throw new Error('Fix all preflight errors before submitting')
    }
    if (modeInput.value === 'console') {
      if (consoleBusy || !consoleConnected) {
        return
      }
      consoleBusy = true
      updateSubmit()
      parent.postMessage({ pluginMessage: { type: 'console-sync' } }, '*')
      return
    }
    const settings = readSettings()
    parent.postMessage({
      pluginMessage: {
        type: 'save-settings',
        settings: {
          repo: repoInput.value.trim(),
          token: settings.token,
          eventType: settings.eventType,
        },
      },
    }, '*')
    githubBusy = true
    updateSubmit()
    setStatus('Dispatching GitHub Action…')
    await dispatchPublish(settings)
    setStatus(`Workflow started. ${actionsUrl(settings)}`, 'ok')
  }
  catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'err')
  }
  finally {
    githubBusy = false
    updateSubmit()
  }
})
window.onmessage = (event: MessageEvent<{
  pluginMessage?: PluginMessage
}>) => {
  if (!uiActive || event.source !== parent) {
    return
  }
  const message = event.data.pluginMessage
  if (!message) {
    return
  }
  if (message.type === 'console-status' || message.type === 'console-state') {
    if (message.busy !== undefined) {
      consoleBusy = message.busy
    }
    if (message.connected !== undefined) {
      consoleConnected = message.connected
    }
    updateSubmit()
  }
  if (message.type === 'console-status') {
    consoleStatus.textContent = message.text ?? ''
    if (message.origin) {
      originInput.value = message.origin
    }
    if (message.url) {
      const url = new URL(message.url)
      if (url.protocol === 'https:'
        && url.origin === new URL(originInput.value).origin) {
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
    scanId = Number.isSafeInteger(message.scanId) ? message.scanId : undefined
    navigationRequest++
    navigationStatus.textContent = ''
    navigationStatus.className = ''
    items = message.items
    currentPreflight = true
    reportPending = undefined
    reportRequest++
    reportAvailable = message.reportAvailable === true && scanId !== undefined
    setReportStatus(reportAvailable ? 'Export includes every scanned component, including drafts and hidden results.' : 'Rescan to prepare a complete report.')
    updateReport()
    render()
  }
  if (message.type === 'preflight-report') {
    receiveReport(message)
  }
  if (message.type === 'navigation-invalidated') {
    invalidatePreflight(message.text ?? '', message.error ?? true)
  }
  if (message.type === 'navigation-result' && message.scanId === scanId && message.requestId === navigationRequest) {
    navigationStatus.textContent = message.text ?? ''
    navigationStatus.className = message.error ? 'err' : 'ok'
  }
  if (message.type === 'settings' && message.settings) {
    for (const key of ['repo', 'token', 'eventType'] as const) {
      if (!editedSettings.has(key)) {
        settingsInputs[key].value = message.settings[key] ?? (key === 'eventType' ? 'iconctl-publish' : '')
      }
    }
  }
  if (message.type === 'preferences' && typeof message.preferences?.problemsOnly === 'boolean' && !editedPreferences) {
    problemsInput.checked = message.preferences.problemsOnly
    changeView()
  }
  if (message.type === 'storage-status' && (message.scope === 'settings' || message.scope === 'preferences')) {
    document.querySelector<HTMLElement>(`#${message.scope}-feedback`)!.hidden = !message.error
    document.querySelector(`#${message.scope}-storage-status`)!.textContent = message.text ?? ''
  }
}
modeInput.addEventListener('change', () => {
  invalidatePreflight('Rescanning page…')
  const consoleMode = modeInput.value === 'console'
  consoleFields.hidden = !consoleMode
  githubFields.hidden = consoleMode
  publishBtn.textContent = consoleMode
    ? 'Sync to console'
    : 'Dispatch GitHub Action'
  parent.postMessage({ pluginMessage: { type: 'rescan', mode: modeInput.value } }, '*')
  updateSubmit()
})
document
  .querySelector('#connect')!
  .addEventListener('click', () => {
    invalidatePreflight('Updating project connection…')
    parent.postMessage({ pluginMessage: { type: 'console-pair', origin: originInput.value } }, '*')
  })
document
  .querySelector('#disconnect')!
  .addEventListener('click', () => {
    invalidatePreflight('Updating project connection…')
    parent.postMessage({ pluginMessage: { type: 'console-disconnect' } }, '*')
  })
parent.postMessage({ pluginMessage: { type: 'console-status' } }, '*')
parent.postMessage({ pluginMessage: { type: 'load-settings' } }, '*')

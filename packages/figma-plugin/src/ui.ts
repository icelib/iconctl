import type { PreflightItem } from './preflight'
import type { IssueType, PreflightSort } from './preflight-view'
import type { AppliedRules } from './report'
import type { LegacySettings, ViewPreferences } from './settings'
import type { HandoffFile } from './svg-handoff-format'
import { CopyVisibleJsonUI } from './copy-visible-json-ui'
import { actionsUrl, dispatchPublish, parseRepo } from './github'
import { canSubmit } from './preflight'
import { issueType, preflightSort, PreflightView } from './preflight-view'
import { SvgHandoffUI } from './svg-handoff-ui'
import { MAX_VISIBLE_SELECTION, selectionError } from './visible-selection'

interface PluginMessage {
  type: string
  appliedRules?: AppliedRules
  paired?: boolean
  stale?: boolean
  outcome?: 'accepted' | 'success' | 'error' | 'ignored'
  text?: string
  origin?: string
  url?: string
  error?: boolean
  busy?: boolean
  enabled?: boolean
  state?: string
  files?: HandoffFile[]
  connected?: boolean
  items?: PreflightItem[]
  scanId?: number
  nodeId?: string
  requestId?: number
  rulesRequestId?: number
  reportAvailable?: boolean
  json?: string
  html?: string
  format?: 'json' | 'html'
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
const githubStatus = document.querySelector('#github-status')!
const liveInput = document.querySelector<HTMLInputElement>('#live-preflight')!
const liveStatus = document.querySelector('#live-preflight-status')!
const listEl = document.querySelector('#list')!
const publishBtn = document.querySelector<HTMLButtonElement>('#publish')!
const rescanBtn = document.querySelector<HTMLButtonElement>('#rescan')!
const navigationStatus = document.querySelector<HTMLElement>('#navigation-status')!
const previousProblem = document.querySelector<HTMLButtonElement>('#previous-problem')!
const nextProblem = document.querySelector<HTMLButtonElement>('#next-problem')!
const selectVisibleBtn = document.querySelector<HTMLButtonElement>('#select-visible')!
const selectionHelp = document.querySelector<HTMLElement>('#selection-help')!
const problemPosition = document.querySelector<HTMLElement>('#problem-position')!
const searchInput = document.querySelector<HTMLInputElement>('#search')!
const problemsInput = document.querySelector<HTMLInputElement>('#problems-only')!
const issueTypeInput = document.querySelector<HTMLSelectElement>('#issue-type')!
const sortInput = document.querySelector<HTMLSelectElement>('#sort')!
const viewCount = document.querySelector<HTMLElement>('#view-count')!
const emptyView = document.querySelector<HTMLElement>('#empty-view')!
const clearFilters = document.querySelector<HTMLButtonElement>('#clear-filters')!
const reportBtn = document.querySelector<HTMLButtonElement>('#export-report')!
const htmlReportBtn = document.querySelector<HTMLButtonElement>('#export-html-report')!
const reportStatus = document.querySelector<HTMLElement>('#report-status')!
const rulesBtn = document.querySelector<HTMLButtonElement>('#refresh-rules')!
const rulesStatus = document.querySelector<HTMLElement>('#rules-status')!
const rulesContent = document.querySelector<HTMLElement>('#rules-content')!
const rulesValidity = document.querySelector<HTMLElement>('#rules-validity')!
const editedSettings = new Set<keyof LegacySettings>()
const settingsInputs = { repo: repoInput, token: tokenInput, eventType: eventInput }
let editedPreferences = false
let items: PreflightItem[] = []
let selectedIssueType: IssueType = 'all'
let selectedSort: PreflightSort = 'page'
const preflightView = new PreflightView()
let scanId: number | undefined
let navigationRequest = 0
let navigationPending: ({ scanId: number, requestId: number } & (
  { type: 'locate', nodeId: string } | { type: 'select-visible', nodeIds: string[] }
)) | undefined
let problemCursor: string | undefined
let consoleBusy = false
let consoleConnected = false
let githubBusy = false
let currentPreflight = false
let reportAvailable = false
let reportRequest = 0
let reportPending: { scanId: number, requestId: number, format: 'json' | 'html' } | undefined
let rulesPaired = false
let hasRulesState = false
let rulesRequest = 0
let rulesPending: number | undefined
let uiActive = true
let liveRequest = 0
let handoffRules: AppliedRules | undefined
function visibleItems() {
  return preflightView.visible({ search: searchInput.value, problemsOnly: problemsInput.checked, issueType: selectedIssueType, sort: selectedSort })
}
const reportUrls = new Map<string, number | undefined>()
const handoffUI = new SvgHandoffUI({
  current: () => ({ active: uiActive, current: currentPreflight, scanId, items, rules: handoffRules }),
  send: message => parent.postMessage({ pluginMessage: message }, '*'),
  button: document.querySelector<HTMLButtonElement>('#export-svg-handoff')!,
  cancel: document.querySelector<HTMLButtonElement>('#cancel-svg-handoff')!,
  help: document.querySelector<HTMLElement>('#svg-handoff-help')!,
  status: document.querySelector<HTMLElement>('#svg-handoff-status')!,
})
const copyVisibleJsonUI = new CopyVisibleJsonUI({
  current: () => ({ active: uiActive, current: currentPreflight, scanId, items: visibleItems(), serverNaming: handoffRules?.rules.namingMode === 'server' }),
  clipboard: () => navigator.clipboard,
  content: document.querySelector<HTMLSelectElement>('#copy-json-content')!,
  scope: document.querySelector<HTMLElement>('#copy-names-scope')!,
  textLabel: document.querySelector<HTMLElement>('#copy-json-label')!,
  button: document.querySelector<HTMLButtonElement>('#copy-visible-names')!,
  summary: document.querySelector<HTMLElement>('#copy-names-summary')!,
  help: document.querySelector<HTMLElement>('#copy-names-help')!,
  warning: document.querySelector<HTMLElement>('#copy-names-warning')!,
  status: document.querySelector<HTMLElement>('#copy-names-status')!,
  fallback: document.querySelector<HTMLElement>('#copy-names-fallback')!,
  text: document.querySelector<HTMLTextAreaElement>('#copy-names-json')!,
  select: document.querySelector<HTMLButtonElement>('#select-names-json')!,
})
function updateRules() {
  rulesBtn.hidden = modeInput.value !== 'console'
  rulesBtn.disabled = !uiActive || !rulesPaired || consoleBusy || rulesPending !== undefined
}
function clearRulesRequest() {
  rulesRequest++
  rulesPending = undefined
  rulesStatus.textContent = ''
  rulesStatus.className = ''
  updateRules()
}
function renderRules(overview?: AppliedRules) {
  rulesContent.replaceChildren()
  if (!overview) {
    rulesValidity.textContent = 'Rule details unavailable. Rescan with the updated plugin.'
    return
  }
  const fields = [
    ['Source', overview.rulesSource === 'project' ? 'Project rules' : overview.rulesSource === 'legacy-defaults' ? 'Legacy GitHub defaults' : 'Unpaired defaults'],
    ...(overview.project ? [['Project', `${overview.project.name} · revision ${overview.project.revision}`]] : []),
    ['Width', overview.rules.width === undefined ? 'Unrestricted' : String(overview.rules.width)],
    ['Height', overview.rules.height === undefined ? 'Unrestricted' : String(overview.rules.height)],
    ['Name pattern', overview.rules.name],
    ['Skip prefixes', overview.rules.skipPrefix.length ? overview.rules.skipPrefix.map(prefix => JSON.stringify(prefix)).join(', ') : 'None'],
    ['Naming', overview.rules.namingMode === 'server' ? 'Provisional — custom naming is validated by the server.' : 'Default local naming. Duplicate names are checked on this page.'],
  ]
  for (const [label, value] of fields) {
    const term = document.createElement('dt')
    term.textContent = label!
    const detail = document.createElement('dd')
    detail.textContent = value!
    rulesContent.append(term, detail)
  }
  rulesValidity.textContent = 'Applied to this scan. Server validation is still required.'
}
function updateReport() {
  reportBtn.disabled = !uiActive || !reportAvailable || scanId === undefined || reportPending !== undefined
  htmlReportBtn.disabled = reportBtn.disabled
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
function requestReport(format: 'json' | 'html') {
  if (!uiActive || !reportAvailable || scanId === undefined || reportPending) {
    return
  }
  reportPending = { scanId, requestId: ++reportRequest, format }
  setReportStatus('Preparing the complete scan report…')
  updateReport()
  parent.postMessage({ pluginMessage: { type: 'export-report', ...reportPending } }, '*')
}
reportBtn.addEventListener('click', () => requestReport('json'))
htmlReportBtn.addEventListener('click', () => requestReport('html'))
function receiveReport(message: PluginMessage) {
  if (!reportPending || message.scanId !== reportPending.scanId || message.requestId !== reportPending.requestId
    || (message.format ?? 'json') !== reportPending.format) {
    return
  }
  const format = reportPending.format
  const content = format === 'html' ? message.html : message.json
  // Consume the request before creating a Blob: replayed responses cannot download twice.
  reportPending = undefined
  if (message.error || typeof content !== 'string') {
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
    url = URL.createObjectURL(new Blob([content, '\n'], { type: format === 'html' ? 'text/html;charset=utf-8' : 'application/json' }))
    reportUrls.set(url, undefined)
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `iconctl-preflight-${message.scanId}.${format}`
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
  handoffUI.update()
  copyVisibleJsonUI.update()
}
function setStatus(text: string, kind: 'ok' | 'err' | '' = '') {
  statusEl.textContent = text
  statusEl.className = kind
}
function setGithubStatus(text: string, kind: 'ok' | 'err' | '' = '') {
  githubStatus.textContent = text
  githubStatus.className = kind
}
function setLive(enabled: boolean) {
  liveInput.checked = enabled
  liveStatus.textContent = enabled ? 'Starting live preflight…' : 'Live preflight is off. Choose Rescan after editing.'
  parent.postMessage({ pluginMessage: { type: 'set-live-preflight', enabled, requestId: ++liveRequest } }, '*')
}
liveInput.addEventListener('change', () => {
  if (uiActive) {
    setLive(liveInput.checked)
  }
})
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[char] || char)
}
function updateProblemNavigation() {
  const visible = visibleItems()
  const problems = visible.filter(item => item.issues.length > 0)
  const active = uiActive && currentPreflight && scanId !== undefined
  const selectionReason = active ? selectionError(visible.map(item => item.id)) : 'Rescan with current rules before selecting components.'
  selectVisibleBtn.disabled = Boolean(selectionReason) || navigationPending?.type === 'select-visible'
  selectionHelp.textContent = selectionReason ?? `${visible.length} visible ${visible.length === 1 ? 'component' : 'components'} · Maximum ${MAX_VISIBLE_SELECTION} per selection`
  previousProblem.disabled = nextProblem.disabled = !active || !problems.length
  const index = problems.findIndex(item => item.id === problemCursor)
  if (!active) {
    problemPosition.textContent = 'Rescan to navigate problems.'
  }
  else if (!problems.length) {
    problemPosition.textContent = items.some(item => !item.skipped && item.issues.length > 0)
      ? 'No problems match these filters.'
      : 'No problems in this scan.'
  }
  else if (index < 0) {
    problemPosition.textContent = `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} in this view. Choose Next or Previous.`
  }
  else {
    problemPosition.textContent = `Problem ${index + 1} of ${problems.length}`
  }
  listEl.querySelectorAll<HTMLElement>('li[data-icon-id]').forEach((row) => {
    if (active && index >= 0 && row.dataset['iconId'] === problemCursor) {
      row.setAttribute('aria-current', 'true')
    }
    else {
      row.removeAttribute('aria-current')
    }
    row.querySelector<HTMLButtonElement>('button[data-node-id]')!.disabled = !active
  })
}
function clearNavigation(cancel = true) {
  navigationRequest++
  navigationPending = undefined
  problemCursor = undefined
  if (cancel && scanId !== undefined) {
    parent.postMessage({ pluginMessage: { type: 'cancel-navigation', scanId } }, '*')
  }
  updateProblemNavigation()
}
function locateItem(nodeId: string) {
  if (!uiActive || !currentPreflight || scanId === undefined) {
    return
  }
  const item = visibleItems().find(item => item.id === nodeId)
  if (!item) {
    return
  }
  // Remember the attempted component so a failed lookup can move on to the next.
  problemCursor = item.issues.length ? item.id : undefined
  navigationPending = { type: 'locate', nodeId, scanId, requestId: ++navigationRequest }
  navigationStatus.textContent = 'Locating component…'
  navigationStatus.className = ''
  updateProblemNavigation()
  const row = [...listEl.querySelectorAll<HTMLElement>('li[data-icon-id]')].find(row => row.dataset['iconId'] === nodeId)
  row?.scrollIntoView({ block: 'nearest' })
  parent.postMessage({ pluginMessage: navigationPending }, '*')
}
function selectVisible() {
  if (!uiActive || !currentPreflight || scanId === undefined || navigationPending?.type === 'select-visible') {
    return
  }
  const nodeIds = visibleItems().map(item => item.id)
  if (selectionError(nodeIds)) {
    return
  }
  problemCursor = undefined
  navigationPending = { type: 'select-visible', nodeIds, scanId, requestId: ++navigationRequest }
  navigationStatus.textContent = `Checking ${nodeIds.length} visible components before selecting…`
  navigationStatus.className = ''
  updateProblemNavigation()
  parent.postMessage({ pluginMessage: navigationPending }, '*')
}
function stepProblem(direction: 1 | -1) {
  const problems = visibleItems().filter(item => item.issues.length > 0)
  if (!problems.length) {
    return
  }
  const index = problems.findIndex(item => item.id === problemCursor)
  const next = index < 0
    ? direction === 1 ? 0 : problems.length - 1
    : (index + direction + problems.length) % problems.length
  locateItem(problems[next]!.id)
}
previousProblem.addEventListener('click', () => stepProblem(-1))
nextProblem.addEventListener('click', () => stepProblem(1))
selectVisibleBtn.addEventListener('click', selectVisible)
window.addEventListener('pagehide', () => {
  copyVisibleJsonUI.dispose()
  handoffUI.dispose()
  setLive(false)
  uiActive = false
  liveInput.disabled = true
  sortInput.disabled = true
  clearNavigation()
  clearRulesRequest()
  updateSubmit()
  reportPending = undefined
  for (const url of [...reportUrls.keys()]) {
    releaseReportUrl(url)
  }
  updateReport()
})
function renderList() {
  issueTypeInput.replaceChildren(...preflightView.options(selectedIssueType).map(({ value, label }) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    return option
  }))
  issueTypeInput.value = selectedIssueType
  sortInput.value = selectedSort
  const available = items.filter(item => !item.skipped)
  const visible = visibleItems()
  viewCount.textContent = `Showing ${visible.length} of ${available.length} icons`
  emptyView.hidden = visible.length > 0
  emptyView.textContent = available.length ? 'No icons match these filters.' : 'No icons to display on this page.'
  clearFilters.disabled = !searchInput.value && !problemsInput.checked && selectedIssueType === 'all'
  listEl.innerHTML = visible
    .map((item) => {
      const state = item.issues.length ? 'err' : 'ok'
      const detail = item.issues.length
        ? item.issues.join(' · ')
        : item.iconName
      return `<li class="${state}" data-icon-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail || '')}</span><span class="node-id">ID: ${escapeHtml(item.id)}</span><button class="secondary locate" type="button" data-node-id="${escapeHtml(item.id)}" aria-label="Locate ${escapeHtml(item.name)}">Locate</button></li>`
    })
    .join('')
  updateProblemNavigation()
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
  copyVisibleJsonUI.change()
  clearNavigation()
  navigationStatus.textContent = ''
  navigationStatus.className = ''
  renderList()
}
function savePreferences() {
  editedPreferences = true
  parent.postMessage({ pluginMessage: { type: 'save-preferences', preferences: { problemsOnly: problemsInput.checked } } }, '*')
}
searchInput.addEventListener('input', changeView)
issueTypeInput.addEventListener('change', () => {
  selectedIssueType = issueType(issueTypeInput.value)
  changeView()
})
sortInput.addEventListener('change', () => {
  if (!uiActive) {
    return
  }
  selectedSort = preflightSort(sortInput.value)
  changeView()
})
problemsInput.addEventListener('change', () => {
  changeView()
  savePreferences()
})
clearFilters.addEventListener('click', () => {
  searchInput.value = ''
  problemsInput.checked = false
  selectedIssueType = 'all'
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
  copyVisibleJsonUI.change()
  clearNavigation()
  rulesValidity.textContent = 'Scan out of date. Rescan or refresh project rules before using these results.'
  updateSubmit()
  scanId = undefined
  navigationStatus.textContent = text
  navigationStatus.className = error ? 'err' : ''
  invalidateReport(text, error)
}
rulesBtn.addEventListener('click', () => {
  if (!uiActive || !rulesPaired || consoleBusy || rulesPending !== undefined || modeInput.value !== 'console') {
    return
  }
  rulesPending = ++rulesRequest
  handoffUI.cancel('Project rules are being refreshed.')
  invalidatePreflight('Refreshing project rules…')
  rulesStatus.textContent = 'Refreshing project rules…'
  rulesStatus.className = ''
  updateRules()
  parent.postMessage({ pluginMessage: { type: 'console-refresh-rules', requestId: rulesPending } }, '*')
})
listEl.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-node-id]') : null
  if (!button || !listEl.contains(button) || button.disabled || scanId === undefined) {
    return
  }
  locateItem(button.dataset['nodeId']!)
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
  handoffUI.cancel('A new scan was requested.')
  invalidatePreflight('Rescanning page…')
  parent.postMessage({ pluginMessage: { type: 'rescan', mode: modeInput.value } }, '*')
})
publishBtn.addEventListener('click', async () => {
  if (!uiActive) {
    return
  }
  const actionMode = modeInput.value
  try {
    if (!currentPreflight) {
      throw new Error('Rescan this page before submitting')
    }
    if (!canSubmit(items)) {
      throw new Error('Fix all preflight errors before submitting')
    }
    if (actionMode === 'console') {
      if (consoleBusy || !consoleConnected) {
        return
      }
      consoleBusy = true
      handoffUI.cancel('Console sync started.')
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
    setGithubStatus('Dispatching GitHub Action…')
    await dispatchPublish(settings)
    setGithubStatus(`Workflow started. ${actionsUrl(settings)}`, 'ok')
  }
  catch (error) {
    const show = actionMode === 'github' ? setGithubStatus : setStatus
    show(error instanceof Error ? error.message : String(error), 'err')
  }
  finally {
    if (actionMode === 'github') {
      githubBusy = false
    }
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
  if (message.type.startsWith('svg-handoff-')) {
    handoffUI.receive(message)
    return
  }
  if (message.type === 'live-preflight-state' && message.requestId === liveRequest) {
    liveInput.checked = message.enabled === true
    liveStatus.textContent = message.text ?? ''
  }
  if (message.type === 'console-status' || message.type === 'console-state') {
    if (message.busy !== undefined) {
      consoleBusy = message.busy
    }
    if (message.connected !== undefined) {
      consoleConnected = message.connected
      if (message.connected && !hasRulesState) {
        rulesPaired = true
      }
    }
    updateSubmit()
    updateRules()
  }
  if (message.type === 'project-rules-state') {
    hasRulesState = true
    if (message.paired !== undefined) {
      rulesPaired = message.paired
    }
    updateRules()
  }
  if (message.type === 'project-rules-status' && rulesPending !== undefined && message.requestId === rulesPending) {
    rulesStatus.textContent = message.text ?? ''
    rulesStatus.className = message.error ? 'err' : message.outcome === 'success' ? 'ok' : ''
    if (message.outcome !== 'accepted') {
      rulesPending = undefined
    }
    updateRules()
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
    if ((message.appliedRules && message.appliedRules.mode !== modeInput.value)
      || (message.rulesRequestId !== undefined && message.rulesRequestId !== rulesPending)) {
      return
    }
    clearNavigation(false)
    scanId = Number.isSafeInteger(message.scanId) ? message.scanId : undefined
    navigationStatus.textContent = ''
    navigationStatus.className = ''
    items = message.items
    preflightView.capture(items)
    handoffRules = message.appliedRules
    renderRules(message.appliedRules)
    currentPreflight = true
    copyVisibleJsonUI.change()
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
  if (message.type === 'navigation-result' && navigationPending?.type === 'locate'
    && message.scanId === scanId && message.scanId === navigationPending.scanId
    && message.requestId === navigationPending.requestId
    && (message.nodeId === undefined || message.nodeId === navigationPending.nodeId)) {
    navigationPending = undefined
    navigationStatus.textContent = message.text ?? ''
    navigationStatus.className = message.error ? 'err' : 'ok'
  }
  if (message.type === 'selection-result' && navigationPending?.type === 'select-visible'
    && message.scanId === scanId && message.scanId === navigationPending.scanId
    && message.requestId === navigationPending.requestId) {
    navigationPending = undefined
    navigationStatus.textContent = message.text ?? ''
    navigationStatus.className = message.error ? 'err' : 'ok'
    updateProblemNavigation()
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
  handoffUI.cancel('Connection mode changed.')
  clearRulesRequest()
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
    handoffUI.cancel('Project connection changed.')
    setLive(false)
    clearRulesRequest()
    rulesPaired = false
    updateRules()
    invalidatePreflight('Updating project connection…')
    parent.postMessage({ pluginMessage: { type: 'console-pair', origin: originInput.value } }, '*')
  })
document
  .querySelector('#disconnect')!
  .addEventListener('click', () => {
    handoffUI.cancel('Project connection changed.')
    setLive(false)
    clearRulesRequest()
    rulesPaired = false
    updateRules()
    invalidatePreflight('Updating project connection…')
    parent.postMessage({ pluginMessage: { type: 'console-disconnect' } }, '*')
  })
parent.postMessage({ pluginMessage: { type: 'console-status' } }, '*')
parent.postMessage({ pluginMessage: { type: 'load-settings' } }, '*')

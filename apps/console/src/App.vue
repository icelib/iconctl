<script setup lang="ts">
import type {
  ConsoleState,
  IconJSON,
  Job,
  Project,
  ProjectInput,
  SnapshotComparison,
  SnapshotPreview,
  Source,
} from '@iconctl/console-contracts'
import type { ComponentPublicInstance } from 'vue'
import type { SnapshotOriginTarget } from './features/history/snapshot-origin'
import type { NavigationIntent } from './features/projects/draft-navigation'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api, downloadSnapshotJson, downloadSnapshotSvg, initializeSession, restoreBackup, upload } from './api'
import { downloadBlob } from './browser-download'
import { createDiagnosticCopy } from './features/history/diagnostic-copy'
import { createHistoryReveal, historyJobAvailable } from './features/history/history-reveal'
import JobAttempts from './features/history/JobAttempts.vue'
import { snapshotOrigin } from './features/history/snapshot-origin'
import SnapshotDiagnostics from './features/history/SnapshotDiagnostics.vue'
import SnapshotOrigin from './features/history/SnapshotOrigin.vue'
import { upsertSubmittedJob } from './features/history/submitted-job'
import { emptyTaskFilters, filterTasks, jobLabels as labels } from './features/history/task-filters'
import { createTaskSubmission } from './features/history/task-submission'
import { createDraftNavigation } from './features/projects/draft-navigation'
import { createProjectEditor, upsertSavedProject } from './features/projects/project-editor'
import ProjectReconciliation from './features/projects/ProjectReconciliation.vue'
import { createSourceUpload } from './features/projects/source-upload'
import { createComparisonReportDownload } from './features/review/comparison-report-download'
import ComparisonReportDownloads from './features/review/ComparisonReportDownloads.vue'
import { createReleaseReview } from './features/review/release-review'
import { createSnapshotDownload } from './features/review/snapshot-download'
import { createSnapshotReview } from './features/review/snapshot-review'
import { createWorkspaceRefresh } from './features/workspace/workspace-refresh'

type View = 'projects' | 'config' | 'preview' | 'history' | 'connections'
const navigation: { id: View, name: string, symbol: string }[] = [
  { id: 'projects', name: '图标项目', symbol: '▦' },
  { id: 'config', name: '项目配置', symbol: '⚙' },
  { id: 'preview', name: '预览与差异', symbol: '◈' },
  { id: 'history', name: '任务与版本', symbol: '↗' },
  { id: 'connections', name: '授权与插件', symbol: '⌘' },
]
const view = ref<View>(
  new URLSearchParams(location.search).get('view') === 'connections'
    ? 'connections'
    : new URLSearchParams(location.search).has('job')
      ? 'history'
      : 'projects',
)
const data = ref<ConsoleState>({
  projects: [],
  jobs: [],
  snapshots: [],
  releases: [],
  connections: [],
  pairings: [],
  devices: [],
})
const mutating = ref(false)
const workspace = createWorkspaceRefresh<ConsoleState>({
  initialize: initializeSession,
  read: signal => api<ConsoleState>('state', undefined, 'GET', { signal }),
  commit: applyWorkspace,
  automatic: () => !mutating.value && document.visibilityState === 'visible',
  visibilityTarget: document,
  onlineTarget: window,
})
const workspaceState = workspace.state
const ready = computed(() => workspaceState.value.ready)
const busy = computed(() => mutating.value || !ready.value)
const error = ref('')
const notice = ref('')
const linkedJobId = new URLSearchParams(location.search).get('job')
const linkedJobError = ref('')
const linkedJobLocated = ref(false)
let locatingLinkedJob = false
const selectedId = ref('')
let uploadsPending = () => false
function blank(): ProjectInput {
  return {
    name: '',
    repository: 'icelib/iconctl',
    prefix: '',
    packageName: '',
    sources: [{ type: 'directory', dir: 'raw' }],
    color: 'currentColor',
    validate: { skipPrefix: ['_', '.'] },
    output: { svg: true, types: true, preview: true, changelog: true },
  }
}
const editor = createProjectEditor({
  blank,
  save: (input, project) => project
    ? api<Project>(`projects/${project.id}`, { project: input, revision: project.revision }, 'PUT')
    : api<Project>('projects', input),
  committed(project, current) {
    workspace.invalidate()
    data.value.projects = upsertSavedProject(data.value.projects, project)
    if (current) {
      selectedId.value = project.id
    }
  },
  async refresh() {
    const state = await refresh(false)
    return state?.projects ?? []
  },
  reconcileBlocked: () => uploadsPending(),
})
const draft = editor.draft
const editorState = editor.state
const editorDirty = editor.dirty
const reconciliationStale = editor.reconciliationStale
const uploads = createSourceUpload({ sources: () => draft.sources ?? [], session: () => editor.session.value, upload })
const uploading = uploads.pending
uploadsPending = () => uploading.value
watch(editor.session, uploads.invalidate, { flush: 'sync' })
watch(() => draft.sources?.slice() ?? [], uploads.prune, { flush: 'sync' })
const editing = computed(() => editorState.value.project)
const protectedDraft = computed(() => view.value === 'config' && editorDirty.value)
const draftNavigation = createDraftNavigation({ dirty: () => protectedDraft.value, session: () => editor.session.value })
const navigationState = draftNavigation.state
const navigationDialog = ref<HTMLDialogElement>()
const allowDocumentLeave = ref(false)
let disposed = false
watch(editor.session, draftNavigation.invalidate, { flush: 'sync' })
watch(() => !!navigationState.value.pending, (pending) => {
  if (pending) {
    navigationDialog.value?.showModal()
  }
  else { navigationDialog.value?.close() }
}, { flush: 'post' })
async function requestNavigation(intent: NavigationIntent, automatic = false) {
  const trigger = document.activeElement
  const result = await draftNavigation.request(intent, automatic)
  if (result === 'cancelled' && !disposed) {
    await nextTick()
    if (!disposed && trigger instanceof HTMLElement && trigger.isConnected) {
      trigger.focus()
    }
  }
  return result
}
function keepNavigationFocus(event: KeyboardEvent) {
  const buttons = navigationDialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  const first = buttons?.[0]
  const last = buttons?.[buttons.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
function protectDocumentLeave(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}
watch(() => protectedDraft.value && !allowDocumentLeave.value, (protect) => {
  if (protect) {
    window.addEventListener('beforeunload', protectDocumentLeave)
  }
  else { window.removeEventListener('beforeunload', protectDocumentLeave) }
}, { flush: 'sync' })
const activeProject = computed(() =>
  data.value.projects.find(project => project.id === selectedId.value),
)
const snapshots = computed(() =>
  data.value.snapshots.filter(
    snapshot => !selectedId.value || snapshot.projectId === selectedId.value,
  ),
)
const projectJobs = computed(() =>
  data.value.jobs.filter(
    job => job.projectId === selectedId.value,
  ),
)
const taskFilters = reactive(emptyTaskFilters())
const jobs = computed(() => filterTasks(projectJobs.value, taskFilters))
const hasTaskFilters = computed(() => taskFilters.status !== 'all' || taskFilters.operation !== 'all' || taskFilters.query !== '')
const linkedJobHidden = computed(() => linkedJobLocated.value && (view.value !== 'history' || !jobs.value.some(job => job.id === linkedJobId)))
function clearTaskFilters() {
  Object.assign(taskFilters, emptyTaskFilters())
}
watch(selectedId, clearTaskFilters, { flush: 'sync' })
const attemptViews = new Map<string, InstanceType<typeof JobAttempts>>()
function rememberHistory(jobId: string, instance: Element | ComponentPublicInstance | null) {
  if (instance) {
    attemptViews.set(jobId, instance as InstanceType<typeof JobAttempts>)
  }
  else { attemptViews.delete(jobId) }
}
const historyReveal = createHistoryReveal({
  request: requestNavigation,
  available: job => historyJobAvailable(job, data.value),
  select(job) {
    selectedId.value = job.projectId
    clearTaskFilters()
    view.value = 'history'
  },
  current: job => view.value === 'history' && selectedId.value === job.projectId
    && jobs.value.some(item => item.id === job.id),
  rendered: nextTick,
  focus(job, attempt) {
    if (attempt !== undefined) {
      return attemptViews.get(job.id)?.reveal(attempt) ?? false
    }
    const row = document.getElementById(`job-${job.id}`)
    if (!row) {
      return false
    }
    row.scrollIntoView({ block: 'center' })
    row.focus()
    return document.activeElement === row
  },
})
watch([selectedId, view, taskFilters], historyReveal.invalidate, { flush: 'sync', deep: true })
const submission = createTaskSubmission({ record: recordSubmittedJob, reveal: revealJob })
const submissionState = submission.state
watch([selectedId, view, taskFilters], submission.invalidate, { flush: 'sync', deep: true })
const releases = computed(() =>
  data.value.releases.filter(
    release => !selectedId.value || release.projectId === selectedId.value,
  ),
)
async function revealJob(job: Job, automatic = false, attempt?: number) {
  return await historyReveal.reveal(job, automatic, attempt)
}
function recordSubmittedJob(job: Job) {
  // The mutation response is authoritative, including a retry's new attempt.
  // Discard any older state request still in flight before displaying it.
  workspace.invalidate()
  data.value.jobs = upsertSubmittedJob(data.value.jobs, job)
}
const sourceType = ref<Source['type']>('figma')
const mastergo = reactive({ label: 'MasterGo', token: '' })
const pairing = reactive({ code: '', projectId: '', label: '我的 Figma 插件' })
const search = ref('')
const filter = ref('all')
const bump = ref<'patch' | 'minor' | 'major'>('patch')
const review = createSnapshotReview((id, compareTo, signal) => api<SnapshotPreview>(
  `snapshots/${id}${compareTo ? `?compareTo=${encodeURIComponent(compareTo)}` : ''}`,
  undefined,
  'GET',
  { signal },
))
const reviewState = review.state
const preview = computed(() => reviewState.value.committed?.preview)
const origin = computed(() => preview.value ? snapshotOrigin(preview.value.snapshot, data.value.jobs) : undefined)
const originLocatable = computed(() => origin.value?.available
  && historyJobAvailable({ id: origin.value.target.jobId, projectId: origin.value.target.projectId }, data.value))
const snapshotId = computed(() => reviewState.value.committed?.id ?? '')
const comparisonTarget = computed(() => reviewState.value.committed?.compareTo ?? '')
const svgDownload = createSnapshotDownload(downloadSnapshotSvg, downloadBlob)
const svgDownloadState = svgDownload.state
const jsonDownload = createSnapshotDownload(downloadSnapshotJson, downloadBlob, { prefix: 'iconctl-icons', extension: 'json', label: 'Iconify JSON' })
const jsonDownloadState = jsonDownload.state
const reportDownload = createComparisonReportDownload({
  current: () => preview.value,
  blocked: () => view.value !== 'preview' || !!reviewState.value.pending,
  save: downloadBlob,
})
const reportDownloadState = reportDownload.state
const diagnosticCopy = createDiagnosticCopy({
  current: () => preview.value,
  blocked: () => view.value !== 'preview' || !!reviewState.value.pending,
})
const svgFiles = computed(() => Object.keys(preview.value?.content.files ?? {}).filter(name => name.startsWith('svg/') && /\.svg$/i.test(name)))
const latePublication = ref<Job>()
const publication = createReleaseReview({
  preview: (context, signal) => api(`projects/${context.projectId}/release/preview`, { snapshotId: context.snapshotId, bump: context.bump }, 'POST', { signal }),
  publish: (context, confirmationId, idempotencyKey) => api<Job>(`projects/${context.projectId}/release/confirm`, { confirmationId }, 'POST', { idempotencyKey }),
  async published(job, current) {
    recordSubmittedJob(job)
    if (current && await revealJob(job, true)) {
      notice.value = '发布任务已创建'
    }
    else {
      latePublication.value = job
    }
  },
})
const releaseState = publication.state
const confirmation = computed(() => releaseState.value.confirmation)
const releaseOpen = computed(() => releaseState.value.open)
const releaseDialog = ref<HTMLDialogElement>()
watch(
  releaseOpen,
  (value) => {
    if (value) {
      releaseDialog.value?.showModal()
    }
    else { releaseDialog.value?.close() }
  },
  { flush: 'post' },
)
watch(selectedId, () => {
  diagnosticCopy.invalidate()
  jsonDownload.invalidate()
  svgDownload.invalidate()
  reportDownload.invalidate()
  review.invalidate(true)
  publication.close()
}, { flush: 'sync' })
watch(view, () => {
  diagnosticCopy.invalidate()
  jsonDownload.invalidate()
  svgDownload.invalidate()
  reportDownload.invalidate()
  review.invalidate()
  publication.close()
  editor.invalidate()
}, { flush: 'sync' })
function selectProject(event: Event) {
  const element = event.target as HTMLSelectElement
  const id = element.value
  element.value = selectedId.value
  if (id === selectedId.value && (view.value !== 'config' || editing.value?.id === id)) {
    return
  }
  void requestNavigation({
    label: data.value.projects.find(project => project.id === id)?.name ?? '所选项目',
    run() {
      const project = data.value.projects.find(project => project.id === id)
      if (!project) {
        return false
      }
      if (view.value === 'config') {
        applyEdit(project)
      }
      else { selectedId.value = id }
      return true
    },
  })
}
const iconNames = computed(() => {
  if (!preview.value) {
    return []
  }
  const names
    = filter.value === 'all'
      ? [
          ...new Set([
            ...Object.keys(preview.value.content.json.icons),
            ...Object.keys(preview.value.previous?.icons ?? {}),
          ]),
        ]
      : preview.value.diff[filter.value as 'added' | 'changed' | 'removed']
  return names.filter(name => name.includes(search.value)).sort()
})
function date(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}
async function locateLinkedJob(automatic = false) {
  if (locatingLinkedJob) {
    return
  }
  locatingLinkedJob = true
  try {
    const job = data.value.jobs.find(item => item.id === linkedJobId)
    if (job && data.value.projects.some(project => project.id === job.projectId)) {
      linkedJobError.value = ''
      if (await revealJob(job, automatic)) {
        linkedJobLocated.value = true
      }
    }
    else { linkedJobError.value = '任务链接无效，或该任务已不可用。' }
  }
  finally {
    locatingLinkedJob = false
  }
}
function applyWorkspace(state: ConsoleState, selectDefault: boolean) {
  const projects = [...state.projects]
  for (const project of data.value.projects) {
    const next = upsertSavedProject(projects, project)
    projects.splice(0, projects.length, ...next)
  }
  data.value = { ...state, projects }
  editor.observe(state.projects)
  // Navigation has its own draft/focus lifetime and must not hold the next
  // network refresh or an editor's explicit read waiting for a decision.
  void selectWorkspace(selectDefault)
}
async function selectWorkspace(selectDefault: boolean) {
  if (linkedJobId && !linkedJobLocated.value) {
    await locateLinkedJob(true)
  }
  if (!disposed && selectDefault && !selectedId.value && data.value.projects[0]) {
    selectedId.value = data.value.projects[0].id
  }
}
async function refresh(selectDefault = true): Promise<ConsoleState | undefined> {
  return await workspace.refresh(selectDefault)
}
async function refreshAfterMutation() {
  workspace.invalidate()
  // The write succeeded. Its recovery must retry only the read, with the
  // workspace message preserving the mutation's own success/error state.
  await refresh().catch(() => undefined)
}
function retryWorkspace() {
  void refresh().catch(() => undefined)
}
async function locatePublication() {
  const job = latePublication.value
  if (job && await revealJob(job)) {
    latePublication.value = undefined
  }
}
async function perform(action: () => Promise<void>) {
  if (busy.value) {
    return
  }
  mutating.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试'
  }
  finally {
    mutating.value = false
  }
}
function applyEdit(project?: Project) {
  if (project) {
    selectedId.value = project.id
  }
  view.value = 'config'
  editor.open(project)
}
function edit(project?: Project) {
  const id = project?.id
  if (view.value === 'config' && editing.value?.id === id) {
    return
  }
  void requestNavigation({
    label: project?.name ?? '新建项目',
    run() {
      const latest = id ? data.value.projects.find(item => item.id === id) : undefined
      if (id && !latest) {
        return false
      }
      applyEdit(latest)
      return true
    },
  })
}
function navigateView(target: View) {
  if (target === view.value) {
    return
  }
  if (target === 'config') {
    edit(activeProject.value)
    return
  }
  void requestNavigation({
    label: navigation.find(item => item.id === target)!.name,
    run() {
      view.value = target
      return true
    },
  })
}
async function save() {
  if (busy.value || uploading.value) {
    return
  }
  mutating.value = true
  try {
    await editor.save()
  }
  finally {
    mutating.value = false
  }
}
function addSource() {
  const type = sourceType.value
  if (type === 'figma') {
    draft.sources.push({
      type,
      file: '',
      connection:
        data.value.connections.find(c => c.type === 'figma')?.id ?? '',
      depth: 3,
    })
  }
  else if (type === 'mastergo') {
    draft.sources.push({
      type,
      fileId: '',
      layerId: '',
      connection:
        data.value.connections.find(c => c.type === 'mastergo')?.id ?? '',
    })
  }
  else if (type === 'iconfont') {
    draft.sources.push({ type, url: '', stripPrefix: 'icon-' })
  }
  else if (type === 'iconify') {
    draft.sources.push({ type, file: '' })
  }
  else {
    draft.sources.push({ type, dir: 'raw' })
  }
}
function csv(event: Event) {
  return (event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)
}
function selectIconifyNames(source: Extract<Source, { type: 'iconify' }>, event: Event) {
  if ((event.target as HTMLSelectElement).value === 'all') {
    delete source.include
  }
  else {
    source.include ??= []
  }
}
function iconifyNames(event: Event) {
  return (event.target as HTMLTextAreaElement).value.split(/\r?\n/).filter(name => name.length > 0)
}
const repositoryFiles = new WeakMap<Source, string>()
function attachUpload(event: Event, source: Source) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // The source status owns the filename; clearing lets the same file be selected again.
  input.value = ''
  if (!file || busy.value || editorState.value.refreshing) {
    return
  }
  if (source.type === 'iconify' && source.file !== undefined) {
    repositoryFiles.set(source, source.file)
  }
  void uploads.start(source, file)
}
function removeSource(source: Source) {
  uploads.forget(source)
  const index = draft.sources.indexOf(source)
  if (index >= 0) {
    draft.sources.splice(index, 1)
  }
}
function useRepositorySource(source: Source) {
  uploads.forget(source)
  if ('dir' in source || source.type === 'iconify') {
    delete source.upload
  }
  if (source.type === 'iconify') {
    source.file = repositoryFiles.get(source) ?? ''
  }
}
async function start(operation: string, projectId = selectedId.value) {
  await submitTask(() => api<Job>(`projects/${projectId}/jobs`, { operation }), '任务已创建，将由 GitHub Actions 执行')
}
async function submitTask(action: () => Promise<Job>, message: string) {
  if (busy.value || uploading.value) {
    return
  }
  mutating.value = true
  try {
    await submission.submit(action, message)
  }
  finally {
    mutating.value = false
  }
}
async function install() {
  if (!activeProject.value || uploading.value) {
    return
  }
  await perform(async () => {
    const result = await api<{ url: string }>(
      `projects/${selectedId.value}/install`,
      {},
    )
    await refreshAfterMutation()
    notice.value = `安装 PR 已创建：${result.url}`
  })
}
async function openSnapshot(id: string, compareTo = '') {
  if (!id) {
    return
  }
  await requestNavigation({
    label: '预览与差异',
    run() {
      const snapshot = data.value.snapshots.find(item => item.id === id)
      if (snapshot) {
        selectedId.value = snapshot.projectId
      }
      view.value = 'preview'
      publication.close()
      jsonDownload.invalidate()
      svgDownload.invalidate()
      reportDownload.invalidate()
      diagnosticCopy.invalidate()
      void review.open(id, compareTo)
      return true
    },
  })
}
async function locateSnapshotOrigin(target: SnapshotOriginTarget) {
  const current = origin.value
  if (disposed || view.value !== 'preview' || !current?.available || !originLocatable.value
    || current.target.snapshotId !== target.snapshotId || current.target.jobId !== target.jobId
    || current.target.projectId !== target.projectId || current.target.attempt !== target.attempt) {
    return
  }
  const job = data.value.jobs.find(item => item.id === target.jobId && item.projectId === target.projectId)
  if (job) {
    await revealJob(job, false, target.attempt)
  }
}
function selectSnapshot(event: Event, comparison = false) {
  const element = event.target as HTMLSelectElement
  const value = element.value
  // Keep the controls bound to the committed content while the next pair loads.
  element.value = comparison ? comparisonTarget.value : snapshotId.value
  void openSnapshot(comparison ? snapshotId.value : value, comparison ? value : '')
}
function comparisonLabel(comparison: SnapshotComparison) {
  if (comparison.release) {
    return `发布版本 v${comparison.release.version}`
  }
  if (!comparison.snapshot) {
    return comparison.mode === 'release' ? '首次发布 · 空图标集' : '无历史快照 · 空图标集'
  }
  return `${comparison.mode === 'previous' ? '上次同步' : '指定快照'} · ${date(comparison.snapshot.createdAt)}`
}
function iconImage(json: IconJSON | undefined, name: string) {
  const icon = json?.icons[name]
  if (!icon) {
    return undefined
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width ?? json?.width ?? 16} ${icon.height ?? json?.height ?? 16}" fill="currentColor">${icon.body}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
async function previewRelease() {
  if (busy.value || reviewState.value.pending || !preview.value || preview.value.snapshot.issues > 0) {
    return
  }
  await publication.open({ projectId: selectedId.value, snapshotId: snapshotId.value, bump: bump.value })
}
async function connectFigma(connectionId?: string) {
  await perform(async () => {
    const result = await api<{ url: string }>(
      'connections/figma',
      connectionId ? { connectionId } : {},
    )
    location.assign(result.url)
  })
}
async function disconnect(id: string) {
  await perform(async () => {
    await api(`connections/${id}`, undefined, 'DELETE')
    await refreshAfterMutation()
  })
}
async function connectMastergo() {
  await perform(async () => {
    await api('connections/mastergo', mastergo)
    mastergo.token = ''
    await refreshAfterMutation()
  })
}
async function approvePairing() {
  await perform(async () => {
    await api('pairings/approve', pairing)
    pairing.code = ''
    await refreshAfterMutation()
    notice.value = '插件已连接，仅能同步所选项目'
  })
}
async function revoke(id: string) {
  await perform(async () => {
    await api(`devices/${id}`, undefined, 'DELETE')
    await refreshAfterMutation()
  })
}
async function retry(job: Job) {
  await submitTask(() => api<Job>(`jobs/${job.id}/retry`, {}), '任务已重试')
}
async function restoreFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }
  await perform(async () => {
    const count = await restoreBackup(file)
    await refreshAfterMutation()
    notice.value = `已恢复 ${count} 条记录；请核对 R2 产物并重新连接来源授权`
  })
}
async function logout() {
  await requestNavigation({
    label: '退出登录',
    async run() {
      await api('logout', {})
      if (disposed) {
        return false
      }
      uploads.invalidate()
      allowDocumentLeave.value = true
      location.assign('/login')
      return true
    },
  })
}
onMounted(retryWorkspace)
onMounted(() => {
  window.addEventListener('pagehide', diagnosticCopy.suspend)
  window.addEventListener('pageshow', diagnosticCopy.resume)
})
onUnmounted(() => {
  disposed = true
  workspace.dispose()
  historyReveal.dispose()
  attemptViews.clear()
  jsonDownload.dispose()
  svgDownload.dispose()
  reportDownload.dispose()
  diagnosticCopy.dispose()
  window.removeEventListener('pagehide', diagnosticCopy.suspend)
  window.removeEventListener('pageshow', diagnosticCopy.resume)
  uploads.dispose()
  draftNavigation.dispose()
  window.removeEventListener('beforeunload', protectDocumentLeave)
  editor.dispose()
  submission.dispose()
  review.invalidate(true)
  publication.dispose()
})
</script>

<template>
  <div class="workbench">
    <aside class="sidebar">
      <a class="brand" href="/app/"><span class="brand-mark">i.</span>iconctl<span class="private-label">私有</span></a>
      <div class="workspace-label">
        图标工作空间
      </div>
      <nav aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: view === item.id }"
          @click="navigateView(item.id)"
        >
          <span aria-hidden="true">{{ item.symbol }}</span>{{ item.name }}
        </button>
      </nav>
      <div class="sidebar-bottom">
        <a href="/" target="_blank" rel="noopener">使用文档 ↗</a>
        <div class="account">
          <span class="avatar">s</span>
          <div><strong>sonofmagic</strong><small>唯一管理员</small></div>
          <button aria-label="退出登录" @click="logout">
            ↪
          </button>
        </div>
      </div>
    </aside>
    <main>
      <dialog
        ref="navigationDialog"
        class="release-dialog navigation-dialog"
        aria-labelledby="navigation-title"
        aria-describedby="navigation-description"
        @keydown.tab="keepNavigationFocus"
        @cancel.prevent="draftNavigation.cancel()"
        @close="!navigationDialog?.open && draftNavigation.cancel()"
      >
        <h2 id="navigation-title">
          离开项目编辑
        </h2>
        <p id="navigation-description">
          <template v-if="protectedDraft">
            「{{ draft.name || '未命名项目' }}」有未保存修改。继续前往「{{ navigationState.pending?.label }}」将放弃这些修改。
          </template>
          <template v-else>
            当前项目配置已保存。是否继续前往「{{ navigationState.pending?.label }}」？
          </template>
        </p>
        <p v-if="editorState.pending" class="help">
          已提交的保存仍会继续；离开只会放弃本地未保存修改。
        </p>
        <div class="inline-controls">
          <button autofocus @click="draftNavigation.cancel()">
            继续编辑
          </button>
          <button class="primary" @click="draftNavigation.confirm()">
            {{ protectedDraft ? '放弃修改并继续' : '继续前往' }}
          </button>
        </div>
      </dialog>
      <header class="page-header">
        <div>
          <p class="eyebrow">
            ICON WORKBENCH
          </p>
          <h1>{{ navigation.find((item) => item.id === view)?.name }}</h1>
        </div>
        <div class="header-actions">
          <select
            v-if="data.projects.length"
            :value="selectedId"
            aria-label="当前项目"
            @change="selectProject"
          >
            <option
              v-for="project in data.projects"
              :key="project.id"
              :value="project.id"
            >
              {{ project.name }}
            </option>
          </select><button
            v-if="view === 'projects'"
            class="primary"
            :disabled="busy"
            @click="edit()"
          >
            ＋ 新建项目
          </button>
        </div>
      </header>
      <div v-if="linkedJobError" role="alert" class="message error">
        {{ linkedJobError }}
      </div>
      <p v-if="linkedJobHidden" class="linked-job-navigation">
        链接任务未显示在当前视图中。
        <button :disabled="busy" @click="perform(() => locateLinkedJob())">
          定位链接任务
        </button>
      </p>
      <div v-if="error" role="alert" class="message error">
        {{ error }}
      </div>
      <div v-if="navigationState.error" role="alert" class="message error" aria-label="导航失败">
        {{ navigationState.error }}
      </div>
      <div v-if="notice" role="status" class="message notice">
        {{ notice }}
      </div>
      <div v-if="submissionState.error" role="alert" class="message error" aria-label="任务提交失败">
        {{ submissionState.error }}
      </div>
      <div v-if="submissionState.notice" role="status" class="message notice">
        {{ submissionState.notice }}
      </div>
      <div v-for="job in submissionState.late" :key="job.id" role="status" class="message notice" aria-label="提交任务已完成">
        任务已提交：{{ job.id }}。当前位置已保留。
        <button @click="submission.locate(job)">
          定位任务
        </button>
      </div>
      <div v-if="latePublication" role="status" class="message notice" aria-label="发布任务已创建">
        发布任务已创建：{{ latePublication.id }}。当前审核位置已保留。
        <button @click="locatePublication">
          定位发布任务
        </button>
      </div>
      <div v-if="workspaceState.error" role="alert" aria-label="工作空间连接状态" class="message error workspace-status">
        <div>
          <strong>{{ ready ? '工作空间暂未更新，保留上次读取的状态。' : '工作空间加载失败。' }}</strong>
          <p>{{ workspaceState.error }}</p>
          <small v-if="workspaceState.lastUpdated">上次更新：{{ date(workspaceState.lastUpdated) }}</small>
        </div>
        <button type="button" :disabled="workspaceState.pending" @click="retryWorkspace">
          {{ workspaceState.pending ? '正在重试…' : '重新读取工作空间' }}
        </button>
      </div>
      <p v-if="!ready && !workspaceState.error" class="loading">
        正在载入工作空间…
      </p>

      <section v-if="view === 'projects' && ready">
        <div class="section-intro">
          <h2>从设计稿，到可发布的图标包。</h2>
          <p>同步来源、检查变化，再确认一个新版本。</p>
        </div>
        <div v-if="!data.projects.length" class="empty-state">
          <div class="empty-grid" aria-hidden="true">
            <span>＋</span><span>◯</span><span>↗</span><span>⌘</span>
          </div>
          <h3>创建你的第一个图标项目</h3>
          <p>连接 GitHub 仓库，选择 Figma、SVG 或 Iconify JSON 来源。</p>
          <button class="primary" @click="edit()">
            新建项目
          </button>
        </div>
        <div v-else class="project-list">
          <article
            v-for="project in data.projects"
            :key="project.id"
            class="project-row"
          >
            <div class="project-symbol">
              {{ project.prefix.slice(0, 2) }}
            </div>
            <div class="project-details">
              <button class="text-button project-title" @click="edit(project)">
                {{ project.name }}
              </button>
              <p>
                <code>{{ project.packageName }}</code>
                <span class="separator">/</span> {{ project.repository }}
              </p>
              <div class="source-tags">
                <span v-for="(source, index) in project.sources" :key="index">{{
                  source.type
                }}</span>
              </div>
            </div>
            <div class="project-actions">
              <button :disabled="busy" @click="edit(project)">
                配置
              </button><button
                class="primary"
                :disabled="busy"
                @click="start('sync', project.id)"
              >
                同步图标 ↗
              </button>
            </div>
          </article>
        </div>
      </section>

      <section v-if="view === 'config'" class="editor-layout">
        <form class="editor" aria-label="项目编辑" @submit.prevent="save">
          <div class="section-heading">
            <h2>{{ editing ? "编辑项目" : "新建项目" }}</h2>
            <span v-if="editing" class="mono" aria-label="编辑基线">配置 v{{ editing.revision }}</span>
          </div>
          <p v-if="editorState.pending || editorState.saved" role="status" aria-label="保存状态" class="message notice">
            {{ editorState.pending ? '正在保存提交的配置…' : '项目配置已保存' }}
          </p>
          <p v-if="editorDirty" role="status" aria-label="未保存修改" class="message notice">
            当前草稿有未保存修改{{ editorState.saved ? '；提交后的修改仍保留在此处。' : '。' }}
          </p>
          <div v-if="editorState.error" role="alert" aria-label="保存失败" class="message error">
            {{ editorState.error }}
          </div>
          <div v-if="editorState.serverChanged || editorState.conflict" role="status" aria-label="服务器配置已更新" class="message notice">
            {{ editorState.serverChanged ? '服务器已有更新的配置。' : '配置已变化、项目身份受限或有任务运行，请核对后恢复。' }}
            载入最新配置将替换当前草稿；不会自动再次保存。
            <button type="button" :disabled="busy || uploading || editorState.refreshing || !!editorState.reconciliation" @click="editor.reconcile()">
              核对并保留草稿
            </button>
            <button type="button" :disabled="busy || editorState.refreshing" @click="editor.reload()">
              载入最新配置
            </button>
          </div>
          <ProjectReconciliation
            v-if="editorState.reconciliation"
            :state="editorState.reconciliation"
            :stale="Boolean(reconciliationStale)"
            :disabled="busy || uploading || editorState.refreshing"
            @apply="editor.applyReconciliation"
            @cancel="editor.cancelReconciliation"
          />
          <div v-if="editorState.refreshError" role="alert" aria-label="工作空间刷新失败" class="message error">
            {{ editorState.saved ? '项目已保存，工作空间状态暂未刷新。' : '工作空间状态暂未刷新，当前草稿已保留。' }}
            {{ editorState.refreshError }}
            <button type="button" :disabled="busy || editorState.refreshing" @click="editor.refresh()">
              重新刷新工作空间
            </button>
          </div>
          <div class="form-grid">
            <label>项目名称<input
              v-model="draft.name"
              required
              placeholder="brand-icons"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            ></label><label>GitHub 仓库<input
              v-model="draft.repository"
              required
              placeholder="icelib/iconctl"
            ></label><label>图标前缀<input
              v-model="draft.prefix"
              required
              placeholder="brand"
            ></label><label>公开 npm 包名<input
              v-model="draft.packageName"
              required
              placeholder="@icelib/brand-icons"
            ></label>
          </div>
          <p class="help">
            图标包保存到
            <code>iconctl/{{ draft.name || "项目名称" }}</code> 分支。GitHub App
            必须已安装到所选仓库。
          </p>
          <div class="section-heading">
            <h2>图标来源</h2>
            <div class="inline-controls">
              <select v-model="sourceType" aria-label="新增来源类型">
                <option value="figma">
                  Figma
                </option>
                <option value="mastergo">
                  MasterGo
                </option>
                <option value="iconfont">
                  iconfont
                </option>
                <option value="directory">
                  SVG 目录
                </option>
                <option value="iconify">
                  Iconify JSON
                </option>
                <option value="jsdesign">
                  即时设计 SVG
                </option>
              </select><button type="button" @click="addSource">
                添加来源
              </button>
            </div>
          </div>
          <fieldset
            v-for="(source, index) in draft.sources"
            :key="uploads.key(source)"
            class="source-editor"
          >
            <legend>
              {{ source.type }} <span class="mono">{{ index + 1 }}</span>
            </legend>
            <button
              type="button"
              class="remove-source"
              :aria-label="`移除来源 ${index + 1}`"
              @click="removeSource(source)"
            >
              移除
            </button>
            <div v-if="source.type === 'figma'" class="form-grid">
              <label class="full-width">Figma 文件链接或 key<input
                v-model="source.file"
                required
                placeholder="https://www.figma.com/design/…"
              ></label><label>授权<select v-model="source.connection" required>
                <option value="" disabled>请先连接 Figma</option>
                <option
                  v-for="connection in data.connections.filter(
                    (item) => item.type === 'figma',
                  )"
                  :key="connection.id"
                  :value="connection.id"
                >
                  {{ connection.label }}
                </option>
              </select></label><label>读取深度<input
                v-model.number="source.depth"
                type="number"
                min="1"
                max="100"
              ></label><label>页面名称（逗号分隔）<input
                :value="source.pages?.join(', ')"
                @input="source.pages = csv($event)"
              ></label><label>节点 ID（逗号分隔）<input
                :value="source.ids?.join(', ')"
                @input="source.ids = csv($event)"
              ></label>
            </div>
            <div v-else-if="source.type === 'mastergo'" class="form-grid">
              <label>文件 ID<input v-model="source.fileId" required></label><label>图层 ID<input v-model="source.layerId" required></label><label>授权<select v-model="source.connection" required>
                <option value="" disabled>请先配置 MasterGo</option>
                <option
                  v-for="connection in data.connections.filter(
                    (item) => item.type === 'mastergo',
                  )"
                  :key="connection.id"
                  :value="connection.id"
                >
                  {{ connection.label }}
                </option>
              </select></label>
            </div>
            <div v-else-if="source.type === 'iconfont'" class="form-grid">
              <label>iconfont Symbol URL<input
                v-model="source.url"
                type="url"
                required
                placeholder="https://at.alicdn.com/t/…js"
              ></label><label>移除名称前缀<input v-model="source.stripPrefix"></label>
            </div>
            <div v-else-if="source.type === 'iconify'" class="form-grid">
              <label v-if="!source.upload" class="full-width">仓库内 JSON 文件路径<input
                v-model="source.file"
                :disabled="uploads.get(source)?.phase === 'pending'"
                required
                maxlength="240"
                placeholder="vendor/icons.json"
              ></label>
              <p class="help full-width">
                从所选 GitHub 仓库读取 JSON（路径相对于仓库根目录），或上传本地 Iconify 集合；保存项目后生效。
              </p>
              <label class="full-width">上传 Iconify JSON（最多 10 MiB）<input
                type="file"
                accept=".json,application/json"
                :disabled="busy || uploading || editorState.refreshing"
                @change="attachUpload($event, source)"
              ></label>
              <p v-if="source.upload" class="help full-width">
                已上传 · {{ source.upload }}
                <button type="button" class="text-button" @click="useRepositorySource(source)">
                  恢复使用仓库文件
                </button>
              </p>
              <p class="help full-width">
                上传仅检查 JSON 格式；图标、别名与项目规则将在运行任务时校验。
              </p>
              <label>导入范围<select
                :value="source.include === undefined ? 'all' : 'selected'"
                @change="selectIconifyNames(source, $event)"
              >
                <option value="all">全部图标</option>
                <option value="selected">指定图标</option>
              </select></label>
              <label>名称前缀（原样添加）<input
                v-model="source.namePrefix"
                placeholder="vendor-"
              ></label>
              <p class="help full-width">
                前缀填 <code>vendor-</code> 时，<code>home</code> 会导入为 <code>vendor-home</code>；不会自动添加分隔符。
              </p>
              <label v-if="source.include !== undefined" class="full-width">图标名称（每行一个）<textarea
                :value="source.include.join('\n')"
                rows="4"
                placeholder="home&#10;arrow-left"
                @change="source.include = iconifyNames($event)"
              /></label>
              <p v-if="source.include !== undefined" class="help full-width">
                按原始图标或 alias 名称匹配，前缀不参与匹配。空行会忽略；名单留空时不导入任何图标。
              </p>
            </div>
            <div v-else class="form-grid">
              <label>仓库内目录 / ZIP 子目录<input
                v-model="source.dir"
                required
              ></label><label>或上传 SVG ZIP（最多 10 MB）<input
                type="file"
                accept=".zip"
                :disabled="busy || uploading || editorState.refreshing"
                @change="attachUpload($event, source)"
              ></label>
              <p v-if="source.upload" class="help full-width">
                已上传 · {{ source.upload }}
                <button
                  type="button"
                  class="text-button"
                  @click="useRepositorySource(source)"
                >
                  恢复使用仓库目录
                </button>
              </p>
              <p class="help full-width">
                即时设计请先导出 SVG。ZIP 根目录使用 <code>svg</code>；只接受
                SVG 文件，不支持符号链接。
              </p>
            </div>
            <div v-if="uploads.get(source)" class="upload-feedback full-width">
              <p v-if="uploads.get(source)?.phase === 'failed'" role="alert" aria-label="来源上传失败" class="message error">
                {{ uploads.get(source)?.fileName }}：{{ uploads.get(source)?.error }}
              </p>
              <p v-else role="status" aria-label="来源上传状态" class="help">
                <template v-if="uploads.get(source)?.phase === 'pending'">
                  正在上传：{{ uploads.get(source)?.fileName }}。完成或取消后可保存项目。
                </template>
                <template v-else-if="uploads.get(source)?.phase === 'uploaded'">
                  已上传：{{ uploads.get(source)?.fileName }}；保存项目后生效。
                </template>
                <template v-else>
                  已取消上传：{{ uploads.get(source)?.fileName }}。
                </template>
              </p>
              <button v-if="uploads.get(source)?.phase === 'pending'" type="button" @click="uploads.cancel(source)">
                取消上传
              </button>
              <button v-if="uploads.get(source)?.phase === 'failed'" type="button" :disabled="busy || uploading || editorState.refreshing" @click="uploads.retry(source)">
                重试上传
              </button>
            </div>
          </fieldset>
          <div class="section-heading">
            <h2>处理与校验</h2>
          </div>
          <div class="form-grid">
            <label>统一颜色<input
              :value="draft.color === false ? '' : draft.color"
              placeholder="留空保留原色"
              @input="
                draft.color
                  = ($event.target as HTMLInputElement).value || false
              "
            ></label><label>名称正则<input
              v-model="draft.validate.name"
              placeholder="^[a-z0-9]+(?:-[a-z0-9]+)*$"
            ></label><label>宽度<input
              :value="draft.validate.width"
              type="number"
              min="1"
              placeholder="不限"
              @input="
                draft.validate.width = ($event.target as HTMLInputElement)
                  .value
                  ? Number(($event.target as HTMLInputElement).value)
                  : undefined
              "
            ></label><label>高度<input
              :value="draft.validate.height"
              type="number"
              min="1"
              placeholder="不限"
              @input="
                draft.validate.height = ($event.target as HTMLInputElement)
                  .value
                  ? Number(($event.target as HTMLInputElement).value)
                  : undefined
              "
            ></label><label>忽略草稿前缀<input
              :value="draft.validate.skipPrefix.join(', ')"
              @input="draft.validate.skipPrefix = csv($event)"
            ></label>
          </div>
          <div class="section-heading">
            <h2>输出</h2>
          </div>
          <div class="checkbox-row">
            <span>✓ Iconify JSON</span><label v-for="(_, key) in draft.output" :key="key"><input v-model="draft.output[key]" type="checkbox">{{
              key
            }}</label>
          </div>
          <details class="advanced">
            <summary>高级配置 · 仓库中的命名函数</summary>
            <p class="help">
              从固定提交读取 iconNameForNode。代码只在 Actions
              中执行，不能修改任务绑定的来源和输出路径。
            </p>
            <label class="checkbox-label"><input
              :checked="!!draft.advancedConfig"
              type="checkbox"
              @change="
                draft.advancedConfig = ($event.target as HTMLInputElement)
                  .checked
                  ? { path: 'iconctl.config.ts', commit: '' }
                  : undefined
              "
            >启用高级配置</label>
            <div v-if="draft.advancedConfig" class="form-grid">
              <label>配置路径<input
                v-model="draft.advancedConfig.path"
                required
              ></label><label>提交 SHA（40 位）<input
                v-model="draft.advancedConfig.commit"
                required
                pattern="[a-f0-9]{40}"
              ></label>
            </div>
          </details>
          <div class="form-footer">
            <button class="primary" type="submit" :disabled="busy || uploading || editorState.refreshing || !!editorState.reconciliation || editorState.serverChanged || editorState.conflict">
              {{ busy ? "保存中…" : "保存项目" }}
            </button>
          </div>
        </form>
        <aside class="context-panel">
          <h3>接入步骤</h3>
          <ol>
            <li>为仓库安装 GitHub App</li>
            <li>保存图标来源与校验规则</li>
            <li>创建并合并 runner 安装 PR</li>
            <li>同步，检查差异，再发布</li>
          </ol>
          <template v-if="editing">
            <button :disabled="busy || uploading" @click="install">
              创建 runner 安装 PR
            </button><a
              v-if="activeProject?.installationPr"
              :href="activeProject.installationPr"
              target="_blank"
              rel="noopener"
            >查看安装 PR ↗</a>
            <hr>
            <button class="primary" :disabled="busy || uploading" @click="start('sync')">
              同步图标
            </button>
            <div class="operation-buttons">
              <button :disabled="busy || uploading" @click="start('check')">
                仅校验
              </button><button :disabled="busy || uploading" @click="start('preview')">
                预览
              </button><button :disabled="busy || uploading" @click="start('dry-run')">
                Dry run
              </button>
            </div>
            <p class="help">
              Dry run 生成检查结果，不更新图标产物或发布基线；允许续期认证凭据。
            </p>
          </template>
        </aside>
      </section>

      <section v-if="view === 'preview'">
        <div class="preview-toolbar">
          <select
            :value="snapshotId"
            aria-label="选择快照"
            @change="selectSnapshot($event)"
          >
            <option value="" disabled>
              选择一个同步快照
            </option>
            <option
              v-for="snapshot in snapshots"
              :key="snapshot.id"
              :value="snapshot.id"
            >
              {{ date(snapshot.createdAt) }} · 第 {{ snapshot.attempt ?? 1 }} 次尝试 · {{ snapshot.iconCount }} 个图标
            </option>
          </select>
          <select
            v-if="preview"
            :value="comparisonTarget"
            aria-label="比较基准"
            @change="selectSnapshot($event, true)"
          >
            <option value="">
              上次同步
            </option>
            <option value="release">
              最近发布
            </option>
            <option v-for="snapshot in snapshots" :key="snapshot.id" :value="snapshot.id">
              快照 {{ date(snapshot.createdAt) }} · 第 {{ snapshot.attempt ?? 1 }} 次尝试 · {{ snapshot.iconCount }} 个图标
            </option>
          </select><input
            v-model="search"
            aria-label="搜索图标"
            placeholder="搜索图标名称…"
          >
        </div>
        <p v-if="reviewState.pending" role="status" aria-label="快照加载状态" class="help">
          正在加载快照与比较结果…{{ preview ? '当前仍显示上次审核内容，加载完成后可发布。' : '' }}
        </p>
        <p v-if="reviewState.error" role="alert" aria-label="快照加载失败" class="message error">
          {{ reviewState.error }}。{{ preview ? '已保留上次审核内容，请重新选择后重试。' : '请重新选择快照后重试。' }}
        </p>
        <div v-if="!preview" class="empty-state">
          <h3>同步之后，在这里审核变化</h3>
          <p>选择上次同步、最近发布或指定快照，检查新增、修改和删除的图标。</p>
          <button
            v-if="activeProject"
            class="primary"
            :disabled="busy"
            @click="start('sync')"
          >
            同步图标
          </button>
        </div>
        <template v-else>
          <p v-if="preview.comparison" class="help" aria-label="当前比较基准">
            比较基准：{{ comparisonLabel(preview.comparison) }}
          </p>
          <div class="diff-header">
            <div class="diff-tabs">
              <button
                :class="{ selected: filter === 'all' }"
                @click="filter = 'all'"
              >
                全部
              </button><button
                v-for="(label, key) in {
                  added: '新增',
                  changed: '修改',
                  removed: '删除',
                }"
                :key="key"
                :class="{ selected: filter === key }"
                @click="filter = key"
              >
                {{ label }} <span>{{ preview.diff[key].length }}</span>
              </button>
            </div>
            <span class="mono">{{ preview.snapshot.digest.slice(0, 12) }}</span>
          </div>
          <p class="help" aria-label="快照尝试">
            第 {{ preview.snapshot.attempt ?? 1 }} 次尝试 · {{ date(preview.snapshot.createdAt) }}
          </p>
          <SnapshotOrigin v-if="origin" :origin="origin" :locatable="!!originLocatable" :busy="busy" :refreshing="workspaceState.pending" @locate="locateSnapshotOrigin" @refresh="retryWorkspace" />
          <SnapshotDiagnostics :snapshot="preview.snapshot" :issues="preview.content.issues" :failed="preview.content.failed" :blocked="!!reviewState.pending" :copy="diagnosticCopy" />
          <div class="icon-grid">
            <article v-for="name in iconNames" :key="name" class="icon-tile">
              <div class="icon-comparison">
                <div class="icon-cell">
                  <img
                    v-if="iconImage(preview.previous, name)"
                    :src="iconImage(preview.previous, name)"
                    :alt="`${name} 之前`"
                  ><span v-else class="missing">—</span><small>之前</small>
                </div>
                <div class="icon-cell">
                  <img
                    v-if="iconImage(preview.content.json, name)"
                    :src="iconImage(preview.content.json, name)"
                    :alt="`${name} 之后`"
                  ><span v-else class="missing">—</span><small>之后</small>
                </div>
              </div>
              <code>{{ name }}</code>
            </article>
          </div>
          <p v-if="!iconNames.length" class="help">
            没有符合条件的图标。
          </p>
          <ComparisonReportDownloads :disabled="!!reviewState.pending" :state="reportDownloadState" @download="reportDownload.start" />
          <div class="artifact-list">
            <h3>下载产物</h3>
            <button
              :disabled="!!reviewState.pending || jsonDownloadState.pending"
              @click="!reviewState.pending && jsonDownload.start(preview.snapshot)"
            >
              下载完整 Iconify JSON
            </button>
            <p class="help">
              当前快照的全部图标，不受搜索或比较筛选影响；检查和 dry-run 快照也可下载。
              <span v-if="preview.content.issues.length || preview.content.failed.length">此快照包含问题，集合可能不完整；下载不代表校验通过。</span>
            </p>
            <p v-if="jsonDownloadState.message" role="status" aria-label="Iconify JSON 下载状态" class="help">
              {{ jsonDownloadState.message }}
            </p>
            <p v-if="jsonDownloadState.error" role="alert" aria-label="Iconify JSON 下载失败" class="message error">
              {{ jsonDownloadState.error }}。可再次点击下载重试。
            </p>
            <button
              v-if="svgFiles.length"
              :disabled="!!reviewState.pending || svgDownloadState.pending"
              @click="!reviewState.pending && svgDownload.start(preview.snapshot)"
            >
              下载全部 SVG（{{ svgFiles.length }}）
            </button>
            <p class="help">
              {{ svgFiles.length ? '下载当前快照的全部 SVG，不受搜索或比较筛选影响。' : '当前快照没有 SVG 产物。' }}
            </p>
            <p v-if="svgDownloadState.message" role="status" aria-label="SVG 下载状态" class="help">
              {{ svgDownloadState.message }}
            </p>
            <p v-if="svgDownloadState.error" role="alert" aria-label="SVG 下载失败" class="message error">
              {{ svgDownloadState.error }}。可再次点击下载重试。
            </p>
            <a
              v-for="name in Object.keys(preview.content.files).filter(
                (name) => name !== 'icons.json' && !name.startsWith('svg/'),
              )"
              :key="name"
              :href="`/api/snapshots/${snapshotId}/files/${name}`"
            >{{ name }} ↓</a>
            <details
              v-if="
                Object.keys(preview.content.files).some((name) =>
                  name.startsWith('svg/'),
                )
              "
            >
              <summary>SVG 文件</summary>
              <a
                v-for="name in Object.keys(preview.content.files).filter(
                  (name) => name.startsWith('svg/'),
                )"
                :key="name"
                :href="`/api/snapshots/${snapshotId}/files/${name}`"
              >{{ name }} ↓</a>
            </details>
          </div>
          <div class="publish-bar">
            <div>
              <strong>将这份快照发布为新版本</strong>
              <p>发布内容固定为当前审核的图标，不会再次抓取来源。</p>
            </div>
            <select v-model="bump" aria-label="版本增量">
              <option value="patch">
                patch · 修复
              </option>
              <option value="minor">
                minor · 新增
              </option>
              <option value="major">
                major · 破坏性变更
              </option>
            </select><button
              class="primary"
              :disabled="busy || !!reviewState.pending || preview.snapshot.issues > 0"
              @click="previewRelease"
            >
              查看发布确认
            </button>
          </div>
          <dialog
            ref="releaseDialog"
            class="release-dialog"
            aria-label="发布确认"
            @cancel.prevent="publication.close()"
          >
            <p v-if="releaseState.pending" role="status" aria-label="发布请求状态">
              {{ releaseState.pending === 'preview' ? '正在获取发布确认…' : '正在提交发布请求…' }}
            </p>
            <template v-if="confirmation">
              <p class="eyebrow">
                确认公开发布
              </p>
              <h2>{{ confirmation.packageName }}</h2>
              <div class="release-version">
                v{{ confirmation.release.version }}
              </div>
              <p>{{ confirmation.iconCount }} 个图标 · npm / latest</p>
              <template v-if="confirmation.comparison && confirmation.diff">
                <p aria-label="发布比较基准">
                  相对{{ comparisonLabel(confirmation.comparison) }}的累计变化
                </p>
                <p aria-label="发布累计差异">
                  新增 {{ confirmation.diff.added.length }} · 修改 {{ confirmation.diff.changed.length }} · 删除 {{ confirmation.diff.removed.length }}
                </p>
                <details v-if="confirmation.diff.removed.length">
                  <summary>查看将删除的图标</summary>
                  <p>{{ confirmation.diff.removed.join('、') }}</p>
                </details>
              </template>
              <p class="help mono">
                SHA-256 {{ confirmation.release.digest }}
              </p>
              <p>发布后会生成 Git 提交、版本标签和 GitHub Release。</p>
            </template>
            <div v-if="releaseState.error" role="alert" aria-label="发布失败" class="message error">
              <p>{{ releaseState.error }}</p>
              <p v-if="releaseState.needsPreview">
                请重新获取发布确认并检查版本和差异。如项目配置已变更，请返回审核并选择新的同步快照。
              </p>
              <p v-else>
                请求结果尚未确认。可使用同一次确认重试，已创建的任务不会重复创建。
              </p>
            </div>
            <div class="inline-controls">
              <button @click="publication.close()">
                返回审核
              </button>
              <button v-if="releaseState.needsPreview" :disabled="!!releaseState.pending" @click="publication.preview()">
                重新获取发布确认
              </button>
              <button v-if="confirmation" class="primary" :disabled="!!releaseState.pending || releaseState.needsPreview" @click="publication.publish()">
                {{ releaseState.failedPublish && !releaseState.needsPreview ? '重试发布请求' : `确认发布 ${confirmation.release.version}` }}
              </button>
            </div>
          </dialog>
        </template>
      </section>

      <section v-if="view === 'history'">
        <div class="section-heading">
          <h2>任务记录</h2>
          <button :disabled="busy || workspaceState.pending" @click="retryWorkspace">
            刷新状态
          </button>
        </div>
        <div class="task-filters" role="search" aria-label="任务筛选">
          <label>任务状态<select v-model="taskFilters.status">
            <option value="all">全部状态</option>
            <option v-for="status in ['queued', 'running', 'succeeded', 'failed', 'reconciling']" :key="status" :value="status">{{ labels[status] }}</option>
          </select></label>
          <label>任务操作<select v-model="taskFilters.operation">
            <option value="all">全部操作</option>
            <option v-for="operation in ['sync', 'check', 'preview', 'dry-run', 'publish']" :key="operation" :value="operation">{{ labels[operation] }}</option>
          </select></label>
          <label class="task-search">搜索任务<input v-model="taskFilters.query" type="search" placeholder="任务 ID、SHA、Actions、阶段或错误"></label>
          <button :disabled="!hasTaskFilters" @click="clearTaskFilters">
            清除任务筛选
          </button>
        </div>
        <p class="help task-filter-count" aria-label="任务筛选结果" aria-live="polite">
          匹配 {{ jobs.length }} / 当前项目 {{ projectJobs.length }}
        </p>
        <p v-if="!projectJobs.length" class="empty-state">
          还没有任务。从项目配置中发起一次同步。
        </p>
        <p v-else-if="!jobs.length" class="empty-state">
          没有匹配的任务。调整条件或清除任务筛选。
        </p>
        <div v-else class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>操作 / 时间</th>
                <th>状态</th>
                <th>阶段</th>
                <th>执行记录</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :id="`job-${job.id}`" :key="job.id" tabindex="-1" :class="{ 'linked-job': job.id === linkedJobId }">
                <td>
                  <strong>{{ labels[job.operation] }}</strong><small>{{ date(job.createdAt) }}</small>
                </td>
                <td>
                  <span class="status" :class="job.status">{{
                    labels[job.status]
                  }}</span>
                </td>
                <td>
                  {{ labels[job.stage] ?? job.stage
                  }}<small v-if="job.error" class="error-text">{{
                    job.error
                  }}</small>
                  <JobAttempts :ref="instance => rememberHistory(job.id, instance)" :job="job" :snapshots="data.snapshots" :busy="busy" :labels="labels" :date="date" @snapshot="openSnapshot" />
                </td>
                <td>
                  <a
                    v-if="job.runId"
                    :href="`https://github.com/${job.project.repository}/actions/runs/${job.runId}`"
                    target="_blank"
                    rel="noopener"
                  >Actions ↗</a><small class="mono">{{ job.sourceCommit.slice(0, 8) }} · 配置 v{{
                    job.project.revision
                  }}</small>
                </td>
                <td>
                  <button
                    v-if="job.snapshotId"
                    class="text-button"
                    @click="openSnapshot(job.snapshotId)"
                  >
                    查看快照
                  </button><button
                    v-if="job.status === 'failed'"
                    :disabled="busy"
                    @click="retry(job)"
                  >
                    重试
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="section-heading">
          <h2>已发布版本</h2>
        </div>
        <p v-if="!releases.length" class="help">
          通过预览页面确认发布后，版本会显示在这里。
        </p>
        <article
          v-for="release in releases"
          :key="release.id"
          class="release-row"
        >
          <div>
            <strong>{{ release.packageName }}
              <span class="mono">{{ release.version }}</span></strong><small>{{ date(release.createdAt) }}</small>
          </div>
          <a :href="release.url" target="_blank" rel="noopener">npm ↗</a><a :href="`/api/releases/${release.id}/package.tgz`">下载 npm 包 ↓</a>
        </article>
      </section>

      <section v-if="view === 'connections'" class="connections-layout">
        <div>
          <div class="section-heading">
            <h2>来源授权</h2>
            <button class="primary" :disabled="busy" @click="connectFigma()">
              连接 Figma
            </button>
          </div>
          <p class="help">
            Figma 在任务需要时自动续期。使用站点独立的 OAuth App，避免影响本地
            CLI 的授权。
          </p>
          <article
            v-for="connection in data.connections"
            :key="connection.id"
            class="connection-row"
          >
            <div>
              <strong>{{ connection.label }}</strong><small>{{
                connection.reconnect
                  ? "需要重新授权"
                  : connection.expiresAt
                    ? `Access token 到期：${date(connection.expiresAt)}`
                    : "个人令牌 · 到期后需重新配置"
              }}</small><code class="connection-id">{{
                connection.id.slice(0, 8)
              }}</code>
            </div>
            <button
              v-if="connection.type === 'figma'"
              :disabled="busy"
              @click="connectFigma(connection.id)"
            >
              重新授权
            </button><button :disabled="busy" @click="disconnect(connection.id)">
              断开
            </button>
          </article>
          <p v-if="!data.connections.length" class="empty-state">
            尚未连接任何来源。
          </p>
          <form class="mastergo-form" @submit.prevent="connectMastergo">
            <h3>配置 MasterGo 个人令牌</h3>
            <label>授权名称<input v-model="mastergo.label" required></label><label>个人令牌<input
              v-model="mastergo.token"
              type="password"
              autocomplete="off"
              required
            ></label><button :disabled="busy">
              加密保存令牌
            </button>
          </form>
        </div>
        <div>
          <div class="section-heading">
            <h2>Figma 插件</h2>
          </div>
          <p class="help">
            在插件中选择「连接控制台」，将配对码填入下方。插件只能触发所选项目的同步，发版仍需在网页确认。
          </p>
          <form class="pair-form" @submit.prevent="approvePairing">
            <label>短时配对码<input
              v-model="pairing.code"
              maxlength="8"
              minlength="8"
              required
              placeholder="8 位配对码"
            ></label><label>图标项目<select v-model="pairing.projectId" required>
              <option value="" disabled>选择项目</option>
              <option
                v-for="project in data.projects"
                :key="project.id"
                :value="project.id"
              >
                {{ project.name }}
              </option>
            </select></label><label>设备名称<input v-model="pairing.label" required></label><button class="primary" :disabled="busy">
              确认连接
            </button>
          </form>
          <article
            v-for="device in data.devices"
            :key="device.id"
            class="connection-row"
          >
            <div>
              <strong>{{ device.label }}</strong><small>{{
                data.projects.find((project) => project.id === device.projectId)
                  ?.name
              }}</small>
            </div>
            <button :disabled="busy" @click="revoke(device.id)">
              撤销
            </button>
          </article>
          <div class="backup-link">
            <h3>数据备份</h3>
            <p class="help">
              管理数据以加密文件导出。产物需同时备份私有
              R2，恢复步骤见接入文档。
            </p>
            <a href="/api/backup">下载加密备份 ↓</a>
            <details>
              <summary>恢复到空账户</summary>
              <p class="help">
                仅在没有项目、任务和授权的账户中可用。先恢复 R2
                对象和原加密密钥，再导入备份。
              </p>
              <label>加密备份文件<input
                type="file"
                accept=".enc"
                :disabled="busy"
                @change="restoreFile"
              ></label>
            </details>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

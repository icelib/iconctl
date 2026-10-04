import type { Project, ProjectInput } from '@iconctl/console-contracts'
import type { ProjectFieldKey, ProjectReconciliation } from './project-reconcile'
import { computed, reactive, shallowRef } from 'vue'
import { ApiError } from '../../api-response'
import { applyProjectReconciliation, prepareProjectReconciliation, projectInputSignature } from './project-reconcile'

export function projectDraft(project: ProjectInput): ProjectInput {
  const { name, repository, prefix, packageName, sources, color, validate, output, advancedConfig } = project
  return JSON.parse(JSON.stringify({ name, repository, prefix, packageName, sources, color, validate, output, ...(advancedConfig ? { advancedConfig } : {}) }))
}

export function upsertSavedProject(projects: Project[], saved: Project): Project[] {
  const current = projects.find(project => project.id === saved.id)
  if (current && current.revision >= saved.revision) {
    // Equal configuration revisions can already contain newer task pointers.
    return projects
  }
  return current ? projects.map(project => project.id === saved.id ? saved : project) : [...projects, saved]
}

interface EditorState {
  project?: Project
  baseline: ProjectInput
  pending: boolean
  saved: boolean
  error: string
  conflict: boolean
  serverChanged: boolean
  refreshing: boolean
  refreshError: string
  reconciliation?: ProjectReconciliation & { pending: boolean, error: string }
}

interface EditorOptions {
  blank: () => ProjectInput
  save: (input: ProjectInput, project?: Project) => Promise<Project>
  committed: (project: Project, current: boolean) => void
  refresh: () => Promise<Project[]>
  reconcileBlocked?: () => boolean
}

export function createProjectEditor(options: EditorOptions) {
  let generation = 0
  const session = shallowRef(0)
  let disposed = false
  let saving = false
  let reconciling = false
  let reconciliationProject: Project | undefined
  const known = new Map<string, Project>()
  const draft = reactive<ProjectInput>(projectDraft(options.blank()))
  const state = shallowRef<EditorState>(initial())
  const dirty = computed(() => projectInputSignature(projectDraft(draft)) !== projectInputSignature(state.value.baseline))
  const reconciliationStale = computed(() => {
    const current = state.value.reconciliation
    return !!current && !current.pending && current.localSignature !== projectInputSignature(projectDraft(draft))
  })

  function initial(project?: Project): EditorState {
    return { project, baseline: projectDraft(project ?? options.blank()), pending: false, saved: false, error: '', conflict: false, serverChanged: false, refreshing: false, refreshError: '' }
  }
  function replaceDraft(input: ProjectInput) {
    for (const key of Object.keys(draft)) {
      delete (draft as unknown as Record<string, unknown>)[key]
    }
    Object.assign(draft, projectDraft(input))
  }
  function current(request: number) {
    return !disposed && request === generation
  }
  function observe(projects: Project[]) {
    for (const project of projects) {
      const previous = known.get(project.id)
      if (!previous || previous.revision <= project.revision) {
        known.set(project.id, project)
      }
    }
    const editing = state.value.project
    if (editing && (known.get(editing.id)?.revision ?? 0) > editing.revision) {
      state.value = { ...state.value, serverChanged: true }
    }
  }
  function open(project?: Project) {
    generation++
    session.value = generation
    state.value = initial(project)
    replaceDraft(state.value.baseline)
    observe(project ? [project] : [])
  }
  function invalidate() {
    generation++
    session.value = generation
    reconciling = false
    reconciliationProject = undefined
    state.value = { ...state.value, pending: false, refreshing: false, error: '', refreshError: '', saved: false, reconciliation: undefined }
  }
  async function refresh(request = generation): Promise<Project[] | undefined> {
    if (!current(request)) {
      return
    }
    state.value = { ...state.value, refreshing: true, refreshError: '' }
    try {
      const projects = await options.refresh()
      if (current(request)) {
        observe(projects)
        return projects
      }
    }
    catch (cause) {
      if (current(request)) {
        state.value = { ...state.value, refreshError: cause instanceof Error ? cause.message : '工作空间暂时无法刷新' }
      }
      return undefined
    }
    finally {
      if (current(request)) {
        state.value = { ...state.value, refreshing: false }
      }
    }
  }
  async function save() {
    if (disposed || saving || reconciling || options.reconcileBlocked?.() || state.value.reconciliation || state.value.serverChanged || state.value.conflict || state.value.refreshing) {
      return
    }
    const request = generation
    const input = projectDraft(draft)
    const project = state.value.project
    saving = true
    state.value = { ...state.value, pending: true, saved: false, error: '', refreshError: '' }
    try {
      const result = await options.save(input, project)
      if (disposed) {
        return
      }
      options.committed(result, current(request))
      if (current(request)) {
        if (JSON.stringify(draft) === JSON.stringify(input)) {
          replaceDraft(result)
        }
        state.value = { ...state.value, project: result, baseline: projectDraft(result), pending: false, saved: true }
        observe([result])
        await refresh(request)
      }
    }
    catch (cause) {
      if (current(request)) {
        state.value = { ...state.value, error: cause instanceof Error ? cause.message : '保存失败，请重试', conflict: cause instanceof ApiError && cause.status === 409 }
      }
    }
    finally {
      saving = false
      if (current(request)) {
        state.value = { ...state.value, pending: false }
      }
    }
  }
  async function reload() {
    const request = generation
    const project = state.value.project
    const before = JSON.stringify(draft)
    if (disposed || saving || options.reconcileBlocked?.() || state.value.refreshing || !project) {
      return
    }
    const latest = await refresh(request)
    if (!current(request) || state.value.refreshError || !latest) {
      return
    }
    if (JSON.stringify(draft) !== before) {
      state.value = { ...state.value, error: '载入期间草稿已修改，请再次点击载入最新配置' }
      return
    }
    const latestProject = latest.find(item => item.id === project.id)
    const knownRevision = known.get(project.id)?.revision
    if (!latestProject || !Number.isSafeInteger(latestProject.revision) || latestProject.revision < project.revision || (knownRevision !== undefined && knownRevision > latestProject.revision)) {
      state.value = { ...state.value, refreshError: '未读取到可应用的最新项目配置，请重试。' }
      return
    }
    open(latestProject)
  }
  async function reconcile() {
    const project = state.value.project
    if (disposed || saving || reconciling || state.value.refreshing || state.value.reconciliation || !project || options.reconcileBlocked?.()) {
      return
    }
    const request = generation
    const baseline = projectDraft(project)
    const local = projectDraft(draft)
    reconciling = true
    state.value = { ...state.value, reconciliation: { pending: true, error: '', baselineRevision: project.revision, serverRevision: project.revision, localSignature: projectInputSignature(local), fields: [] } }
    try {
      const projects = await refresh(request)
      if (!projects) {
        throw new Error(state.value.refreshError || '配置核对失败，请重试。')
      }
      const server = projects.find(item => item.id === project.id)
      if (!current(request) || !server || !Number.isSafeInteger(server.revision) || server.revision < project.revision) {
        throw new Error('未读取到可应用的最新项目配置，请重试。')
      }
      const observed = known.get(project.id)?.revision
      if (observed !== undefined && observed > server.revision) {
        throw new Error('服务器已有更新的配置，请重新核对。')
      }
      if (projectInputSignature(projectDraft(draft)) !== projectInputSignature(local)) {
        throw new Error('草稿在读取期间已修改，请重新核对。')
      }
      reconciliationProject = server
      state.value = { ...state.value, reconciliation: { ...prepareProjectReconciliation(baseline, local, projectDraft(server), project.revision, server.revision), pending: false, error: '' } }
    }
    catch (cause) {
      if (current(request)) {
        state.value = { ...state.value, reconciliation: { ...state.value.reconciliation!, pending: false, error: cause instanceof Error ? cause.message : '配置核对失败，请重试' } }
      }
    }
    finally {
      reconciling = false
    }
  }
  function cancelReconciliation() {
    reconciliationProject = undefined
    state.value = { ...state.value, reconciliation: undefined }
  }
  function applyReconciliation(choices: Partial<Record<ProjectFieldKey, 'local' | 'server'>> = {}) {
    const currentReconciliation = state.value.reconciliation
    const project = state.value.project
    const server = reconciliationProject
    if (disposed || saving || reconciling || options.reconcileBlocked?.() || !currentReconciliation || currentReconciliation.pending || !project || !server || reconciliationStale.value || project.id !== server.id || server.revision !== currentReconciliation.serverRevision || (known.get(project.id)?.revision ?? server.revision) > server.revision) {
      return false
    }
    const next = applyProjectReconciliation(currentReconciliation, choices)
    if (!next) {
      return false
    }
    generation++
    session.value = generation
    reconciliationProject = undefined
    state.value = { ...state.value, project: server, baseline: projectDraft(server), saved: false, error: '', conflict: false, serverChanged: false, reconciliation: undefined }
    replaceDraft(next)
    return true
  }
  function dispose() {
    disposed = true
    generation++
    session.value = generation
    reconciling = false
    reconciliationProject = undefined
    state.value = { ...state.value, reconciliation: undefined }
  }
  return { draft, state, dirty, reconciliationStale, session, open, observe, invalidate, save, refresh, reload, reconcile, cancelReconciliation, applyReconciliation, dispose }
}

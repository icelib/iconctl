import type { Project, ProjectInput } from '@iconctl/console-contracts'
import { computed, reactive, shallowRef } from 'vue'
import { ApiError } from '../../api-response'

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
}

interface EditorOptions {
  blank: () => ProjectInput
  save: (input: ProjectInput, project?: Project) => Promise<Project>
  committed: (project: Project, current: boolean) => void
  refresh: () => Promise<Project[]>
}

export function createProjectEditor(options: EditorOptions) {
  let generation = 0
  let disposed = false
  let saving = false
  const known = new Map<string, Project>()
  const draft = reactive<ProjectInput>(projectDraft(options.blank()))
  const state = shallowRef<EditorState>(initial())
  const dirty = computed(() => JSON.stringify(draft) !== JSON.stringify(state.value.baseline))

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
    state.value = initial(project)
    replaceDraft(state.value.baseline)
    observe(project ? [project] : [])
  }
  function invalidate() {
    generation++
    state.value = { ...state.value, pending: false, refreshing: false, error: '', refreshError: '', saved: false }
  }
  async function refresh(request = generation) {
    if (!current(request)) {
      return
    }
    state.value = { ...state.value, refreshing: true, refreshError: '' }
    try {
      const projects = await options.refresh()
      if (current(request)) {
        observe(projects)
      }
    }
    catch (cause) {
      if (current(request)) {
        state.value = { ...state.value, refreshError: cause instanceof Error ? cause.message : '工作空间暂时无法刷新' }
      }
    }
    finally {
      if (current(request)) {
        state.value = { ...state.value, refreshing: false }
      }
    }
  }
  async function save() {
    if (disposed || saving || state.value.serverChanged || state.value.conflict || state.value.refreshing) {
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
    if (disposed || saving || state.value.refreshing || !project) {
      return
    }
    await refresh(request)
    if (!current(request) || state.value.refreshError) {
      return
    }
    if (JSON.stringify(draft) !== before) {
      state.value = { ...state.value, error: '载入期间草稿已修改，请再次点击载入最新配置' }
      return
    }
    const latest = known.get(project.id)
    if (latest) {
      open(latest)
    }
  }
  function dispose() {
    disposed = true
    generation++
  }
  return { draft, state, dirty, open, observe, invalidate, save, refresh, reload, dispose }
}

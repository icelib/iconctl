<script setup lang="ts">
import type {
  ConsoleState,
  IconJSON,
  Job,
  Project,
  ProjectInput,
  Snapshot,
  SnapshotContent,
  Source,
} from '@iconctl/console-contracts'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api, initializeSession, restoreBackup, upload } from './api'

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
const busy = ref(false)
const ready = ref(false)
const error = ref('')
const notice = ref('')
const selectedId = ref('')
const editing = ref<Project>()
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
const draft = reactive<ProjectInput>(blank())
const activeProject = computed(() =>
  data.value.projects.find(project => project.id === selectedId.value),
)
const snapshots = computed(() =>
  data.value.snapshots.filter(
    snapshot => !selectedId.value || snapshot.projectId === selectedId.value,
  ),
)
const jobs = computed(() =>
  data.value.jobs.filter(
    job => !selectedId.value || job.projectId === selectedId.value,
  ),
)
const releases = computed(() =>
  data.value.releases.filter(
    release => !selectedId.value || release.projectId === selectedId.value,
  ),
)
const sourceType = ref<Source['type']>('figma')
const mastergo = reactive({ label: 'MasterGo', token: '' })
const pairing = reactive({ code: '', projectId: '', label: '我的 Figma 插件' })
const snapshotId = ref('')
const search = ref('')
const filter = ref('all')
const bump = ref<'patch' | 'minor' | 'major'>('patch')
const preview = ref<{
  snapshot: Snapshot
  content: SnapshotContent
  previous?: IconJSON
  diff: { added: string[], changed: string[], removed: string[] }
}>()
const confirmation = ref<{
  id: string
  packageName: string
  iconCount: number
  release: { version: string, digest: string }
}>()
const releaseDialog = ref<HTMLDialogElement>()
watch(
  confirmation,
  (value) => {
    if (value) {
      releaseDialog.value?.showModal()
    }
    else { releaseDialog.value?.close() }
  },
  { flush: 'post' },
)
function selectProject(event: Event) {
  selectedId.value = (event.target as HTMLSelectElement).value
  if (view.value === 'config') {
    edit(activeProject.value)
  }
  if (view.value === 'preview') {
    preview.value = undefined
    snapshotId.value = ''
    confirmation.value = undefined
  }
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
const labels: Record<string, string> = {
  'queued': '等待执行',
  'running': '运行中',
  'succeeded': '已完成',
  'failed': '失败',
  'reconciling': '核对发布结果',
  'sync': '同步',
  'check': '仅校验',
  'preview': '预览',
  'dry-run': 'Dry run',
  'publish': '发布',
  'claimed': '已领取',
  'fetching': '抓取来源',
  'validating': '校验图标',
  'packing': '组装产物',
  'publishing': '发布 npm',
  'complete': '完成',
}
function date(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)
}
async function refresh() {
  data.value = await api<ConsoleState>('state')
  if (!selectedId.value && data.value.projects[0]) {
    selectedId.value = data.value.projects[0].id
  }
}
async function perform(action: () => Promise<void>) {
  if (busy.value) {
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试'
  }
  finally {
    busy.value = false
  }
}
function edit(project?: Project) {
  editing.value = project
  Object.keys(draft).forEach(
    key => delete (draft as unknown as Record<string, unknown>)[key],
  )
  Object.assign(
    draft,
    project
      ? {
          name: project.name,
          repository: project.repository,
          prefix: project.prefix,
          packageName: project.packageName,
          sources: JSON.parse(JSON.stringify(project.sources)),
          color: project.color,
          validate: JSON.parse(JSON.stringify(project.validate)),
          output: JSON.parse(JSON.stringify(project.output)),
          ...(project.advancedConfig
            ? {
                advancedConfig: JSON.parse(
                  JSON.stringify(project.advancedConfig),
                ),
              }
            : {}),
        }
      : blank(),
  )
  if (project) {
    selectedId.value = project.id
  }
  view.value = 'config'
}
async function save() {
  await perform(async () => {
    const result = editing.value
      ? await api<Project>(
          `projects/${editing.value.id}`,
          { project: draft, revision: editing.value.revision },
          'PUT',
        )
      : await api<Project>('projects', draft)
    selectedId.value = result.id
    editing.value = result
    await refresh()
    notice.value = '项目配置已保存'
  })
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
  else {
    draft.sources.push({ type, dir: 'raw' })
  }
}
function csv(event: Event) {
  return (event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)
}
async function attachUpload(event: Event, source: Source) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !('dir' in source)) {
    return
  }
  await perform(async () => {
    source.upload = await upload(file)
    source.dir = 'svg'
    notice.value = 'SVG 压缩包已上传；保存项目后生效'
  })
}
async function start(operation: string, projectId = selectedId.value) {
  await perform(async () => {
    await api(`projects/${projectId}/jobs`, { operation })
    selectedId.value = projectId
    await refresh()
    view.value = 'history'
    notice.value = '任务已创建，将由 GitHub Actions 执行'
  })
}
async function install() {
  if (!activeProject.value) {
    return
  }
  await perform(async () => {
    const result = await api<{ url: string }>(
      `projects/${selectedId.value}/install`,
      {},
    )
    await refresh()
    notice.value = `安装 PR 已创建：${result.url}`
  })
}
async function openSnapshot(id: string) {
  await perform(async () => {
    preview.value = await api(`snapshots/${id}`)
    snapshotId.value = id
    selectedId.value = preview.value!.snapshot.projectId
    view.value = 'preview'
    confirmation.value = undefined
  })
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
  await perform(async () => {
    confirmation.value = await api(
      `projects/${selectedId.value}/release/preview`,
      { snapshotId: snapshotId.value, bump: bump.value },
    )
  })
}
async function publish() {
  if (!confirmation.value) {
    return
  }
  await perform(async () => {
    await api(`projects/${selectedId.value}/release/confirm`, {
      confirmationId: confirmation.value!.id,
    })
    confirmation.value = undefined
    await refresh()
    view.value = 'history'
    notice.value = '发布任务已创建'
  })
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
    await refresh()
  })
}
async function connectMastergo() {
  await perform(async () => {
    await api('connections/mastergo', mastergo)
    mastergo.token = ''
    await refresh()
  })
}
async function approvePairing() {
  await perform(async () => {
    await api('pairings/approve', pairing)
    pairing.code = ''
    await refresh()
    notice.value = '插件已连接，仅能同步所选项目'
  })
}
async function revoke(id: string) {
  await perform(async () => {
    await api(`devices/${id}`, undefined, 'DELETE')
    await refresh()
  })
}
async function retry(job: Job) {
  await perform(async () => {
    await api(`jobs/${job.id}/retry`, {})
    await refresh()
  })
}
async function restoreFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }
  await perform(async () => {
    const count = await restoreBackup(file)
    await refresh()
    notice.value = `已恢复 ${count} 条记录；请核对 R2 产物并重新连接来源授权`
  })
}
async function logout() {
  await api('logout', {})
  location.assign('/login')
}
let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await perform(async () => {
    await initializeSession()
    await refresh()
    ready.value = true
  })
  poll = setInterval(() => {
    if (ready.value && !busy.value && document.visibilityState === 'visible') {
      refresh().catch(() => undefined)
    }
  }, 10_000)
})
onUnmounted(() => clearInterval(poll))
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
          @click="item.id === 'config' ? edit(activeProject) : (view = item.id)"
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
      <div v-if="error" role="alert" class="message error">
        {{ error }}
      </div>
      <div v-if="notice" role="status" class="message notice">
        {{ notice }}
      </div>
      <p v-if="!ready && !error" class="loading">
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
          <p>连接 GitHub 仓库，选择 Figma 或 SVG 来源。</p>
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
        <form class="editor" @submit.prevent="save">
          <div class="section-heading">
            <h2>{{ editing ? "编辑项目" : "新建项目" }}</h2>
            <span v-if="editing" class="mono">配置 v{{ editing.revision }}</span>
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
            :key="index"
            class="source-editor"
          >
            <legend>
              {{ source.type }} <span class="mono">{{ index + 1 }}</span>
            </legend>
            <button
              type="button"
              class="remove-source"
              :aria-label="`移除来源 ${index + 1}`"
              @click="draft.sources.splice(index, 1)"
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
            <div v-else class="form-grid">
              <label>仓库内目录 / ZIP 子目录<input
                v-model="source.dir"
                required
              ></label><label>或上传 SVG ZIP（最多 10 MB）<input
                type="file"
                accept=".zip"
                @change="attachUpload($event, source)"
              ></label>
              <p v-if="source.upload" class="help full-width">
                已上传 · {{ source.upload }}
                <button
                  type="button"
                  class="text-button"
                  @click="delete source.upload"
                >
                  恢复使用仓库目录
                </button>
              </p>
              <p class="help full-width">
                即时设计请先导出 SVG。ZIP 根目录使用 <code>svg</code>；只接受
                SVG 文件，不支持符号链接。
              </p>
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
            <button class="primary" type="submit" :disabled="busy">
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
            <button :disabled="busy" @click="install">
              创建 runner 安装 PR
            </button><a
              v-if="activeProject?.installationPr"
              :href="activeProject.installationPr"
              target="_blank"
              rel="noopener"
            >查看安装 PR ↗</a>
            <hr>
            <button class="primary" :disabled="busy" @click="start('sync')">
              同步图标
            </button>
            <div class="operation-buttons">
              <button :disabled="busy" @click="start('check')">
                仅校验
              </button><button :disabled="busy" @click="start('preview')">
                预览
              </button><button :disabled="busy" @click="start('dry-run')">
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
            @change="openSnapshot(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>
              选择一个同步快照
            </option>
            <option
              v-for="snapshot in snapshots"
              :key="snapshot.id"
              :value="snapshot.id"
            >
              {{ date(snapshot.createdAt) }} · {{ snapshot.iconCount }} 个图标
            </option>
          </select><input
            v-model="search"
            aria-label="搜索图标"
            placeholder="搜索图标名称…"
          >
        </div>
        <div v-if="!preview" class="empty-state">
          <h3>同步之后，在这里审核变化</h3>
          <p>比较上一次成功快照，检查新增、修改和删除的图标。</p>
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
          <div
            v-if="
              preview.content.issues.length || preview.content.failed.length
            "
            class="validation-issues"
          >
            <h3>请先修复校验问题</h3>
            <p v-for="(issue, index) in preview.content.issues" :key="index">
              <code>{{ issue.name }}</code> · {{ issue.message }}
            </p>
            <p v-for="name in preview.content.failed" :key="name">
              处理失败：{{ name }}
            </p>
          </div>
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
          <div class="artifact-list">
            <h3>下载产物</h3>
            <a
              v-for="name in Object.keys(preview.content.files).filter(
                (name) => !name.startsWith('svg/'),
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
              :disabled="busy || preview.snapshot.issues > 0"
              @click="previewRelease"
            >
              查看发布确认
            </button>
          </div>
          <dialog
            ref="releaseDialog"
            class="release-dialog"
            @cancel.prevent="confirmation = undefined"
          >
            <template v-if="confirmation">
              <p class="eyebrow">
                确认公开发布
              </p>
              <h2>{{ confirmation.packageName }}</h2>
              <div class="release-version">
                v{{ confirmation.release.version }}
              </div>
              <p>{{ confirmation.iconCount }} 个图标 · npm / latest</p>
              <p class="help mono">
                SHA-256 {{ confirmation.release.digest }}
              </p>
              <p>发布后会生成 Git 提交、版本标签和 GitHub Release。</p>
              <div class="inline-controls">
                <button :disabled="busy" @click="confirmation = undefined">
                  返回审核
                </button><button class="primary" :disabled="busy" @click="publish">
                  确认发布 {{ confirmation.release.version }}
                </button>
              </div>
            </template>
          </dialog>
        </template>
      </section>

      <section v-if="view === 'history'">
        <div class="section-heading">
          <h2>任务记录</h2>
          <button :disabled="busy" @click="perform(refresh)">
            刷新状态
          </button>
        </div>
        <p v-if="!jobs.length" class="empty-state">
          还没有任务。从项目配置中发起一次同步。
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
              <tr v-for="job in jobs" :key="job.id">
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

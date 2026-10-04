import type { ConsoleState, Project, ProjectInput } from '@iconctl/console-contracts'
import type { Page, Request } from '@playwright/test'
import { test as base, expect } from '@playwright/test'

export const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
export const alpha: Project = {
  id: id(701),
  name: 'alpha-icons',
  prefix: 'alpha',
  packageName: '@fixture/alpha-icons',
  repository: 'fixture/alpha',
  revision: 1,
  repositoryInfo: { id: 701, installationId: 456, defaultBranch: 'main' },
  createdAt: 1_790_000_000_000,
  sources: [{ type: 'directory', dir: 'raw/alpha' }],
  color: 'currentColor',
  validate: { width: 24, height: 24, skipPrefix: ['_', '.'] },
  output: { svg: true, types: true, preview: true, changelog: true },
  advancedConfig: { path: 'alpha.config.ts', commit: 'a'.repeat(40) },
}
export const beta: Project = {
  ...alpha,
  id: id(702),
  name: 'beta-icons',
  prefix: 'beta',
  packageName: '@fixture/beta-icons',
  repository: 'fixture/beta',
  revision: 7,
  sources: [{ type: 'directory', dir: 'raw/beta' }],
  color: false,
  validate: { width: 16, skipPrefix: ['Draft-'] },
  output: { svg: false, types: true, preview: false, changelog: true },
  advancedConfig: { path: 'beta.config.ts', commit: 'b'.repeat(40) },
}
export function input(project: Project): ProjectInput {
  return structuredClone({
    name: project.name,
    prefix: project.prefix,
    packageName: project.packageName,
    repository: project.repository,
    sources: project.sources,
    color: project.color,
    validate: project.validate,
    output: project.output,
    ...(project.advancedConfig ? { advancedConfig: project.advancedConfig } : {}),
  })
}
export interface Reply { status?: number, json: unknown }
export interface Captured { method: string, path: string, body: unknown }
export interface Gate {
  method: string
  path: string
  entered: boolean
  settled: boolean
  request?: Captured
  transport?: Request
  promise: Promise<Reply>
  release: (reply: Reply) => void
}
export interface EditorApi {
  state: ConsoleState
  gates: Gate[]
  requests: Captured[]
  stateReads: number
}
export function hold(api: EditorApi, method: string, path: string) {
  let done!: (reply: Reply) => void
  const gate: Gate = {
    method,
    path,
    entered: false,
    settled: false,
    promise: new Promise<Reply>((resolve) => { done = resolve }),
    release(reply) {
      if (!gate.settled) {
        gate.settled = true
        done(structuredClone(reply))
      }
    },
  }
  api.gates.push(gate)
  return gate
}
export const test = base.extend<{ editorApi: EditorApi }>({
  editorApi: async ({ page }, use) => {
    await page.clock.install()
    const api: EditorApi = {
      state: { projects: structuredClone([alpha, beta]), jobs: [], snapshots: [], releases: [], connections: [], pairings: [], devices: [] },
      gates: [],
      requests: [],
      stateReads: 0,
    }
    const errors: string[] = []
    const unexpected: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const method = request.method()
      const path = new URL(request.url()).pathname
      const captured = { method, path, body: request.postData() ? structuredClone(request.postDataJSON()) as unknown : undefined }
      api.requests.push(captured)
      if (path === '/api/session') {
        return route.fulfill({ json: { csrf: 'editor-csrf' } })
      }
      const gate = api.gates.find(item => !item.entered && item.method === method && item.path === path)
      if (path === '/api/state') {
        api.stateReads++
      }
      else {
        expect(request.headers()['x-csrf-token']).toBe('editor-csrf')
      }
      if (gate) {
        // Capture before awaiting: later input must not mutate the request body.
        gate.request = captured
        gate.transport = request
        gate.entered = true
        const reply = await gate.promise
        if (/^\/api\/projects(?:\/[^/]+)?$/.test(path) && (reply.status ?? 200) < 400) {
          const saved = reply.json as Project
          const current = api.state.projects.find(project => project.id === saved.id)
          if (!current || current.revision <= saved.revision) {
            api.state.projects = [structuredClone(saved), ...api.state.projects.filter(project => project.id !== saved.id)]
          }
        }
        return route.fulfill(reply)
      }
      if (path === '/api/state') {
        return route.fulfill({ json: structuredClone(api.state) })
      }
      unexpected.push(`${method} ${path}`)
      return route.fulfill({ status: 500, json: { error: 'Unplanned editor request' } })
    })
    try {
      await use(api)
      expect(errors).toEqual([])
      expect(unexpected).toEqual([])
    }
    finally {
      api.gates.forEach(gate => gate.release({ status: 503, json: { error: 'Fixture closed' } }))
    }
  },
})

export const form = (page: Page) => page.getByRole('form', { name: '项目编辑', exact: true })
export const mutations = (api: EditorApi) => api.requests.filter(request => request.method !== 'GET')
export async function open(page: Page, project = alpha) {
  await page.goto('/app/')
  await page.getByRole('button', { name: project.name, exact: true }).click()
  await expect(form(page)).toBeVisible()
  await expect(page.getByLabel('当前项目', { exact: true })).toHaveValue(project.id)
}
export async function answer(page: Page, gate: Gate, reply: Reply) {
  await expect.poll(() => gate.entered).toBe(true)
  // Cancellation is a terminal transport result too; bind to this exact read.
  const response = gate.transport!.response()
  gate.release(reply)
  await (await response)?.finished()
  await page.clock.runFor(50)
}
export async function save(page: Page, gate: Gate) {
  await form(page).getByRole('button', { name: '保存项目', exact: true }).click()
  await expect.poll(() => gate.entered).toBe(true)
}
export async function baseline(page: Page, revision: number) {
  await expect(page.getByLabel('编辑基线', { exact: true })).toHaveText(`配置 v${revision}`)
}
export async function advanceState(page: Page, api: EditorApi, value: ConsoleState) {
  const gate = hold(api, 'GET', '/api/state')
  await page.clock.fastForward(10_000)
  await expect.poll(() => gate.entered).toBe(true)
  return { gate, value: structuredClone(value) }
}

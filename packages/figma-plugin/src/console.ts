import type { PluginContext } from '@iconctl/console-contracts'
import type { PreflightItem, PreflightRules } from './preflight'
import { canSubmit } from './preflight'

export const DEVICE_KEY = 'iconctl-console-device'
export const TASK_KEY = 'iconctl-console-task'
interface Device {
  origin: string
  deviceId: string
  projectId: string
  token: string
}
interface Task {
  deviceId: string
  requestId: string
  expectedRevision: number
  jobId?: string
}
interface Host {
  storage: {
    getAsync: (key: string) => Promise<unknown>
    setAsync: (key: string, value: unknown) => Promise<void>
    deleteAsync: (key: string) => Promise<void>
  }
  post: (message: Record<string, unknown>) => void
  scan: (rules?: PreflightRules) => PreflightItem[]
}
class ConsoleError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
class Superseded extends Error {
}
export function consoleOrigin(value = 'https://iconctl.icebreaker.top') {
  const url = new URL(value)
  if (url.protocol !== 'https:'
    || (url.hostname !== 'iconctl.icebreaker.top' && !url.hostname.endsWith('.workers.dev'))
    || url.pathname !== '/' || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Use the iconctl console HTTPS origin')
  }
  return url.origin
}
function uuid() {
  // Request deduplication only: the Figma sandbox does not expose WebCrypto.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}
/** Owns one connection generation, durable submission intent and polling loop. */
export class PluginConsole {
  private generation = 0
  private active = false
  private context: PluginContext | undefined
  private wake: (() => void) | undefined
  private writes: Promise<void> = Promise.resolve()
  private mode: 'console' | 'github' = 'console'
  constructor(private readonly host: Host) { }
  private check(generation: number) {
    if (generation !== this.generation) {
      throw new Superseded()
    }
  }

  private status(text: string, extra: Record<string, unknown> = {}) {
    this.host.post({ type: 'console-status', text, busy: this.active, connected: Boolean(this.context), ...extra })
  }

  private changeGeneration() {
    this.generation++
    this.wake?.()
    this.wake = undefined
    this.active = false
    return this.generation
  }

  private async write(generation: number, action: () => Promise<void>) {
    const write = this.writes.then(async () => {
      this.check(generation)
      await action()
    })
    this.writes = write.catch(() => { })
    await write
    this.check(generation)
  }

  private async delay(generation: number, ms: number) {
    this.check(generation)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
    this.check(generation)
  }

  private async request<T>(generation: number, origin: string, path: string, token?: string, body?: unknown, requestId?: string): Promise<T> {
    this.check(generation)
    const response = await fetch(`${origin}/api/plugin/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(requestId ? { 'Idempotency-Key': requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    this.check(generation)
    if (!response.ok) {
      throw new ConsoleError(response.status, path.endsWith('/context') && response.status === 404
        ? 'Project context is unavailable. Update the console or pair the device again.'
        : `Console request failed (${response.status}). Check the connection or pair again.`)
    }
    const result = await response.json() as T
    this.check(generation)
    return result
  }

  private async retry<T>(generation: number, action: () => Promise<T>): Promise<T> {
    let failures = 0
    while (true) {
      try {
        return await action()
      }
      catch (error) {
        this.check(generation)
        if (error instanceof ConsoleError && error.status < 500 && error.status !== 429) {
          throw error
        }
        this.status('Connection interrupted. Retrying the same task…', { error: true })
        await this.delay(generation, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)))
      }
    }
  }

  rescan(mode = this.mode) {
    this.mode = mode
    const rules = mode === 'console' && this.context
      ? { ...this.context.validate, namingMode: this.context.namingMode }
      : undefined
    this.host.post({ type: 'preflight', items: this.host.scan(rules) })
  }

  private async refresh(generation: number, device: Device, announce = true) {
    const context = await this.retry(generation, () => this.request<PluginContext>(generation, device.origin, `devices/${device.deviceId}/context`, device.token))
    if (context.projectId !== device.projectId) {
      throw new Error('The connected project changed. Pair again.')
    }
    this.context = context
    this.rescan()
    if (announce) {
      this.status(`Connected to ${context.name} · revision ${context.revision}${context.namingMode === 'server' ? ' · Custom names are validated by the server.' : ''}`, { origin: device.origin })
    }
    return context
  }

  private async track(generation: number, device: Device, task: Task) {
    try {
      if (!task.jobId) {
        const result = await this.retry(generation, () => this.request<{
          id: string
        }>(generation, device.origin, `devices/${device.deviceId}/jobs`, device.token, { expectedRevision: task.expectedRevision }, task.requestId))
        task = { ...task, jobId: result.id }
        await this.write(generation, () => this.host.storage.setAsync(TASK_KEY, task))
      }
      const url = `${device.origin}/app/?job=${task.jobId}`
      while (true) {
        const result = await this.retry(generation, () => this.request<{
          status: string
          stage: string
          error?: string
        }>(generation, device.origin, `devices/${device.deviceId}/jobs/${task.jobId}`, device.token))
        this.status(`${result.status} · ${result.stage}${result.error ? ` · ${result.error}` : ''}`, { url })
        if (result.status === 'succeeded' || result.status === 'failed') {
          await this.write(generation, () => this.host.storage.deleteAsync(TASK_KEY))
          return
        }
        await this.delay(generation, 5000)
      }
    }
    catch (error) {
      this.check(generation)
      if (error instanceof ConsoleError && error.status === 409 && !task.jobId) {
        await this.write(generation, () => this.host.storage.deleteAsync(TASK_KEY))
        await this.refresh(generation, device)
        throw new Error('Project rules or task state changed. Review the refreshed preflight and sync again.')
      }
      throw error
    }
  }

  private async connect(generation: number, submit: boolean) {
    const device = await this.host.storage.getAsync(DEVICE_KEY) as Device | undefined
    this.check(generation)
    if (!device) {
      throw new Error('Connect the console first')
    }
    consoleOrigin(device.origin)
    const task = await this.host.storage.getAsync(TASK_KEY) as Task | undefined
    this.check(generation)
    // Reconcile a saved request before fetching newer project rules.
    if (task?.deviceId === device.deviceId) {
      await this.track(generation, device, task)
      await this.refresh(generation, device, false)
      return
    }
    const context = await this.refresh(generation, device)
    if (!submit) {
      return
    }
    const items = this.host.scan({ ...context.validate, namingMode: context.namingMode })
    this.host.post({ type: 'preflight', items })
    if (!canSubmit(items)) {
      throw new Error('Fix all preflight errors and include at least one icon before syncing')
    }
    const next: Task = { deviceId: device.deviceId, requestId: uuid(), expectedRevision: context.revision }
    await this.write(generation, () => this.host.storage.setAsync(TASK_KEY, next))
    await this.track(generation, device, next)
  }

  private async pair(generation: number, origin: string) {
    const pair = await this.request<{
      id: string
      code: string
      pollToken: string
      expiresAt: number
    }>(generation, origin, 'pair', undefined, {})
    this.status(`Pairing code: ${pair.code} · Confirm in ${origin}/app/?view=connections within 5 minutes`)
    while (Date.now() < pair.expiresAt) {
      await this.delay(generation, 3000)
      const result = await this.request<{
        pending: boolean
        deviceId?: string
        projectId?: string
        token?: string
      }>(generation, origin, `pair/${pair.id}`, pair.pollToken)
      if (!result.pending && result.deviceId && result.projectId && result.token) {
        const device: Device = { origin, deviceId: result.deviceId, projectId: result.projectId, token: result.token }
        await this.write(generation, () => this.host.storage.setAsync(DEVICE_KEY, device))
        await this.refresh(generation, device)
        return
      }
    }
    throw new Error('Pairing expired. Request a new code.')
  }

  async handle(message: {
    type: string
    origin?: string
  }) {
    const replacing = message.type === 'console-disconnect' || message.type === 'console-pair'
    if (this.active && !replacing) {
      return
    }
    const generation = this.changeGeneration()
    this.active = true
    this.status('Connecting…')
    try {
      const origin = message.type === 'console-pair' ? consoleOrigin(message.origin) : undefined
      if (replacing) {
        this.context = undefined
        await this.write(generation, async () => {
          await this.host.storage.deleteAsync(DEVICE_KEY)
          await this.host.storage.deleteAsync(TASK_KEY)
        })
        this.rescan()
        if (message.type === 'console-disconnect') {
          this.status('Local connection removed. Revoke the device in the console to invalidate its credential.')
          return
        }
        await this.pair(generation, origin!)
      }
      else {
        await this.connect(generation, message.type === 'console-sync')
      }
    }
    catch (error) {
      if (generation !== this.generation || error instanceof Superseded) {
        return
      }
      if (error instanceof ConsoleError && [401, 403, 404].includes(error.status)) {
        this.context = undefined
        if (error.status !== 404) {
          try {
            await this.write(generation, async () => {
              await this.host.storage.deleteAsync(DEVICE_KEY)
              await this.host.storage.deleteAsync(TASK_KEY)
            })
          }
          catch (cleanupError) {
            if (generation !== this.generation) {
              return
            }
            this.status(cleanupError instanceof Error ? cleanupError.message : 'Unable to clear local credentials', { error: true })
            return
          }
        }
      }
      this.status(error instanceof Error ? error.message : 'Console request failed', { error: true })
    }
    finally {
      if (generation === this.generation) {
        this.active = false
        this.host.post({ type: 'console-state', busy: false, connected: Boolean(this.context) })
      }
    }
  }

  dispose() { this.changeGeneration() }
}

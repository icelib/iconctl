export interface LegacySettings {
  repo?: string
  token?: string
  eventType?: string
}

export interface ViewPreferences {
  problemsOnly: boolean
}

type Scope = 'settings' | 'preferences'
type StoredValue = LegacySettings | ViewPreferences
interface StorageHost {
  storage: {
    getAsync: (key: string) => Promise<unknown>
    setAsync: (key: string, value: unknown) => Promise<void>
  }
  post: (message: Record<string, unknown>) => void
}
interface Domain {
  key: string
  revision: number
  failed?: 'load' | 'save'
}

function decode(scope: Scope, input: unknown): { value: StoredValue, invalid: boolean } {
  const fallback: StoredValue = scope === 'settings' ? {} : { problemsOnly: false }
  if (input == null) {
    return { value: fallback, invalid: false }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { value: fallback, invalid: true }
  }
  const record = input as Record<string, unknown>
  if (scope === 'preferences') {
    return typeof record['problemsOnly'] === 'boolean'
      ? { value: { problemsOnly: record['problemsOnly'] }, invalid: false }
      : { value: fallback, invalid: true }
  }
  const value: LegacySettings = {}
  let invalid = false
  for (const key of ['repo', 'token', 'eventType'] as const) {
    if (record[key] === undefined) {
      continue
    }
    if (typeof record[key] === 'string') {
      value[key] = record[key]
    }
    else {
      invalid = true
    }
  }
  return { value, invalid }
}

/** Owns storage operations for one open plugin, independently of device/task state. */
export class PluginSettings {
  private disposed = false
  private writes: Promise<void> = Promise.resolve()
  private readonly domains: Record<Scope, Domain> = {
    settings: { key: 'iconctl-settings', revision: 0 },
    preferences: { key: 'iconctl-preflight-preferences', revision: 0 },
  }

  constructor(private readonly host: StorageHost) {}

  dispose() {
    this.disposed = true
  }

  private current(scope: Scope, revision: number) {
    return !this.disposed && this.domains[scope].revision === revision
  }

  private feedback(scope: Scope, operation: 'load' | 'save', error = false) {
    const label = scope === 'settings' ? 'GitHub settings' : 'Preflight view preference'
    this.host.post({
      type: 'storage-status',
      scope,
      operation,
      error,
      text: error
        ? `${label} could not be ${operation === 'load' ? 'fully restored' : 'saved'}. You can keep using this session and retry.`
        : '',
    })
  }

  private async load(scope: Scope) {
    if (this.disposed) {
      return
    }
    const domain = this.domains[scope]
    const revision = ++domain.revision
    delete domain.failed
    try {
      const result = decode(scope, await this.host.storage.getAsync(domain.key))
      if (!this.current(scope, revision)) {
        return
      }
      this.host.post({ type: scope, [scope]: result.value })
      if (result.invalid) {
        domain.failed = 'load'
      }
      this.feedback(scope, 'load', result.invalid)
    }
    catch {
      if (this.current(scope, revision)) {
        domain.failed = 'load'
        this.feedback(scope, 'load', true)
      }
    }
  }

  private async save(scope: Scope, input: unknown) {
    if (this.disposed) {
      return
    }
    const result = decode(scope, input)
    if (input == null || result.invalid) {
      return
    }
    const domain = this.domains[scope]
    const revision = ++domain.revision
    delete domain.failed
    const pending = this.writes.then(async () => {
      // A newer queued save supersedes this one. In-flight writes still finish
      // before the next write, even if they fail or the plugin closes.
      if (!this.current(scope, revision)) {
        return
      }
      try {
        await this.host.storage.setAsync(domain.key, result.value)
        if (this.current(scope, revision)) {
          this.feedback(scope, 'save')
        }
      }
      catch {
        if (this.current(scope, revision)) {
          domain.failed = 'save'
          this.feedback(scope, 'save', true)
        }
      }
    })
    this.writes = pending
    await pending
  }

  async handle(message: { type: string, scope?: unknown, settings?: unknown, preferences?: unknown }) {
    if (this.disposed) {
      return
    }
    if (message.type === 'load-settings') {
      await Promise.all([this.load('settings'), this.load('preferences')])
    }
    else if (message.type === 'save-settings') {
      await this.save('settings', message.settings)
    }
    else if (message.type === 'save-preferences') {
      await this.save('preferences', message.preferences)
    }
    else if (message.type === 'retry-storage' && (message.scope === 'settings' || message.scope === 'preferences')) {
      const scope = message.scope
      const failed = this.domains[scope].failed
      if (failed === 'load') {
        await this.load(scope)
      }
      else if (failed === 'save') {
        await this.save(scope, message[scope])
      }
    }
  }
}

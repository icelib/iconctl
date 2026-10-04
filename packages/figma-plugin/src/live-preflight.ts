export type LocalScanState = 'ready' | 'waiting' | 'stale' | 'disposed'
interface Host {
  currentPage: () => PageNode
  state: () => LocalScanState
  scan: () => LocalScanState | 'published' | 'failed'
  invalidate: (text: string) => void
  post: (message: Record<string, unknown>) => void
}

/** Owns only local page observation; remote tasks and rules have separate owners. */
export class LivePreflight {
  private enabled = false
  private disposed = false
  private epoch = 0
  private requestId = 0
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private binding: { page: PageNode, callback: (event: NodeChangeEvent) => void } | undefined

  constructor(private readonly host: Host) {}

  private status(state: string, text: string) {
    if (!this.disposed) {
      this.host.post({ type: 'live-preflight-state', enabled: this.enabled, requestId: this.requestId, state, text })
    }
  }

  private cancel() {
    this.epoch++
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private detach() {
    const binding = this.binding
    this.binding = undefined
    binding?.page.off('nodechange', binding.callback)
  }

  private bind() {
    const page = this.host.currentPage()
    const binding = { page, callback: (event: NodeChangeEvent) => {
      // off() cannot retract a callback already queued by Figma.
      if (!this.enabled || this.disposed || this.binding !== binding || this.host.currentPage().id !== page.id || !event.nodeChanges.length) {
        return
      }
      if (!this.dirty) {
        this.dirty = true
        this.host.invalidate('Page edited. Updating preflight…')
      }
      this.schedule()
    } }
    this.binding = binding
    page.on('nodechange', binding.callback)
  }

  private available() {
    const state = this.host.state()
    if (state !== 'ready') {
      this.status(state, state === 'stale'
        ? 'Refresh project rules to resume live preflight.'
        : 'Waiting for project rules…')
      return false
    }
    return true
  }

  private run() {
    if (!this.enabled || this.disposed || !this.dirty || this.binding?.page.id !== this.host.currentPage().id || !this.available()) {
      return
    }
    this.dirty = false
    const result = this.host.scan()
    if (result === 'failed') {
      this.failed()
    }
    else if (result !== 'published') {
      this.dirty = true
      this.available()
    }
  }

  private schedule() {
    this.cancel()
    if (!this.available()) {
      return
    }
    this.status('updating', 'Updating preflight…')
    const epoch = this.epoch
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (epoch === this.epoch) {
        this.run()
      }
    }, 150)
  }

  setEnabled(enabled: boolean, requestId?: number) {
    if (this.disposed || (requestId !== undefined && (!Number.isSafeInteger(requestId) || requestId <= this.requestId))) {
      return
    }
    if (requestId !== undefined) {
      this.requestId = requestId
    }
    this.cancel()
    this.detach()
    this.enabled = enabled
    this.dirty = enabled
    if (enabled) {
      this.bind()
      this.host.invalidate('Starting live preflight…')
      this.run()
    }
    else {
      this.status('off', 'Live preflight is off. Choose Rescan after editing.')
    }
  }

  pageChanged() {
    this.cancel()
    this.detach()
    if (this.enabled && !this.disposed) {
      this.bind()
      this.dirty = true
      this.run()
    }
  }

  /** Manual scans supersede the pending burst even if that scan fails. */
  manualScan() {
    this.cancel()
    this.dirty = false
  }

  published() {
    this.manualScan()
    if (this.enabled) {
      this.status('ready', 'Live preflight is on for this page. Uses loaded rules.')
    }
  }

  failed() {
    this.manualScan()
    if (this.enabled) {
      this.status('error', 'Could not scan this page. Edit again or choose Rescan.')
    }
  }

  stateChanged() {
    this.cancel()
    if (!this.enabled || this.disposed) {
      return
    }
    if (this.host.state() !== 'ready') {
      this.dirty = true
      this.available()
    }
    else if (this.dirty) {
      this.schedule()
    }
  }

  dispose() {
    this.disposed = true
    this.enabled = false
    this.cancel()
    this.detach()
    this.dirty = false
  }
}

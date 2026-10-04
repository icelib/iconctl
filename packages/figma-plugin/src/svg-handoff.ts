import type { LocalScanState } from './live-preflight'
import type { PreflightItem, PreflightRules } from './preflight'
import type { ScanMetadata } from './report'
import type { HandoffFile } from './svg-handoff-format'
import { inspectComponent } from './preflight'
import { handoffItems, MAX_HANDOFF_BYTES, svgByteLength } from './svg-handoff-format'

export const HANDOFF_EXPORT_SETTINGS: ExportSettingsSVGString = {
  format: 'SVG_STRING',
  contentsOnly: true,
  useAbsoluteBounds: true,
  svgOutlineText: true,
  svgIdAttribute: false,
  svgSimplifyStroke: true,
  colorProfile: 'DOCUMENT',
}

interface Host {
  currentPage: () => PageNode
  state: () => LocalScanState
  scan: () => { items: PreflightItem[], metadata: ScanMetadata, scanId: number }
  inspect: (rules?: PreflightRules) => PreflightItem[]
  lookup: (id: string) => Promise<BaseNode | null>
  invalidate: (text: string) => void
  post: (message: Record<string, unknown>) => void
}
interface Run {
  requestId: number
  page: PageNode
  callback: (event: NodeChangeEvent) => void
  cancelled: boolean
  waiting: boolean
  ready: boolean
  delivered: boolean
  attached: boolean
  scanId?: number
  snapshot?: string
  rules?: PreflightRules | undefined
  files: HandoffFile[]
}
class Cancelled extends Error {}

/** A local export owns no task, credential, live toggle or remote request. */
export class SvgHandoff {
  private active: Run | undefined
  private lastRequest = 0
  private disposed = false
  private scanning = false

  constructor(private readonly host: Host) {}

  private post(run: Run, state: string, text: string, busy: boolean, extra: Record<string, unknown> = {}) {
    if (!this.disposed && this.active === run) {
      this.host.post({ type: 'svg-handoff-status', requestId: run.requestId, scanId: run.scanId, state, text, busy, ...extra })
    }
  }

  private detach(run: Run) {
    if (run.attached) {
      run.attached = false
      run.page.off('nodechange', run.callback)
    }
  }

  private check(run: Run) {
    if (this.disposed || this.active !== run || run.cancelled) {
      throw new Cancelled()
    }
    if (this.host.currentPage().id !== run.page.id || this.host.state() !== 'ready') {
      throw new Error('Page or project rules changed. Export again after rescanning.')
    }
  }

  private checkSnapshot(run: Run) {
    this.check(run)
    if (JSON.stringify(this.host.inspect(run.rules)) !== run.snapshot) {
      this.host.invalidate('Page changed during SVG export. Rescan and export again.')
      throw new Cancelled()
    }
  }

  private component(run: Run, node: BaseNode | null, item: PreflightItem): ComponentNode {
    this.check(run)
    if (!node || node.removed || node.type !== 'COMPONENT' || node.id !== item.id) {
      throw new Error(`Component ${item.id} is no longer available. Rescan and export again.`)
    }
    let parent = node.parent
    while (parent && parent.type !== 'PAGE') {
      parent = parent.parent
    }
    if (parent?.id !== run.page.id) {
      throw new Error(`Component ${item.id} moved to another page. Rescan and export again.`)
    }
    const current = inspectComponent({
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width,
      height: node.height,
      ...(node.parent ? { parentName: node.parent.name, parentType: node.parent.type } : {}),
    }, run.rules)
    if (current.name !== item.name || current.width !== item.width || current.height !== item.height
      || current.iconName !== item.iconName || current.skipped || current.issues.length) {
      this.host.invalidate(`Component ${item.id} changed. Rescan and export again.`)
      throw new Cancelled()
    }
    return node
  }

  /** The initiating cached scan is the only invalidation this request owns. */
  invalidate(text = 'SVG export cancelled because the page or rules changed.') {
    if (!this.scanning) {
      this.cancel(undefined, text)
    }
  }

  cancel(requestId?: number, text = 'SVG export cancelled.') {
    const run = this.active
    if (!run || (requestId !== undefined && requestId !== run.requestId) || run.cancelled) {
      return
    }
    run.cancelled = true
    run.files = []
    this.detach(run)
    this.post(run, run.waiting ? 'cancelling' : 'cancelled', run.waiting ? `${text} Waiting for the current Figma operation to finish…` : text, run.waiting)
    if (!run.waiting) {
      this.active = undefined
    }
  }

  async start(requestId: number) {
    if (this.disposed || !Number.isSafeInteger(requestId) || requestId <= this.lastRequest) {
      return
    }
    if (this.active) {
      this.host.post({ type: 'svg-handoff-status', requestId, state: 'error', text: 'An SVG export is already active. Cancel it or wait for it to finish.', busy: false })
      return
    }
    this.lastRequest = requestId
    const page = this.host.currentPage()
    const run: Run = { requestId, page, cancelled: false, waiting: false, ready: false, delivered: false, attached: false, files: [], callback: (event) => {
      if (this.active !== run || run.cancelled || !event.nodeChanges.length) {
        return
      }
      this.cancel(run.requestId, 'Page edited. SVG export cancelled.')
      this.host.invalidate('Page edited during SVG export. Rescan and export again.')
    } }
    this.active = run
    let nodeId: string | undefined
    try {
      this.check(run)
      page.on('nodechange', run.callback)
      run.attached = true
      this.post(run, 'scanning', 'Checking the complete page before SVG export…', true)
      this.scanning = true
      let capture: ReturnType<Host['scan']>
      try {
        capture = this.host.scan()
      }
      finally {
        this.scanning = false
      }
      this.check(run)
      run.scanId = capture.scanId
      run.rules = capture.metadata.rules
      run.snapshot = JSON.stringify(capture.items)
      const items = handoffItems(capture.items, capture.metadata.rules?.namingMode === 'server')
      let total = 0
      for (const item of items) {
        nodeId = item.id
        this.check(run)
        this.post(run, 'exporting', `Exporting ${run.files.length + 1} of ${items.length}: ${item.iconName}`, true, { nodeId })
        run.waiting = true
        const found = await this.host.lookup(item.id)
        run.waiting = false
        const node = this.component(run, found, item)
        run.waiting = true
        const svg = await node.exportAsync(HANDOFF_EXPORT_SETTINGS)
        run.waiting = false
        this.component(run, node, item)
        const bytes = svgByteLength(svg)
        total += bytes
        if (total > MAX_HANDOFF_BYTES) {
          throw new Error('SVG handoff exceeds the 5 MiB total SVG limit.')
        }
        run.files.push({ path: item.path, svg, bytes })
      }
      this.checkSnapshot(run)
      run.ready = true
      this.post(run, 'ready', `Preparing ZIP with ${items.length} SVGs…`, true, { count: items.length, bytes: total })
      // Keep the listener and ownership through the iframe's download handshake.
    }
    catch (error) {
      run.waiting = false
      if (error instanceof Cancelled || run.cancelled || this.disposed) {
        this.post(run, 'cancelled', 'SVG export cancelled.', false)
      }
      else {
        this.post(run, 'error', error instanceof Error ? error.message : 'Could not export SVGs. Rescan and try again.', false, { nodeId })
      }
      run.files = []
      this.detach(run)
      if (this.active === run) {
        this.active = undefined
      }
    }
  }

  deliver(requestId: number, scanId: number) {
    const run = this.active
    if (!run || run.requestId !== requestId || run.scanId !== scanId || !run.ready || run.waiting || run.delivered || !run.files.length) {
      return
    }
    try {
      this.checkSnapshot(run)
      run.delivered = true
      this.host.post({ type: 'svg-handoff-files', requestId, scanId, files: run.files })
      run.files = []
    }
    catch (error) {
      this.cancel(requestId, error instanceof Error ? error.message : 'SVG export is no longer available.')
    }
  }

  finish(requestId: number, scanId: number) {
    const run = this.active
    if (run?.requestId === requestId && run.scanId === scanId && run.delivered && !run.waiting) {
      this.detach(run)
      run.files = []
      this.active = undefined
    }
  }

  dispose() {
    this.disposed = true
    this.cancel()
  }
}

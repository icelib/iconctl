import type { PreflightItem } from './preflight'

interface NavigationHost {
  currentPage: () => PageNode
  lookup: (id: string) => Promise<BaseNode | null>
  focus: (node: SceneNode) => void
  post: (message: Record<string, unknown>) => void
}

/** Navigation is limited to the latest preflight, even when node lookup is async. */
export class PreflightNavigation {
  private scan = 0
  private request = 0
  private pageId: string | undefined
  private allowed = new Set<string>()
  private disposed = false

  constructor(private readonly host: NavigationHost) {}

  get scanId() { return this.scan }

  cancel(scanId: unknown) {
    if (!this.disposed && scanId === this.scan) {
      this.request++
    }
  }

  capture(pageId: string, items: PreflightItem[]) {
    this.scan++
    this.request++
    this.pageId = pageId
    this.allowed = new Set(items.filter(item => !item.skipped).map(item => item.id))
  }

  invalidate() {
    this.scan++
    this.request++
    this.pageId = undefined
    this.allowed.clear()
    if (!this.disposed) {
      this.host.post({ type: 'navigation-invalidated', scanId: this.scan, text: 'Page changed. Rescan to locate icons on this page.' })
    }
  }

  dispose() {
    this.disposed = true
    this.request++
    this.allowed.clear()
  }

  async locate(message: { nodeId?: unknown, scanId?: unknown, requestId?: unknown }) {
    const { nodeId, scanId, requestId } = message
    if (this.disposed || typeof nodeId !== 'string' || !Number.isSafeInteger(scanId) || !Number.isSafeInteger(requestId)) {
      return
    }
    const request = ++this.request
    const current = () => !this.disposed && request === this.request && scanId === this.scan
    const reply = (text: string, error: boolean) => this.host.post({ type: 'navigation-result', nodeId, scanId, requestId, text, error })
    if (scanId !== this.scan || !this.allowed.has(nodeId)) {
      reply('This component is not in the current preflight. Rescan and try again.', true)
      return
    }
    try {
      if (this.host.currentPage().id !== this.pageId) {
        throw new Error('Page changed. Rescan to locate icons on this page.')
      }
      const node = await this.host.lookup(nodeId).catch(() => {
        throw new Error('Could not read this component. Rescan and try again.')
      })
      if (!current()) {
        return
      }
      if (this.host.currentPage().id !== this.pageId) {
        throw new Error('Page changed. Rescan to locate icons on this page.')
      }
      if (!node || node.removed || node.type !== 'COMPONENT' || node.id !== nodeId) {
        throw new Error('This component is no longer available. Rescan and try again.')
      }
      let parent = node.parent
      while (parent && parent.type !== 'PAGE') {
        parent = parent.parent
      }
      if (parent?.id !== this.pageId) {
        throw new Error('This component moved to another page. Rescan and try again.')
      }
      this.host.focus(node)
      reply(`Located ${node.name}`, false)
    }
    catch (error) {
      if (current()) {
        reply(error instanceof Error ? error.message : 'Could not locate this component. Rescan and try again.', true)
      }
    }
  }
}

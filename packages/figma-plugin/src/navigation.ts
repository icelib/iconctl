import type { PreflightItem } from './preflight'
import { selectionError } from './visible-selection'

interface NavigationHost {
  currentPage: () => PageNode
  lookup: (id: string) => Promise<BaseNode | null>
  focus: (node: SceneNode) => void
  observeSelection: (callback: () => void) => () => void
  post: (message: Record<string, unknown>) => void
}
interface SelectionRun {
  detach?: () => void
}

function sameSelection(nodes: readonly SceneNode[], ids: Set<string>) {
  const actual = new Set(nodes.map(node => node.id))
  return actual.size === ids.size && [...actual].every(id => ids.has(id))
}

/** Navigation is limited to the latest preflight, even when node lookup is async. */
export class PreflightNavigation {
  private scan = 0
  private request = 0
  private pageId: string | undefined
  private allowed = new Set<string>()
  private disposed = false
  private selection: SelectionRun | undefined

  constructor(private readonly host: NavigationHost) {}

  get scanId() { return this.scan }

  private detach(run = this.selection) {
    if (run && this.selection === run) {
      this.selection = undefined
      run.detach?.()
    }
  }

  private advance() {
    this.request++
    this.detach()
    return this.request
  }

  cancel(scanId: unknown) {
    if (!this.disposed && scanId === this.scan) {
      this.advance()
    }
  }

  capture(pageId: string, items: PreflightItem[]) {
    this.scan++
    this.advance()
    this.pageId = pageId
    this.allowed = new Set(items.filter(item => !item.skipped).map(item => item.id))
  }

  invalidate(text = 'Page changed. Rescan to locate icons on this page.', error = true) {
    this.scan++
    this.advance()
    this.pageId = undefined
    this.allowed.clear()
    if (!this.disposed) {
      this.host.post({ type: 'navigation-invalidated', scanId: this.scan, text, error })
    }
  }

  dispose() {
    this.disposed = true
    this.advance()
    this.allowed.clear()
  }

  async locate(message: { nodeId?: unknown, scanId?: unknown, requestId?: unknown }) {
    const { nodeId, scanId, requestId } = message
    if (this.disposed || typeof nodeId !== 'string' || !Number.isSafeInteger(scanId) || !Number.isSafeInteger(requestId)) {
      return
    }
    const reply = (text: string, error: boolean) => this.host.post({ type: 'navigation-result', nodeId, scanId, requestId, text, error })
    if (scanId !== this.scan || !this.allowed.has(nodeId)) {
      reply('This component is not in the current preflight. Rescan and try again.', true)
      return
    }
    const request = this.advance()
    const current = () => !this.disposed && request === this.request && scanId === this.scan
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
      const component = this.component(node, nodeId)
      this.host.focus(component)
      reply(`Located ${component.name}`, false)
    }
    catch (error) {
      if (current()) {
        reply(error instanceof Error ? error.message : 'Could not locate this component. Rescan and try again.', true)
      }
    }
  }

  private component(node: BaseNode | null, nodeId: string, selected?: Set<string>): ComponentNode {
    if (!node || node.removed || node.type !== 'COMPONENT' || node.id !== nodeId) {
      throw new Error('This component is no longer available. Rescan and try again.')
    }
    let parent = node.parent
    while (parent && parent.type !== 'PAGE') {
      if (selected?.has(parent.id)) {
        throw new Error('Visible components now contain an ancestor and its child. Rescan before selecting.')
      }
      parent = parent.parent
    }
    if (parent?.id !== this.pageId) {
      throw new Error('This component moved to another page. Rescan and try again.')
    }
    return node
  }

  async selectVisible(message: { nodeIds?: unknown, scanId?: unknown, requestId?: unknown }) {
    const { scanId, requestId } = message
    if (this.disposed || !Number.isSafeInteger(scanId) || !Number.isSafeInteger(requestId)) {
      return
    }
    const reply = (text: string, error: boolean) => this.host.post({ type: 'selection-result', scanId, requestId, text, error })
    const reason = selectionError(message.nodeIds)
    if (reason) {
      reply(reason, true)
      return
    }
    // Capture the request array before awaiting any host operation.
    const ids = [...message.nodeIds as string[]]
    if (scanId !== this.scan || ids.some(id => !this.allowed.has(id))) {
      reply('These components are not in the current preflight. Rescan and try again.', true)
      return
    }
    const request = this.advance()
    const current = () => !this.disposed && request === this.request && scanId === this.scan
    const run: SelectionRun = {}
    this.selection = run
    try {
      const page = this.host.currentPage()
      const checkPage = () => {
        if (this.host.currentPage().id !== this.pageId || page.id !== this.pageId) {
          throw new Error('Page changed. Rescan to select components on this page.')
        }
      }
      checkPage()
      const original = new Set(page.selection.map(node => node.id))
      run.detach = this.host.observeSelection(() => {
        if (this.selection === run && current()) {
          this.advance()
          reply('Selection changed. Select this view again.', true)
        }
      })
      const nodes: ComponentNode[] = []
      for (const id of ids) {
        const found = await this.host.lookup(id).catch(() => {
          throw new Error(`Could not read component ${id}. Rescan and try again.`)
        })
        if (!current()) {
          return
        }
        checkPage()
        nodes.push(this.component(found, id))
      }
      // No await from final validation through the single selection assignment.
      checkPage()
      const requested = new Set(ids)
      nodes.forEach((node, index) => this.component(node, ids[index]!, requested))
      if (!sameSelection(page.selection, original)) {
        throw new Error('Selection changed. Select this view again.')
      }
      this.detach(run)
      try {
        page.selection = nodes
        if (!sameSelection(page.selection, requested)) {
          throw new Error('Incomplete native selection')
        }
      }
      catch {
        throw new Error('Figma could not confirm the complete selection. Check the canvas selection before trying again.')
      }
      reply(`Selected ${nodes.length} visible ${nodes.length === 1 ? 'component' : 'components'}. Canvas zoom is unchanged.`, false)
    }
    catch (error) {
      if (current()) {
        reply(error instanceof Error ? error.message : 'Could not select these components. Rescan and try again.', true)
      }
    }
    finally {
      this.detach(run)
    }
  }
}

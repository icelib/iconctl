import type { NamesJson, NodeIdsJson } from './copy-visible-json-format'
import type { PreflightItem } from './preflight'
import { visibleNamesJson, visibleNodeIdsJson } from './copy-visible-json-format'

type CopyMode = 'names' | 'node-ids'
type Payload = { mode: 'names', value: NamesJson } | { mode: 'node-ids', value: NodeIdsJson }

interface Host {
  current: () => { active: boolean, current: boolean, scanId: number | undefined, items: PreflightItem[], serverNaming: boolean }
  clipboard: () => Pick<Clipboard, 'writeText'> | undefined
  content: HTMLSelectElement
  button: HTMLButtonElement
  scope: HTMLElement
  summary: HTMLElement
  help: HTMLElement
  warning: HTMLElement
  status: HTMLElement
  fallback: HTMLElement
  text: HTMLTextAreaElement
  textLabel: HTMLElement
  select: HTMLButtonElement
}
interface Pending {
  generation: number
  scanId: number
  mode: CopyMode
  payload: Payload | undefined
}
type Prepared = { payload: Payload, reason?: never } | { reason: string, payload?: never }

/** One physical write at a time, with independent ownership of current-view feedback. */
export class CopyVisibleJsonUI {
  private host: Host | undefined
  private generation = 0
  private pending: Pending | undefined
  private checked: { scanId: number, mode: CopyMode, result: Prepared } | undefined
  private manual: Pick<Pending, 'generation' | 'scanId' | 'mode'> | undefined
  private readonly onCopy = () => this.copy()
  private readonly onSelect = () => this.select()
  private readonly onContentChange = () => this.change()

  constructor(host: Host) {
    this.host = host
    host.button.addEventListener('click', this.onCopy)
    host.select.addEventListener('click', this.onSelect)
    host.content.addEventListener('change', this.onContentChange)
    this.update()
  }

  private mode(): CopyMode {
    return this.host?.content.value === 'node-ids' ? 'node-ids' : 'names'
  }

  private prepare(): Prepared {
    const current = this.host?.current()
    const mode = this.mode()
    if (!current?.active || !current.current || current.scanId === undefined) {
      return { reason: `Rescan with current rules before copying ${mode === 'names' ? 'local names' : 'node IDs'}.` }
    }
    if (this.checked?.scanId !== current.scanId || this.checked.mode !== mode) {
      let result: Prepared
      try {
        result = { payload: mode === 'names'
          ? { mode, value: visibleNamesJson(current.items) }
          : { mode, value: visibleNodeIdsJson(current.items) } }
      }
      catch (error) {
        result = { reason: error instanceof Error ? error.message : 'Could not prepare the visible JSON.' }
      }
      this.checked = { scanId: current.scanId, mode, result }
    }
    return this.checked.result
  }

  update() {
    const host = this.host
    if (!host) {
      return
    }
    const result = this.prepare()
    const names = this.mode() === 'names'
    host.button.textContent = names ? 'Copy visible names JSON' : 'Copy visible node IDs JSON'
    host.scope.textContent = names
      ? 'Local preflight names · Current filtered view · Not a sync result'
      : 'Figma node IDs · Current filtered view · Use in the same file’s Figma source ids'
    host.status.ariaLabel = names ? 'Names copy status' : 'Node IDs copy status'
    host.textLabel.textContent = names ? 'Visible local names JSON' : 'Visible Figma node IDs JSON'
    host.button.disabled = Boolean(this.pending || result.reason)
    host.help.textContent = result.reason ?? ''
    const payload = result.payload
    host.summary.textContent = !payload
      ? ''
      : payload.mode === 'names'
        ? `${payload.value.componentCount} visible components → ${payload.value.uniqueCount} unique local names.${payload.value.duplicateCount ? ` ${payload.value.duplicateCount} duplicate name ${payload.value.duplicateCount === 1 ? 'entry' : 'entries'} merged.` : ''}`
        : `${payload.value.componentCount} visible ${payload.value.componentCount === 1 ? 'component' : 'components'} → ${payload.value.componentCount} Figma node ${payload.value.componentCount === 1 ? 'ID' : 'IDs'}.`
    host.warning.hidden = !names || !host.current().serverNaming
  }

  private clearFeedback() {
    this.manual = undefined
    const host = this.host
    if (host) {
      host.status.textContent = ''
      host.status.className = ''
      host.fallback.hidden = true
      host.text.value = ''
      host.select.disabled = true
    }
  }

  /** Content/view changes invalidate feedback without unlocking a native write. */
  change() {
    this.generation++
    this.checked = undefined
    if (this.pending) {
      this.pending.payload = undefined
    }
    this.clearFeedback()
    this.update()
  }

  private owns(pending: Pick<Pending, 'generation' | 'scanId' | 'mode'>) {
    const current = this.host?.current()
    return current?.active && current.current && current.scanId === pending.scanId && this.generation === pending.generation && this.mode() === pending.mode
  }

  private copy() {
    const host = this.host
    if (!host || this.pending) {
      return
    }
    const result = this.prepare()
    if (!result.payload) {
      this.update()
      return
    }
    this.clearFeedback()
    const pending: Pending = { generation: this.generation, scanId: host.current().scanId!, mode: result.payload.mode, payload: result.payload }
    this.pending = pending
    host.status.textContent = pending.mode === 'names' ? 'Copying captured local names…' : 'Copying captured node IDs…'
    this.update()
    try {
      // Stay in the explicit click's call stack to preserve browser user activation.
      const clipboard = host.clipboard()
      if (!clipboard) {
        this.settle(pending, false)
        return
      }
      void clipboard.writeText(result.payload.value.json).then(
        () => this.settle(pending, true),
        () => this.settle(pending, false),
      )
    }
    catch {
      this.settle(pending, false)
    }
  }

  private settle(pending: Pending, success: boolean) {
    if (this.pending !== pending) {
      return
    }
    this.pending = undefined
    const host = this.host
    const payload = pending.payload
    pending.payload = undefined
    if (!host) {
      return
    }
    if (payload && this.owns(pending)) {
      if (success) {
        host.status.textContent = payload.mode === 'names'
          ? `Copied ${payload.value.uniqueCount} unique local names from ${payload.value.componentCount} visible components.`
          : `Copied ${payload.value.componentCount} Figma node ${payload.value.componentCount === 1 ? 'ID' : 'IDs'} from the current filtered view.`
        host.status.className = 'ok'
      }
      else {
        host.status.textContent = 'Automatic copy is unavailable. Select the JSON and copy it manually.'
        host.status.className = 'err'
        host.text.value = payload.value.json
        host.fallback.hidden = false
        host.select.disabled = false
        this.manual = { generation: pending.generation, scanId: pending.scanId, mode: pending.mode }
      }
    }
    // Stale completion only unlocks: never add feedback or restore an old fallback.
    this.update()
  }

  private select() {
    const host = this.host
    if (host && this.manual && this.owns(this.manual)) {
      host.text.focus()
      host.text.select()
    }
  }

  dispose() {
    this.generation++
    this.checked = undefined
    if (this.pending) {
      this.pending.payload = undefined
    }
    this.clearFeedback()
    this.host?.button.removeEventListener('click', this.onCopy)
    this.host?.select.removeEventListener('click', this.onSelect)
    this.host?.content.removeEventListener('change', this.onContentChange)
    this.host = undefined
  }
}

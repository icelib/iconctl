import type { NamesJson } from './copy-names-format'
import type { PreflightItem } from './preflight'
import { visibleNamesJson } from './copy-names-format'

interface Host {
  current: () => { active: boolean, current: boolean, scanId: number | undefined, items: PreflightItem[], serverNaming: boolean }
  clipboard: () => Pick<Clipboard, 'writeText'> | undefined
  button: HTMLButtonElement
  summary: HTMLElement
  help: HTMLElement
  warning: HTMLElement
  status: HTMLElement
  fallback: HTMLElement
  text: HTMLTextAreaElement
  select: HTMLButtonElement
}
interface Pending {
  generation: number
  scanId: number
  payload: NamesJson | undefined
}
type Prepared = { payload: NamesJson, reason?: never } | { reason: string, payload?: never }

/** One physical write at a time, with independent ownership of current-view feedback. */
export class CopyNamesUI {
  private host: Host | undefined
  private generation = 0
  private pending: Pending | undefined
  private checked: { scanId: number, result: Prepared } | undefined
  private manual: { generation: number, scanId: number } | undefined
  private readonly onCopy = () => this.copy()
  private readonly onSelect = () => this.select()

  constructor(host: Host) {
    this.host = host
    host.button.addEventListener('click', this.onCopy)
    host.select.addEventListener('click', this.onSelect)
    this.update()
  }

  private prepare(): Prepared {
    const current = this.host?.current()
    if (!current?.active || !current.current || current.scanId === undefined) {
      return { reason: 'Rescan with current rules before copying local names.' }
    }
    if (this.checked?.scanId !== current.scanId) {
      let result: Prepared
      try {
        result = { payload: visibleNamesJson(current.items) }
      }
      catch (error) {
        result = { reason: error instanceof Error ? error.message : 'Could not prepare the local names JSON.' }
      }
      this.checked = { scanId: current.scanId, result }
    }
    return this.checked.result
  }

  update() {
    const host = this.host
    if (!host) {
      return
    }
    const result = this.prepare()
    host.button.disabled = Boolean(this.pending || result.reason)
    host.help.textContent = result.reason ?? ''
    const payload = result.payload
    host.summary.textContent = payload
      ? `${payload.componentCount} visible components → ${payload.uniqueCount} unique local names.${payload.duplicateCount ? ` ${payload.duplicateCount} duplicate name ${payload.duplicateCount === 1 ? 'entry' : 'entries'} merged.` : ''}`
      : ''
    host.warning.hidden = !host.current().serverNaming
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

  /** Filter changes, accepted scans and invalidation never unlock a native write. */
  change() {
    this.generation++
    this.checked = undefined
    if (this.pending) {
      this.pending.payload = undefined
    }
    this.clearFeedback()
    this.update()
  }

  private owns(pending: Pick<Pending, 'generation' | 'scanId'>) {
    const current = this.host?.current()
    return current?.active && current.current && current.scanId === pending.scanId && this.generation === pending.generation
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
    const pending: Pending = { generation: this.generation, scanId: host.current().scanId!, payload: result.payload }
    this.pending = pending
    host.status.textContent = 'Copying captured local names…'
    this.update()
    try {
      // Stay in the explicit click's call stack to preserve browser user activation.
      const clipboard = host.clipboard()
      if (!clipboard) {
        this.settle(pending, false)
        return
      }
      void clipboard.writeText(result.payload.json).then(
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
        host.status.textContent = `Copied ${payload.uniqueCount} unique local names from ${payload.componentCount} visible components.`
        host.status.className = 'ok'
      }
      else {
        host.status.textContent = 'Automatic copy is unavailable. Select the JSON and copy it manually.'
        host.status.className = 'err'
        host.text.value = payload.json
        host.fallback.hidden = false
        host.select.disabled = false
        this.manual = { generation: pending.generation, scanId: pending.scanId }
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
    this.host = undefined
  }
}

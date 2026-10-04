import type { PreflightItem } from './preflight'
import type { AppliedRules } from './report'
import type { HandoffFile } from './svg-handoff-format'
import { handoffItems } from './svg-handoff-format'
import { createHandoffZip } from './svg-handoff-zip'

interface Host {
  current: () => { active: boolean, current: boolean, scanId: number | undefined, items: PreflightItem[], rules: AppliedRules | undefined }
  send: (message: Record<string, unknown>) => void
  button: HTMLButtonElement
  cancel: HTMLButtonElement
  help: HTMLElement
  status: HTMLElement
}
interface Message {
  type: string
  requestId?: number
  scanId?: number
  state?: string
  text?: string
  busy?: boolean
  nodeId?: string
  files?: HandoffFile[]
}
interface Pending {
  requestId: number
  scanId?: number
  phase: 'exporting' | 'requesting-files' | 'consumed'
  accept: boolean
}

/** UI ownership continues through ZIP creation and the download acknowledgement. */
export class SvgHandoffUI {
  private request = 0
  private pending: Pending | undefined
  private urls = new Map<string, number | undefined>()
  private disposed = false
  private checked: { scanId: number, items: PreflightItem[], rules: AppliedRules, reason: string | undefined } | undefined

  constructor(private readonly host: Host) {
    host.button.addEventListener('click', () => this.start())
    host.cancel.addEventListener('click', () => this.cancel())
    this.update()
  }

  private eligibility() {
    const current = this.host.current()
    if (!current.active || this.disposed || !current.current || current.scanId === undefined || !current.rules) {
      return 'Rescan the page with current rules before exporting SVGs.'
    }
    if (this.checked?.scanId !== current.scanId || this.checked.items !== current.items || this.checked.rules !== current.rules) {
      let reason: string | undefined
      try {
        handoffItems(current.items, current.rules.rules.namingMode === 'server')
      }
      catch (error) {
        reason = error instanceof Error ? error.message : 'This scan cannot be exported as SVGs.'
      }
      this.checked = { scanId: current.scanId, items: current.items, rules: current.rules, reason }
    }
    return this.checked.reason
  }

  update() {
    const reason = this.eligibility()
    this.host.button.disabled = Boolean(reason || this.pending)
    this.host.cancel.disabled = !this.pending?.accept || this.disposed
    this.host.help.textContent = reason ?? 'Complete current page · Raw Figma SVGs · No automatic sync'
  }

  private status(text: string, error = false) {
    if (!this.disposed) {
      this.host.status.textContent = text
      this.host.status.className = error ? 'err' : ''
    }
  }

  private start() {
    if (this.pending || this.eligibility()) {
      return
    }
    this.pending = { requestId: ++this.request, accept: true, phase: 'exporting' }
    this.status('Checking the complete page before SVG export…')
    this.update()
    this.host.send({ type: 'export-svg-handoff', requestId: this.request })
  }

  cancel(text = 'SVG export cancelled.') {
    const pending = this.pending
    if (!pending || !pending.accept) {
      return
    }
    pending.accept = false
    this.status(`${text} Waiting for the current Figma operation to finish…`)
    this.host.send({ type: 'cancel-svg-handoff', requestId: pending.requestId })
    this.update()
  }

  receive(message: Message) {
    const pending = this.pending
    if (this.disposed || !pending || pending.requestId !== message.requestId || !this.host.current().active) {
      return
    }
    if (message.type === 'svg-handoff-status') {
      if (message.state === 'cancelling' || message.state === 'cancelled' || message.state === 'error') {
        pending.accept = false
      }
      this.status(`${message.text ?? ''}${message.nodeId ? ` (Node ${message.nodeId})` : ''}`, message.state === 'error')
      if (message.busy === false) {
        this.pending = undefined
      }
      else if (message.state === 'ready' && pending.accept && pending.phase === 'exporting') {
        if (!Number.isSafeInteger(message.scanId) || message.scanId !== this.host.current().scanId || !this.host.current().current) {
          this.cancel('The SVG scan is no longer current.')
        }
        else {
          pending.scanId = message.scanId!
          pending.phase = 'requesting-files'
          this.host.send({ type: 'download-svg-handoff', requestId: pending.requestId, scanId: pending.scanId })
        }
      }
      this.update()
      return
    }
    if (message.type !== 'svg-handoff-files' || !pending.accept || pending.phase !== 'requesting-files'
      || message.scanId !== pending.scanId) {
      return
    }
    // Consume before invoking browser APIs: a duplicate message cannot download twice.
    pending.phase = 'consumed'
    let url: string | undefined
    let anchor: HTMLAnchorElement | undefined
    try {
      if (this.host.current().scanId !== pending.scanId || !this.host.current().current) {
        throw new Error('The SVG scan is no longer current. Export again.')
      }
      if (!Array.isArray(message.files)) {
        throw new TypeError('The SVG handoff is incomplete. Export again.')
      }
      for (const file of message.files) {
        const xml = new DOMParser().parseFromString(file.svg, 'image/svg+xml')
        if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg'
          || (xml.documentElement.namespaceURI && xml.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg')) {
          throw new Error(`Invalid SVG in ${file.path}. Export again.`)
        }
      }
      const bytes = createHandoffZip(message.files)
      url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
      this.urls.set(url, undefined)
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `iconctl-svg-${pending.scanId}.zip`
      anchor.hidden = true
      document.body.appendChild(anchor)
      anchor.click()
      this.status(`Download started for ${message.files.length} raw SVGs. Extract raw-svg/ and run iconctl sync or watch.`)
      const owned = url
      this.urls.set(owned, window.setTimeout(() => this.release(owned), 0))
      url = undefined
    }
    catch (error) {
      this.status(error instanceof Error ? error.message : 'Could not download the SVG ZIP. Try exporting again.', true)
    }
    finally {
      try {
        anchor?.remove()
      }
      catch {
        this.status('Could not remove the temporary download link. Reopen the plugin to clean up.', true)
      }
      if (url) {
        this.release(url)
      }
      // Both successful and failed browser work release the host's edit listener.
      this.host.send({ type: 'finish-svg-handoff', requestId: pending.requestId, scanId: pending.scanId })
      if (this.pending === pending) {
        this.pending = undefined
      }
      this.update()
    }
  }

  private release(url: string) {
    try {
      const timer = this.urls.get(url)
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
      if (this.urls.has(url)) {
        URL.revokeObjectURL(url)
        this.urls.delete(url)
      }
    }
    catch {
      this.status('Could not release the temporary download URL. Reopen the plugin to clean up.', true)
    }
  }

  dispose() {
    this.cancel()
    this.disposed = true
    this.pending = undefined
    this.checked = undefined
    for (const url of [...this.urls.keys()]) {
      this.release(url)
    }
    this.update()
  }
}

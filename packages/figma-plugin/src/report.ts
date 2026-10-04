import type { PreflightItem, PreflightRules } from './preflight'
import { captureDiagnostics } from './diagnostics'
import { DEFAULT_NAME_PATTERN, DEFAULT_SIZE, DEFAULT_SKIP_PREFIX } from './naming'
import { canSubmit } from './preflight'
import { renderPreflightHtml } from './report-html'

export interface ScanMetadata {
  mode: 'console' | 'github'
  rulesSource: 'project' | 'legacy-defaults' | 'unpaired-defaults'
  rules?: PreflightRules
  project?: { name: string, revision: number }
}

/** A public, credential-free projection shared by the overview and report. */
export function appliedRules(metadata: ScanMetadata) {
  const rules = metadata.rules ?? { width: DEFAULT_SIZE, height: DEFAULT_SIZE }
  return {
    mode: metadata.mode,
    rulesSource: metadata.rulesSource,
    ...(metadata.project ? { project: { name: metadata.project.name, revision: metadata.project.revision } } : {}),
    rules: {
      ...(rules.width !== undefined ? { width: rules.width } : {}),
      ...(rules.height !== undefined ? { height: rules.height } : {}),
      name: rules.name ?? DEFAULT_NAME_PATTERN.source,
      skipPrefix: [...(rules.skipPrefix ?? DEFAULT_SKIP_PREFIX)],
      namingMode: rules.namingMode ?? 'default',
    },
    serverValidationRequired: true,
  }
}
export type AppliedRules = ReturnType<typeof appliedRules>

export interface PreflightDocument extends AppliedRules {
  schemaVersion: 1
  generatedAt: string
  scanId: number
  scope: 'current-page'
  page: { id: string, name: string }
  summary: {
    total: number
    checked: number
    skipped: number
    withIssues: number
    issueCount: number
    canSubmit: boolean
  }
  items: PreflightItem[]
}

interface ReportHost {
  currentPage: () => { id: string }
  post: (message: Record<string, unknown>) => void
}

/** Own the complete, immutable scan rather than the UI's filtered view. */
export class PreflightReport {
  private snapshot: { scanId: number, pageId: string, projectRules: boolean, serverNamingPending: boolean, json: string } | undefined
  private disposed = false

  constructor(private readonly host: ReportHost) {}

  capture(scanId: number, page: { id: string, name: string }, items: PreflightItem[], metadata: ScanMetadata) {
    if (this.disposed) {
      return
    }
    const overview = appliedRules(metadata)
    const captured = items.map((item) => {
      const diagnostics = captureDiagnostics(item.issues, item.diagnostics)
      return {
        id: item.id,
        name: item.name,
        iconName: item.iconName,
        skipped: item.skipped,
        width: item.width,
        height: item.height,
        issues: [...item.issues],
        ...(diagnostics ? { diagnostics } : {}),
      }
    })
    // Construct the report explicitly. Device credentials, tasks and arbitrary
    // context/settings fields must never enter the serialized snapshot.
    const report: PreflightDocument = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scanId,
      scope: 'current-page',
      page: { id: page.id, name: page.name },
      ...overview,
      summary: {
        total: captured.length,
        checked: captured.filter(item => !item.skipped).length,
        skipped: captured.filter(item => item.skipped).length,
        withIssues: captured.filter(item => item.issues.length > 0).length,
        issueCount: captured.reduce((count, item) => count + item.issues.length, 0),
        canSubmit: canSubmit(captured),
      },
      items: captured,
    }
    this.snapshot = { scanId, pageId: page.id, projectRules: metadata.rulesSource === 'project', serverNamingPending: overview.rules.namingMode === 'server', json: JSON.stringify(report, null, 2) }
  }

  invalidate() { this.snapshot = undefined }

  invalidateProject() {
    if (!this.snapshot?.projectRules) {
      return false
    }
    this.invalidate()
    return true
  }

  dispose() {
    this.disposed = true
    this.invalidate()
  }

  send(message: { scanId?: unknown, requestId?: unknown, format?: unknown }) {
    const { scanId, requestId } = message
    if (this.disposed || !Number.isSafeInteger(scanId) || !Number.isSafeInteger(requestId)
      || (message.format !== undefined && message.format !== 'json' && message.format !== 'html')) {
      return
    }
    const snapshot = this.snapshot
    let current = false
    try {
      current = Boolean(snapshot && scanId === snapshot.scanId && this.host.currentPage().id === snapshot.pageId)
    }
    catch {
      // Reading a removed or unavailable page also requires a new scan.
    }
    if (!snapshot || !current) {
      this.host.post({ type: 'preflight-report', scanId, requestId, ...(message.format === 'html' ? { format: 'html' } : {}), error: true, rescan: true, text: 'This scan is no longer available. Rescan the page before exporting.' })
      return
    }
    // Both formats come from the same serialized capture, never the current
    // page, context or filtered UI. The JSON response remains backward compatible.
    const content = message.format === 'html'
      ? { format: 'html', html: renderPreflightHtml(JSON.parse(snapshot.json) as PreflightDocument) }
      : { json: snapshot.json }
    this.host.post({ type: 'preflight-report', scanId, requestId, ...content, serverNamingPending: snapshot.serverNamingPending })
  }
}

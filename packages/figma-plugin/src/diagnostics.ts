/** Optional metadata; issues remains the authority for preflight eligibility. */
export interface PreflightDiagnostic {
  code: string
  message: string
}

/** Validate correspondence, then project only the public diagnostic fields. */
export function captureDiagnostics(issues: string[], value: unknown): PreflightDiagnostic[] | undefined {
  if (!Array.isArray(value) || value.length !== issues.length) {
    return undefined
  }
  const captured: PreflightDiagnostic[] = []
  for (let index = 0; index < issues.length; index++) {
    const entry: unknown = value[index]
    if (!entry || typeof entry !== 'object'
      || !('code' in entry) || typeof entry.code !== 'string' || !entry.code.trim()
      || !('message' in entry) || typeof entry.message !== 'string' || entry.message !== issues[index]) {
      return undefined
    }
    captured.push({ code: entry.code, message: entry.message })
  }
  return captured
}

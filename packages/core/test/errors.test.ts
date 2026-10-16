import type { SyncIssue } from '../src/errors'
import { formatSyncIssues, IconctlAbortError, IconctlError, IconctlSyncError, serializeIconctlError } from '../src/errors'

it('preserves the existing formatting for issues without collision groups', () => {
  const issues: SyncIssue[] = [
    { name: 'arrow', nodeId: '1:2', stage: 'download', message: 'SVG download failed' },
    { name: 'bell', stage: 'process', message: 'Invalid SVG' },
  ]
  const expected = '- arrow (1:2) [download]: SVG download failed\n- bell [process]: Invalid SVG'
  expect(formatSyncIssues(issues)).toBe(expected)
  expect(new IconctlSyncError(issues).message).toBe(`Icon sync failed:\n${expected}`)
  expect(formatSyncIssues([])).toBe('')
})

it('groups name collisions once and includes actionable details for every node', () => {
  const message = 'Duplicate icon name "bell" is shared by 2 Figma nodes.'
  const issues: SyncIssue[] = [{
    name: 'bell',
    stage: 'import',
    message,
    collisionGroup: 'bell',
    sourceIndex: 0,
    fileKey: 'design',
    nodeId: '34:1698',
    originalName: ' Bell ',
    normalizedName: 'bell',
    parentPath: ['Icons', 'Notifications'],
    proposedName: 'bell',
    figmaUrl: 'https://www.figma.com/design/design?node-id=34-1698',
  }, {
    name: 'arrow',
    stage: 'download',
    message: 'SVG download failed',
  }, {
    name: 'bell',
    stage: 'import',
    message,
    collisionGroup: 'bell',
    sourceIndex: 0,
    fileKey: 'design',
    nodeId: '5398:44',
    originalName: 'bell',
    normalizedName: 'bell',
    parentPath: ['Icons', 'Legacy'],
    proposedName: 'bell-5398-44',
    figmaUrl: 'https://www.figma.com/design/design?node-id=5398-44',
  }]
  const formatted = formatSyncIssues(issues)
  expect(formatted.split(message)).toHaveLength(2)
  expect(formatted).toBe([
    `- bell [import] (source 0, file design): ${message}`,
    '  - name: " Bell "; node: 34:1698; path: "Icons" > "Notifications"; normalized: "bell"; proposed: "bell"; URL: https://www.figma.com/design/design?node-id=34-1698',
    '  - name: "bell"; node: 5398:44; path: "Icons" > "Legacy"; normalized: "bell"; proposed: "bell-5398-44"; URL: https://www.figma.com/design/design?node-id=5398-44',
    '- arrow [download]: SVG download failed',
  ].join('\n'))
  expect(new IconctlSyncError(issues).message).toBe(`Icon sync failed:\n${formatted}`)
})

it('keeps collision groups from separate sources and files distinct without losing node messages', () => {
  const issue: SyncIssue = { name: 'bell', stage: 'import', message: 'Collision', collisionGroup: 'bell', sourceIndex: 0, fileKey: 'design' }
  const formatted = formatSyncIssues([
    issue,
    { ...issue, name: 'bell-alias', originalName: 'Bell', nodeId: '2:3', message: 'Assigned a stable name' },
    { ...issue, sourceIndex: 1 },
    { ...issue, fileKey: 'another-design' },
  ])
  expect(formatted.match(/^- bell \[import\]/gm)).toHaveLength(3)
  expect(formatted).toContain('name: "Bell"; node: 2:3; icon: "bell-alias"; Assigned a stable name')
  expect(formatted).toContain('(source 1, file design)')
  expect(formatted).toContain('(source 0, file another-design)')
})

it('keeps ErrorOptions compatibility and exposes optional diagnostic metadata', () => {
  const cause = new TypeError('connection reset')
  const error = new IconctlError('Figma failed', {
    cause,
    code: 'FIGMA_HTTP_ERROR',
    httpStatus: 429,
    retryable: true,
    retryAfterMs: 30000,
    sourceType: 'figma',
    sourceIndex: 1,
    operation: 'document',
  })
  expect(error).toMatchObject({ name: 'IconctlError', cause, code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 30000, sourceType: 'figma', sourceIndex: 1, operation: 'document' })
  expect(serializeIconctlError(error)).toEqual({ name: 'IconctlError', message: 'Figma failed', code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 30000, sourceType: 'figma', sourceIndex: 1, operation: 'document', cause: { name: 'TypeError', message: 'connection reset' } })
  expect(new IconctlError('legacy', { cause }).cause).toBe(cause)
  expect(new IconctlAbortError(cause)).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause })
  const enriched = new IconctlSyncError([], 'Source failed')
  enriched.sourceType ??= 'figma'
  enriched.sourceIndex ??= 2
  expect(enriched).toMatchObject({ name: 'IconctlSyncError', sourceType: 'figma', sourceIndex: 2 })
})

it('serializes only safe diagnostic fields in messages, causes, issues and aggregate errors', () => {
  const secret = 'private / value'
  const error = new IconctlSyncError([{
    name: 'arrow',
    message: 'SVG failed, access_token="issue-access-token"',
    stage: 'download',
    sourceType: 'figma',
    sourceIndex: 0,
    fileKey: 'design-file',
    nodeId: '1:2',
    code: 'FIGMA_HTTP_ERROR',
    httpStatus: 429,
    retryable: true,
    retryAfterMs: 2000,
    operation: 'figma-svg',
    request: { headers: { authorization: 'never-copy-request' } },
  } as never], 'Failed', {
    code: 'ICON_SYNC_FAILED',
    sourceType: 'figma',
    cause: new AggregateError([
      new Error(`Connection failed: ${secret}; ${encodeURIComponent(secret)}`),
      new Error('https://url-user:url-password@api.example/v1/files?token=query-secret&signature=signed-secret&code=oauth-code&sig=azure-signature#code=fragment-oauth-code\nBearer dynamic-access-token\nBasic dXNlcjpwYXNz\nfigd_figma-pat\n{"refreshToken":"refresh-secret","client_secret":"client-secret"}'),
    ], 'Recovery failed'),
  })
  Object.assign(error, { headers: { authorization: 'never-copy-header' }, response: { data: 'never-copy-response' }, stack: 'never-copy-stack' })
  const safe = serializeIconctlError(error, { secrets: [secret] })
  const json = JSON.stringify(safe)
  for (const hidden of [secret, encodeURIComponent(secret), 'issue-access-token', 'url-user', 'url-password', 'query-secret', 'signed-secret', 'oauth-code', 'azure-signature', 'fragment-oauth-code', 'dynamic-access-token', 'dXNlcjpwYXNz', 'figd_figma-pat', 'refresh-secret', 'client-secret', 'never-copy-request', 'never-copy-header', 'never-copy-response', 'never-copy-stack']) {
    expect(json).not.toContain(hidden)
  }
  expect(safe).toMatchObject({ code: 'ICON_SYNC_FAILED', issues: [{ name: 'arrow', stage: 'download', sourceType: 'figma', sourceIndex: 0, fileKey: 'design-file', nodeId: '1:2', code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 2000, operation: 'figma-svg' }], cause: { name: 'AggregateError', message: 'Recovery failed', errors: [{ name: 'Error', message: expect.stringContaining('Connection failed') }, { message: expect.stringContaining('api.example/v1/files') }] } })
  expect(safe.issues?.[0]).not.toHaveProperty('request')
})

it('removes local filesystem paths from public diagnostics while retaining HTTP URLs', () => {
  const paths = ['/Users/person/private credentials.json', '/tmp/private/icons.ts', '/home/service/icons.svg', 'C:\\Users\\person\\credentials.json', '\\\\server\\private\\credentials.json']
  const error = new IconctlError(`ENOENT open '${paths[0]}'\nCannot import '${paths[1]}'\nRead ${paths[2]}\nOpen "${paths[3]}"\nRead ${paths[4]}\nFetch https://api.figma.com/v1/files/design-file`, {
    cause: new Error('Cannot import file:///private/credentials.json'),
  })
  const safe = serializeIconctlError(error)
  const json = JSON.stringify(safe)
  for (const path of paths) {
    expect(json).not.toContain(path)
    expect(safe.message).not.toContain(path)
  }
  expect(safe.cause?.message).toBe('Cannot import [path]')
  expect(safe.message).toContain('https://api.figma.com/v1/files/design-file')
  expect(safe.message).toContain('ENOENT open')
})

it('serializes collision details and redacts sensitive values in every new string field', () => {
  const secret = 'private-design-name'
  const safe = serializeIconctlError({
    message: 'Name collision',
    issues: [{
      name: 'bell',
      message: 'Assigned a stable name',
      stage: 'import',
      severity: 'warning',
      originalName: `Bell ${secret}`,
      normalizedName: `bell-${secret}`,
      parentPath: ['Icons', secret, 'figd_private-token'],
      proposedName: `bell-${secret}-1-2`,
      figmaUrl: `https://www.figma.com/design/file?node-id=1-2&token=${secret}`,
      collisionGroup: `group-${secret}`,
    }, {
      name: 'other',
      message: 'Error',
      stage: 'import',
      severity: 'error',
    }, {
      name: 'invalid',
      message: 'Error',
      stage: 'import',
      severity: 'fatal',
    }],
  }, { secrets: [secret] })
  expect(JSON.stringify(safe)).not.toContain(secret)
  expect(safe.issues?.[0]).toEqual({
    name: 'bell',
    message: 'Assigned a stable name',
    stage: 'import',
    severity: 'warning',
    originalName: 'Bell [redacted]',
    normalizedName: 'bell-[redacted]',
    parentPath: ['Icons', '[redacted]', '[redacted]'],
    proposedName: 'bell-[redacted]-1-2',
    figmaUrl: 'https://www.figma.com/design/file?node-id=1-2&token=[redacted]',
    collisionGroup: 'group-[redacted]',
  })
  expect(safe.issues?.[1]?.severity).toBe('error')
  expect(safe.issues?.[2]).not.toHaveProperty('severity')
})

it('bounds collision paths and shares the existing diagnostic character budget', () => {
  const safe = serializeIconctlError({
    message: 'Name collision',
    issues: Array.from({ length: 5 }, () => ({
      name: 'bell',
      message: 'Collision',
      stage: 'import',
      parentPath: Array.from({ length: 100 }, () => 'x'.repeat(1000)),
      figmaUrl: `https://www.figma.com/design/${'x'.repeat(5000)}`,
    })),
  })
  expect(safe.issues?.[0]?.parentPath).toHaveLength(20)
  expect(safe.issues?.[0]?.parentPath?.every(segment => segment.length <= 256)).toBe(true)
  expect(safe.issues?.[0]?.figmaUrl?.length).toBeLessThanOrEqual(2000)
  expect(safe.truncated).toBe(true)
  expect(JSON.stringify(safe).length).toBeLessThan(18000)
})

it('does not invoke getters in collision metadata or parent path array entries', () => {
  const getter = vi.fn(() => {
    throw new Error('do not invoke')
  })
  const fields = ['severity', 'originalName', 'normalizedName', 'proposedName', 'figmaUrl', 'collisionGroup']
  const parentPath = ['Icons', 'unsafe']
  Object.defineProperty(parentPath, '1', { get: getter })
  const issue = Object.defineProperties({ name: 'bell', message: 'Collision', stage: 'import', parentPath }, Object.fromEntries(fields.map(field => [field, { get: getter }])))
  const safe = serializeIconctlError({ message: 'Name collision', issues: [issue] })
  expect(safe.issues?.[0]).toEqual({ name: 'bell', message: 'Collision', stage: 'import', parentPath: ['Icons'] })
  expect(getter).not.toHaveBeenCalled()
  Object.defineProperty(issue, 'parentPath', { get: getter })
  expect(serializeIconctlError({ message: 'Name collision', issues: [issue] }).issues?.[0]).not.toHaveProperty('parentPath')
  expect(getter).not.toHaveBeenCalled()
})

it('bounds long and deeply nested diagnostics and reports truncation', () => {
  let error = new IconctlError('deep')
  for (let index = 0; index < 20; index++) {
    error = new IconctlError(`depth ${index}`, { cause: error })
  }
  expect(JSON.stringify(serializeIconctlError(error))).toContain('Error details truncated')
  const issues = Array.from({ length: 100 }, (_, index) => ({ name: `icon-${index}`, message: 'x'.repeat(10000), stage: 'process' as const }))
  const safe = serializeIconctlError(new IconctlSyncError(issues))
  expect(safe.message.length).toBeLessThanOrEqual(4000)
  expect(safe.issues).toHaveLength(50)
  expect(safe.truncated).toBe(true)
  expect(JSON.stringify(safe).length).toBeLessThan(22000)
  const aggregated = serializeIconctlError(new AggregateError(Array.from({ length: 20 }, () => new Error('nested')), 'many failures'))
  expect(aggregated.errors).toHaveLength(10)
  expect(aggregated.truncated).toBe(true)
})

it('handles cycles, unknown thrown values and hostile properties without invoking getters', () => {
  const cyclic = new IconctlError('cyclic')
  cyclic.cause = cyclic
  expect(serializeIconctlError(cyclic).cause).toEqual({ name: 'Error', message: '[Circular error cause]', truncated: true })
  expect(serializeIconctlError('plain failure')).toEqual({ name: 'Error', message: 'plain failure' })
  expect(serializeIconctlError(undefined)).toEqual({ name: 'Error', message: 'Unknown error' })
  const getter = vi.fn(() => {
    throw new Error('do not invoke')
  })
  const hostile = Object.defineProperties({}, { message: { get: getter }, cause: { get: getter }, stack: { get: getter } })
  expect(() => serializeIconctlError(hostile)).not.toThrow()
  expect(getter).not.toHaveBeenCalled()
  const proxy = Proxy.revocable([], {})
  proxy.revoke()
  expect(() => serializeIconctlError({ message: 'safe root', issues: proxy.proxy })).not.toThrow()
  expect(serializeIconctlError(new Error('\u001B[31mred error\u001B[39m\n    at privateStackFrame (file.js:1:1)')).message).toBe('red error')
})

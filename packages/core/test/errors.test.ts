import { IconctlAbortError, IconctlError, IconctlSyncError, serializeIconctlError } from '../src/errors'

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

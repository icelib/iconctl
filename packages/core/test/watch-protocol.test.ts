import { resolveConfig } from '../src/config'
import { IconctlAbortError, IconctlError, IconctlSyncError, serializeIconctlError } from '../src/errors'
import { watchInputDescriptor } from '../src/watch-paths'
import { packWatchFailure, unpackWatchFailure } from '../src/watch-protocol'

function transferred(error: unknown) {
  return unpackWatchFailure(structuredClone(packWatchFailure(error)))
}

it('retains public error classes, sync issues and exactly one formatted message across cloning', () => {
  const issues = [{ name: 'invalid', message: 'wrong width', stage: 'validation' as const }]
  const syncError = new IconctlSyncError(issues, 'Validation failed')
  const result = transferred(syncError)
  expect(result).toBeInstanceOf(IconctlSyncError)
  expect(result).toMatchObject({ name: syncError.name, message: syncError.message, issues, stack: syncError.stack })
  expect(transferred(new IconctlError('config failed'))).toBeInstanceOf(IconctlError)
  const aborted = transferred(new IconctlAbortError(new TypeError('cancel reason')))
  expect(aborted).toBeInstanceOf(IconctlAbortError)
  expect(aborted).toMatchObject({ code: 'ABORT_ERR', cause: expect.any(TypeError) })
})

it('retains native syntax errors and filesystem error codes, and handles arbitrary thrown values', () => {
  expect(transferred(new SyntaxError('invalid config'))).toBeInstanceOf(SyntaxError)
  expect(transferred(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toMatchObject({ code: 'ENOENT' })
  expect(transferred(undefined)).toBeUndefined()
  expect(transferred({ message: 'custom value' })).toEqual({ message: 'custom value' })
  expect(() => transferred(() => {})).not.toThrow()
  expect(transferred(Object.assign(Object.create(null), { callback: () => {} }))).toBe('Non-serializable thrown value')
  const cyclic = new Error('cyclic')
  cyclic.cause = cyclic
  expect(transferred(cyclic)).toMatchObject({ message: 'cyclic', cause: '[Circular error cause]' })
})

it.each(['toString', '__proto__', 'constructor'])('keeps custom error name %s without using object prototype properties as constructors', (name) => {
  const original = Object.assign(new Error('custom failure'), { name })
  const result = transferred(original)
  expect(result).toBeInstanceOf(Error)
  expect(result).toMatchObject({ name, message: original.message, stack: original.stack })
})

it('preserves aggregate recovery errors inside an output failure cause', () => {
  const original = new IconctlError('Output commit and recovery failed', {
    cause: new AggregateError([Object.assign(new Error('rename failed'), { code: 'EACCES' }), new TypeError('recovery failed')], 'Write and recovery failed'),
  })
  const result = transferred(original) as IconctlError
  expect(result).toBeInstanceOf(IconctlError)
  expect(result.cause).toBeInstanceOf(AggregateError)
  expect((result.cause as AggregateError).errors).toEqual([expect.objectContaining({ code: 'EACCES' }), expect.any(TypeError)])
})

it('keeps private diagnostics lossless across IPC while public serialization redacts credentials', () => {
  const original = new IconctlError('Figma failed: Bearer private-access-token', {
    code: 'FIGMA_HTTP_ERROR',
    httpStatus: 429,
    retryable: true,
    retryAfterMs: 2000,
    sourceType: 'figma',
    sourceIndex: 0,
    operation: 'document',
    cause: new IconctlError('network failed', { code: 'ECONNRESET', operation: 'fetch' }),
  })
  const result = transferred(original) as IconctlError
  expect(result).toMatchObject({ name: original.name, message: original.message, stack: original.stack, code: 'FIGMA_HTTP_ERROR', httpStatus: 429, retryable: true, retryAfterMs: 2000, sourceType: 'figma', sourceIndex: 0, operation: 'document', cause: { code: 'ECONNRESET', operation: 'fetch' } })
  expect(JSON.stringify(serializeIconctlError(result))).not.toContain('private-access-token')
  expect(serializeIconctlError(result)).not.toHaveProperty('stack')
  const sync = new IconctlSyncError([{ name: 'arrow', message: 'invalid', stage: 'validation' }], 'Failed', { code: 'ICON_SYNC_FAILED', sourceIndex: 1 })
  expect(transferred(sync)).toMatchObject({ message: sync.message, code: 'ICON_SYNC_FAILED', sourceIndex: 1, issues: sync.issues })
})

it('projects paths without cloning hooks, validation state, package metadata or credentials', () => {
  const config = resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'figma', file: 'fixture', token: 'private-token', iconNameForNode: node => node.name }],
    validate: { name: /custom/gi },
    output: { jsonPackage: { dir: 'package', package: { privateValue: () => 'private' } }, svg: 'svg' },
  })
  const input = structuredClone(watchInputDescriptor(config))
  expect(input).toEqual({
    sources: [{ type: 'figma', file: 'fixture' }],
    output: { json: 'icons.json', svg: 'svg', jsonPackage: { dir: 'package' } },
    cacheDir: '.iconctl-cache',
  })
})

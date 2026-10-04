import { describe, expect, it } from 'vitest'
import { iconDiff, nextVersion, projectInput, safePath, snapshotCompareTo, snapshotIssue, sourceSchema, uploadKind, validateIconifyUpload } from '../src'

describe('console contracts', () => {
  it('keeps bounded structured diagnostics while accepting legacy issues', () => {
    const legacy = { name: 'arrow', message: 'Invalid size' }
    expect(snapshotIssue.parse(legacy)).toEqual(legacy)
    const structured = { ...legacy, stage: 'validation', sourceType: 'figma', sourceIndex: 0, fileKey: 'abc123', nodeId: '12:34' }
    expect(snapshotIssue.parse(structured)).toEqual(structured)
    for (const extra of [{ sourceIndex: -1 }, { sourceIndex: 1.5 }, { stage: 'x'.repeat(41) }, { fileKey: 'x'.repeat(201) }]) {
      expect(() => snapshotIssue.parse({ ...legacy, ...extra })).toThrow()
    }
  })
  it('accepts only an omitted, published or explicit snapshot comparison', () => {
    const id = crypto.randomUUID()
    expect(snapshotCompareTo.parse(undefined)).toBeUndefined()
    expect(snapshotCompareTo.parse('release')).toBe('release')
    expect(snapshotCompareTo.parse(id)).toBe(id)
    for (const value of ['', 'previous', '../snapshot', ['release']]) {
      expect(() => snapshotCompareTo.parse(value)).toThrow()
    }
  })
  it('preserves exact Iconify selections and literal prefixes', () => {
    expect(sourceSchema.parse({ type: 'iconify', file: 'vendor/icons.json' })).toEqual({ type: 'iconify', file: 'vendor/icons.json' })
    expect(sourceSchema.parse({ type: 'iconify', file: 'vendor/icons.json', include: [], namePrefix: '' })).toEqual({ type: 'iconify', file: 'vendor/icons.json', include: [], namePrefix: '' })
    expect(sourceSchema.parse({ type: 'iconify', file: 'vendor/icons.json', include: ['arrow', 'arrow'], namePrefix: ' Vendor ' })).toMatchObject({ include: ['arrow', 'arrow'], namePrefix: ' Vendor ' })
  })
  it.each([
    { file: '../icons.json' },
    { file: '/icons.json' },
    { file: '.git/config' },
    { file: 'https://example.com/icons.json' },
    { include: [''] },
    { upload: crypto.randomUUID() },
    { connection: crypto.randomUUID() },
    { token: 'secret' },
    { dir: 'raw' },
  ])('rejects invalid or out-of-scope Iconify source fields: %j', (fields) => {
    expect(() => sourceSchema.parse({ type: 'iconify', file: 'icons.json', ...fields })).toThrow()
  })
  it('accepts exactly one Iconify input and retains upload selections', () => {
    const upload = crypto.randomUUID()
    expect(sourceSchema.parse({ type: 'iconify', upload, include: [], namePrefix: ' X_' })).toEqual({ type: 'iconify', upload, include: [], namePrefix: ' X_' })
    for (const fields of [{}, { file: '' }, { file: 'a.json', upload }, { upload: 'invalid' }]) {
      expect(() => sourceSchema.parse({ type: 'iconify', ...fields })).toThrow()
    }
    expect(uploadKind.parse('iconify-json')).toBe('iconify-json')
    expect(uploadKind.parse('svg-zip')).toBe('svg-zip')
    expect(() => uploadKind.parse('json')).toThrow()
  })
  it('checks only the upload envelope, preserving BOM, metadata and unresolved icon/alias values', () => {
    for (const value of [
      { prefix: '', icons: {} },
      { prefix: ' Vendor_1', icons: { selected: null }, aliases: { bad: { parent: 'missing' } }, not_found: ['unknown'], info: { name: 'Extra' } },
    ]) {
      expect(() => validateIconifyUpload(new TextEncoder().encode(`\uFEFF${JSON.stringify(value)}`))).not.toThrow()
    }
  })
  it.each(['not json', 'null', '[]', '{"icons":{}}', '{"prefix":"x","icons":[]}', '{"prefix":"x","icons":{},"aliases":[]}', '{"prefix":"x","icons":{},"not_found":[1]}'])('rejects invalid upload envelopes: %s', (value) => {
    expect(() => validateIconifyUpload(new TextEncoder().encode(value))).toThrow(/Iconify JSON upload/)
  })
  it('rejects invalid UTF-8 instead of replacing malformed bytes', () => {
    expect(() => validateIconifyUpload(new Uint8Array([0x7B, 0xFF, 0x7D]))).toThrow(/UTF-8 JSON/)
  })
  it('uses stable semantic versions and starts at 0.1.0', () => {
    expect(nextVersion(undefined, 'major')).toBe('0.1.0')
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(() => nextVersion('1.2.3-beta.1', 'patch')).toThrow()
  })
  it('compares inherited dimensions and reports removals', () => {
    const before = {
      prefix: 'test',
      width: 24,
      icons: {
        arrow: { body: '<path/>', width: 24 },
        removed: { body: '<circle/>' },
      },
    }
    expect(
      iconDiff(before, {
        prefix: 'test',
        width: 24,
        icons: { arrow: { body: '<path/>' }, added: { body: '<rect/>' } },
      }),
    ).toEqual({ added: ['added'], removed: ['removed'], changed: [] })
    expect(
      iconDiff(before, {
        ...before,
        width: 16,
        icons: { arrow: { body: '<path/>' } },
      }).changed,
    ).toEqual(['arrow'])
  })
  it('rejects embedded secrets, unsafe paths and arbitrary network targets', () => {
    expect(() => safePath.parse('../credentials')).toThrow()
    expect(() =>
      projectInput.parse({
        name: 'icons',
        prefix: 'icons',
        packageName: '@test/icons',
        repository: 'owner/repo',
        sources: [
          {
            type: 'figma',
            file: 'file',
            connection: crypto.randomUUID(),
            token: 'secret',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      projectInput.parse({
        name: 'icons',
        prefix: 'icons',
        packageName: '@test/icons',
        repository: 'owner/repo',
        sources: [{ type: 'iconfont', url: 'https://127.0.0.1/internal' }],
      }),
    ).toThrow()
  })
})

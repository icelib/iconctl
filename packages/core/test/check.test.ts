import type { CheckInputOptions } from '../src'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { check, IconctlCheckError, resolveConfig } from '../src'

const body = '<path d="M0 0h16v16H0z"/>'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`

describe('check local artifacts', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-check-'))
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('Unexpected network request')
    }))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  async function json(value: unknown) {
    await writeFile(path.join(cwd, 'icons.json'), JSON.stringify(value))
  }

  async function failure(options: CheckInputOptions) {
    try {
      await check(options)
      throw new Error('Expected check to fail')
    }
    catch (error) {
      expect(error).toBeInstanceOf(IconctlCheckError)
      return (error as IconctlCheckError).report
    }
  }

  it('checks BOM JSON, aliases and inherited 16px defaults without configuration or writes', async () => {
    const contents = `\uFEFF${JSON.stringify({ prefix: 'vendor', icons: { home: { body, hidden: true } }, aliases: { copy: { parent: 'home', hFlip: true } } })}`
    await writeFile(path.join(cwd, 'icons.json'), contents)
    await writeFile(path.join(cwd, 'iconctl.config.ts'), 'throw new Error("Do not load config")')
    const files = await readdir(cwd)
    expect(await check({ cwd, input: 'icons.json', validate: { width: 16, height: 16 } })).toEqual({ prefix: 'vendor', count: 2, source: 'json' })
    expect(await readFile(path.join(cwd, 'icons.json'), 'utf8')).toBe(contents)
    expect(await readdir(cwd)).toEqual(files)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates rendered alias dimensions and aggregates import, process and validation issues', async () => {
    await json({
      prefix: 'vendor',
      width: 16,
      height: 24,
      icons: { good: { body }, Bad_Name: { body }, unsafe: { body: '<script>throw new Error("never executed")</script>' }, invalid: { body: 12 } },
      aliases: { rotated: { parent: 'good', rotate: 1 }, missing: { parent: 'absent' }, cycle: { parent: 'cycle' } },
    })
    const report = await failure({ cwd, input: 'icons.json', validate: { width: 16, height: 24 } })
    expect(report).toMatchObject({ prefix: 'vendor', count: 7, source: 'json', valid: false })
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'invalid', stage: 'import' }),
      expect.objectContaining({ name: 'missing', stage: 'import' }),
      expect.objectContaining({ name: 'cycle', stage: 'import' }),
      expect.objectContaining({ name: 'unsafe', stage: 'process' }),
      expect.objectContaining({ name: 'Bad_Name', stage: 'validation', message: expect.stringContaining('does not match') }),
      expect.objectContaining({ name: 'rotated', stage: 'validation', message: 'Icon "rotated" width is 24, expected 16' }),
      expect.objectContaining({ name: 'rotated', stage: 'validation', message: 'Icon "rotated" height is 16, expected 24' }),
    ]))
    expect(report.issues).toHaveLength(7)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses collection geometry and prefix for existing JSON output checks', async () => {
    await json({ prefix: 'actual', icons: { home: { body } }, aliases: { copy: { parent: 'home', rotate: 2 } } })
    const config = resolveConfig({ prefix: 'configured', sources: [{ type: 'directory', dir: 'missing-source' }], output: { json: 'icons.json' }, validate: { width: 24 } })
    await expect(check({ cwd, config })).rejects.toMatchObject({ report: { prefix: 'actual', count: 2, issues: [expect.objectContaining({ name: 'copy' }), expect.objectContaining({ name: 'home' })] } })
    expect(await check({ cwd, config, validate: { width: 16 } })).toEqual({ prefix: 'actual', count: 2, source: 'json' })
  })

  it('inspects every original SVG name and keeps all failure stages', async () => {
    await mkdir(path.join(cwd, 'svg', '.nested'), { recursive: true })
    const contents: Record<string, string> = {
      'Bad_Name.svg': svg,
      '_draft.svg': svg,
      '.hidden.svg': svg,
      'broken.svg': 'not svg',
      'unsafe.svg': '<svg viewBox="0 0 16 16"><script>throw new Error("never executed")</script></svg>',
      'home.svg': svg,
      '.nested/home.svg': svg,
    }
    await Promise.all(Object.entries(contents).map(([name, value]) => writeFile(path.join(cwd, 'svg', name), value)))
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'missing' }], output: { svg: 'svg' }, validate: { width: 24, skipPrefix: ['_', '.'] } })
    await expect(check({ cwd, config })).rejects.toMatchObject({
      report: {
        prefix: 'brand',
        count: 7,
        source: 'svg',
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ name: 'home', stage: 'import', message: expect.stringContaining('Duplicate') }),
          expect.objectContaining({ name: 'broken', stage: 'import' }),
          expect.objectContaining({ name: 'unsafe', stage: 'process' }),
          ...['Bad_Name', '_draft', '.hidden'].map(name => expect.objectContaining({ name, stage: 'validation', message: expect.stringContaining('does not match') })),
          expect.objectContaining({ name: 'home', stage: 'validation', message: expect.stringContaining('width is 16') }),
        ]),
      },
    })
    expect(await readFile(path.join(cwd, 'svg', 'Bad_Name.svg'), 'utf8')).toBe(svg)
  })

  it('does not fall back to JSON when the configured SVG directory is absent', async () => {
    await json({ prefix: 'vendor', icons: { home: { body } } })
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'unused' }], output: { svg: 'missing', json: 'icons.json' } })
    await expect(check({ cwd, config })).rejects.toMatchObject({ report: { source: 'svg', valid: false, issues: [expect.objectContaining({ stage: 'read' })] } })
  })

  it.each([
    [{ icons: {} }, 'import'],
    [{ prefix: 'vendor', width: 0, icons: {} }, 'import'],
    [{ prefix: 'vendor', icons: {}, not_found: ['absent'] }, 'import'],
  ] as const)('reports malformed collection %j', async (value, stage) => {
    await json(value)
    expect((await failure({ cwd, input: 'icons.json' })).issues[0]?.stage).toBe(stage)
  })

  it('reports missing and invalid JSON input as read failures', async () => {
    expect((await failure({ cwd, input: 'missing.json' })).issues).toEqual([expect.objectContaining({ stage: 'read', file: path.join(cwd, 'missing.json') })])
    await writeFile(path.join(cwd, 'icons.json'), '{')
    expect((await failure({ cwd, input: 'icons.json' })).issues[0]?.stage).toBe('read')
  })

  it('reports malformed UTF-8 input as a read failure', async () => {
    const bytes = Buffer.from('{"prefix":"vendor","icons":{"bad":{"body":"<path/>"}}}')
    bytes[bytes.indexOf('bad') + 2] = 255
    await writeFile(path.join(cwd, 'icons.json'), bytes)
    const report = await failure({ cwd, input: 'icons.json' })
    expect(report).toMatchObject({ source: 'json', count: 0, valid: false, issues: [expect.objectContaining({ stage: 'read', file: path.join(cwd, 'icons.json') })] })
  })

  it.each([
    { input: '' },
    { input: 'https://example.com/icons.json' },
    { input: 'icons.json', validate: { width: 0 } },
    { input: 'icons.json', validate: { height: Number.NaN } },
    { input: 'icons.json', validate: { name: '[' } },
  ])('rejects invalid options before reading input: %j', async (options) => {
    expect((await failure({ cwd, ...options })).issues).toEqual([expect.objectContaining({ stage: 'options' })])
    expect(fetch).not.toHaveBeenCalled()
  })
})

import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { renderIconNameTypes } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

describe('local types CLI', () => {
  let cwd: string
  let input: string
  let output: string
  const previousCwd = process.cwd()
  const icons = { prefix: 'brand', width: 24, height: 16, icons: { arrow: { body: '<path d="M0 0h4v4z"/>' }, hidden: { body: '<path/>', hidden: true } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-types-cli-')))
    input = join(cwd, 'icons.json')
    await writeFile(input, JSON.stringify(icons))
    process.chdir(cwd)
    process.exitCode = 0
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    vi.stubEnv('FIGMA_TOKEN', '')
    vi.stubEnv('FIGMA_CLIENT_ID', '')
    vi.stubEnv('FIGMA_CLIENT_SECRET', '')
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('local types must not fetch')
    }))
  })
  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled()
    process.chdir(previousCwd)
    process.exitCode = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(cwd, { recursive: true, force: true })
  })

  it('writes only a default type declaration with no config, preserving all icons and aliases', async () => {
    await runCli(['node', 'iconctl', 'types', '--input', 'icons.json', '--json'])
    expect(process.exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [join(cwd, 'icons.d.ts')] })
    const types = await readFile(join(cwd, 'icons.d.ts'), 'utf8')
    expect(types).toBe(await renderIconNameTypes(icons))
    expect(types).toContain('export type IconName = \'arrow\' | \'hidden\' | \'rotated\'')
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
    expect(await readdir(cwd)).toEqual(['icons.d.ts', 'icons.json'])
  })

  it('accepts BOM and absolute destinations without executing an existing config', async () => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("config must not execute")')
    await writeFile(input, `\uFEFF${JSON.stringify(icons)}`)
    const report = join(cwd, 'reports', 'local.d.ts')
    await runCli(['node', 'iconctl', 'types', '--input', input, '--output', report, '--json'])
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [report] })
    expect(await readFile(report, 'utf8')).toBe(await renderIconNameTypes(icons))
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'reports'])
  })

  it('renders an empty collection and preserves custom names without applying check rules', async () => {
    const custom = { prefix: 'Brand.v1', icons: { '_Name.With.Dots': { body: '<path fill="red"/>' } } }
    await writeFile(input, JSON.stringify(custom))
    await runCli(['node', 'iconctl', 'types', '--input', input, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { prefix: 'Brand.v1' }, count: 1 })
    expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toBe(await renderIconNameTypes(custom))
    output = ''
    await writeFile(input, JSON.stringify({ prefix: 'empty', icons: {} }))
    await runCli(['node', 'iconctl', 'types', '--input', input, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { prefix: 'empty' }, count: 0 })
    expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toContain('export type IconName = never')
  })

  it('preserves leading and trailing whitespace in real file paths', async () => {
    const name = ' icons.json '
    const target = ' types.d.ts '
    await writeFile(join(cwd, name), JSON.stringify(icons))
    await runCli(['node', 'iconctl', 'types', '--input', name, '--output', target, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { file: join(cwd, name) }, outputFiles: [join(cwd, target)] })
    expect(await readFile(join(cwd, target), 'utf8')).toBe(await renderIconNameTypes(icons))
  })

  it('dry-run validates and reports without creating output parents, staging or caches', async () => {
    await runCli(['node', 'iconctl', 'types', '--input', input, '--output', 'new/reports/types.d.ts', '--dry-run', '--json'])
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [], dryRun: true })
    expect(await readdir(cwd)).toEqual(['icons.json'])
  })

  it.each([
    '{',
    '{"prefix":"brand","icons":{},"not_found":["missing"]}',
    'null',
    '{}',
    '{"prefix":"brand","icons":{"bad":{"body":3}}}',
    '{"prefix":"brand","width":0,"icons":{}}',
    '{"prefix":"brand","icons":{},"aliases":{"bad":{"parent":"missing"}}}',
    '{"prefix":"brand","icons":{},"aliases":{"a":{"parent":"b"},"b":{"parent":"a"}}}',
  ])('rejects invalid collections without replacing types or changing the input: %s', async (invalid) => {
    await writeFile(input, invalid)
    const report = join(cwd, 'icons.d.ts')
    await writeFile(report, 'previous report')
    await expect(runCli(['node', 'iconctl', 'types', '--input', input, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'types', error: { name: 'IconctlError', phase: 'execution' } })
    expect(JSON.parse(output)).not.toHaveProperty('valid')
    expect(consola.error).not.toHaveBeenCalled()
    expect(await readFile(report, 'utf8')).toBe('previous report')
    expect(await readFile(input, 'utf8')).toBe(invalid)
    expect(await readdir(cwd)).toEqual(['icons.d.ts', 'icons.json'])
  })

  it('reports a missing source without creating the destination directory', async () => {
    await expect(runCli(['node', 'iconctl', 'types', '--input', 'missing.json', '--output', 'new/types.d.ts', '--json'])).rejects.toThrow('Cannot read Iconify JSON')
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'types', error: { phase: 'execution' } })
    expect(await readdir(cwd)).toEqual(['icons.json'])
  })

  it('rejects malformed UTF-8 without replacing the existing declaration', async () => {
    const bytes = Buffer.from('{"prefix":"brand","icons":{"bad":{"body":"<path/>"}}}')
    bytes[bytes.indexOf('bad') + 2] = 255
    await writeFile(input, bytes)
    const report = join(cwd, 'icons.d.ts')
    await writeFile(report, 'previous types')
    await expect(runCli(['node', 'iconctl', 'types', '--input', input, '--json'])).rejects.toThrow('Cannot read Iconify JSON')
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'types', error: { phase: 'execution' } })
    expect(await readFile(report, 'utf8')).toBe('previous types')
  })

  it.each([false, true])('protects the source from the output path, dryRun=%s', async (dryRun) => {
    await expect(runCli(['node', 'iconctl', 'types', '--input', input, '--output', input, '--json', ...(dryRun ? ['--dry-run'] : [])])).rejects.toThrow(/conflicts with input/)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'types', error: { phase: 'execution' } })
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  })

  it.each([
    [],
    ['--input', 'icons.json', '--config', 'other.mjs'],
    ['--input', 'icons.json', '--continue'],
    ['--output', 'types.d.ts'],
    ['--input', ''],
    ['--input', '   '],
    ['--input', '-'],
    ['--input', 'https://example.invalid/icons.json'],
    ['--input', 'icons.json', '--output', ''],
    ['--input', 'icons.json', '--output', '   '],
    ['--input', 'icons.json', '--output', '-'],
    ['--input', 'icons.json', '--output', 'file:///types.d.ts'],
    ['--input', 'icons.json', '--input', 'other.json'],
    ['--input', 'icons.json', '--output', 'one.d.ts', '--output', 'two.d.ts'],
    ['--input'],
    ['--input', 'icons.json', '--output'],
    ['--input', 'icons.json', '--unknown'],
  ])('reports one argument error before configuration or writes: %j', async (...args) => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("config must not execute")')
    await expect(runCli(['node', 'iconctl', 'types', ...args, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'types', error: { phase: 'arguments' } })
    expect(output).not.toContain('config must not execute')
    expect(consola.error).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
  })

  it('reports human execution failure once without replacing the existing types', async () => {
    await writeFile(input, '{')
    await writeFile(join(cwd, 'icons.d.ts'), 'previous types')
    await expect(runCli(['node', 'iconctl', 'types', '--input', input])).rejects.toThrow('Cannot read Iconify JSON')
    expect(output).toBe('')
    expect(consola.error).toHaveBeenCalledTimes(1)
    expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toBe('previous types')
  })

  it.each([false, true])('provides a concise human result, dryRun=%s', async (dryRun) => {
    await runCli(['node', 'iconctl', 'types', '--input', input, ...(dryRun ? ['--dry-run'] : [])])
    expect(output).toBe(`${dryRun ? 'Would write' : 'Wrote'} ${join(cwd, 'icons.d.ts')} · 3 icon names for prefix "brand"\n`)
  })
})

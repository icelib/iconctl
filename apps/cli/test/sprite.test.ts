import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { renderSvgSprite } from '@iconctl/core'
import { consola } from 'consola'
import { runCli } from '../src/program'

describe('local sprite CLI', () => {
  let cwd: string
  let input: string
  let output: string
  const previousCwd = process.cwd()
  const icons = { prefix: 'brand', width: 24, height: 16, icons: { arrow: { body: '<path d="M0 0h4v4z"/>' }, hidden: { body: '<path/>', hidden: true } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-sprite-cli-')))
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
      throw new Error('local sprite must not fetch')
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

  it('writes only a default SVG report with no config, preserving all icons and aliases', async () => {
    await runCli(['node', 'iconctl', 'sprite', '--input', 'icons.json', '--json'])
    expect(process.exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [join(cwd, 'icons.svg')] })
    const svg = await readFile(join(cwd, 'icons.svg'), 'utf8')
    expect(svg).toBe(await renderSvgSprite(icons))
    expect(svg.match(/<symbol /g)).toHaveLength(3)
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
    expect(await readdir(cwd)).toEqual(['icons.json', 'icons.svg'])
  })

  it('accepts BOM and absolute destinations without executing an existing config', async () => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("config must not execute")')
    await writeFile(input, `\uFEFF${JSON.stringify(icons)}`)
    const report = join(cwd, 'reports', 'local.svg')
    await runCli(['node', 'iconctl', 'sprite', '--input', input, '--output', report, '--json'])
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [report] })
    expect(await readFile(report, 'utf8')).toBe(await renderSvgSprite(icons))
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'reports'])
  })

  it('renders an empty collection and preserves custom names without applying check rules', async () => {
    const custom = { prefix: 'Brand.v1', icons: { '_Name.With.Dots': { body: '<path fill="red"/>' } } }
    await writeFile(input, JSON.stringify(custom))
    await runCli(['node', 'iconctl', 'sprite', '--input', input, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { prefix: 'Brand.v1' }, count: 1 })
    expect(await readFile(join(cwd, 'icons.svg'), 'utf8')).toBe(await renderSvgSprite(custom))
    output = ''
    await writeFile(input, JSON.stringify({ prefix: 'empty', icons: {} }))
    await runCli(['node', 'iconctl', 'sprite', '--input', input, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { prefix: 'empty' }, count: 0 })
    expect(await readFile(join(cwd, 'icons.svg'), 'utf8')).not.toContain('<symbol ')
  })

  it('preserves leading and trailing whitespace in real file paths', async () => {
    const name = ' icons.json '
    const target = ' sprite.svg '
    await writeFile(join(cwd, name), JSON.stringify(icons))
    await runCli(['node', 'iconctl', 'sprite', '--input', name, '--output', target, '--json'])
    expect(JSON.parse(output)).toMatchObject({ input: { file: join(cwd, name) }, outputFiles: [join(cwd, target)] })
    expect(await readFile(join(cwd, target), 'utf8')).toBe(await renderSvgSprite(icons))
  })

  it('dry-run validates and reports without creating output parents, staging or caches', async () => {
    await runCli(['node', 'iconctl', 'sprite', '--input', input, '--output', 'new/reports/sprite.svg', '--dry-run', '--json'])
    expect(JSON.parse(output)).toEqual({ input: { file: input, prefix: 'brand' }, count: 3, outputFiles: [], dryRun: true })
    expect(await readdir(cwd)).toEqual(['icons.json'])
  })

  it.each([
    '{',
    JSON.stringify({ prefix: 'brand', icons: { bad: { body: '<use href="#missing"/>' } } }),
    '{"prefix":"brand","icons":{},"not_found":["missing"]}',
    'null',
    '{}',
    '{"prefix":"brand","icons":{"bad":{"body":3}}}',
    '{"prefix":"brand","width":0,"icons":{}}',
    '{"prefix":"brand","icons":{},"aliases":{"bad":{"parent":"missing"}}}',
    '{"prefix":"brand","icons":{},"aliases":{"a":{"parent":"b"},"b":{"parent":"a"}}}',
  ])('rejects invalid collections without replacing SVG or changing the input: %s', async (invalid) => {
    await writeFile(input, invalid)
    const report = join(cwd, 'icons.svg')
    await writeFile(report, 'previous report')
    await expect(runCli(['node', 'iconctl', 'sprite', '--input', input, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'sprite', error: { name: 'IconctlError', phase: 'execution' } })
    expect(JSON.parse(output)).not.toHaveProperty('valid')
    expect(consola.error).not.toHaveBeenCalled()
    expect(await readFile(report, 'utf8')).toBe('previous report')
    expect(await readFile(input, 'utf8')).toBe(invalid)
    expect(await readdir(cwd)).toEqual(['icons.json', 'icons.svg'])
  })

  it('reports a missing source without creating the destination directory', async () => {
    await expect(runCli(['node', 'iconctl', 'sprite', '--input', 'missing.json', '--output', 'new/sprite.svg', '--json'])).rejects.toThrow('Cannot read Iconify JSON')
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'sprite', error: { phase: 'execution' } })
    expect(await readdir(cwd)).toEqual(['icons.json'])
  })

  it.each([false, true])('protects the source from the output path, dryRun=%s', async (dryRun) => {
    await expect(runCli(['node', 'iconctl', 'sprite', '--input', input, '--output', input, '--json', ...(dryRun ? ['--dry-run'] : [])])).rejects.toThrow(/conflicts with input/)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'sprite', error: { phase: 'execution' } })
    expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  })

  it.each([
    [],
    ['--input', 'icons.json', '--config', 'other.mjs'],
    ['--input', 'icons.json', '--continue'],
    ['--output', 'sprite.svg'],
    ['--input', ''],
    ['--input', '   '],
    ['--input', '-'],
    ['--input', 'https://example.invalid/icons.json'],
    ['--input', 'icons.json', '--output', ''],
    ['--input', 'icons.json', '--output', '   '],
    ['--input', 'icons.json', '--output', '-'],
    ['--input', 'icons.json', '--output', 'file:///sprite.svg'],
    ['--input', 'icons.json', '--input', 'other.json'],
    ['--input', 'icons.json', '--output', 'one.svg', '--output', 'two.svg'],
    ['--input'],
    ['--input', 'icons.json', '--output'],
    ['--input', 'icons.json', '--unknown'],
  ])('reports one argument error before configuration or writes: %j', async (...args) => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("config must not execute")')
    await expect(runCli(['node', 'iconctl', 'sprite', ...args, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'sprite', error: { phase: 'arguments' } })
    expect(output).not.toContain('config must not execute')
    expect(consola.error).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
  })

  it('reports human execution failure once without replacing the existing sprite', async () => {
    await writeFile(input, '{')
    await writeFile(join(cwd, 'icons.svg'), 'previous sprite')
    await expect(runCli(['node', 'iconctl', 'sprite', '--input', input])).rejects.toThrow('Cannot read Iconify JSON')
    expect(output).toBe('')
    expect(consola.error).toHaveBeenCalledTimes(1)
    expect(await readFile(join(cwd, 'icons.svg'), 'utf8')).toBe('previous sprite')
  })

  it.each([false, true])('provides a concise human result, dryRun=%s', async (dryRun) => {
    await runCli(['node', 'iconctl', 'sprite', '--input', input, ...(dryRun ? ['--dry-run'] : [])])
    expect(output).toBe(`${dryRun ? 'Would write' : 'Wrote'} ${join(cwd, 'icons.svg')} · 3 icons for prefix "brand"\n`)
  })
})

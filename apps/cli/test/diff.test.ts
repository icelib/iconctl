import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { runCli } from '../src/program'

describe('offline diff CLI', () => {
  let cwd: string
  let before: string
  let after: string
  let output: string
  const previousCwd = process.cwd()
  const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h4v4z"/>' } } }
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-diff-cli-')))
    before = join(cwd, 'before.json')
    after = join(cwd, 'after.json')
    await writeFile(before, JSON.stringify(icons))
    await writeFile(after, JSON.stringify(icons))
    process.chdir(cwd)
    process.exitCode = 0
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    vi.spyOn(consola, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    process.chdir(previousCwd)
    process.exitCode = 0
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true })
  })

  it('compares local files from a directory with no config and emits only the diff JSON contract', async () => {
    await runCli(['node', 'iconctl', 'diff', 'before.json', 'after.json', '--json', '--check'])
    expect(process.exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      before: { file: before, prefix: 'brand' },
      after: { file: after, prefix: 'brand' },
      prefixChanged: false,
      hasChanges: false,
      added: [],
      removed: [],
      changed: [],
      unchanged: ['arrow'],
      outputFiles: [],
    })
    expect(await readdir(cwd)).toEqual(['after.json', 'before.json'])
  })

  it('writes a report before returning the check failure for a prefix-only change', async () => {
    await writeFile(after, JSON.stringify({ ...icons, prefix: 'new-brand' }))
    const report = join(cwd, 'reports', 'diff.html')
    await runCli(['node', 'iconctl', 'diff', before, after, '--html', report, '--json', '--check'])
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ prefixChanged: true, hasChanges: true, unchanged: ['arrow'], outputFiles: [report] })
    expect(await readFile(report, 'utf8')).toContain('Prefix changed')
  })

  it('writes a deterministic Markdown report alongside JSON output', async () => {
    await writeFile(after, JSON.stringify({ ...icons, icons: { ...icons.icons, plus: { body: '<path/>' } } }))
    const report = join(cwd, 'reports', 'diff.md')
    await runCli(['node', 'iconctl', 'diff', before, after, '--markdown', report, '--json'])
    expect(JSON.parse(output).outputFiles).toEqual([report])
    expect(await readFile(report, 'utf8')).toContain('| plus | added |')
  })

  it('detects alias geometry changes and accepts a BOM without touching configuration', async () => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("config must not load")')
    await writeFile(after, `\uFEFF${JSON.stringify({ ...icons, aliases: { flipped: { parent: 'arrow', hFlip: true } } })}`)
    await runCli(['node', 'iconctl', 'diff', before, after, '--json', '--check'])
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ added: ['flipped'], unchanged: ['arrow'] })
  })

  it('reports differences successfully unless check was requested', async () => {
    await writeFile(after, JSON.stringify({ ...icons, icons: {} }))
    await runCli(['node', 'iconctl', 'diff', before, after])
    expect(process.exitCode).toBe(0)
    expect(output).toContain('Removed 1')
  })

  it('dry-run validates and reports the comparison but creates no output directory', async () => {
    await runCli(['node', 'iconctl', 'diff', before, after, '--html', join(cwd, 'reports', 'diff.html'), '--dry-run', '--json'])
    expect(JSON.parse(output)).toMatchObject({ dryRun: true, outputFiles: [] })
    expect(await readdir(cwd)).toEqual(['after.json', 'before.json'])
  })

  it('rejects malformed UTF-8 in either comparison input before writing a report', async () => {
    const bytes = Buffer.from('{"prefix":"brand","icons":{"bad":{"body":"<path/>"}}}')
    bytes[bytes.indexOf('bad') + 2] = 255
    await writeFile(before, bytes)
    const report = join(cwd, 'diff.html')
    await writeFile(report, 'previous report')
    await expect(runCli(['node', 'iconctl', 'diff', before, after, '--html', report, '--json'])).rejects.toThrow('Cannot read Iconify JSON')
    expect(await readFile(report, 'utf8')).toBe('previous report')
  })

  it.each(['{', 'null', '{"prefix":"brand","icons":{},"aliases":{"broken":{"parent":"missing"}}}'])('rejects invalid input before replacing a report: %s', async (invalid) => {
    await writeFile(before, invalid)
    const report = join(cwd, 'diff.html')
    await writeFile(report, 'previous report')
    await expect(runCli(['node', 'iconctl', 'diff', before, after, '--html', report, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ success: false, command: 'diff', error: { name: 'IconctlError', message: expect.any(String), phase: 'execution' } })
    expect(consola.error).not.toHaveBeenCalled()
    expect(await readFile(report, 'utf8')).toBe('previous report')
  })

  it('rejects an output path that replaces an input, including dry-run', async () => {
    await expect(runCli(['node', 'iconctl', 'diff', before, after, '--html', after, '--dry-run'])).rejects.toThrow(/conflicts with input/)
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(await readFile(after, 'utf8'))).toEqual(icons)
  })
})

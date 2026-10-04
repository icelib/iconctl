import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const cliDirectory = fileURLToPath(new URL('..', import.meta.url))
const coreDirectory = resolve(cliDirectory, '../../packages/core')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

describe('built CLI process boundary', () => {
  let fixture: string
  let cwd: string
  let executable: string

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'iconctl-built-cli-'))
    // Build current source with each package's real bundler config. Isolated
    // outputs avoid stale dist files and races with repository-wide builds.
    for (const [name, source] of [['core', coreDirectory], ['cli', cliDirectory]] as const) {
      const target = join(fixture, name)
      await mkdir(target, { recursive: true })
      const packageFile = join(source, 'package.json')
      const metadata = JSON.parse(await readFile(packageFile, 'utf8')) as { dependencies: Record<string, string> }
      await copyFile(packageFile, join(target, 'package.json'))
      for (const dependency of Object.keys(metadata.dependencies)) {
        const link = join(target, 'node_modules', dependency)
        await mkdir(dirname(link), { recursive: true })
        await symlink(dependency === '@iconctl/core' ? join(fixture, 'core') : join(source, 'node_modules', dependency), link, 'dir')
      }
      await build({ cwd: source, config: join(source, 'tsdown.config.ts'), outDir: join(target, 'dist'), dts: false, logLevel: 'error' })
    }
    await build({ cwd: cliDirectory, config: join(cliDirectory, 'tsdown.config.ts'), entry: { dev: join(cliDirectory, 'dev', 'index.ts') }, outDir: join(fixture, 'cli', 'dist'), clean: false, dts: false, logLevel: 'error' })
    await mkdir(join(fixture, 'cli', 'bin'))
    executable = join(fixture, 'cli', 'bin', 'index.js')
    await copyFile(join(cliDirectory, 'bin', 'index.js'), executable)
  }, 30000)

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(fixture, 'project-')))
    await mkdir(join(cwd, 'source'))
    await writeFile(join(cwd, 'source', 'good.svg'), svg)
    await writeFile(join(cwd, 'iconctl.config.mjs'), `export default ${JSON.stringify({ prefix: 'brand', sources: [{ type: 'directory', dir: './source' }], output: { json: 'icons.json' } })}`)
  })

  afterAll(async () => {
    if (fixture) {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  async function runEntry(entry: string, args: string[]) {
    return new Promise<{ code: number | string | null, stdout: string, stderr: string }>((resolveRun, reject) => {
      const child = execFile(process.execPath, [entry, ...args], {
        cwd,
        timeout: 10000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          FIGMA_TOKEN: '',
          FIGMA_CLIENT_ID: '',
          FIGMA_CLIENT_SECRET: '',
          FIGMA_REFRESH_TOKEN: '',
          ICONCTL_FIGMA_CREDENTIALS_FILE: join(cwd, 'credentials.json'),
        },
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.signal)) {
          reject(error)
        }
        else {
          resolveRun({ code: error?.code ?? 0, stdout, stderr })
        }
      })
      child.stdin?.end()
    })
  }

  async function run(...args: string[]) {
    return runEntry(executable, args)
  }

  describe('safe initialization through the built entry points', () => {
    const flags = ['--source', 'directory', '--input', './source', '--prefix', 'brand']

    it.each(['packaged', 'development'])('creates a usable config from the %s entry with closed stdin', async (entry) => {
      await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("init must not execute configuration")')
      const result = await runEntry(entry === 'packaged' ? executable : join(fixture, 'cli/dist/dev.mjs'), ['init', ...flags, '--config', 'nested/config.ts', '--no-interactive', '--json'])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ configFile: join(cwd, 'nested/config.ts'), sourceType: 'directory', prefix: 'brand', outputFiles: [join(cwd, 'nested/config.ts')] })
      expect(await readdir(join(cwd, 'nested'))).toEqual(['config.ts'])
      await mkdir(join(cwd, 'node_modules'))
      await symlink(join(fixture, 'cli'), join(cwd, 'node_modules/iconctl'), 'dir')
      const synced = await run('sync', '--config', 'nested/config.ts', '--dry-run', '--json')
      expect(synced.code).toBe(0)
      expect(synced.stderr).toBe('')
      expect(JSON.parse(synced.stdout)).toMatchObject({ prefix: 'brand', complete: true, added: ['good'], outputFiles: [] })
    })

    it('never prompts when required flags are missing and stdin is closed', async () => {
      const result = await run('init', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments', message: expect.stringContaining('--source') } })
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'source'])
    })

    it('checks future config/output case aliases through the real bin without writing probes', async () => {
      const result = await run('init', ...flags, '--config', 'abc.ts', '--json-output', 'ABC.TS', '--dry-run', '--json')
      expect(result.stderr).toBe('')
      if (process.platform === 'darwin' || process.platform === 'win32') {
        expect(result.code).toBe(1)
        expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments', message: expect.stringContaining('conflicts') } })
      }
      else {
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, outputFiles: [] })
      }
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'source'])
    })

    it('performs a zero-write dry-run and protects an existing target', async () => {
      const result = await run('init', ...flags, '--config', 'new/nested/config.ts', '--dry-run', '--json')
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ configFile: join(cwd, 'new/nested/config.ts'), dryRun: true, outputFiles: [] })
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'source'])
      await writeFile(join(cwd, 'iconctl.config.ts'), 'existing bytes')
      const existing = await run('init', ...flags, '--dry-run', '--json')
      expect(existing.code).toBe(1)
      expect(existing.stderr).toBe('')
      expect(JSON.parse(existing.stdout)).toMatchObject({ success: false, command: 'init', error: { phase: 'execution', message: expect.stringContaining('Config already exists') } })
      expect(await readFile(join(cwd, 'iconctl.config.ts'), 'utf8')).toBe('existing bytes')
    })

    it.each([
      ['--source'],
      ['--source', 'unknown'],
      [...flags, '--continue'],
      [...flags, '--force'],
      [...flags, '--source', 'iconify'],
      [...flags, '--config', 'config.json'],
      [...flags, '--url', 'https://example.invalid/symbol.js'],
    ])('reports one argument failure for %j', async (...options) => {
      const result = await run('init', ...options, '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments' } })
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'source'])
    })

    it('lets exactly one concurrent process initialize a target', async () => {
      const results = await Promise.all([run('init', ...flags, '--json'), run('init', ...flags, '--json')])
      expect(results.map(result => result.code).sort()).toEqual([0, 1])
      for (const result of results) {
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toMatchObject(result.code === 0 ? { outputFiles: [join(cwd, 'iconctl.config.ts')] } : { success: false, error: { message: expect.stringContaining('Config already exists') } })
      }
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'iconctl.config.ts', 'source'])
    })
  })

  it.each(['sync', 'preview'])('emits one fatal JSON report and no duplicate stderr for %s', async (command) => {
    await writeFile(join(cwd, 'source', 'bad.svg'), 'not an SVG')
    await writeFile(join(cwd, 'icons.json'), 'previous output')
    const result = await run(command, '--json')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command, error: { name: 'IconctlSyncError', phase: 'execution', issues: [{ name: 'bad', stage: 'import', sourceType: 'directory', sourceIndex: 0 }] } })
    expect(JSON.parse(result.stdout)).not.toHaveProperty('outputFiles')
    expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe('previous output')
  })

  it.each(['packaged', 'development'])('prints a human failure once at the %s entry boundary', async (entry) => {
    await rm(join(cwd, 'iconctl.config.mjs'))
    const result = await runEntry(entry === 'packaged' ? executable : join(fixture, 'cli', 'dist', 'dev.mjs'), ['sync'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.match(/No iconctl config found/g)).toHaveLength(1)
    expect(result.stderr).not.toMatch(/at .*\.mjs|UnhandledPromiseRejection/)
  })

  it('reports real configuration failure as JSON', async () => {
    await rm(join(cwd, 'iconctl.config.mjs'))
    const result = await run('sync', '--json')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'sync', error: { name: 'IconctlError', phase: 'configuration' } })
  })

  it.each([['sync', '--config', '--json'], ['auth', 'figma', '--json']])('reports parsed argument failure: %s', async (...args) => {
    const result = await run(...args)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: args[0], error: { name: 'CACError', phase: 'arguments' } })
  })

  it('reports authentication failure without leaking credentials or loading project config', async () => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("Configuration must not execute")')
    const result = await run('auth', 'figma', 'login', '--no-open', '--json')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'auth', error: { name: 'IconctlError', phase: 'authentication' } })
    expect(result.stdout).not.toContain('Configuration must not execute')
  })

  it('preserves successful and partial sync summaries without fatal envelopes', async () => {
    const complete = await run('sync', '--json', '--dry-run')
    expect(complete.code).toBe(0)
    expect(complete.stderr).toBe('')
    expect(JSON.parse(complete.stdout)).toEqual({ prefix: 'brand', complete: true, deletionsReliable: true, notModified: false, sources: [{ type: 'directory', notModified: false }], added: ['good'], removed: [], changed: [], skipped: [], issues: [], outputFiles: [] })
    await writeFile(join(cwd, 'source', 'bad.svg'), 'not an SVG')
    const partial = await run('sync', '--json', '--continue', '--dry-run')
    expect(partial.code).toBe(0)
    expect(partial.stderr).toBe('')
    const report = JSON.parse(partial.stdout)
    expect(report).toMatchObject({ complete: false, deletionsReliable: false, removed: [], skipped: ['bad'], issues: [{ name: 'bad' }], outputFiles: [] })
    expect(report).not.toHaveProperty('success')
    expect(report).not.toHaveProperty('error')
  })

  it.each([undefined, 'reports/configured.html'])('preserves config-backed preview defaults and sync JSON: %s', async (preview) => {
    await writeFile(join(cwd, 'iconctl.config.mjs'), `export default ${JSON.stringify({ prefix: 'brand', sources: [{ type: 'directory', dir: './source' }], output: { json: 'icons.json', ...(preview ? { preview } : {}) } })}`)
    const result = await run('preview', '--config', 'iconctl.config.mjs', '--json')
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ prefix: 'brand', complete: true, deletionsReliable: true, notModified: false, sources: [{ type: 'directory', notModified: false }], added: ['good'], removed: [], changed: [], skipped: [], issues: [], outputFiles: [join(cwd, 'icons.json'), join(cwd, preview ?? 'preview.html')] })
    expect(await readFile(join(cwd, preview ?? 'preview.html'), 'utf8')).toContain('brand:good')
  })

  it('preserves check fields and adds the same diagnostics in its fatal envelope', async () => {
    await writeFile(join(cwd, 'icons.json'), JSON.stringify({ prefix: 'brand', icons: { good: { body: '<path d="M0 0h16v16z"/>' } } }))
    const result = await run('check', '--input', 'icons.json', '--width', '24', '--json')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ prefix: 'brand', count: 1, source: 'json', valid: false, success: false, command: 'check', issues: [{ name: 'good', stage: 'validation' }], error: { phase: 'execution' } })
    expect(report.error.issues).toEqual(report.issues)
  })
  describe('local preview with the shipped and development entry points', () => {
    const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h8v8H0z"/>', hidden: true } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }
    beforeEach(async () => {
      await writeFile(join(cwd, 'icons.json'), `\uFEFF${JSON.stringify(icons)}`)
      await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("preview must not execute project configuration")')
    })

    it.each(['packaged', 'development'])('writes a local gallery through the %s entry', async (entry) => {
      const result = await runEntry(entry === 'packaged' ? executable : join(fixture, 'cli/dist/dev.mjs'), ['preview', '--input', 'icons.json', '--output', 'reports/local.html', '--json'])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 2, outputFiles: [join(cwd, 'reports/local.html')] })
      const html = await readFile(join(cwd, 'reports/local.html'), 'utf8')
      expect(html).toContain('brand:rotated')
      expect(html).toContain('Search icons')
      expect(html.match(/<figure class="icon"/g)).toHaveLength(2)
      expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(`\uFEFF${JSON.stringify(icons)}`)
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'reports', 'source'])
    })

    it('creates no directories or cache in dry-run', async () => {
      const result = await run('preview', '--input', 'icons.json', '--output', 'new/reports/preview.html', '--dry-run', '--json')
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 2, outputFiles: [], dryRun: true })
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'source'])
    })

    it.each([
      ['--input'],
      ['--input', 'icons.json', '--output'],
      ['--input', 'icons.json', '--unknown'],
      ['--input', 'icons.json', '--config', 'config.mjs'],
      ['--input', 'icons.json', '--continue'],
      ['--output', 'preview.html'],
      ['--input', 'https://example.invalid/icons.json'],
      ['--input', 'icons.json', '--input', 'again.json'],
    ])('emits exactly one JSON for parser or semantic argument errors: %j', async (...args) => {
      const result = await run('preview', ...args, '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'preview', error: { phase: 'arguments' } })
      expect(result.stdout).not.toContain('preview must not execute')
      expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'source'])
    })

    it('preserves a report when the local collection cannot be resolved', async () => {
      await writeFile(join(cwd, 'icons.json'), JSON.stringify({ ...icons, aliases: { bad: { parent: 'missing' } } }))
      await writeFile(join(cwd, 'preview.html'), 'previous report')
      const result = await run('preview', '--input', 'icons.json', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'preview', error: { name: 'IconctlError', phase: 'execution' } })
      expect(await readFile(join(cwd, 'preview.html'), 'utf8')).toBe('previous report')
    })

    it('validates input/output conflicts during dry-run without changing source bytes', async () => {
      const result = await run('preview', '--input', 'icons.json', '--output', 'icons.json', '--dry-run', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'preview', error: { phase: 'execution', message: expect.stringMatching(/conflicts with input/) } })
      expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(`\uFEFF${JSON.stringify(icons)}`)
    })
  })

  describe('offline diff with the common one-shot error boundary', () => {
    const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h24v24H0z"/>' } }, width: 24, height: 24 }

    beforeEach(async () => {
      await writeFile(join(cwd, 'before.json'), JSON.stringify(icons))
      await writeFile(join(cwd, 'after.json'), JSON.stringify(icons))
      await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("diff must not execute project configuration")')
    })

    it('keeps a valid comparison as the original JSON result even when --check exits 1', async () => {
      await writeFile(join(cwd, 'after.json'), JSON.stringify({ ...icons, prefix: 'updated' }))
      const result = await run('diff', 'before.json', 'after.json', '--html', 'reports/diff.html', '--json', '--check')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({
        before: { file: join(cwd, 'before.json'), prefix: 'brand' },
        after: { file: join(cwd, 'after.json'), prefix: 'updated' },
        prefixChanged: true,
        hasChanges: true,
        added: [],
        removed: [],
        changed: [],
        unchanged: ['arrow'],
        outputFiles: [join(cwd, 'reports/diff.html')],
      })
      expect(await readFile(join(cwd, 'reports/diff.html'), 'utf8')).toContain('Prefix changed')
    })

    it('keeps unchanged comparisons successful and configuration-free', async () => {
      const result = await run('diff', 'before.json', 'after.json', '--json', '--check')
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      const comparison = JSON.parse(result.stdout)
      expect(comparison).toMatchObject({ hasChanges: false, unchanged: ['arrow'] })
      expect(comparison).not.toHaveProperty('error')
      expect(comparison).not.toHaveProperty('success')
    })

    it.each(['{', 'null', '{"prefix":"brand","icons":{},"aliases":{"broken":{"parent":"missing"}}}'])('reports invalid input as one failure and preserves the existing HTML: %s', async (invalid) => {
      await writeFile(join(cwd, 'before.json'), invalid)
      await writeFile(join(cwd, 'diff.html'), 'previous report')
      const result = await run('diff', 'before.json', 'after.json', '--html', 'diff.html', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({ success: false, command: 'diff', error: { name: 'IconctlError', phase: 'execution' } })
      expect(report).not.toHaveProperty('hasChanges')
      expect(await readFile(join(cwd, 'diff.html'), 'utf8')).toBe('previous report')
    })

    it('uses the argument boundary when an input positional argument is missing', async () => {
      const result = await run('diff', 'before.json', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'diff', error: { name: 'CACError', phase: 'arguments' } })
    })

    it('reports an HTML input conflict without replacing the input in dry-run', async () => {
      const result = await run('diff', 'before.json', 'after.json', '--html', 'after.json', '--dry-run', '--json')
      expect(result.code).toBe(1)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'diff', error: { phase: 'execution', message: expect.stringMatching(/conflicts with input/) } })
      expect(JSON.parse(await readFile(join(cwd, 'after.json'), 'utf8'))).toEqual(icons)
    })
  })
})

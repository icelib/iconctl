import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
    cwd = await mkdtemp(join(fixture, 'project-'))
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
      execFile(process.execPath, [entry, ...args], {
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
    })
  }

  async function run(...args: string[]) {
    return runEntry(executable, args)
  }

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

  it('preserves check fields and adds the same diagnostics in its fatal envelope', async () => {
    await writeFile(join(cwd, 'icons.json'), JSON.stringify({ prefix: 'brand', icons: { good: { body: '<path d="M0 0h16v16z"/>' } } }))
    const result = await run('check', '--input', 'icons.json', '--width', '24', '--json')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ prefix: 'brand', count: 1, source: 'json', valid: false, success: false, command: 'check', issues: [{ name: 'good', stage: 'validation' }], error: { phase: 'execution' } })
    expect(report.error.issues).toEqual(report.issues)
  })
})

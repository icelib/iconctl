import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderIconNameTypes, renderSvgSprite } from '@iconctl/core'
import { build } from 'tsdown'
import spriteFixture from '../../../packages/core/test/fixtures/standalone-sprite.json'

const cliDirectory = fileURLToPath(new URL('..', import.meta.url))
const coreDirectory = resolve(cliDirectory, '../../packages/core')
// Build tooling may need a newer Node than the CLI's supported minimum.
const node = process.env['ICONCTL_NATIVE_NODE'] ?? process.execPath

describe('native TypeScript CLI process boundary', () => {
  let fixture: string
  let cwd: string
  let executable: string
  let version: string
  let nodeVersion: string

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'iconctl-native-cli-'))
    nodeVersion = (await promisify(execFile)(node, ['--version'])).stdout.trim()
    // Native stripping is deliberately tested outside node_modules. Only the
    // public core dependency is built; CLI sources are copied without bundling.
    for (const [name, source] of [['core', coreDirectory], ['cli', cliDirectory]] as const) {
      const target = join(fixture, name)
      await mkdir(target, { recursive: true })
      const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { version: string, dependencies: Record<string, string> }
      await copyFile(join(source, 'package.json'), join(target, 'package.json'))
      for (const dependency of Object.keys(metadata.dependencies)) {
        const link = join(target, 'node_modules', dependency)
        await mkdir(dirname(link), { recursive: true })
        await symlink(dependency === '@iconctl/core' ? join(fixture, 'core') : join(source, 'node_modules', dependency), link, 'dir')
      }
      if (name === 'core') {
        await build({ cwd: source, config: join(source, 'tsdown.config.ts'), outDir: join(target, 'dist'), dts: false, logLevel: 'error' })
      }
      else {
        version = metadata.version
        await cp(join(source, 'src'), join(target, 'src'), { recursive: true })
        await cp(join(source, 'dev'), join(target, 'dev'), { recursive: true })
      }
    }
    executable = join(fixture, 'cli', 'dev', 'index.ts')
    expect(await readdir(join(fixture, 'cli'))).toEqual(['dev', 'node_modules', 'package.json', 'src'])
  }, 30000)

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(fixture, 'project-')))
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("native offline commands must not execute config")')
    await writeFile(join(cwd, 'icons.json'), JSON.stringify({ prefix: 'brand', icons: { home: { body: '<path d="M0 0h16v16z"/>' } } }))
  })

  afterAll(async () => {
    if (fixture) {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  async function run(args: string[], entry = executable) {
    return new Promise<{ code: number | string | null, stdout: string, stderr: string }>((resolveRun, reject) => {
      const child = execFile(node, ['--experimental-strip-types', entry, ...args], {
        cwd,
        timeout: 10000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          npm_package_version: 'unrelated-consumer',
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
          // Strip only Node 22.13's known type-stripping warning, retaining
          // all other warnings and command diagnostics for assertions.
          const commandStderr = stderr.replace(/^\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/m, '')
          resolveRun({ code: error?.code ?? 0, stdout, stderr: commandStderr })
        }
      })
      child.stdin?.end()
    })
  }

  it('loads help directly from raw source without CLI dist', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`iconctl/${version}`)
    expect(result.stdout).toContain('preview')
    expect(result.stdout).toContain('sprite')
    expect(result.stdout).toContain('types')
    expect(result.stdout).toContain('init')
  })

  it.each(['--version', '-v'])('reads its own metadata for %s from an unrelated cwd', async (flag) => {
    const result = await run([flag])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(`iconctl/${version} ${process.platform}-${process.arch} node-${nodeVersion}`)
  })

  it('keeps the source library facade side-effect-free', async () => {
    const result = await run([], join(fixture, 'cli', 'src', 'index.ts'))
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('runs offline preview and init dry-runs without configuration, credentials or writes', async () => {
    const preview = await run(['preview', '--input', 'icons.json', '--output', 'new/preview.html', '--dry-run', '--json'])
    expect(preview.code).toBe(0)
    expect(preview.stderr).toBe('')
    expect(JSON.parse(preview.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 1, outputFiles: [], dryRun: true })
    const init = await run(['init', '--source', 'directory', '--input', './raw-svg', '--prefix', 'brand', '--config', 'new/config.ts', '--no-interactive', '--dry-run', '--json'])
    expect(init.code).toBe(0)
    expect(init.stderr).toBe('')
    expect(JSON.parse(init.stdout)).toEqual({ configFile: join(cwd, 'new/config.ts'), sourceType: 'directory', prefix: 'brand', outputFiles: [], dryRun: true })
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
  })

  it('emits one JSON error for failed native command arguments', async () => {
    const result = await run(['preview', '--input', '--json'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, command: 'preview', error: { phase: 'arguments' } })
    expect(result.stdout).not.toContain('must not execute config')
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
  })

  it('runs the raw native sprite command with exact bytes, summary and no configuration', async () => {
    await writeFile(join(cwd, 'icons.json'), JSON.stringify(spriteFixture))
    const dry = await run(['sprite', '--input', 'icons.json', '--output', 'new/icons.svg', '--dry-run', '--json'])
    expect(dry.code).toBe(0)
    expect(dry.stderr).toBe('')
    expect(JSON.parse(dry.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 8, outputFiles: [], dryRun: true })
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
    const result = await run(['sprite', '--input', 'icons.json', '--json'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 8, outputFiles: [join(cwd, 'icons.svg')] })
    expect(await readFile(join(cwd, 'icons.svg'), 'utf8')).toBe(await renderSvgSprite(spriteFixture))
    const failure = await run(['sprite', '--input', 'icons.json', '--output', 'icons.json', '--dry-run', '--json'])
    expect(failure.code).toBe(1)
    expect(failure.stderr).toBe('')
    expect(JSON.parse(failure.stdout)).toMatchObject({ success: false, command: 'sprite', error: { phase: 'execution' } })
    expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(JSON.stringify(spriteFixture))
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json', 'icons.svg'])
  })

  it('generates types through raw native source with dry-run and input protection', async () => {
    await writeFile(join(cwd, 'icons.json'), JSON.stringify(spriteFixture))
    const dry = await run(['types', '--input', 'icons.json', '--output', 'new/icons.d.ts', '--dry-run', '--json'])
    expect(dry).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(dry.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 8, outputFiles: [], dryRun: true })
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.json'])
    const result = await run(['types', '--input', 'icons.json', '--json'])
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({ input: { file: join(cwd, 'icons.json'), prefix: 'brand' }, count: 8, outputFiles: [join(cwd, 'icons.d.ts')] })
    expect(await readFile(join(cwd, 'icons.d.ts'), 'utf8')).toBe(renderIconNameTypes(spriteFixture))
    const failure = await run(['types', '--input', 'icons.json', '--output', 'icons.json', '--json'])
    expect(failure).toMatchObject({ code: 1, stderr: '' })
    expect(JSON.parse(failure.stdout)).toMatchObject({ success: false, command: 'types', error: { phase: 'execution' } })
    expect(await readFile(join(cwd, 'icons.json'), 'utf8')).toBe(JSON.stringify(spriteFixture))
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs', 'icons.d.ts', 'icons.json'])
  })

  it('prints a human configuration failure once', async () => {
    await rm(join(cwd, 'iconctl.config.mjs'))
    const result = await run(['sync'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.match(/No iconctl config found/g)).toHaveLength(1)
    expect(result.stderr).not.toMatch(/at .*\.ts|UnhandledPromiseRejection/)
  })
})

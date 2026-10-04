import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from '@iconctl/core'
import { consola } from 'consola'
import { reportCliError } from '../src/failure'
import { InitCancelledError } from '../src/init'
import { runCli } from '../src/program'

const sources = [
  ['directory', './raw-svg'],
  ['iconify', './vendor/icons.json'],
  ['figma', 'https://www.figma.com/design/abcdefghij/Icons'],
  ['mastergo', 'https://mastergo.com/file/123?layer_id=4%3A5'],
  ['iconfont', './iconfont'],
  ['jsdesign', './jsdesign-svg'],
] as const

describe('safe init', () => {
  let cwd: string
  let previous: string
  let writes: string[]
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  function tty(value: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
  }
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-init-')))
    previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    tty(false)
    writes = []
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      writes.push(String(text))
      return true
    })
    vi.spyOn(consola, 'prompt').mockRejectedValue(new Error('Unexpected prompt'))
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.spyOn(consola, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    process.chdir(previous)
    process.exitCode = 0
    vi.restoreAllMocks()
    for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
      if (descriptor) {
        Object.defineProperty(stream, 'isTTY', descriptor)
      }
      else {
        Reflect.deleteProperty(stream, 'isTTY')
      }
    }
    await rm(cwd, { recursive: true, force: true })
  })
  const args = ['--source', 'directory', '--input', './raw-svg', '--prefix', 'brand']
  function init(...options: string[]) {
    return runCli(['node', 'iconctl', 'init', ...options])
  }
  function report() {
    expect(writes).toHaveLength(1)
    expect(consola.error).not.toHaveBeenCalled()
    return JSON.parse(writes[0]!)
  }
  async function generated(file = 'iconctl.config.ts') {
    const source = await readFile(join(cwd, file), 'utf8')
    const code = source.replace('import { defineConfig } from \'iconctl\'', '').replace('export default defineConfig(', 'result = (')
    const sandbox = { result: undefined }
    runInNewContext(code, sandbox)
    return resolveConfig(sandbox.result!)
  }

  it.each(sources)('generates a valid %s config from explicit flags without a prompt', async (type, input) => {
    await init('--source', type, '--input', input, '--prefix', 'brand', '--json-output', 'generated/icons.json', '--config', 'config/brand.ts', '--no-interactive', '--json')
    expect(report()).toEqual({ configFile: join(cwd, 'config/brand.ts'), sourceType: type, prefix: 'brand', outputFiles: [join(cwd, 'config/brand.ts')] })
    const config = await generated('config/brand.ts')
    expect(config.sources[0]!.type).toBe(type)
    expect(config.output.json).toBe('generated/icons.json')
    expect(config.validate.width).toBe(type === 'iconify' ? undefined : 24)
    expect(config.sources[0]).toMatchObject(type === 'mastergo' ? { fileId: '123', layerId: '4:5' } : {})
    expect(consola.prompt).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual(['config'])
    expect(await readdir(join(cwd, 'config'))).toEqual(['brand.ts'])
  })

  it('generates the remote iconfont branch and safely escapes source strings', async () => {
    const url = 'https://example.invalid/symbol.js?label="图标"&path=\\folder'
    await init('--source', 'iconfont', '--url', url, '--prefix', 'brand', '--json')
    expect((await generated()).sources[0]).toMatchObject({ type: 'iconfont', url, stripPrefix: 'icon-' })
    expect(report().sourceType).toBe('iconfont')
  })

  it.each(sources)('preserves valid %s wizard answers', async (type, input) => {
    tty(true)
    const answers = [type, 'brand', 'icons.json', ...(type === 'iconfont' ? ['', input] : [input])]
    vi.mocked(consola.prompt).mockReset()
    for (const answer of answers) {
      vi.mocked(consola.prompt).mockResolvedValueOnce(answer)
    }
    await init()
    expect((await generated()).sources[0]!.type).toBe(type)
    expect(consola.prompt).toHaveBeenCalledTimes(answers.length)
    for (const [, settings] of vi.mocked(consola.prompt).mock.calls) {
      expect(settings).toMatchObject({ cancel: 'reject' })
    }
    expect(consola.success).toHaveBeenCalledOnce()
  })

  it('prompts only for missing source input and preserves explicitly supplied fields', async () => {
    tty(true)
    vi.mocked(consola.prompt).mockResolvedValueOnce('./raw-svg')
    await init('--source', 'directory', '--prefix', 'given', '--json-output', 'given.json')
    expect(consola.prompt).toHaveBeenCalledExactlyOnceWith('SVG directory', expect.objectContaining({ cancel: 'reject' }))
    expect(await generated()).toMatchObject({ prefix: 'given', output: { json: 'given.json' } })
  })

  it('keeps meaningful empty-submit defaults in the directory wizard', async () => {
    tty(true)
    vi.mocked(consola.prompt).mockReset().mockResolvedValueOnce('directory').mockResolvedValueOnce('').mockResolvedValueOnce('').mockResolvedValueOnce('')
    await init()
    expect(await generated()).toMatchObject({ prefix: 'brand', sources: [{ dir: './raw-svg' }], output: { json: 'icons.json' } })
  })

  const cancellationCases = sources.flatMap(([type, input]) => {
    const answers: string[] = [type, 'brand', 'icons.json', ...(type === 'iconfont' ? ['', input] : [input])]
    return answers.map((_, index) => ({ type, index, answers: answers.slice(0, index) }))
  })
  it.each(cancellationCases)('cancels $type prompt $index before creating directories', async ({ index, answers }) => {
    tty(true)
    const cancelled = Object.assign(new Error('cancelled'), { name: 'ConsolaPromptCancelledError' })
    vi.mocked(consola.prompt).mockReset()
    for (const answer of answers) {
      vi.mocked(consola.prompt).mockResolvedValueOnce(answer)
    }
    vi.mocked(consola.prompt).mockRejectedValueOnce(cancelled)
    await expect(init('--config', 'new/nested/config.ts')).rejects.toMatchObject({ name: 'InitCancelledError', cause: cancelled })
    expect(process.exitCode).toBe(130)
    expect(consola.prompt).toHaveBeenCalledTimes(index + 1)
    expect(consola.error).toHaveBeenCalledExactlyOnceWith('Initialization cancelled. No config was written.')
    expect(consola.success).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual([])
  })

  it('serializes explicit cancellation as one JSON without a second writer', () => {
    const error = new InitCancelledError(new Error('cause'))
    reportCliError(error, 'init', { json: true }, { phase: 'execution', exitCode: 130 })
    expect(report()).toEqual({ success: false, command: 'init', error: { name: 'InitCancelledError', message: 'Initialization cancelled. No config was written.', phase: 'execution' } })
    expect(process.exitCode).toBe(130)
  })

  it.each([undefined, null, Symbol('cancel'), 42])('rejects an invalid prompt result rather than applying defaults: %s', async (answer) => {
    tty(true)
    vi.mocked(consola.prompt).mockResolvedValueOnce(answer as never)
    await expect(init()).rejects.toThrow('Invalid answer')
    expect(await readdir(cwd)).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it.each([
    [],
    ['--source', 'directory'],
    ['--source', 'invalid'],
    [...args, '--continue'],
    [...args, '--force'],
    [...args, '--config'],
    [...args, '--source', 'iconify'],
    [...args, '--input', 'other'],
    [...args, '--json-output', ''],
    [...args, '--json-output', 'https://example.invalid/a'],
    [...args, '--config', '-'],
    [...args, '--config', 'config.json'],
    [...args, '--url', 'https://example.invalid/symbol.js'],
    ['--source', 'iconfont', '--prefix', 'brand', '--url', 'file:///symbol.js'],
    ['--source', 'figma', '--prefix', 'brand', '--input', 'invalid'],
    ['--source', 'mastergo', '--prefix', 'brand', '--input', 'https://mastergo.com/file/123'],
  ].map(options => [options]))('reports argument errors once without prompts or writes: %j', async (options) => {
    await expect(init(...options, '--json')).rejects.toThrow()
    expect(report()).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments' } })
    expect(consola.prompt).not.toHaveBeenCalled()
    expect(await readdir(cwd)).toEqual([])
  })

  it.each([false, true])('dry-run validates the plan without creating parents, interactive=%s', async (interactive) => {
    tty(interactive)
    await writeFile(join(cwd, 'iconctl.config.mjs'), 'throw new Error("must not execute")')
    await init(...args, '--json-output', 'icons.json', '--config', 'new/nested/config.ts', '--dry-run', ...(interactive ? [] : ['--json']))
    expect(await readdir(cwd)).toEqual(['iconctl.config.mjs'])
    expect(consola.prompt).not.toHaveBeenCalled()
    if (!interactive) {
      expect(report()).toEqual({ configFile: join(cwd, 'new/nested/config.ts'), sourceType: 'directory', prefix: 'brand', outputFiles: [], dryRun: true })
    }
  })

  it.each(['regular', 'directory', 'symlink', 'dangling', 'hardlink'])('preserves an existing %s target before asking any question', async (kind) => {
    tty(true)
    const target = join(cwd, 'iconctl.config.ts')
    const original = join(cwd, 'original.ts')
    const contents = 'throw new Error("never execute or overwrite")'
    if (kind === 'directory') {
      await mkdir(target)
    }
    else if (kind === 'regular') {
      await writeFile(target, contents)
    }
    else {
      if (kind !== 'dangling') {
        await writeFile(original, contents)
      }
      await (kind === 'hardlink' ? link(original, target) : symlink(original, target))
    }
    const before = await lstat(target)
    await expect(init()).rejects.toThrow('Config already exists')
    expect((await lstat(target)).ino).toBe(before.ino)
    if (kind === 'regular' || kind === 'symlink' || kind === 'hardlink') {
      expect(await readFile(target, 'utf8')).toBe(contents)
    }
    expect(consola.prompt).not.toHaveBeenCalled()
    expect(consola.success).not.toHaveBeenCalled()
  })

  it('uses a single canonical parent for a symlinked config directory', async () => {
    await mkdir(join(cwd, 'actual'))
    await symlink(join(cwd, 'actual'), join(cwd, 'alias'))
    await init(...args, '--config', 'alias/nested/config.ts', '--json')
    expect(report().configFile).toBe(join(cwd, 'actual/nested/config.ts'))
    expect(await readdir(join(cwd, 'actual/nested'))).toEqual(['config.ts'])
  })

  it.each([
    [...args, '--config', 'abc.ts', '--json-output', 'ABC.TS'],
    [...args, '--config', 'SVG/config.ts'],
    ['--source', 'directory', '--input', 'SVG', '--prefix', 'brand'],
    ['--source', 'iconify', '--input', 'SVG/source.json', '--prefix', 'brand'],
    ['--source', 'iconify', '--input', 'PREVIEW.HTML', '--prefix', 'brand'],
  ].map(options => [options]))('uses platform case rules for future paths without probing writes: %j', async (options) => {
    const result = init(...options, '--json', '--dry-run')
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await expect(result).rejects.toThrow(/conflicts|overlaps/)
      expect(report()).toMatchObject({ success: false, command: 'init', error: { phase: 'arguments' } })
    }
    else {
      await expect(result).resolves.toBeUndefined()
      expect(report()).toMatchObject({ dryRun: true, outputFiles: [] })
    }
    expect(await readdir(cwd)).toEqual([])
  })

  it.each(['json', 'iconify', 'dangling-output', 'hardlinked-input-output', 'svg-directory', 'config-in-svg', 'iconify-in-svg', 'iconify-preview'])('rejects planned aliases: %s', async (kind) => {
    let options = args
    if (kind === 'json') {
      options = [...args, '--json-output', 'iconctl.config.ts']
    }
    if (kind === 'iconify') {
      options = ['--source', 'iconify', '--input', 'iconctl.config.ts', '--prefix', 'brand']
    }
    if (kind === 'dangling-output') {
      await symlink(join(cwd, 'iconctl.config.ts'), join(cwd, 'icons.json'))
    }
    if (kind === 'hardlinked-input-output') {
      await writeFile(join(cwd, 'vendor.json'), 'keep')
      await link(join(cwd, 'vendor.json'), join(cwd, 'icons.json'))
      options = ['--source', 'iconify', '--input', 'vendor.json', '--prefix', 'brand']
    }
    if (kind === 'svg-directory') {
      options = ['--source', 'directory', '--input', './svg', '--prefix', 'brand']
    }
    if (kind === 'config-in-svg') {
      options = [...args, '--config', 'svg/config.ts']
    }
    if (kind === 'iconify-in-svg' || kind === 'iconify-preview') {
      options = ['--source', 'iconify', '--input', kind === 'iconify-in-svg' ? 'svg/source.json' : 'preview.html', '--prefix', 'brand']
    }
    const before = await readdir(cwd)
    await expect(init(...options, '--json', '--dry-run')).rejects.toThrow(/conflicts|overlaps/)
    expect(report()).toMatchObject({ success: false, error: { phase: 'arguments' } })
    expect(await readdir(cwd)).toEqual(before)
  })
})

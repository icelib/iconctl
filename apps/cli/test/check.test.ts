import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { runCli } from '../src/program'

const body = '<path d="M0 0h16v16H0z"/>'

describe('standalone check command', () => {
  let cwd: string
  let previous: string
  let output: string
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-cli-check-'))
    previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('Unexpected network request')
    }))
    await writeFile(path.join(cwd, 'icons.json'), JSON.stringify({ prefix: 'vendor', icons: { home: { body } }, aliases: { copy: { parent: 'home' } } }))
  })
  afterEach(async () => {
    process.chdir(previous)
    process.exitCode = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it.each([false, true])('checks local input when a throwing config exists: %s', async (withConfig) => {
    if (withConfig) {
      await writeFile(path.join(cwd, 'iconctl.config.ts'), 'throw new Error("Config must not execute")')
    }
    const files = await readdir(cwd)
    const contents = await readFile(path.join(cwd, 'icons.json'), 'utf8')
    await runCli(['node', 'iconctl', 'check', '--input', 'icons.json', '--width', '16', '--height', '16', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'vendor', count: 2, source: 'json', valid: true, issues: [] })
    expect(process.exitCode).toBe(0)
    expect(await readFile(path.join(cwd, 'icons.json'), 'utf8')).toBe(contents)
    expect(await readdir(cwd)).toEqual(files)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts a regex source and fractional dimensions', async () => {
    await writeFile(path.join(cwd, 'icons.json'), JSON.stringify({ prefix: 'vendor', width: 16.5, height: 8.25, icons: { Bad_Name: { body } } }))
    await runCli(['node', 'iconctl', 'check', '--input', 'icons.json', '--name', '^Bad_Name$', '--width', '16.5', '--height', '8.25', '--json'])
    expect(JSON.parse(output)).toMatchObject({ count: 1, valid: true })
  })

  it('emits one complete failure report including all stages and exits nonzero', async () => {
    await writeFile(path.join(cwd, 'icons.json'), JSON.stringify({ prefix: 'vendor', icons: { home: { body }, unsafe: { body: '<script>never()</script>' }, invalid: { body: 1 } } }))
    await expect(runCli(['node', 'iconctl', 'check', '--input', 'icons.json', '--width', '24', '--json'])).rejects.toThrow(/Icon validation failed/)
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ prefix: 'vendor', count: 3, source: 'json', valid: false, issues: [expect.objectContaining({ name: 'invalid', stage: 'import' }), expect.objectContaining({ name: 'unsafe', stage: 'process' }), expect.objectContaining({ name: 'home', stage: 'validation' })] })
  })

  it.each([
    ['--width', 'invalid'],
    ['--width', '0'],
    ['--height', '-1'],
    ['--height', 'Infinity'],
    ['--name', '['],
    ['--config', 'iconctl.config.ts'],
  ])('reports invalid %s %s in JSON before reading config', async (flag, value) => {
    await writeFile(path.join(cwd, 'iconctl.config.ts'), 'throw new Error("Config must not execute")')
    await expect(runCli(['node', 'iconctl', 'check', '--input', 'icons.json', flag, value, '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ valid: false, issues: [expect.objectContaining({ stage: 'options' })] })
    expect(output).not.toContain('Config must not execute')
  })

  it('still checks configured output and applies explicit rule overrides', async () => {
    const configFile = path.join(cwd, 'iconctl.config.mjs')
    await writeFile(configFile, `export default ${JSON.stringify({ prefix: 'brand', sources: [{ type: 'directory', dir: 'missing-source' }], output: { json: 'icons.json' }, validate: { width: 24 } })}`)
    await runCli(['node', 'iconctl', 'check', '--config', configFile, '--width', '16', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'vendor', count: 2, source: 'json', valid: true, issues: [] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a missing option value through the same JSON boundary', async () => {
    await expect(runCli(['node', 'iconctl', 'check', '--input', 'icons.json', '--width', '--json'])).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ valid: false, issues: [expect.objectContaining({ stage: 'options' })] })
  })
})

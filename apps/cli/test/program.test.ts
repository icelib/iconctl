import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { consola } from 'consola'
import { runCli } from '../src/program'

describe('cli', () => {
  it('prints help without throwing', async () => {
    await expect(runCli(['node', 'iconctl', '--help'])).resolves.toBeUndefined()
  })

  it('fails check without a config', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-cli-'))
    await writeFile(path.join(cwd, 'package.json'), '{"name":"tmp"}')
    const previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    try {
      await expect(runCli(['node', 'iconctl', 'check'])).rejects.toThrow(/config/)
    }
    finally {
      process.chdir(previous)
      process.exitCode = 0
    }
  })
})

describe('sync failure reporting', () => {
  let cwd: string
  let configFile: string
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-cli-failures-'))
    configFile = path.join(cwd, 'iconctl.config.mjs')
    const sourceDir = path.join(cwd, 'source')
    await mkdir(sourceDir)
    await writeFile(path.join(sourceDir, 'good.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')
    await writeFile(path.join(sourceDir, 'bad.svg'), 'not an SVG')
    await writeFile(configFile, `export default ${JSON.stringify({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: sourceDir }],
      output: { json: path.join(cwd, 'icons.json'), preview: path.join(cwd, 'preview.html') },
    })}`)
    process.exitCode = 0
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    process.exitCode = 0
    await rm(cwd, { recursive: true, force: true })
  })

  it('exits nonzero and writes no outputs for an import failure', async () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    await expect(runCli(['node', 'iconctl', 'sync', '--config', configFile, '--json'])).rejects.toThrow(/bad/)
    expect(process.exitCode).toBe(1)
    await expect(readFile(path.join(cwd, 'icons.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['sync', 'preview'])('warns visibly when %s continues with a partial result', async (command) => {
    const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
    await runCli(['node', 'iconctl', command, '--config', configFile, '--continue'])
    expect(process.exitCode).toBe(0)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Incomplete sync'))
    expect(warning).toHaveBeenCalledWith('skipped: bad')
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/^bad \[import\]: Cannot import/))
    expect(success).not.toHaveBeenCalled()
  })

  it('preserves the JSON skipped and issues fields for continued failures', async () => {
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      output += String(text)
      return true
    })
    const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    await runCli(['node', 'iconctl', 'sync', '--config', configFile, '--continue', '--json'])
    expect(process.exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      skipped: ['bad'],
      issues: [{ name: 'bad', message: expect.stringContaining('Cannot import') }],
      added: ['good'],
      outputFiles: [path.join(cwd, 'icons.json'), path.join(cwd, 'preview.html')],
    })
    expect(warning).not.toHaveBeenCalled()
  })
})

import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/program'

describe('cli', () => {
  it('prints help without throwing', async () => {
    await expect(runCli(['node', 'figma-iconify', '--help'])).resolves.toBeUndefined()
  })

  it('fails check without a config', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'figma-iconify-cli-'))
    await writeFile(path.join(cwd, 'package.json'), '{"name":"tmp"}')
    const previous = process.cwd()
    process.chdir(cwd)
    process.exitCode = 0
    try {
      await expect(runCli(['node', 'figma-iconify', 'check'])).rejects.toThrow(/config/)
    }
    finally {
      process.chdir(previous)
      process.exitCode = 0
    }
  })
})

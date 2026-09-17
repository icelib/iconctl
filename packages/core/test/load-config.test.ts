import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FigmaIconifyError, loadConfig } from '../src'

describe('loadConfig', () => {
  it('throws when the config file does not exist', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'figma-iconify-config-'))
    await expect(loadConfig({
      cwd,
      configFile: path.join(cwd, 'missing.config.ts'),
    })).rejects.toThrow(FigmaIconifyError)
  })

  it('loads a config file', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'figma-iconify-config-'))
    const file = path.join(cwd, 'figma-iconify.config.ts')
    await writeFile(file, `export default { file: 'AbCdEfGhIjKlMnOpQrStUv', prefix: 'brand' }\n`)
    const config = await loadConfig({ cwd, configFile: file })
    expect(config.prefix).toBe('brand')
    expect(config.file).toBe('AbCdEfGhIjKlMnOpQrStUv')
  })
})

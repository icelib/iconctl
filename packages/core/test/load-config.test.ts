import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IconctlError, loadConfig } from '../src'

describe('loadConfig', () => {
  it('throws when the config file does not exist', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-config-'))
    await expect(loadConfig({
      cwd,
      configFile: path.join(cwd, 'missing.config.ts'),
    })).rejects.toThrow(IconctlError)
  })

  it('loads a config file', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-config-'))
    const file = path.join(cwd, 'iconctl.config.ts')
    await writeFile(file, `export default {
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
}
`)
    const config = await loadConfig({ cwd, configFile: file })
    expect(config.prefix).toBe('brand')
    expect(config.sources[0]).toMatchObject({ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' })
  })
})

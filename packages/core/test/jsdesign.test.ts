import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IconctlError, resolveConfig, sync } from '../src'
import { JSDESIGN_REMOTE_HELP } from '../src/sources/jsdesign'

const fixtureSvgDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('jsdesign', () => {
  it('loads an exported svg folder', async () => {
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'jsdesign', dir: fixtureSvgDir }],
      output: { json: 'icons.json' },
    })
    const result = await sync({ cwd: await mkdtemp(path.join(os.tmpdir(), 'iconctl-jsd-')), config })
    expect(result.sources[0]?.type).toBe('jsdesign')
    expect(result.diff.added.sort()).toEqual(['arrow-left', 'user'])
  })

  it('rejects a remote js.design URL', async () => {
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'jsdesign', file: 'https://js.design/f/abc123' }],
    })
    await expect(sync({ cwd: import.meta.dirname, config })).rejects.toThrow(IconctlError)
    await expect(sync({ cwd: import.meta.dirname, config })).rejects.toThrow(JSDESIGN_REMOTE_HELP)
  })
})

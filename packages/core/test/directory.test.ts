import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IconctlError, resolveConfig, sync } from '../src'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#111111" d="M0 0h24v24H0z"/></svg>`

async function writeSvgDir(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iconctl-dir-'))
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(path.join(dir, name), contents, 'utf8')))
  return dir
}

describe('directory source', () => {
  it('converts mixed filenames to kebab-case', async () => {
    const dir = await writeSvgDir({
      'Arrow Left.svg': svg,
      'userFilled.svg': svg,
    })
    const result = await sync({
      cwd: await mkdtemp(path.join(os.tmpdir(), 'iconctl-out-')),
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir }],
        output: { json: 'icons.json' },
      }),
    })
    expect(Object.keys(result.json.icons).sort()).toEqual(['arrow-left', 'user-filled'])
  })

  it('skips draft prefixes', async () => {
    const dir = await writeSvgDir({
      'arrow-left.svg': svg,
      '_draft.svg': svg,
      '.hidden.svg': svg,
    })
    const result = await sync({
      cwd: await mkdtemp(path.join(os.tmpdir(), 'iconctl-out-')),
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir }],
        output: { json: 'icons.json' },
      }),
    })
    expect(Object.keys(result.json.icons)).toEqual(['arrow-left'])
  })

  it('throws IconctlError when the directory is missing', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-out-'))
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: './no-such-svg-dir' }],
    })
    await expect(sync({ cwd, config })).rejects.toThrow(IconctlError)
    await expect(sync({ cwd, config })).rejects.toThrow(/does not exist/)
  })
})

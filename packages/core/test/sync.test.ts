import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { importLocalSvgDirectory, resolveConfig, sync } from '../src'

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('sync', () => {
  it('exports json from a directory source without calling Figma', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-'))
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: fixtureDir }],
      output: {
        json: 'icons.json',
        svg: 'svg',
        types: 'icon-names.d.ts',
        preview: 'preview.html',
      },
    })
    const result = await sync({ cwd, config })
    const json = JSON.parse(await readFile(path.join(cwd, 'icons.json'), 'utf8')) as { prefix: string, icons: Record<string, { body: string }> }

    expect(result.notModified).toBe(false)
    expect(result.sources).toEqual([{ type: 'directory', notModified: false }])
    expect(result.diff.added.sort()).toEqual(['arrow-left', 'user'])
    expect(json.prefix).toBe('brand')
    expect(json.icons['arrow-left']?.body).toContain('currentColor')
    expect(await readFile(path.join(cwd, 'icon-names.d.ts'), 'utf8')).toContain('\'arrow-left\'')
    expect(await readFile(path.join(cwd, 'preview.html'), 'utf8')).toContain('brand:arrow-left')
  })

  it('creates parent directories for json output', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-'))
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: fixtureDir }],
      output: { json: 'nested/out/icons.json' },
    })
    await sync({ cwd, config })
    const json = JSON.parse(await readFile(path.join(cwd, 'nested/out/icons.json'), 'utf8')) as { prefix: string }
    expect(json.prefix).toBe('brand')
  })

  it('still accepts a preloaded icon set', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-'))
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: fixtureDir }],
      output: { json: 'icons.json' },
    })
    const iconSet = await importLocalSvgDirectory(fixtureDir, 'brand')
    const result = await sync({ cwd, config, iconSet })
    expect(result.diff.added.sort()).toEqual(['arrow-left', 'user'])
  })
})

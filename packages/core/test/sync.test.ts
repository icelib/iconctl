import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { importLocalSvgDirectory, resolveConfig, sync } from '../src'

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('sync', () => {
  it('exports json from a local icon set without calling Figma', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'figma-iconify-'))
    const config = resolveConfig({
      file: 'AbCdEfGhIjKlMnOpQrStUv',
      prefix: 'brand',
      output: {
        json: 'icons.json',
        svg: 'svg',
        types: 'icon-names.d.ts',
        preview: 'preview.html',
      },
    })
    const iconSet = await importLocalSvgDirectory(fixtureDir, 'brand')
    const result = await sync({ cwd, config, iconSet })
    const json = JSON.parse(await readFile(path.join(cwd, 'icons.json'), 'utf8')) as { prefix: string, icons: Record<string, { body: string }> }

    expect(result.notModified).toBe(false)
    expect(result.diff.added.sort()).toEqual(['arrow-left', 'user'])
    expect(json.prefix).toBe('brand')
    expect(json.icons['arrow-left']?.body).toContain('currentColor')
    expect(await readFile(path.join(cwd, 'icon-names.d.ts'), 'utf8')).toContain('\'arrow-left\'')
    expect(await readFile(path.join(cwd, 'preview.html'), 'utf8')).toContain('brand:arrow-left')
  })
})

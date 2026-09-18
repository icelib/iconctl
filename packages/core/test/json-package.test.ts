import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, resolveJsonPackage, sync } from '../src'

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('jsonPackage output', () => {
  it('normalizes a string to @iconify-json/{prefix}', () => {
    expect(resolveJsonPackage('brand', 'packages/icons')).toEqual({
      dir: 'packages/icons',
      name: '@iconify-json/brand',
      clean: true,
    })
  })

  it('exports an Iconify JSON package', async () => {
    const outDir = path.join(os.tmpdir(), `iconctl-jp-${Date.now()}`)
    await mkdir(outDir, { recursive: true })
    const result = await sync({
      cwd: outDir,
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir: fixtureDir }],
        output: { json: 'icons.json', jsonPackage: 'icon-json' },
      }),
    })
    const pkg = JSON.parse(await readFile(path.join(outDir, 'icon-json/package.json'), 'utf8')) as { name: string }
    const json = JSON.parse(await readFile(path.join(outDir, 'icon-json/icons.json'), 'utf8')) as { prefix: string }
    expect(pkg.name).toBe('@iconify-json/brand')
    expect(json.prefix).toBe('brand')
    expect(result.files.some(file => file.endsWith('icon-json'))).toBe(true)
  })

  it('keeps sibling files when clean is false', async () => {
    const cwd = path.join(os.tmpdir(), `iconctl-jp-keep-${Date.now()}`)
    const pkgDir = path.join(cwd, 'pkg')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(path.join(pkgDir, 'KEEP.md'), 'keep', 'utf8')
    await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@acme/icons', version: '1.2.3', private: true }), 'utf8')

    await sync({
      cwd,
      config: resolveConfig({
        prefix: 'brand',
        sources: [{ type: 'directory', dir: fixtureDir }],
        output: {
          json: 'icons.json',
          jsonPackage: {
            dir: 'pkg',
            name: '@acme/icons',
            clean: false,
          },
        },
      }),
    })

    expect(await readFile(path.join(pkgDir, 'KEEP.md'), 'utf8')).toBe('keep')
    const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8')) as { name: string, version: string, private?: boolean }
    expect(pkg.name).toBe('@acme/icons')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.private).toBe(true)
  })
})

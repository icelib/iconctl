import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseIconfontSymbolJs, resolveConfig, stripIconPrefix, symbolToSvg, sync, writeIconfontJsToDirectory } from '../src'
import { loadIconfontSource } from '../src/sources/iconfont'

const fixtureJs = path.resolve(import.meta.dirname, 'fixtures/iconfont/symbol.js')
const fixtureSvgDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('iconfont', () => {
  it('parses symbol ids and strips the default prefix', async () => {
    const js = await readFile(fixtureJs, 'utf8')
    const symbols = parseIconfontSymbolJs(js)
    expect(symbols.map(item => item.id)).toEqual(['icon-arrow-left', 'icon-user'])
    expect(symbolToSvg(symbols[0]!)).toContain('viewBox="0 0 1024 1024"')
    expect(stripIconPrefix('icon-arrow-left', 'icon-')).toBe('arrow-left')
  })

  it('loads a symbol script through fetch', async () => {
    const js = await readFile(fixtureJs, 'utf8')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(js, { status: 200 })) as typeof fetch
    try {
      const loaded = await loadIconfontSource(
        { type: 'iconfont', url: 'https://at.alicdn.com/t/c/font_test.js', stripPrefix: 'icon-' },
        { cwd: import.meta.dirname, prefix: 'brand' },
      )
      expect(Object.keys(loaded.iconSet?.export().icons ?? {}).sort()).toEqual(['arrow-left', 'user'])
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('loads a local svg folder as an iconfont source', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-iconfont-'))
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'iconfont', dir: fixtureSvgDir, stripPrefix: '' }],
      output: { json: 'icons.json' },
    })
    const result = await sync({ cwd, config })
    expect(result.sources[0]?.type).toBe('iconfont')
    expect(result.diff.added.sort()).toEqual(['arrow-left', 'user'])
  })

  it('writes selected symbols into a directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'iconctl-iconfont-raw-'))
    const js = await readFile(fixtureJs, 'utf8')
    const names = await writeIconfontJsToDirectory(js, dir, { only: ['user'] })
    expect(names).toEqual(['user'])
    const svg = await readFile(path.join(dir, 'user.svg'), 'utf8')
    expect(svg).toContain('viewBox="0 0 1024 1024"')
    await expect(readFile(path.join(dir, 'arrow-left.svg'), 'utf8')).rejects.toThrow()
  })
})

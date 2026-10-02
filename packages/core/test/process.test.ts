import path from 'node:path'
import { IconSet } from '@iconify/tools'
import { importLocalSvgDirectory, processIconSet, resolveConfig, validateIconSet } from '../src'

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('processIconSet', () => {
  it('rewrites fills to currentColor and keeps valid names', async () => {
    const config = resolveConfig({
      prefix: 'brand',
      sources: [{ type: 'directory', dir: fixtureDir }],
      validate: { width: 24, height: 24 },
    })
    const iconSet = await importLocalSvgDirectory(fixtureDir, 'brand')
    const processed = processIconSet(iconSet, config)
    const json = iconSet.export()

    expect(processed.failed).toEqual([])
    expect(processed.issues).toEqual([])
    expect(Object.keys(json.icons).sort()).toEqual(['arrow-left', 'user'])
    expect(json.icons['arrow-left']?.body).toContain('currentColor')
    expect(json.icons['arrow-left']?.body).not.toContain('#111111')

    const { issues } = validateIconSet(iconSet, config)
    expect(issues).toEqual([])
  })

  it('reports SVG cleanup failures and preserves the remaining icons', () => {
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: fixtureDir }] })
    const iconSet = new IconSet({
      prefix: 'brand',
      width: 24,
      height: 24,
      icons: {
        good: { body: '<path d="M0 0h24v24H0z"/>' },
        bad: { body: '<script>throw new Error("not executed")</script>' },
      },
    })
    const result = processIconSet(iconSet, config)
    expect(result.processed).toBe(1)
    expect(result.failed).toEqual(['bad'])
    expect(result.issues).toEqual([{ name: 'bad', message: expect.stringContaining('cleaning SVG') }])
    expect(iconSet.list()).toEqual(['good'])
  })

  it.each(['missing', 'throws'])('reports an icon whose SVG conversion %s', async (failure) => {
    const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: fixtureDir }] })
    const iconSet = await importLocalSvgDirectory(fixtureDir, 'brand')
    const toSvg = iconSet.toSVG.bind(iconSet)
    vi.spyOn(iconSet, 'toSVG').mockImplementation((name) => {
      if (name !== 'user') {
        return toSvg(name)
      }
      if (failure === 'throws') {
        throw new Error('Cannot construct SVG')
      }
      return null
    })
    const result = processIconSet(iconSet, config)
    expect(result.processed).toBe(1)
    expect(result.failed).toEqual(['user'])
    expect(result.issues).toEqual([{ name: 'user', message: expect.stringContaining('reading SVG') }])
  })
})

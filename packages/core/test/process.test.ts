import path from 'node:path'
import { importLocalSvgDirectory, processIconSet, resolveConfig, validateIconSet } from '../src'

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/svg')

describe('processIconSet', () => {
  it('rewrites fills to currentColor and keeps valid names', async () => {
    const config = resolveConfig({
      file: 'AbCdEfGhIjKlMnOpQrStUv',
      prefix: 'brand',
      validate: { width: 24, height: 24 },
    })
    const iconSet = await importLocalSvgDirectory(fixtureDir, 'brand')
    const processed = processIconSet(iconSet, config)
    const json = iconSet.export()

    expect(processed.failed).toEqual([])
    expect(Object.keys(json.icons).sort()).toEqual(['arrow-left', 'user'])
    expect(json.icons['arrow-left']?.body).toContain('currentColor')
    expect(json.icons['arrow-left']?.body).not.toContain('#111111')

    const { issues } = validateIconSet(iconSet, config)
    expect(issues).toEqual([])
  })
})

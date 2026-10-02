import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { blankIconSet, SVG } from '@iconify/tools'
import { exportOutputs, IconctlAbortError, resolveConfig, sync } from '../src'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
let cwd: string
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h12v24H0z"/></svg>'
function iconSet() {
  const set = blankIconSet('fixture')
  set.fromSVG('first', new SVG(svg))
  set.fromSVG('second', new SVG(svg))
  return set
}
function config() {
  return resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: '.' }], output: { json: 'icons.json', svg: 'svg', preview: 'preview.html', types: 'types.ts', jsonPackage: { dir: 'pkg', clean: false }, changelog: 'CHANGELOG.md' } })
}
const originalFiles = ['icons.json', 'svg/keep.svg', 'types.ts', 'preview.html', 'pkg/KEEP', 'pkg/package.json', 'CHANGELOG.md']
async function snapshot() {
  return await Promise.all(originalFiles.map(file => fs.readFile(join(cwd, file), 'utf8')))
}
async function stagedFiles() {
  return (await fs.readdir(cwd, { recursive: true })).filter(file => file.includes('.iconctl-stage-'))
}
beforeEach(async () => {
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.writeFile).mockImplementation(actual.writeFile)
  cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'iconctl-output-')))
  await fs.mkdir(join(cwd, 'svg'))
  await fs.mkdir(join(cwd, 'pkg'))
  for (const file of originalFiles) {
    await fs.writeFile(join(cwd, file), file === 'pkg/package.json' ? JSON.stringify({ name: '@test/icons', version: '1.2.3', private: true }) : `old-${file}`)
  }
})
afterEach(async () => {
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.writeFile).mockImplementation(actual.writeFile)
  await fs.rm(cwd, { recursive: true, force: true })
})

it('cancels temporary SVG generation and leaves all previous outputs intact', async () => {
  const before = await snapshot()
  const controller = new AbortController()
  let stagedWrites = 0
  vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
    await actual.writeFile(...args)
    if (String(args[0]).includes('.iconctl-stage-')) {
      stagedWrites++
      if (String(args[0]).endsWith('first.svg')) {
        controller.abort()
      }
    }
  })
  await expect(sync({ cwd, config: config(), iconSet: iconSet(), signal: controller.signal })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(await snapshot()).toEqual(before)
  expect(await stagedFiles()).toEqual([])
  const count = stagedWrites
  await setImmediate()
  expect(stagedWrites).toBe(count)
})

it('finishes a started commit even when cancellation arrives during replacement', async () => {
  const controller = new AbortController()
  vi.mocked(fs.rename).mockImplementation(async (...args) => {
    await actual.rename(...args)
    if (String(args[1]).endsWith('/backup')) {
      controller.abort()
    }
  })
  const result = await sync({ cwd, config: config(), iconSet: iconSet(), signal: controller.signal })
  expect(controller.signal.aborted).toBe(true)
  expect(result.complete).toBe(true)
  expect(JSON.parse(await fs.readFile(join(cwd, 'icons.json'), 'utf8')).icons).toHaveProperty('second')
  expect(await fs.readFile(join(cwd, 'svg/second.svg'), 'utf8')).toContain('<svg')
  expect(await fs.readFile(join(cwd, 'pkg/KEEP'), 'utf8')).toBe('old-pkg/KEEP')
  expect(await stagedFiles()).toEqual([])
})

it('rolls back earlier replacements when a later replacement fails', async () => {
  const before = await snapshot()
  let failed = false
  vi.mocked(fs.rename).mockImplementation(async (...args) => {
    if (!failed && String(args[0]).endsWith('/output') && String(args[1]) === join(cwd, 'svg')) {
      failed = true
      throw new Error('simulated disk failure')
    }
    await actual.rename(...args)
  })
  await expect(sync({ cwd, config: config(), iconSet: iconSet() })).rejects.toThrow('previous outputs were restored')
  expect(await snapshot()).toEqual(before)
  expect(await stagedFiles()).toEqual([])
})

it('preserves recoverable backups and reports their location if rollback also fails', async () => {
  vi.mocked(fs.rename).mockImplementation(async (...args) => {
    if (String(args[1]) === join(cwd, 'svg')) {
      throw new Error('simulated persistent disk failure')
    }
    await actual.rename(...args)
  })
  await expect(sync({ cwd, config: config(), iconSet: iconSet() })).rejects.toThrow('Recover backups from:')
  const backup = (await stagedFiles()).find(file => file.endsWith('/backup/keep.svg'))
  expect(backup).toBeDefined()
  expect(await fs.readFile(join(cwd, backup!), 'utf8')).toBe('old-svg/keep.svg')
})

it('does not touch outputs if generation fails', async () => {
  const before = await snapshot()
  vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
    if (String(args[0]).includes('.iconctl-stage-') && String(args[0]).endsWith('second.svg')) {
      throw new Error('generation failure')
    }
    await actual.writeFile(...args)
  })
  await expect(sync({ cwd, config: config(), iconSet: iconSet() })).rejects.toThrow('generation failure')
  expect(await snapshot()).toEqual(before)
  expect(await stagedFiles()).toEqual([])
})

it.each([false, true])('groups nested outputs with clean:%s', async (clean) => {
  const cfg = resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: '.' }], output: { json: 'pkg/custom.json', jsonPackage: { dir: 'pkg', clean }, svg: 'pkg/svg', types: 'pkg/types.ts', preview: 'pkg/preview.html', changelog: 'pkg/CHANGELOG.md' } })
  await fs.writeFile(join(cwd, 'pkg/CHANGELOG.md'), '# Changelog\n\n## 2020-01-01\n\n- Added: `historical`\n')
  await sync({ cwd, config: cfg, iconSet: iconSet() })
  expect(await fs.readFile(join(cwd, 'pkg/CHANGELOG.md'), 'utf8')).toContain('historical')
  for (const file of ['custom.json', 'icons.json', 'types.ts', 'preview.html', 'CHANGELOG.md', 'svg/first.svg']) {
    expect(await fs.readFile(join(cwd, 'pkg', file), 'utf8')).not.toBe('')
  }
  if (!clean) {
    expect(JSON.parse(await fs.readFile(join(cwd, 'pkg/package.json'), 'utf8'))).toMatchObject({ version: '1.2.3', private: true })
    expect(await fs.readFile(join(cwd, 'pkg/KEEP'), 'utf8')).toBe('old-pkg/KEEP')
  }
  else {
    await expect(fs.readFile(join(cwd, 'pkg/KEEP'))).rejects.toThrow()
  }
})

it('supports cancellation in the public exportOutputs helper', async () => {
  const before = await snapshot()
  await expect(exportOutputs(iconSet(), config(), { cwd, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(IconctlAbortError)
  expect(await snapshot()).toEqual(before)
})

it('preserves a nested changelog when a partial export cleans its package directory', async () => {
  const cfg = resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: '.' }], output: { json: 'pkg/custom.json', jsonPackage: 'pkg', changelog: 'pkg/CHANGELOG.md' }, validate: { width: 16 } })
  await fs.writeFile(join(cwd, 'pkg/CHANGELOG.md'), 'previous changelog')
  const result = await sync({ cwd, config: cfg, iconSet: iconSet(), continueOnError: true })
  expect(result.complete).toBe(false)
  expect(await fs.readFile(join(cwd, 'pkg/CHANGELOG.md'), 'utf8')).toBe('previous changelog')
  expect(JSON.parse(await fs.readFile(join(cwd, 'pkg/custom.json'), 'utf8')).icons).toHaveProperty('second')
})

it('does not allow partial export names to escape the temporary SVG directory', async () => {
  const set = blankIconSet('fixture')
  set.fromSVG('../../escape', new SVG(svg))
  const before = await snapshot()
  await expect(sync({ cwd, config: config(), iconSet: set, continueOnError: true })).rejects.toThrow('escapes the output directory')
  expect(await snapshot()).toEqual(before)
  await expect(fs.readFile(join(cwd, 'escape.svg'))).rejects.toThrow()
  expect(await stagedFiles()).toEqual([])
})

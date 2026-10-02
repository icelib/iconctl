import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { IconSet } from '@iconify/tools'
import { resolveConfig, sync } from '../src'
import { OutputTransaction } from '../src/output-transaction'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

const roots: string[] = []
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iconctl-transaction-')))
  roots.push(cwd)
  const config = resolveConfig({
    prefix: 'brand',
    sources: [{ type: 'directory', dir: 'raw' }],
    output: { json: 'icons.json', svg: 'svg', types: 'types.ts', preview: 'preview.html', changelog: 'CHANGELOG.md', jsonPackage: { dir: 'pkg', clean: false } },
  })
  return { cwd, config }
}
function icons(...names: string[]) {
  return new IconSet({ prefix: 'brand', width: 24, height: 24, icons: Object.fromEntries(names.map(name => [name, { body: '<path fill="currentColor" d="M0 0h24v24H0z"/>' }])) })
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
      }
      else {
        result[path.relative(root, file)] = await readFile(file, 'utf8')
      }
    }
  }
  await visit(root)
  return result
}
afterEach(async () => {
  vi.mocked(rename).mockRestore()
  vi.mocked(rm).mockRestore()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['types.ts', 'preview.html', 'pkg', '.iconctl-cache/meta.json'])('rolls back all outputs when committing %s fails', async (destination) => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  await mkdir(path.join(cwd, '.iconctl-cache'), { recursive: true })
  await writeFile(path.join(cwd, '.iconctl-cache/meta.json'), '{"version":"old"}')
  const before = await tree(cwd)
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (destination === '.iconctl-cache/meta.json'
      ? String(from) === path.join(cwd, destination)
      : String(from).endsWith('/next') && String(to) === path.join(cwd, destination)) {
      throw new Error('injected commit failure')
    }
    await original(from, to)
  })
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow('injected commit failure')
  expect(await tree(cwd)).toEqual(before)
  expect((await readdir(cwd)).some(name => name.startsWith('.iconctl-transaction-'))).toBe(false)
})

it('stages every output before replacing any old file', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  await writeFile(path.join(cwd, 'pkg/package.json'), '{broken')
  const before = await tree(cwd)
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow()
  expect(await tree(cwd)).toEqual(before)
})

it.each(['types', 'preview', 'jsonPackage'] as const)('rejects wrong destination types before changing outputs: %s', async (kind) => {
  const { cwd, config } = await fixture()
  await writeFile(path.join(cwd, 'icons.json'), '{"prefix":"brand","icons":{}}')
  if (kind === 'jsonPackage') {
    await writeFile(path.join(cwd, 'pkg'), 'occupied')
  }
  else {
    await mkdir(path.join(cwd, config.output[kind]!))
  }
  const before = await tree(cwd)
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow('wrong file type')
  expect(await tree(cwd)).toEqual(before)
})

it('rejects overlapping output targets including directory aliases', async () => {
  const { cwd, config } = await fixture()
  config.output.types = 'svg/types.ts'
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow('Conflicting output targets')
  expect(await tree(cwd)).toEqual({})
  await mkdir(path.join(cwd, 'actual'))
  await symlink(path.join(cwd, 'actual'), path.join(cwd, 'alias'))
  config.output.json = 'actual/icons.json'
  config.output.types = 'alias/icons.json'
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow('Conflicting output targets')
})

it('removes deleted and renamed managed SVGs while preserving other files', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old', 'keep') })
  await writeFile(path.join(cwd, 'svg/manual.svg'), 'manually maintained')
  await writeFile(path.join(cwd, 'svg/README.md'), 'keep me')
  await sync({ cwd, config, iconSet: icons('renamed', 'keep') })
  expect((await readdir(path.join(cwd, 'svg'))).sort()).toEqual(['.iconctl-manifest.json', 'README.md', 'keep.svg', 'manual.svg', 'renamed.svg'])
  await sync({ cwd, config, iconSet: icons() })
  expect((await readdir(path.join(cwd, 'svg'))).sort()).toEqual(['.iconctl-manifest.json', 'README.md', 'manual.svg'])
  expect(await readFile(path.join(cwd, 'svg/manual.svg'), 'utf8')).toBe('manually maintained')
})

it('adopts only matching legacy SVGs without a manifest', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old', 'edited') })
  await rm(path.join(cwd, 'svg/.iconctl-manifest.json'))
  await writeFile(path.join(cwd, 'svg/edited.svg'), 'user edit')
  await sync({ cwd, config, iconSet: icons('new') })
  expect((await readdir(path.join(cwd, 'svg'))).sort()).toEqual(['.iconctl-manifest.json', 'edited.svg', 'new.svg'])
})

it('rejects a malformed manifest without deleting any file', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  await writeFile(path.join(cwd, 'svg/.iconctl-manifest.json'), JSON.stringify({ version: 1, files: ['../icons.json'] }))
  const before = await tree(cwd)
  await expect(sync({ cwd, config, iconSet: icons('new') })).rejects.toThrow('Invalid SVG output manifest')
  expect(await tree(cwd)).toEqual(before)
})

it('does not follow generated SVG symlinks while staging', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  await writeFile(path.join(cwd, 'outside'), 'untouched')
  await rm(path.join(cwd, 'svg/old.svg'))
  await symlink(path.join(cwd, 'outside'), path.join(cwd, 'svg/old.svg'))
  await sync({ cwd, config, iconSet: icons('old') })
  expect(await readFile(path.join(cwd, 'outside'), 'utf8')).toBe('untouched')
  expect(await readFile(path.join(cwd, 'svg/old.svg'), 'utf8')).toContain('<svg')
})

it('leaves outputs, manifests and completion cache untouched during dry-run', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  const before = await tree(cwd)
  const result = await sync({ cwd, config, iconSet: icons('new'), dryRun: true })
  expect(result.files).toEqual([])
  expect(result.diff.removed).toEqual(['old'])
  expect(await tree(cwd)).toEqual(before)
})

it('retains recovery backups if rollback itself fails', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'iconctl-rollback-'))
  roots.push(cwd)
  const destination = path.join(cwd, 'icons.json')
  await writeFile(destination, 'old')
  const transaction = new OutputTransaction()
  transaction.add(destination, 'file', async staged => writeFile(staged, 'new'))
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith('/next') || String(from).endsWith('/previous')) {
      throw new Error('disk unavailable')
    }
    await original(from, to)
  })
  await expect(transaction.commit()).rejects.toThrow('recovery files retained')
  const backup = (await readdir(cwd)).find(name => name.startsWith('.iconctl-transaction-'))!
  expect(await readFile(path.join(cwd, backup, 'previous'), 'utf8')).toBe('old')
})

it('removes newly created outputs and parent directories on a first-run failure', async () => {
  const { cwd } = await fixture()
  const transaction = new OutputTransaction()
  transaction.add(path.join(cwd, 'nested/deep/first.json'), 'file', async staged => writeFile(staged, 'first'))
  transaction.add(path.join(cwd, 'nested/deep/second.json'), 'file', async staged => writeFile(staged, 'second'))
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith('/second.json')) {
      throw new Error('injected commit failure')
    }
    await original(from, to)
  })
  await expect(transaction.commit()).rejects.toThrow('injected commit failure')
  expect(await readdir(cwd)).toEqual([])
})

it('checks changelog destination conflicts even when there are no changes', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('same') })
  config.output.changelog = config.output.types!
  const before = await tree(cwd)
  await expect(sync({ cwd, config, iconSet: icons('same') })).rejects.toThrow('Conflicting output targets')
  expect(await tree(cwd)).toEqual(before)
})

it('reports post-commit cleanup failures without reporting the committed sync as failed', async () => {
  const { cwd, config } = await fixture()
  await sync({ cwd, config, iconSet: icons('old') })
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  vi.mocked(rm).mockImplementation(async (file, options) => {
    if (path.basename(String(file)).startsWith('.iconctl-transaction-')) {
      throw new Error('cleanup unavailable')
    }
    await original(file, options)
  })
  const result = await sync({ cwd, config, iconSet: icons('new') })
  expect(result.diff.added).toEqual(['new'])
  expect(JSON.parse(await readFile(path.join(cwd, 'icons.json'), 'utf8')).icons).toHaveProperty('new')
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('Remove these directories manually:'), { code: 'ICONCTL_OUTPUT_CLEANUP' })
})

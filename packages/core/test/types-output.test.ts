import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderIconNameTypes, writeIconNameTypes } from '../src/types-output'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h8v8H0z"/>' } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }
let cwd: string
let input: string
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-types-output-')))
  input = join(cwd, 'icons.json')
  await writeFile(input, JSON.stringify(icons))
})
afterEach(async () => {
  vi.mocked(writeFile).mockRestore()
  vi.mocked(rename).mockRestore()
  await rm(cwd, { recursive: true, force: true })
})

it('writes renderer bytes and replaces nested TypeScript outputs', async () => {
  const output = join(cwd, 'types', 'types.d.ts')
  expect(await writeIconNameTypes(output, icons)).toEqual({ prefix: 'brand', count: 2 })
  expect(await readFile(output, 'utf8')).toBe(renderIconNameTypes(icons))
  await writeFile(output, 'previous types')
  await writeIconNameTypes(output, icons, { inputs: [input] })
  expect(await readFile(output, 'utf8')).toBe(renderIconNameTypes(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'types'])
  expect(await readdir(join(cwd, 'types'))).toEqual(['types.d.ts'])
})

it('validates a dry run without creating parents or staging files', async () => {
  expect(await writeIconNameTypes(join(cwd, 'new', 'types.d.ts'), icons, { inputs: [input], dryRun: true })).toEqual({ prefix: 'brand', count: 2 })
  expect(await readdir(cwd)).toEqual(['icons.json'])
})

it.each([false, true])('resolves and validates aliases before touching any destination, dryRun=%s', async (dryRun) => {
  const invalid = { ...icons, aliases: { broken: { parent: 'missing' } } }
  await expect(writeIconNameTypes(join(cwd, 'new', 'types.d.ts'), invalid, { dryRun })).rejects.toThrow()
  expect(await readdir(cwd)).toEqual(['icons.json'])
  const output = join(cwd, 'types.d.ts')
  await writeFile(output, 'previous types')
  await expect(writeIconNameTypes(output, invalid, { dryRun })).rejects.toThrow()
  expect(await readFile(output, 'utf8')).toBe('previous types')
})

it.each([false, true])('protects inputs through direct paths, hard links and directory/input symlinks, dryRun=%s', async (dryRun) => {
  const hardlink = join(cwd, 'hardlink.d.ts')
  const alias = join(cwd, 'alias')
  const linkedInput = join(cwd, 'linked-input.json')
  await link(input, hardlink)
  await symlink(cwd, alias)
  await symlink(input, linkedInput)
  for (const source of [input, linkedInput]) {
    for (const target of [input, hardlink, join(alias, 'icons.json')]) {
      await expect(writeIconNameTypes(target, icons, { inputs: [source], dryRun })).rejects.toThrow(/conflicts with input/)
    }
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['alias', 'hardlink.d.ts', 'icons.json', 'linked-input.json'])
})

it.each([false, true])('rejects leaf symlinks, dangling symlinks, directories and file ancestors, dryRun=%s', async (dryRun) => {
  const linkedOutput = join(cwd, 'linked.d.ts')
  const dangling = join(cwd, 'dangling.d.ts')
  const directory = join(cwd, 'directory')
  await symlink(input, linkedOutput)
  await symlink(join(cwd, 'missing.d.ts'), dangling)
  await mkdir(directory)
  for (const target of [linkedOutput, dangling, directory]) {
    await expect(writeIconNameTypes(target, icons, { dryRun })).rejects.toThrow(/regular file/)
  }
  await expect(writeIconNameTypes(join(input, 'types.d.ts'), icons, { dryRun })).rejects.toThrow()
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['dangling.d.ts', 'directory', 'icons.json', 'linked.d.ts'])
})

it('preserves the input and types and removes staging when the staged write fails', async () => {
  const output = join(cwd, 'types.d.ts')
  await writeFile(output, 'previous types')
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
  vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
    if (String(file).includes('/.iconctl-stage-')) {
      throw new Error('injected write failure')
    }
    await original(file, data, options)
  })
  await expect(writeIconNameTypes(output, icons, { inputs: [input] })).rejects.toThrow('injected write failure')
  expect(await readFile(output, 'utf8')).toBe('previous types')
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'types.d.ts'])
})

it.each([false, true])('rolls back an actual commit failure and cleans new parent directories, existing=%s', async (existing) => {
  const output = existing ? join(cwd, 'types.d.ts') : join(cwd, 'new', 'nested', 'types.d.ts')
  if (existing) {
    await writeFile(output, 'previous types')
  }
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith('/output') && String(to) === output) {
      throw new Error('injected rename failure')
    }
    await original(from, to)
  })
  await expect(writeIconNameTypes(output, icons, { inputs: [input] })).rejects.toThrow('previous outputs were restored')
  if (existing) {
    expect(await readFile(output, 'utf8')).toBe('previous types')
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(existing ? ['icons.json', 'types.d.ts'] : ['icons.json'])
})

it.for([false, true])('protects existing case aliases on case-insensitive filesystems, dryRun=%s', async (dryRun, context) => {
  const alias = join(cwd, 'ICONS.JSON')
  const candidate = await stat(alias, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  const original = await stat(input, { bigint: true })
  if (!candidate || candidate.dev !== original.dev || candidate.ino !== original.ino) {
    context.skip()
    return
  }
  await expect(writeIconNameTypes(alias, icons, { inputs: [input], dryRun })).rejects.toThrow(`Types output conflicts with input: ${input}`)
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
})

it('returns count zero for an empty collection', async () => {
  const empty = { prefix: 'empty', icons: {} }
  const output = join(cwd, 'types.d.ts')
  expect(await writeIconNameTypes(output, empty)).toEqual({ prefix: 'empty', count: 0 })
  expect(await readFile(output, 'utf8')).toBe(renderIconNameTypes(empty))
})

it('does not render or apply sprite restrictions to SVG body text', async () => {
  const collection = { prefix: 'Brand / 雪', icons: { 'name / 雪': { body: 'not XML at all' } } }
  const output = join(cwd, 'icons.d.ts')
  expect(await writeIconNameTypes(output, collection)).toEqual({ prefix: 'Brand / 雪', count: 1 })
  expect(await readFile(output, 'utf8')).toBe(renderIconNameTypes(collection))
})

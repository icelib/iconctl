import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSvgSprite, writeSvgSprite } from '../src/sprite-output'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h8v8H0z"/>' } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }
let cwd: string
let input: string
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-sprite-output-')))
  input = join(cwd, 'icons.json')
  await writeFile(input, JSON.stringify(icons))
})
afterEach(async () => {
  vi.mocked(writeFile).mockRestore()
  vi.mocked(rename).mockRestore()
  await rm(cwd, { recursive: true, force: true })
})

it('preserves the two-argument API and renderer bytes while replacing nested sprites', async () => {
  const output = join(cwd, 'sprites', 'sprite.svg')
  expect(await writeSvgSprite(output, icons)).toEqual({ prefix: 'brand', count: 2 })
  expect(await readFile(output, 'utf8')).toBe(await renderSvgSprite(icons))
  await writeFile(output, 'previous sprite')
  await writeSvgSprite(output, icons, { inputs: [input] })
  expect(await readFile(output, 'utf8')).toBe(await renderSvgSprite(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'sprites'])
  expect(await readdir(join(cwd, 'sprites'))).toEqual(['sprite.svg'])
})

it('validates a dry run without creating parents or staging files', async () => {
  expect(await writeSvgSprite(join(cwd, 'new', 'sprite.svg'), icons, { inputs: [input], dryRun: true })).toEqual({ prefix: 'brand', count: 2 })
  expect(await readdir(cwd)).toEqual(['icons.json'])
})

it.each([false, true])('renders and validates aliases before touching any destination, dryRun=%s', async (dryRun) => {
  const invalid = { ...icons, aliases: { broken: { parent: 'missing' } } }
  await expect(writeSvgSprite(join(cwd, 'new', 'sprite.svg'), invalid, { dryRun })).rejects.toThrow()
  expect(await readdir(cwd)).toEqual(['icons.json'])
  const output = join(cwd, 'sprite.svg')
  await writeFile(output, 'previous sprite')
  await expect(writeSvgSprite(output, invalid, { dryRun })).rejects.toThrow()
  expect(await readFile(output, 'utf8')).toBe('previous sprite')
})

it.each([false, true])('protects inputs through direct paths, hard links and directory/input symlinks, dryRun=%s', async (dryRun) => {
  const hardlink = join(cwd, 'hardlink.svg')
  const alias = join(cwd, 'alias')
  const linkedInput = join(cwd, 'linked-input.json')
  await link(input, hardlink)
  await symlink(cwd, alias)
  await symlink(input, linkedInput)
  for (const source of [input, linkedInput]) {
    for (const target of [input, hardlink, join(alias, 'icons.json')]) {
      await expect(writeSvgSprite(target, icons, { inputs: [source], dryRun })).rejects.toThrow(/conflicts with input/)
    }
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['alias', 'hardlink.svg', 'icons.json', 'linked-input.json'])
})

it.each([false, true])('rejects leaf symlinks, dangling symlinks, directories and file ancestors, dryRun=%s', async (dryRun) => {
  const linkedOutput = join(cwd, 'linked.svg')
  const dangling = join(cwd, 'dangling.svg')
  const directory = join(cwd, 'directory')
  await symlink(input, linkedOutput)
  await symlink(join(cwd, 'missing.svg'), dangling)
  await mkdir(directory)
  for (const target of [linkedOutput, dangling, directory]) {
    await expect(writeSvgSprite(target, icons, { dryRun })).rejects.toThrow(/regular file/)
  }
  await expect(writeSvgSprite(join(input, 'sprite.svg'), icons, { dryRun })).rejects.toThrow()
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['dangling.svg', 'directory', 'icons.json', 'linked.svg'])
})

it('preserves the input and sprite and removes staging when the staged write fails', async () => {
  const output = join(cwd, 'sprite.svg')
  await writeFile(output, 'previous sprite')
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
  vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
    if (String(file).includes('/.iconctl-stage-')) {
      throw new Error('injected write failure')
    }
    await original(file, data, options)
  })
  await expect(writeSvgSprite(output, icons, { inputs: [input] })).rejects.toThrow('injected write failure')
  expect(await readFile(output, 'utf8')).toBe('previous sprite')
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'sprite.svg'])
})

it.each([false, true])('rolls back an actual commit failure and cleans new parent directories, existing=%s', async (existing) => {
  const output = existing ? join(cwd, 'sprite.svg') : join(cwd, 'new', 'nested', 'sprite.svg')
  if (existing) {
    await writeFile(output, 'previous sprite')
  }
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith('/output') && String(to) === output) {
      throw new Error('injected rename failure')
    }
    await original(from, to)
  })
  await expect(writeSvgSprite(output, icons, { inputs: [input] })).rejects.toThrow('previous outputs were restored')
  if (existing) {
    expect(await readFile(output, 'utf8')).toBe('previous sprite')
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(existing ? ['icons.json', 'sprite.svg'] : ['icons.json'])
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
  await expect(writeSvgSprite(alias, icons, { inputs: [input], dryRun })).rejects.toThrow(`Sprite output conflicts with input: ${input}`)
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
})

it('returns count zero for an empty collection', async () => {
  const empty = { prefix: 'empty', icons: {} }
  const output = join(cwd, 'sprite.svg')
  expect(await writeSvgSprite(output, empty)).toEqual({ prefix: 'empty', count: 0 })
  expect(await readFile(output, 'utf8')).toBe(await renderSvgSprite(empty))
})

it.each([false, true])('rejects unsupported markup before changing existing output, dryRun=%s', async (dryRun) => {
  const output = join(cwd, 'sprite.svg')
  await writeFile(output, 'previous sprite')
  const invalid = { prefix: 'brand', icons: { invalid: { body: '<path style="fill:red"/>' } } }
  await expect(writeSvgSprite(output, invalid, { inputs: [input], dryRun })).rejects.toThrow('nonempty style')
  await expect(writeSvgSprite(join(cwd, 'new', 'sprite.svg'), invalid, { dryRun })).rejects.toThrow('nonempty style')
  expect(await readFile(output, 'utf8')).toBe('previous sprite')
  expect(await readdir(cwd)).toEqual(['icons.json', 'sprite.svg'])
})

import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPreviewHtml, writePreviewHtml } from '../src/preview'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const icons = { prefix: 'brand', icons: { arrow: { body: '<path d="M0 0h8v8H0z"/>' } }, aliases: { rotated: { parent: 'arrow', rotate: 1 } } }
let cwd: string
let input: string
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-preview-output-')))
  input = join(cwd, 'icons.json')
  await writeFile(input, JSON.stringify(icons))
})
afterEach(async () => {
  vi.mocked(writeFile).mockRestore()
  vi.mocked(rename).mockRestore()
  await rm(cwd, { recursive: true, force: true })
})

it('preserves the two-argument API and renderer bytes while replacing nested reports', async () => {
  const output = join(cwd, 'reports', 'preview.html')
  await writePreviewHtml(output, icons)
  expect(await readFile(output, 'utf8')).toBe(renderPreviewHtml(icons))
  await writeFile(output, 'previous report')
  await writePreviewHtml(output, icons, { inputs: [input] })
  expect(await readFile(output, 'utf8')).toBe(renderPreviewHtml(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'reports'])
  expect(await readdir(join(cwd, 'reports'))).toEqual(['preview.html'])
})

it('validates a dry run without creating parents or staging files', async () => {
  await writePreviewHtml(join(cwd, 'new', 'preview.html'), icons, { inputs: [input], dryRun: true })
  expect(await readdir(cwd)).toEqual(['icons.json'])
})

it.each([false, true])('renders and validates aliases before touching any destination, dryRun=%s', async (dryRun) => {
  const invalid = { ...icons, aliases: { broken: { parent: 'missing' } } }
  await expect(writePreviewHtml(join(cwd, 'new', 'preview.html'), invalid, { dryRun })).rejects.toThrow()
  expect(await readdir(cwd)).toEqual(['icons.json'])
  const output = join(cwd, 'preview.html')
  await writeFile(output, 'previous report')
  await expect(writePreviewHtml(output, invalid, { dryRun })).rejects.toThrow()
  expect(await readFile(output, 'utf8')).toBe('previous report')
})

it.each([false, true])('protects inputs through direct paths, hard links and directory/input symlinks, dryRun=%s', async (dryRun) => {
  const hardlink = join(cwd, 'hardlink.html')
  const alias = join(cwd, 'alias')
  const linkedInput = join(cwd, 'linked-input.json')
  await link(input, hardlink)
  await symlink(cwd, alias)
  await symlink(input, linkedInput)
  for (const source of [input, linkedInput]) {
    for (const target of [input, hardlink, join(alias, 'icons.json')]) {
      await expect(writePreviewHtml(target, icons, { inputs: [source], dryRun })).rejects.toThrow(`Report output conflicts with input: ${source}`)
    }
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['alias', 'hardlink.html', 'icons.json', 'linked-input.json'])
})

it.each([false, true])('rejects leaf symlinks, dangling symlinks, directories and file ancestors, dryRun=%s', async (dryRun) => {
  const linkedOutput = join(cwd, 'linked.html')
  const dangling = join(cwd, 'dangling.html')
  const directory = join(cwd, 'directory')
  await symlink(input, linkedOutput)
  await symlink(join(cwd, 'missing.html'), dangling)
  await mkdir(directory)
  for (const target of [linkedOutput, dangling, directory]) {
    await expect(writePreviewHtml(target, icons, { dryRun })).rejects.toThrow(`Report target must be a regular file: ${target}`)
  }
  await expect(writePreviewHtml(join(input, 'preview.html'), icons, { dryRun })).rejects.toThrow()
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['dangling.html', 'directory', 'icons.json', 'linked.html'])
})

it('preserves the input and report and removes staging when the staged write fails', async () => {
  const output = join(cwd, 'preview.html')
  await writeFile(output, 'previous report')
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
  vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
    if (String(file).includes('/.iconctl-stage-')) {
      throw new Error('injected write failure')
    }
    await original(file, data, options)
  })
  await expect(writePreviewHtml(output, icons, { inputs: [input] })).rejects.toThrow('injected write failure')
  expect(await readFile(output, 'utf8')).toBe('previous report')
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(['icons.json', 'preview.html'])
})

it.each([false, true])('rolls back an actual commit failure and cleans new parent directories, existing=%s', async (existing) => {
  const output = existing ? join(cwd, 'preview.html') : join(cwd, 'new', 'nested', 'preview.html')
  if (existing) {
    await writeFile(output, 'previous report')
  }
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from).endsWith('/output') && String(to) === output) {
      throw new Error('injected rename failure')
    }
    await original(from, to)
  })
  await expect(writePreviewHtml(output, icons, { inputs: [input] })).rejects.toThrow('previous outputs were restored')
  if (existing) {
    expect(await readFile(output, 'utf8')).toBe('previous report')
  }
  expect(await readFile(input, 'utf8')).toBe(JSON.stringify(icons))
  expect(await readdir(cwd)).toEqual(existing ? ['icons.json', 'preview.html'] : ['icons.json'])
})

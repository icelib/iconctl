import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeChangelog } from '../src/changelog'
import { readPreviousIconJson } from '../src/export'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('rethrows a prior JSON read error instead of treating the file as missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iconctl-io-'))
  roots.push(root)
  const file = path.join(root, 'icons.json')
  const before = '{"prefix":"brand","icons":{}}'
  await writeFile(file, before)
  const failure = Object.assign(new Error('disk read failed'), { code: 'EIO' })
  vi.mocked(readFile).mockRejectedValueOnce(failure)

  await expect(readPreviousIconJson(file)).rejects.toBe(failure)
  expect(await readFile(file, 'utf8')).toBe(before)
})

it('rethrows a changelog read error before writing over existing history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iconctl-io-'))
  roots.push(root)
  const file = path.join(root, 'CHANGELOG.md')
  const before = '# Changelog\n\n## 2026-10-05\n\n- Added: `old`\n'
  await writeFile(file, before)
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  vi.mocked(readFile).mockRejectedValueOnce(failure)

  await expect(writeChangelog(file, { added: ['new'], removed: [], changed: [], unchanged: [] }, '2026-10-05')).rejects.toBe(failure)
  expect(await readFile(file, 'utf8')).toBe(before)
})

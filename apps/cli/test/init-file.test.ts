import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInitFile, inspectInitTarget } from '../src/init-file'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, link: vi.fn(actual.link), lstat: vi.fn(actual.lstat), mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
let cwd: string
function resetFilesystem() {
  vi.mocked(fs.link).mockImplementation(actual.link)
  vi.mocked(fs.lstat).mockImplementation(actual.lstat)
  vi.mocked(fs.mkdir).mockImplementation(actual.mkdir)
  vi.mocked(fs.open).mockImplementation(actual.open)
  vi.mocked(fs.unlink).mockImplementation(actual.unlink)
}
beforeEach(async () => {
  resetFilesystem()
  cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'iconctl-init-file-')))
})
afterEach(async () => {
  resetFilesystem()
  await fs.rm(cwd, { recursive: true, force: true })
})

it('publishes complete bytes into nested parents and removes its temporary file', async () => {
  const path = join(cwd, 'new/nested/config.ts')
  await createInitFile(await inspectInitTarget(path), 'complete config')
  expect(await fs.readFile(path, 'utf8')).toBe('complete config')
  expect(await fs.readdir(dirname(path))).toEqual(['config.ts'])
})

it('accepts a long valid target basename without extending it for staging', async () => {
  const name = `${'a'.repeat(220)}.ts`
  const path = join(cwd, name)
  await createInitFile(await inspectInitTarget(path), 'complete config')
  expect(await fs.readFile(path, 'utf8')).toBe('complete config')
  expect(await fs.readdir(cwd)).toEqual([name])
})

it('protects a competing file created after the initial check', async () => {
  const path = join(cwd, 'config.ts')
  const target = await inspectInitTarget(path)
  await fs.writeFile(path, 'competing config')
  await expect(createInitFile(target, 'ours')).rejects.toThrow('Config already exists')
  expect(await fs.readFile(path, 'utf8')).toBe('competing config')
  expect(await fs.readdir(cwd)).toEqual(['config.ts'])
})

it('allows at most one of two initializers to publish the same target', async () => {
  const path = join(cwd, 'new/nested/config.ts')
  const first = await inspectInitTarget(path)
  const second = await inspectInitTarget(path)
  const results = await Promise.allSettled([createInitFile(first, 'first'), createInitFile(second, 'second')])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(['first', 'second']).toContain(await fs.readFile(path, 'utf8'))
  expect(await fs.readdir(dirname(path))).toEqual(['config.ts'])
})

it.each(['write', 'close', 'link', 'open'])('cleans owned parents and staging after %s failure', async (operation) => {
  const error = new Error(`${operation} failed`)
  if (operation === 'link') {
    vi.mocked(fs.link).mockRejectedValueOnce(error)
  }
  else if (operation === 'open') {
    vi.mocked(fs.open).mockRejectedValueOnce(error)
  }
  else {
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args)
      if (operation === 'write') {
        vi.spyOn(file, 'writeFile').mockRejectedValueOnce(error)
      }
      else {
        const close = file.close.bind(file)
        vi.spyOn(file, 'close').mockImplementationOnce(async () => {
          await close()
          throw error
        })
      }
      return file
    })
  }
  await expect(createInitFile(await inspectInitTarget(join(cwd, 'new/nested/config.ts')), 'complete')).rejects.toBe(error)
  expect(await fs.readdir(cwd)).toEqual([])
})

it('cleans earlier parents when a later mkdir fails', async () => {
  const error = new Error('mkdir failed')
  vi.mocked(fs.mkdir).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/nested')) {
      throw error
    }
    return actual.mkdir(...args)
  })
  await expect(createInitFile(await inspectInitTarget(join(cwd, 'new/nested/config.ts')), 'complete')).rejects.toBe(error)
  expect(await fs.readdir(cwd)).toEqual([])
})

it('reports an unverified temporary file when reading its opened identity fails', async () => {
  const error = Object.assign(new Error('file stat failed'), { code: 'EIO' })
  let close: ReturnType<typeof vi.spyOn> | undefined
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args)
    vi.spyOn(file, 'stat').mockRejectedValueOnce(error)
    close = vi.spyOn(file, 'close')
    return file
  })
  const path = join(cwd, 'new/nested/config.ts')
  const result = createInitFile(await inspectInitTarget(path), 'complete')
  await expect(result).rejects.toMatchObject({ cause: error, message: expect.stringContaining('Cannot verify temporary file ownership; left untouched:') })
  expect(close).toHaveBeenCalledOnce()
  const files = await fs.readdir(dirname(path))
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/\.tmp$/)
  await expect(result).rejects.toThrow(join(dirname(path), files[0]!))
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports an unverified created directory when its first identity read fails', async () => {
  const error = Object.assign(new Error('directory stat failed'), { code: 'EIO' })
  const unverified = join(cwd, 'new/nested')
  const target = await inspectInitTarget(join(unverified, 'config.ts'))
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if (String(args[0]) === unverified) {
      vi.mocked(fs.lstat).mockImplementation(actual.lstat)
      throw error
    }
    return actual.lstat(...args)
  })
  await expect(createInitFile(target, 'complete')).rejects.toMatchObject({ cause: error, message: expect.stringContaining(`Cannot verify created directory ownership; left untouched: ${unverified}`) })
  expect(await fs.readdir(unverified)).toEqual([])
  expect(await fs.readdir(cwd)).toEqual(['new'])
})

it('does not remove an empty directory that another initializer created', async () => {
  vi.mocked(fs.mkdir).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/nested')) {
      await actual.mkdir(...args)
      throw Object.assign(new Error('competing directory'), { code: 'EEXIST' })
    }
    return actual.mkdir(...args)
  })
  vi.mocked(fs.link).mockRejectedValueOnce(new Error('link failed'))
  await expect(createInitFile(await inspectInitTarget(join(cwd, 'new/nested/config.ts')), 'complete')).rejects.toThrow('link failed')
  expect(await fs.readdir(join(cwd, 'new/nested'))).toEqual([])
})

it('does not follow a new symlink in a previously absent parent', async () => {
  const path = join(cwd, 'new/config.ts')
  const target = await inspectInitTarget(path)
  await fs.mkdir(join(cwd, 'other'))
  await fs.symlink(join(cwd, 'other'), join(cwd, 'new'))
  await expect(createInitFile(target, 'complete')).rejects.toThrow('Config parent changed')
  expect(await fs.readdir(join(cwd, 'other'))).toEqual([])
  expect((await fs.lstat(join(cwd, 'new'))).isSymbolicLink()).toBe(true)
})

it('reports the committed config and residual path when post-publication cleanup fails', async () => {
  const path = join(cwd, 'new/config.ts')
  vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('unlink failed'))
  const result = createInitFile(await inspectInitTarget(path), 'complete')
  await expect(result).rejects.toThrow(`Created config ${path}, but cleanup failed. Cannot remove temporary file:`)
  expect(await fs.readFile(path, 'utf8')).toBe('complete')
  expect((await fs.readdir(dirname(path))).filter(file => file.endsWith('.tmp'))).toHaveLength(1)
})

it.each(['file', 'dangling-parent'])('rejects an invalid %s parent without writes', async (kind) => {
  const parent = join(cwd, 'parent')
  if (kind === 'file') {
    await fs.writeFile(parent, 'keep')
  }
  else {
    await fs.symlink(join(cwd, 'absent'), parent)
  }
  await expect(inspectInitTarget(join(parent, 'config.ts'))).rejects.toThrow()
  expect(await fs.readdir(cwd)).toEqual(['parent'])
})

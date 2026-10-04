import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconctlAbortError } from '../src/errors'
import { createWatchObserver } from '../src/watch-observer'
import { watchPaths } from '../src/watch-paths'

const scan = vi.hoisted(() => ({
  directory: '',
  entered: false,
  pending: undefined as Promise<void> | undefined,
  inspected: [] as string[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === scan.directory && scan.pending) {
        scan.entered = true
        await scan.pending
      }
      return actual.readdir(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (scan.entered) {
        scan.inspected.push(String(args[0]))
      }
      return actual.lstat(...args)
    },
  }
})

let root: string
let release: () => void
let observer: ReturnType<typeof createWatchObserver> | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'iconctl-observer-')))
  release = () => {}
  scan.directory = ''
  scan.entered = false
  scan.pending = undefined
  scan.inspected = []
  await mkdir(join(root, 'raw/nested'), { recursive: true })
  await mkdir(join(root, 'outside/secret'), { recursive: true })
  await writeFile(join(root, 'raw/nested/icon.svg'), '<svg/>')
  await writeFile(join(root, 'outside/secret/hidden.svg'), '<svg/>')
})
afterEach(async () => {
  release()
  await observer?.close()
  observer = undefined
  await rm(root, { recursive: true, force: true })
})
function paths() {
  return watchPaths({
    sources: [{ type: 'directory', dir: 'raw' }],
    output: { json: 'icons.json', svg: 'svg' },
    cacheDir: '.cache',
  }, root, [])
}
function block(directory: string) {
  scan.directory = directory
  scan.pending = new Promise<void>((resolve) => {
    release = resolve
  })
}

it.each(['raw', 'raw/nested'])('discards a retargeted %s directory before inspecting its returned descendants', async (input) => {
  const changes = vi.fn()
  const errors = vi.fn()
  observer = createWatchObserver(changes, errors)
  await observer.replace(await paths())
  const directory = join(root, input)
  block(directory)
  const checking = observer.check()
  await vi.waitFor(() => expect(scan.entered).toBe(true))
  await rename(directory, join(root, 'parked'))
  await symlink(join(root, 'outside'), directory, 'dir')
  release()
  await checking
  // readdir returned the target's names, but their metadata must never be read.
  expect(scan.inspected).not.toContain(join(directory, 'secret'))
  expect(scan.inspected).not.toContain(join(directory, 'secret/hidden.svg'))
  expect(changes).toHaveBeenCalledExactlyOnceWith(false)
  expect(errors).not.toHaveBeenCalled()
  await observer.check()
  expect(changes).toHaveBeenCalledTimes(1)
})

it('aborts a pending replacement synchronously and drains it without publishing a new baseline', async () => {
  const changes = vi.fn()
  const errors = vi.fn()
  observer = createWatchObserver(changes, errors)
  const scope = await paths()
  block(join(root, 'raw'))
  const replacing = observer.replace(scope).catch(error => error)
  await vi.waitFor(() => expect(scan.entered).toBe(true))
  observer.stop()
  let closed = false
  const closing = observer.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  expect(await replacing).toBeInstanceOf(IconctlAbortError)
  await closing
  expect(changes).not.toHaveBeenCalled()
  expect(errors).not.toHaveBeenCalled()
  expect(scan.inspected).not.toContain(join(root, 'raw/nested'))
})

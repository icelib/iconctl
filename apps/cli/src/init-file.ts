import type { Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readlink, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { IconctlError } from '@iconctl/core'

interface OwnedPath {
  path: string
  info: Stats
}

interface CreatedPath {
  path: string
  info?: Stats
}

export interface InitTarget {
  path: string
  ancestor: OwnedPath
}

async function inspect(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    return undefined
  }
}

function sameFile(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino
}

function alreadyExists(path: string) {
  return new IconctlError(`Config already exists: ${path}. Edit it or choose a new --config path.`)
}

/** Resolve existing parent links without following or accepting an existing leaf. */
export async function inspectInitTarget(path: string): Promise<InitTarget> {
  let ancestor = dirname(path)
  while (!(await inspect(ancestor))) {
    ancestor = dirname(ancestor)
  }
  const canonical = await realpath(ancestor)
  const info = await lstat(canonical)
  if (!info.isDirectory()) {
    throw new IconctlError(`Config parent is not a directory: ${ancestor}`)
  }
  const target = join(canonical, relative(ancestor, path))
  if (await inspect(target)) {
    throw alreadyExists(target)
  }
  return { path: target, ancestor: { path: canonical, info } }
}

/** Compare planned locations, including a dangling symlink to a future output. */
export async function initLocation(path: string, links = new Set<string>()): Promise<string> {
  let ancestor = path
  while (true) {
    try {
      return join(await realpath(ancestor), relative(ancestor, path))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) {
        throw error
      }
      if ((await inspect(ancestor))?.isSymbolicLink()) {
        if (links.has(ancestor)) {
          throw new IconctlError(`Circular symbolic link: ${ancestor}`)
        }
        links.add(ancestor)
        return join(await initLocation(resolve(dirname(ancestor), await readlink(ancestor)), links), relative(ancestor, path))
      }
      ancestor = dirname(ancestor)
    }
  }
}

/** Future paths cannot be realpathed. Conservatively match common volume semantics. */
export function comparableInitPath(path: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path
}

export async function sameInitLocation(left: string, right: string): Promise<boolean> {
  if (comparableInitPath(left) === comparableInitPath(right)) {
    return true
  }
  const [leftInfo, rightInfo] = await Promise.all([inspect(left), inspect(right)])
  return Boolean(leftInfo && rightInfo && sameFile(leftInfo, rightInfo))
}

async function verifyDirectory(directory: OwnedPath) {
  const info = await inspect(directory.path)
  if (!info?.isDirectory() || !sameFile(info, directory.info) || await realpath(directory.path) !== directory.path) {
    throw new IconctlError(`Config parent changed during initialization: ${directory.path}`)
  }
}

/** Publish complete text exactly once. Existing files are never renamed or replaced. */
export async function createInitFile(target: InitTarget, contents: string): Promise<void> {
  const directories: CreatedPath[] = []
  let temporary: CreatedPath | undefined
  let published = false
  let failed = false
  let failure: unknown
  const cleanupErrors: string[] = []
  try {
    let parent = target.ancestor
    await verifyDirectory(parent)
    const parts = relative(parent.path, dirname(target.path)).split(sep).filter(Boolean)
    for (const part of parts) {
      await verifyDirectory(parent)
      const path = join(parent.path, part)
      let created = false
      try {
        await mkdir(path)
        created = true
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      }
      const resource: CreatedPath = { path }
      if (created) {
        // Record the successful mutation before reading its identity. If that
        // read fails, cleanup must report the unverified resource, not lose it.
        directories.push(resource)
      }
      const directory = { path, info: await lstat(path) }
      resource.info = directory.info
      await verifyDirectory(directory)
      parent = directory
    }
    await verifyDirectory(parent)
    const path = join(parent.path, `.iconctl-init-${randomUUID()}.tmp`)
    const file = await open(path, 'wx', 0o600)
    temporary = { path }
    try {
      temporary.info = await file.stat()
      await file.writeFile(contents, 'utf8')
    }
    finally {
      await file.close()
    }
    await verifyDirectory(parent)
    try {
      // Unlike rename(), link() fails atomically when any destination exists.
      await link(path, target.path)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw alreadyExists(target.path)
      }
      throw error
    }
    published = true
  }
  catch (error) {
    failed = true
    failure = error
  }
  if (temporary) {
    try {
      const current = await inspect(temporary.path)
      if (current && !temporary.info) {
        cleanupErrors.push(`Cannot verify temporary file ownership; left untouched: ${temporary.path}`)
      }
      else if (current && temporary.info && sameFile(current, temporary.info)) {
        await unlink(temporary.path)
      }
      else if (current) {
        cleanupErrors.push(`Temporary path changed; left untouched: ${temporary.path}`)
      }
    }
    catch {
      cleanupErrors.push(`Cannot remove temporary file: ${temporary.path}`)
    }
  }
  if (!published) {
    for (const directory of directories.reverse()) {
      try {
        const current = await inspect(directory.path)
        if (current && !directory.info) {
          cleanupErrors.push(`Cannot verify created directory ownership; left untouched: ${directory.path}`)
        }
        else if (current?.isDirectory() && directory.info && sameFile(current, directory.info)) {
          await rmdir(directory.path)
        }
      }
      catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          cleanupErrors.push(`Cannot remove created directory: ${directory.path}`)
        }
      }
    }
  }
  if (cleanupErrors.length) {
    const outcome = published ? `Created config ${target.path}, but cleanup failed.` : `Config was not created at ${target.path}.`
    throw new IconctlError(`${outcome} ${cleanupErrors.join(' ')}`, { cause: failure })
  }
  if (failed) {
    throw failure
  }
}

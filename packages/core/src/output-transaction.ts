import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { checkpoint } from './abort'
import { IconctlError } from './errors'

export interface OutputTarget {
  path: string
  directory?: boolean
}

interface Entry {
  target: string
  temporary: string
  staged: string
  backup: string
  backedUp: boolean
  installed: boolean
  preserve: boolean
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function canonicalTarget(path: string): Promise<{ path: string, parent: string }> {
  let ancestor = dirname(path)
  while (!(await exists(ancestor))) {
    ancestor = dirname(ancestor)
  }
  const parent = await realpath(ancestor)
  return { path: join(parent, relative(ancestor, path)), parent }
}

interface NormalizedTarget extends OutputTarget {
  requested: string
  parent: string
}

/**
 * Resolve and validate output destinations without creating a staging
 * directory. Dry-run callers use this to exercise the same destination
 * checks as publication while keeping the filesystem untouched.
 */
export async function validateOutputTargets(targets: readonly OutputTarget[], signal?: AbortSignal): Promise<NormalizedTarget[]> {
  const normalized: NormalizedTarget[] = []
  for (const target of targets) {
    await checkpoint(signal)
    const absolute = resolve(target.path)
    const canonical = await canonicalTarget(absolute)
    if (await exists(canonical.path)) {
      const stat = await lstat(canonical.path)
      if (stat.isSymbolicLink() || (target.directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new IconctlError(`Output target has the wrong file type: ${absolute}`)
      }
    }
    for (const other of normalized) {
      if (canonical.path === other.path
        || (!other.directory && contains(other.path, canonical.path))
        || (!target.directory && contains(canonical.path, other.path))) {
        throw new IconctlError(`Conflicting output targets: ${other.path} and ${canonical.path}`)
      }
    }
    normalized.push({ ...target, ...canonical, requested: absolute })
  }
  return normalized
}

/** Stage related paths together, so nested outputs cannot overwrite each other at commit. */
export class OutputTransaction {
  private readonly entries: Entry[] = []
  private readonly paths = new Map<string, string>()
  private readonly createdParents: string[] = []
  private committed = false

  static async create(targets: OutputTarget[], signal?: AbortSignal): Promise<OutputTransaction> {
    const transaction = new OutputTransaction()
    const normalized = await validateOutputTargets(targets, signal)
    for (const target of normalized) {
      transaction.paths.set(target.requested, target.path)
    }
    const roots = normalized.filter((target, index) => !normalized.some((other, otherIndex) =>
      otherIndex !== index && ((other.directory && other.path !== target.path && contains(other.path, target.path))
        || (other.path === target.path && otherIndex < index))))
    try {
      for (const root of roots) {
        await checkpoint(signal)
        const temporary = await mkdtemp(join(root.parent, '.iconctl-stage-'))
        const entry: Entry = {
          target: root.path,
          temporary,
          staged: join(temporary, 'output'),
          backup: join(temporary, 'backup'),
          backedUp: false,
          installed: false,
          preserve: false,
        }
        transaction.entries.push(entry)
        if (await exists(root.path)) {
          // Dereference links in the copy: generation must never write through a
          // staged symlink into the live output tree.
          await cp(root.path, entry.staged, {
            recursive: true,
            dereference: true,
            filter: async () => {
              await checkpoint(signal)
              return true
            },
          })
        }
      }
      return transaction
    }
    catch (error) {
      await transaction.dispose()
      throw error
    }
  }

  path(target: string): string {
    const requested = resolve(target)
    const ancestor = [...this.paths.keys()].sort((a, b) => b.length - a.length).find(path => contains(path, requested))
    const absolute = ancestor ? join(this.paths.get(ancestor)!, relative(ancestor, requested)) : requested
    const entry = this.entries.find(entry => contains(entry.target, absolute))
    if (!entry) {
      throw new IconctlError(`Output path was not staged: ${absolute}`)
    }
    return join(entry.staged, relative(entry.target, absolute))
  }

  /** The last cancellation boundary. Once passed, finish or roll back every write. */
  async commit(signal?: AbortSignal): Promise<void> {
    await checkpoint(signal)
    try {
      for (const entry of this.entries) {
        const created = await mkdir(dirname(entry.target), { recursive: true })
        if (created) {
          const parents = [dirname(entry.target)]
          while (parents.at(-1) !== created) {
            parents.push(dirname(parents.at(-1)!))
          }
          this.createdParents.push(...parents.reverse())
        }
        if (await exists(entry.target)) {
          await rename(entry.target, entry.backup)
          entry.backedUp = true
        }
        if (await exists(entry.staged)) {
          await rename(entry.staged, entry.target)
          entry.installed = true
        }
      }
      this.committed = true
    }
    catch (error) {
      const recoveryErrors: unknown[] = []
      for (const entry of [...this.entries].reverse()) {
        try {
          if (entry.installed) {
            await rm(entry.target, { recursive: true, force: true })
          }
          if (entry.backedUp) {
            await rename(entry.backup, entry.target)
          }
        }
        catch (recoveryError) {
          entry.preserve = true
          recoveryErrors.push(recoveryError)
        }
      }
      if (recoveryErrors.length) {
        throw new IconctlError(`Output commit and recovery failed. Recover backups from: ${this.entries.filter(entry => entry.preserve).map(entry => entry.temporary).join(', ')}`, {
          cause: new AggregateError([error, ...recoveryErrors], 'Output commit and recovery failed'),
        })
      }
      throw new IconctlError('Output commit failed; previous outputs were restored.', { cause: error })
    }
  }

  async dispose(): Promise<void> {
    const removable = this.entries.filter(entry => !entry.preserve)
    const cleanup = await Promise.allSettled(removable.map(entry => rm(entry.temporary, { recursive: true, force: true })))
    const retained = removable.filter((_, index) => cleanup[index]?.status === 'rejected').map(entry => entry.temporary)
    if (!this.committed) {
      for (const parent of [...this.createdParents].reverse()) {
        try {
          await rmdir(parent)
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
            retained.push(parent)
          }
        }
      }
    }
    if (retained.length) {
      process.emitWarning(`Could not remove temporary output files. Remove these directories manually: ${retained.join(', ')}`, { code: 'ICONCTL_OUTPUT_CLEANUP' })
    }
  }
}

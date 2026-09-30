import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { checkpoint } from './abort'
import { IconctlError } from './errors'

interface Target {
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

/** Stage related paths together, so nested outputs cannot overwrite each other at commit. */
export class OutputTransaction {
  private readonly entries: Entry[] = []

  static async create(targets: Target[], signal?: AbortSignal): Promise<OutputTransaction> {
    const transaction = new OutputTransaction()
    const normalized = targets.map(target => ({ ...target, path: resolve(target.path) }))
    const roots = normalized.filter((target, index) => !normalized.some((other, otherIndex) =>
      otherIndex !== index && ((other.directory && other.path !== target.path && contains(other.path, target.path))
        || (other.path === target.path && otherIndex < index))))
    try {
      for (const root of roots) {
        await checkpoint(signal)
        await mkdir(dirname(root.path), { recursive: true })
        const temporary = await mkdtemp(join(dirname(root.path), '.iconctl-stage-'))
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
    const absolute = resolve(target)
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
        if (await exists(entry.target)) {
          await rename(entry.target, entry.backup)
          entry.backedUp = true
        }
        if (await exists(entry.staged)) {
          await rename(entry.staged, entry.target)
          entry.installed = true
        }
      }
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
    for (const entry of this.entries) {
      if (!entry.preserve) {
        await rm(entry.temporary, { recursive: true, force: true })
      }
    }
  }
}

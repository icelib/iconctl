import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { IconctlError } from './errors'

interface OutputOperation {
  target: string
  kind: 'file' | 'directory' | 'delete' | 'keep'
  prepare?: (staged: string) => Promise<void>
}

interface PreparedOperation extends OutputOperation {
  workspace: string
  staged: string
  backup: string
  backedUp: boolean
  installed: boolean
}

async function statIfPresent(target: string) {
  try {
    return await lstat(target)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function existingParent(target: string): Promise<string> {
  let parent = dirname(target)
  while (!(await statIfPresent(parent))) {
    parent = dirname(parent)
  }
  // Resolve directory aliases before comparing destinations or staging files.
  return await realpath(parent)
}

/** Stage every output before replacing any destination; roll back caught failures. */
export class OutputTransaction {
  private readonly operations: OutputOperation[] = []

  add(target: string, kind: OutputOperation['kind'], prepare?: OutputOperation['prepare']) {
    this.operations.push({ target: resolve(target), kind, ...(prepare ? { prepare } : {}) })
  }

  async commit(): Promise<void> {
    const destinations: { operation: OutputOperation, parent: string }[] = []
    for (const operation of this.operations) {
      let ancestor = dirname(operation.target)
      while (!(await statIfPresent(ancestor))) {
        ancestor = dirname(ancestor)
      }
      const parent = await existingParent(operation.target)
      const target = join(parent, relative(ancestor, operation.target))
      const stat = await statIfPresent(target)
      if (stat && (stat.isSymbolicLink() || (operation.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()))) {
        throw new IconctlError(`Output target has the wrong file type: ${target}`)
      }
      for (const item of destinations) {
        const other = item.operation.target
        if (target === other || target.startsWith(`${other}${sep}`) || other.startsWith(`${target}${sep}`)) {
          throw new IconctlError(`Conflicting output targets: ${other} and ${target}`)
        }
      }
      destinations.push({ operation: { ...operation, target }, parent })
    }

    const prepared: PreparedOperation[] = []
    const createdParents: string[] = []
    let preserveBackups = false
    try {
      for (const { operation, parent } of destinations) {
        if (operation.kind === 'keep' || (operation.kind === 'delete' && !(await statIfPresent(operation.target)))) {
          continue
        }
        const workspace = await mkdtemp(join(parent, '.iconctl-transaction-'))
        const entry: PreparedOperation = {
          ...operation,
          workspace,
          staged: join(workspace, 'next'),
          backup: join(workspace, 'previous'),
          backedUp: false,
          installed: false,
        }
        prepared.push(entry)
        await entry.prepare?.(entry.staged)
      }
      for (const entry of prepared) {
        const created = await mkdir(dirname(entry.target), { recursive: true })
        if (created) {
          const parents = [dirname(entry.target)]
          while (parents.at(-1) !== created) {
            parents.push(dirname(parents.at(-1)!))
          }
          createdParents.push(...parents.reverse())
        }
        if (await statIfPresent(entry.target)) {
          await rename(entry.target, entry.backup)
          entry.backedUp = true
        }
        if (entry.kind !== 'delete') {
          await rename(entry.staged, entry.target)
          entry.installed = true
        }
      }
    }
    catch (error) {
      const rollbackErrors: unknown[] = []
      for (const entry of [...prepared].reverse()) {
        try {
          if (entry.installed) {
            await rm(entry.target, { recursive: true, force: true })
          }
          if (entry.backedUp) {
            await rename(entry.backup, entry.target)
          }
        }
        catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      // Only remove empty directories created by this transaction.
      for (const parent of createdParents.reverse()) {
        try {
          await rmdir(parent)
        }
        catch (cleanupError) {
          const code = (cleanupError as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
            rollbackErrors.push(cleanupError)
          }
        }
      }
      if (rollbackErrors.length) {
        preserveBackups = true
        throw new AggregateError([error, ...rollbackErrors], `Output rollback failed; recovery files retained in: ${prepared.map(item => item.workspace).join(', ')}`)
      }
      throw error
    }
    finally {
      if (!preserveBackups) {
        const cleanup = await Promise.allSettled(prepared.map(entry => rm(entry.workspace, { recursive: true, force: true })))
        const retained = prepared.filter((_, index) => cleanup[index]?.status === 'rejected')
        if (retained.length) {
          // Cleanup is after the commit/rollback boundary. It must neither turn
          // a committed sync into a failure nor hide the original failure.
          process.emitWarning(`Could not remove temporary output files. Remove these directories manually: ${retained.map(entry => entry.workspace).join(', ')}`, { code: 'ICONCTL_OUTPUT_CLEANUP' })
        }
      }
    }
  }
}

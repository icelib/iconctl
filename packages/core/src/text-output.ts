import { lstat, realpath, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { IconctlError } from './errors'
import { canonicalTarget, OutputTransaction } from './output-transaction'

interface TextOutputOptions {
  label: 'Report' | 'Sprite' | 'Types' | 'Markdown report'
  inputs?: readonly string[]
  dryRun?: boolean
}

/** Publish one rendered text artifact while protecting its input files. */
export async function writeTextOutput(file: string, contents: string, options: TextOutputOptions): Promise<void> {
  const target = await canonicalTarget(resolve(file))
  let outputStat
  try {
    outputStat = await lstat(target.path, { bigint: true })
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) {
      throw new IconctlError(`${options.label} target must be a regular file: ${file}`)
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  for (const input of options.inputs ?? []) {
    const source = await realpath(input)
    const inputStat = await stat(source, { bigint: true })
    if (source === target.path || (outputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)) {
      throw new IconctlError(`${options.label} output conflicts with input: ${input}`)
    }
  }
  if (options.dryRun) {
    return
  }
  const transaction = await OutputTransaction.create([{ path: target.path }])
  try {
    await writeFile(transaction.path(target.path), contents, 'utf8')
    await transaction.commit()
  }
  finally {
    await transaction.dispose()
  }
}

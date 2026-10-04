import { lstat, realpath, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { IconctlError } from './errors'
import { canonicalTarget, OutputTransaction } from './output-transaction'

interface HtmlOutputOptions {
  inputs?: readonly string[]
  dryRun?: boolean
}

/** Publish one rendered report while protecting its input files. */
export async function writeHtmlReport(file: string, contents: string, options: HtmlOutputOptions = {}): Promise<void> {
  const target = await canonicalTarget(resolve(file))
  let outputStat
  try {
    outputStat = await lstat(target.path, { bigint: true })
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) {
      throw new IconctlError(`Report target must be a regular file: ${file}`)
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
      throw new IconctlError(`Report output conflicts with input: ${input}`)
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

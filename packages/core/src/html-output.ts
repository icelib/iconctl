import { writeTextOutput } from './text-output'

interface HtmlOutputOptions {
  inputs?: readonly string[]
  dryRun?: boolean
}

/** Publish one rendered report while protecting its input files. */
export async function writeHtmlReport(file: string, contents: string, options: HtmlOutputOptions = {}): Promise<void> {
  await writeTextOutput(file, contents, { ...options, label: 'Report' })
}

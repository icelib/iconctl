import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  check,
  FigmaIconifyError,
  loadConfig,
  sync,
} from '@icebreakers/figma-iconify'
import { cac } from 'cac'
import { consola } from 'consola'

interface GlobalOptions {
  config?: string
  dryRun?: boolean
  json?: boolean
  continue?: boolean
}

function loadOptions(options: GlobalOptions) {
  return loadConfig({
    cwd: process.cwd(),
    ...(options.config ? { configFile: options.config } : {}),
  })
}

function printError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof FigmaIconifyError) {
    consola.error(message)
  }
  else {
    consola.error(error)
  }
  process.exitCode = 1
  throw error
}

function printSyncResult(result: Awaited<ReturnType<typeof sync>>, asJson: boolean) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      prefix: result.prefix,
      fileKey: result.fileKey,
      fileVersion: result.fileVersion,
      notModified: result.notModified,
      added: result.diff.added,
      removed: result.diff.removed,
      changed: result.diff.changed,
      skipped: result.failed,
      issues: result.issues,
      outputFiles: result.files,
    }, null, 2)}\n`)
    return
  }

  if (result.notModified) {
    consola.success('Figma file was not modified. Nothing to write.')
    return
  }

  consola.success(`Synced ${result.processed} icons for prefix "${result.prefix}"`)
  if (result.diff.added.length) {
    consola.info(`added: ${result.diff.added.join(', ')}`)
  }
  if (result.diff.removed.length) {
    consola.info(`removed: ${result.diff.removed.join(', ')}`)
  }
  if (result.diff.changed.length) {
    consola.info(`changed: ${result.diff.changed.join(', ')}`)
  }
}

export async function runCli(argv: string[] = process.argv) {
  const cli = cac('figma-iconify')

  cli.option('--config <path>', 'Path to figma-iconify config')
  cli.option('--dry-run', 'Validate and print the plan without writing files')
  cli.option('--json', 'Print machine-readable JSON')
  cli.option('--continue', 'Write files even when validation fails')

  cli
    .command('sync', 'Fetch icons from Figma and export Iconify JSON')
    .action(async (options: GlobalOptions) => {
      try {
        const config = await loadOptions(options)
        const result = await sync({
          cwd: process.cwd(),
          config,
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.continue ? { continueOnError: true } : {}),
        })
        printSyncResult(result, Boolean(options.json))
      }
      catch (error) {
        printError(error)
      }
    })

  cli
    .command('check', 'Validate generated SVG or JSON without calling Figma')
    .action(async (options: GlobalOptions) => {
      try {
        const config = await loadOptions(options)
        const result = await check({ cwd: process.cwd(), config })
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
          return
        }
        consola.success(`Checked ${result.count} icons from ${result.source}`)
      }
      catch (error) {
        printError(error)
      }
    })

  cli
    .command('preview', 'Generate a static HTML gallery from the current config')
    .action(async (options: GlobalOptions) => {
      try {
        const config = await loadOptions(options)
        if (!config.output.preview) {
          config.output.preview = 'preview.html'
        }
        const result = await sync({
          cwd: process.cwd(),
          config,
          ...(options.dryRun ? { dryRun: true } : {}),
        })
        printSyncResult(result, Boolean(options.json))
      }
      catch (error) {
        printError(error)
      }
    })

  cli
    .command('init', 'Write a figma-iconify.config.ts in the current directory')
    .action(async () => {
      try {
        const file = await consola.prompt('Figma file URL or file key', { type: 'text' })
        const prefix = await consola.prompt('Iconify prefix', { type: 'text', placeholder: 'brand' })
        const json = await consola.prompt('JSON output path', { type: 'text', placeholder: 'icons.json', default: 'icons.json' })
        const contents = `import { defineConfig } from 'figma-iconify'

export default defineConfig({
  file: ${JSON.stringify(file)},
  prefix: ${JSON.stringify(prefix || 'brand')},
  pages: ['Icons'],
  output: {
    json: ${JSON.stringify(json || 'icons.json')},
    svg: 'svg',
    preview: 'preview.html',
  },
  validate: {
    width: 24,
    height: 24,
  },
})
`
        const target = join(process.cwd(), 'figma-iconify.config.ts')
        await writeFile(target, contents, 'utf8')
        consola.success(`Wrote ${target}`)
        consola.info('Set FIGMA_TOKEN, then run `figma-iconify sync`.')
      }
      catch (error) {
        printError(error)
      }
    })

  cli.help()
  cli.version('0.0.0')

  const parsed = cli.parse(argv, { run: false })
  if (!cli.matchedCommand && !parsed.options['help'] && !parsed.options['version']) {
    cli.outputHelp()
    return
  }
  await cli.runMatchedCommand()
}

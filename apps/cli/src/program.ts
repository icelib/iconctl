import type { CheckCommandOptions } from './check.ts'
import type { CommandContext } from './failure.ts'
import type { InitCommandOptions } from './init.ts'
import type { PreviewCommandOptions } from './preview.ts'
import type { SpriteCommandOptions } from './sprite.ts'
import type { TypesCommandOptions } from './types.ts'
import process from 'node:process'
import {
  loadConfig,
  sync,
} from '@iconctl/core'
import { cac } from 'cac'
import { consola } from 'consola'
import packageJson from '../package.json' with { type: 'json' }
import { runCheck } from './check.ts'
import { runDiff } from './diff.ts'
import { reportCliError } from './failure.ts'
import { runFigmaAuth } from './figma-auth.ts'
import { runInit } from './init.ts'
import { runLocalPreview } from './preview.ts'
import { runSprite } from './sprite.ts'
import { syncSummary } from './sync-summary.ts'
import { runTypes } from './types.ts'
import { runWatch } from './watch.ts'

interface GlobalOptions {
  config?: string
  dryRun?: boolean
  json?: boolean
  continue?: boolean
}

async function loadOptions(options: GlobalOptions, context: CommandContext) {
  context.phase = 'configuration'
  const config = await loadConfig({
    cwd: process.cwd(),
    ...(options.config ? { configFile: options.config } : {}),
  })
  context.phase = 'execution'
  return config
}

function printSyncResult(result: Awaited<ReturnType<typeof sync>>, asJson: boolean) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(syncSummary(result), null, 2)}\n`)
    return
  }

  if (result.notModified) {
    consola.success('Sources were not modified. Nothing to write.')
    return
  }

  if (result.complete) {
    consola.success(`Synced ${result.processed} icons for prefix "${result.prefix}"`)
  }
  else {
    consola.warn(`Incomplete sync: ${result.processed} icons for prefix "${result.prefix}". Deletions are unknown; changelog was not updated.`)
    if (result.failed.length) {
      consola.warn(`skipped: ${result.failed.join(', ')}`)
    }
    for (const issue of result.issues) {
      consola.warn(`${issue.name}${issue.nodeId ? ` (${issue.nodeId})` : ''} [${issue.stage}]: ${issue.message}`)
    }
  }
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
  const cli = cac('iconctl')
  const context: CommandContext = { phase: 'arguments' }
  // Parser validation runs before this wrapper, so command work has an
  // explicit boundary without classifying exceptions by their message.
  const action = <Args extends unknown[]>(handler: (...args: Args) => unknown) => (...args: Args) => {
    context.phase = 'execution'
    return handler(...args)
  }

  cli.option('--config <path>', 'Path to iconctl config')
  cli.option('--dry-run', 'Validate without writing icon outputs (authentication and caches may update)')
  cli.option('--json', 'Print machine-readable JSON')
  cli.option('--continue', 'Export available icons despite individual import, processing or validation failures')

  cli
    .command('diff <before> <after>', 'Compare two local Iconify JSON files without loading config or remote sources')
    .option('--html <path>', 'Write a standalone offline HTML comparison')
    .option('--check', 'Exit with status 1 when icons or the prefix differ')
    .action(action(runDiff))

  cli
    .command('watch', 'Watch local SVG sources and reload config on change')
    .action(runWatch)

  cli
    .command('auth <provider> <action>', 'Manage Figma OAuth: auth figma login|status|logout')
    .option('--redirect-uri <url>', 'Registered HTTP loopback callback URL')
    .option('--no-open', 'Print the authorization URL without opening a browser')
    .action(action((provider: string, operation: string, options) => runFigmaAuth(provider, operation, options, context)))

  cli
    .command('sync', 'Load icon sources and export Iconify JSON')
    .action(action(async (options: GlobalOptions) => {
      const config = await loadOptions(options, context)
      const result = await sync({
        cwd: process.cwd(),
        config,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.continue ? { continueOnError: true } : {}),
      })
      printSyncResult(result, Boolean(options.json))
    }))

  cli
    .command('check', 'Validate configured output or a standalone Iconify JSON file')
    .option('--input <file>', 'Check a local Iconify JSON file without a config')
    .option('--name <pattern>', 'Override the icon-name regular expression source')
    .option('--width <number>', 'Require this positive canvas width')
    .option('--height <number>', 'Require this positive canvas height')
    .action(action((options: CheckCommandOptions) => runCheck(options, context)))

  cli
    .command('preview', 'Generate an offline HTML gallery from config or a local Iconify JSON file')
    .option('--input <file>', 'Preview local JSON without config, sources or credentials; dry-run writes no files or caches')
    .option('--output <file>', 'HTML destination with --input (default: preview.html in the current directory)')
    .action(action(async (options: PreviewCommandOptions) => {
      if (await runLocalPreview(options, context)) {
        return
      }
      const config = await loadOptions(options, context)
      if (!config.output.preview) {
        config.output.preview = 'preview.html'
      }
      const result = await sync({
        cwd: process.cwd(),
        config,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.continue ? { continueOnError: true } : {}),
      })
      printSyncResult(result, Boolean(options.json))
    }))

  cli
    .command('sprite', 'Render a static SVG sprite from local Iconify JSON without config or credentials')
    .option('--input <file>', 'Required local JSON collection; dry-run writes no files or caches')
    .option('--output <file>', 'SVG destination (default: icons.svg in the current directory)')
    .action(action((options: SpriteCommandOptions) => runSprite(options, context)))

  cli
    .command('types', 'Generate icon name types from local Iconify JSON without config or credentials')
    .option('--input <file>', 'Required local JSON collection; dry-run writes no files or caches')
    .option('--output <file>', 'TypeScript destination (default: icons.d.ts in the current directory)')
    .action(action((options: TypesCommandOptions) => runTypes(options, context)))

  cli
    .command('init', 'Create a new TypeScript config without overwriting existing files')
    .option('--source <type>', 'directory, iconify, figma, mastergo, iconfont, or jsdesign')
    .option('--input <value>', 'Source path or Figma/MasterGo file reference')
    .option('--url <url>', 'iconfont Symbol URL (instead of --input)')
    .option('--prefix <name>', 'Iconify collection prefix')
    .option('--json-output <file>', 'Generated output.json path (default: icons.json)')
    .option('--no-interactive', 'Require source, prefix and input flags; never prompt')
    .action(action((options: InitCommandOptions) => runInit(options, context)))

  cli.help()
  cli.version(packageJson.version)

  try {
    const parsed = cli.parse(argv, { run: false })
    if (!cli.matchedCommand && !parsed.options['help'] && !parsed.options['version']) {
      cli.outputHelp()
      return
    }
    await cli.runMatchedCommand()
  }
  catch (error) {
    reportCliError(error, cli.matchedCommand?.name ?? null, cli.options, context)
    throw error
  }
}

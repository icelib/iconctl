import type { CheckCommandOptions } from './check'
import type { CommandContext } from './failure'
import type { PreviewCommandOptions } from './preview'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  loadConfig,
  sync,
} from '@iconctl/core'
import { cac } from 'cac'
import { consola } from 'consola'
import { runCheck } from './check'
import { runDiff } from './diff'
import { reportCliError } from './failure'
import { runFigmaAuth } from './figma-auth'
import { runLocalPreview } from './preview'
import { syncSummary } from './sync-summary'
import { runWatch } from './watch'

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

function configTemplate(input: { prefix: string, json: string, sourceBlock: string, fixedSize: boolean }) {
  return `import { defineConfig } from 'iconctl'

export default defineConfig({
  prefix: ${JSON.stringify(input.prefix)},
  sources: [
    ${input.sourceBlock}
  ],
  output: {
    json: ${JSON.stringify(input.json)},
    svg: 'svg',
    preview: 'preview.html',
    // Or ship an installable package:
    // jsonPackage: { dir: 'packages/icons', name: '@iconify-json/brand' },
  },
  validate: {
    ${input.fixedSize ? '' : '// '}width: 24,
    ${input.fixedSize ? '' : '// '}height: 24,
  },
})
`
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
    .command('init', 'Write an iconctl.config.ts in the current directory')
    .action(action(async () => {
      const sourceType = await consola.prompt('Icon source', {
        type: 'select',
        options: [
          { label: 'Figma file', value: 'figma' },
          { label: 'Local SVG directory', value: 'directory' },
          { label: 'Local Iconify JSON', value: 'iconify' },
          { label: 'MasterGo file', value: 'mastergo' },
          { label: 'iconfont Symbol URL or folder', value: 'iconfont' },
          { label: '即时设计 exported SVG folder', value: 'jsdesign' },
        ],
      })
      const prefix = await consola.prompt('Iconify prefix', { type: 'text', placeholder: 'brand' })
      const json = await consola.prompt('JSON output path', { type: 'text', placeholder: 'icons.json', default: 'icons.json' })
      let sourceBlock = `{ type: 'directory', dir: './raw-svg' }`
      let hint = 'Put SVGs in ./raw-svg, then run `iconctl sync` or `iconctl watch`.'
      if (sourceType === 'figma') {
        const file = await consola.prompt('Figma file URL or file key', { type: 'text' })
        sourceBlock = `{ type: 'figma', file: ${JSON.stringify(file)}, pages: ['Icons'] }`
        hint = 'Run `iconctl auth figma login` for OAuth with automatic refresh, or set FIGMA_TOKEN, then run `iconctl sync`.'
      }
      else if (sourceType === 'mastergo') {
        const file = await consola.prompt('MasterGo file URL (include layer_id)', { type: 'text' })
        sourceBlock = `{ type: 'mastergo', file: ${JSON.stringify(file)} }`
        hint = 'Set MASTERGO_TOKEN, then run `iconctl sync`. Team edition and a team-project file are required.'
      }
      else if (sourceType === 'iconfont') {
        const url = await consola.prompt('iconfont Symbol JS URL (or leave empty for a folder)', { type: 'text' })
        if (url) {
          sourceBlock = `{ type: 'iconfont', url: ${JSON.stringify(url)}, stripPrefix: 'icon-' }`
          hint = 'No token needed for a public Symbol URL. Run `iconctl sync`.'
        }
        else {
          const dir = await consola.prompt('iconfont download folder', { type: 'text', placeholder: './iconfont', default: './iconfont' })
          sourceBlock = `{ type: 'iconfont', dir: ${JSON.stringify(dir || './iconfont')}, stripPrefix: 'icon-' }`
        }
      }
      else if (sourceType === 'jsdesign') {
        const dir = await consola.prompt('Exported SVG folder from 即时设计', { type: 'text', placeholder: './jsdesign-svg', default: './jsdesign-svg' })
        sourceBlock = `{ type: 'jsdesign', dir: ${JSON.stringify(dir || './jsdesign-svg')} }`
        hint = '即时设计 has no public REST for CLI. Export SVG in the app, then run `iconctl sync`.'
      }
      else if (sourceType === 'iconify') {
        const file = await consola.prompt('Iconify JSON file', { type: 'text', placeholder: './vendor/icons.json', default: './vendor/icons.json' })
        sourceBlock = `{ type: 'iconify', file: ${JSON.stringify(file || './vendor/icons.json')} }`
        hint = 'Keep the vendor JSON separate from output paths, then run `iconctl sync` or `iconctl watch`.'
      }
      else {
        const dir = await consola.prompt('SVG directory', { type: 'text', placeholder: './raw-svg', default: './raw-svg' })
        sourceBlock = `{ type: 'directory', dir: ${JSON.stringify(dir || './raw-svg')} }`
      }
      const contents = configTemplate({
        prefix: prefix || 'brand',
        json: json || 'icons.json',
        sourceBlock,
        fixedSize: sourceType !== 'iconify',
      })
      const target = join(process.cwd(), 'iconctl.config.ts')
      await writeFile(target, contents, 'utf8')
      consola.success(`Wrote ${target}`)
      consola.info(hint)
    }))

  cli.help()
  cli.version('0.0.0')

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

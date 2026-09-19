import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  IconctlError,
  loadConfig,
  sync,
  writeIconfontJsToDirectory,
} from '@iconctl/core'

interface AddIconfontArgs {
  url?: string
  stripPrefix: string
  only?: string[]
  json: boolean
}

function parseArgs(argv: string[]): AddIconfontArgs {
  let stripPrefix = 'icon-'
  let only: string[] | undefined
  let json = false
  const rest: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--strip-prefix') {
      stripPrefix = argv[index + 1] ?? stripPrefix
      index += 1
      continue
    }
    if (arg.startsWith('--strip-prefix=')) {
      stripPrefix = arg.slice('--strip-prefix='.length)
      continue
    }
    if (arg === '--only') {
      only = (argv[index + 1] ?? '').split(',').map(name => name.trim()).filter(Boolean)
      index += 1
      continue
    }
    if (arg.startsWith('--only=')) {
      only = arg.slice('--only='.length).split(',').map(name => name.trim()).filter(Boolean)
      continue
    }
    if (arg === '--') {
      rest.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('-')) {
      throw new IconctlError(`Unknown flag ${arg}`)
    }
    rest.push(arg)
  }

  const parsed: AddIconfontArgs = {
    stripPrefix,
    json,
  }
  if (rest[0]) {
    parsed.url = rest[0]
  }
  if (only?.length) {
    parsed.only = only
  }
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.url) {
    process.stderr.write('Usage: add-iconfont [--strip-prefix icon-] [--only a,b] [--json] <symbol-js-url>\n')
    process.exitCode = 1
    return
  }

  const response = await fetch(args.url)
  if (!response.ok) {
    throw new IconctlError(`Request failed ${response.status} for ${args.url}`)
  }
  const js = await response.text()
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const names = await writeIconfontJsToDirectory(js, join(pkgRoot, 'raw'), {
    stripPrefix: args.stripPrefix,
    ...(args.only ? { only: args.only } : {}),
  })

  const config = await loadConfig({ cwd: pkgRoot })
  const result = await sync({ cwd: pkgRoot, config })

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      prefix: result.prefix,
      ingested: names,
      added: result.diff.added,
      removed: result.diff.removed,
      changed: result.diff.changed,
      outputFiles: result.files,
    }, null, 2)}\n`)
    return
  }

  process.stdout.write(`Ingested ${names.length} iconfont icon(s) into raw/ and synced @iconctl/icons.\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})

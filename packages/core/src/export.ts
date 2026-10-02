import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedIconctlConfig } from './config'
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { exportJSONPackage, exportToDirectory, IconSet as IconSetClass, writeJSONFile } from '@iconify/tools'
import { join, resolve } from 'pathe'
import { IconctlError } from './errors'
import { OutputTransaction } from './output-transaction'

export interface ExportResult {
  files: string[]
  json: IconifyJSON
}

const svgManifest = '.iconctl-manifest.json'
const safeSvgName = /^[^/\\\0]+\.svg$/

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function copyExistingDirectory(source: string, target: string) {
  try {
    await lstat(source)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    await mkdir(target)
    return
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true })
}

async function managedSvgFiles(directory: string, previous?: IconifyJSON): Promise<string[]> {
  const manifest = await readOptional(join(directory, svgManifest))
  if (manifest !== undefined) {
    const parsed: unknown = JSON.parse(manifest)
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('files' in parsed) || !Array.isArray(parsed.files) || !parsed.files.every(file => typeof file === 'string' && safeSvgName.test(file))) {
      throw new IconctlError(`Invalid SVG output manifest: ${join(directory, svgManifest)}`)
    }
    return parsed.files as string[]
  }
  // Adopt legacy outputs only when both the prior JSON and exact SVG agree.
  const managed: string[] = []
  if (previous) {
    const oldSet = new IconSetClass(previous)
    for (const name of oldSet.list()) {
      const file = `${name}.svg`
      if (safeSvgName.test(file) && await readOptional(join(directory, file)) === oldSet.toString(name, { width: 'auto', height: 'auto' })) {
        managed.push(file)
      }
    }
  }
  return managed
}

export function generateIconNameTypes(prefix: string, names: string[]): string {
  const union = names.length
    ? names.map(name => `'${name}'`).join(' | ')
    : 'never'
  return `export const ICONIFY_PREFIX = '${prefix}' as const\nexport type IconName = ${union}\n`
}

export async function readPreviousIconJson(file: string): Promise<IconifyJSON | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as IconifyJSON
  }
  catch {
    return undefined
  }
}

/** Build the output plan so sync can include preview, changelog and cache metadata. */
export function prepareOutputs(
  iconSet: IconSet,
  config: ResolvedIconctlConfig,
  options: { cwd: string, previous?: IconifyJSON },
): ExportResult & { transaction: OutputTransaction } {
  const files: string[] = []
  const json = iconSet.export()
  const transaction = new OutputTransaction()
  const jsonFile = resolve(options.cwd, config.output.json)
  transaction.add(jsonFile, 'file', async staged => writeJSONFile(staged, json))
  files.push(jsonFile)

  if (config.output.svg) {
    const svgDir = resolve(options.cwd, config.output.svg)
    transaction.add(svgDir, 'directory', async (staged) => {
      const managed = await managedSvgFiles(svgDir, options.previous)
      await copyExistingDirectory(svgDir, staged)
      const next = iconSet.list().map(name => `${name}.svg`)
      if (!next.every(file => safeSvgName.test(file))) {
        throw new IconctlError('SVG output names must be filenames without path separators')
      }
      for (const file of managed) {
        if (!next.includes(file)) {
          await rm(join(staged, file), { force: true })
        }
      }
      // Remove copied generated targets, including symlinks, before writing.
      for (const file of [...next, svgManifest]) {
        await rm(join(staged, file), { force: true })
      }
      await exportToDirectory(iconSet, { target: staged })
      await writeFile(join(staged, svgManifest), `${JSON.stringify({ version: 1, files: next.sort() }, null, 2)}\n`)
    })
    files.push(svgDir)
  }

  if (config.output.jsonPackage) {
    const pkg = config.output.jsonPackage
    const dir = resolve(options.cwd, pkg.dir)
    transaction.add(dir, 'directory', async (staged) => {
      let existing: Record<string, unknown> = {}
      if (pkg.clean === false) {
        await copyExistingDirectory(dir, staged)
        const contents = await readOptional(join(dir, 'package.json'))
        if (contents) {
          existing = JSON.parse(contents) as Record<string, unknown>
        }
        // Never follow copied links for generated package files.
        for (const file of ['icons.json', 'info.json', 'metadata.json', 'chars.json', 'index.js', 'index.mjs', 'index.d.ts', 'package.json']) {
          await rm(join(staged, file), { force: true })
        }
      }
      await exportJSONPackage(iconSet, {
        target: staged,
        cleanup: pkg.clean !== false,
        package: {
          name: pkg.name ?? `@iconify-json/${config.prefix}`,
          description: 'Iconify JSON generated by iconctl',
          ...(typeof existing['version'] === 'string' ? { version: existing['version'] } : {}),
          ...pkg.package,
        },
        customisePackage: (contents) => {
          if (pkg.clean !== false) {
            return
          }
          for (const key of ['private', 'scripts', 'files', 'devDependencies', 'author', 'license', 'repository', 'bugs', 'keywords']) {
            if (existing[key] != null && contents[key] == null) {
              contents[key] = existing[key]
            }
          }
        },
      })
    })
    files.push(dir)
  }

  if (config.output.types) {
    const typesFile = resolve(options.cwd, config.output.types)
    transaction.add(typesFile, 'file', async staged => writeFile(staged, generateIconNameTypes(config.prefix, Object.keys(json.icons).sort()), 'utf8'))
    files.push(typesFile)
  }
  return { files, json, transaction }
}

export async function exportOutputs(
  iconSet: IconSet,
  config: ResolvedIconctlConfig,
  options: { cwd: string, dryRun?: boolean } = { cwd: process.cwd() },
): Promise<ExportResult> {
  if (options.dryRun) {
    return { files: [], json: iconSet.export() }
  }
  const previous = await readPreviousIconJson(resolve(options.cwd, config.output.json))
  const { files, json, transaction } = prepareOutputs(iconSet, config, { cwd: options.cwd, ...(previous ? { previous } : {}) })
  await transaction.commit()
  return { files, json }
}

import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedIconctlConfig } from './config'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { exportJSONPackage, IconSet as IconSetClass, writeJSONFile } from '@iconify/tools'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'pathe'
import { checkpoint } from './abort'
import { IconctlError } from './errors'
import { createIconifyJsonResolver } from './iconify-json'
import { decodeUtf8 } from './json-input'
import { OutputTransaction } from './output-transaction'
import { generateSvgSprite } from './sprite'

export interface ExportResult {
  files: string[]
  json: IconifyJSON
}

const svgManifest = '.iconctl-manifest.json'
const safeSvgName = /^[^/\\\0]+\.svg$/
const jsonPackageFiles = ['icons.json', 'info.json', 'metadata.json', 'chars.json', 'index.js', 'index.mjs', 'index.d.ts', 'package.json']

function outputIconNames(iconSet: IconSet): string[] {
  return iconSet.list(['icon', 'variation', 'alias']).sort().filter(name => iconSet.resolve(name) !== null)
}

function svgOutputNames(iconSet: IconSet): string[] {
  return outputIconNames(iconSet).map((name) => {
    const file = `${name}.svg`
    if (!safeSvgName.test(file)) {
      throw new IconctlError('SVG name escapes the output directory: names must be filenames without path separators')
    }
    return name
  })
}

/** Finite generated-file roster; completion proofs never choose filesystem paths. */
export function managedOutputFiles(config: ResolvedIconctlConfig, json: IconifyJSON, cwd: string): { path: string, optional?: boolean }[] {
  const files = new Map<string, { path: string, optional?: boolean }>()
  const add = (file: string, optional = false) => {
    const path = resolvePath(cwd, file)
    const existing = files.get(path)
    if (!existing || !optional) {
      files.set(path, { path, ...(optional ? { optional: true } : {}) })
    }
  }
  const { output } = config
  add(output.json)
  if (output.svg) {
    add(join(output.svg, svgManifest))
    for (const name of svgOutputNames(new IconSetClass(json))) {
      add(join(output.svg, `${name}.svg`))
    }
  }
  if (output.jsonPackage) {
    for (const file of jsonPackageFiles) {
      add(join(output.jsonPackage.dir, file))
    }
  }
  for (const file of [output.sprite, output.types, output.preview]) {
    if (file) {
      add(file)
    }
  }
  if (output.changelog) {
    add(output.changelog, true)
  }
  return [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

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

async function managedSvgFiles(directory: string, previous: IconifyJSON | undefined, signal?: AbortSignal): Promise<string[]> {
  const manifest = await readOptional(join(directory, svgManifest))
  let claimed: Set<string> | undefined
  if (manifest !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(manifest)
    }
    catch (cause) {
      throw new IconctlError(`Invalid SVG output manifest: ${join(directory, svgManifest)}`, { cause })
    }
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('files' in parsed) || !Array.isArray(parsed.files) || !parsed.files.every(file => typeof file === 'string' && safeSvgName.test(file))) {
      throw new IconctlError(`Invalid SVG output manifest: ${join(directory, svgManifest)}`)
    }
    claimed = new Set(parsed.files as string[])
  }
  let oldSet: IconSet
  let priorNames: string[]
  try {
    const resolver = createIconifyJsonResolver(previous)
    for (const name of resolver.names) {
      if ('issue' in resolver.resolve(name)) {
        return []
      }
    }
    oldSet = new IconSetClass(previous!)
    priorNames = svgOutputNames(oldSet)
  }
  catch {
    // Missing or invalid prior JSON cannot establish ownership of any file.
    return []
  }
  const managed: string[] = []
  for (const name of priorNames) {
    await checkpoint(signal)
    const file = `${name}.svg`
    if (claimed && !claimed.has(file)) {
      continue
    }
    let contents: string | null
    try {
      contents = oldSet.toString(name, { width: 'auto', height: 'auto' })
    }
    catch {
      // An entry that cannot be reconstructed does not prove file ownership.
      continue
    }
    if (contents && await readOptional(join(directory, file)) === contents) {
      managed.push(file)
    }
  }
  return managed
}

async function writeTextFile(file: string, contents: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
}

export function generateIconNameTypes(prefix: string, names: string[]): string {
  const literal = (value: string) => `'${JSON.stringify(value).slice(1, -1).replaceAll('\'', '\\\'').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}'`
  const union = names.length
    ? names.map(literal).join(' | ')
    : 'never'
  // A const string initializer already keeps its literal type and is also
  // valid in declaration files, where an `as const` expression is rejected.
  return `export const ICONIFY_PREFIX = ${literal(prefix)}\nexport type IconName = ${union}\n`
}

export async function readPreviousIconJson(file: string): Promise<IconifyJSON | undefined> {
  try {
    return JSON.parse(decodeUtf8(await readFile(file))) as IconifyJSON
  }
  catch {
    return undefined
  }
}

export async function generateOutputs(
  iconSet: IconSet,
  config: ResolvedIconctlConfig,
  options: { cwd: string, dryRun?: boolean, signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<ExportResult> {
  const files: string[] = []
  const json = iconSet.export()
  const resolve = (file: string) => file.startsWith('/') ? file : join(options.cwd, file)
  await checkpoint(options.signal)
  const sprite = config.output.sprite ? await generateSvgSprite(iconSet, options.signal) : undefined

  if (!options.dryRun) {
    await checkpoint(options.signal)
    const svgNames = config.output.svg ? svgOutputNames(iconSet) : []
    const generatedFiles = new Set<string>()
    if (config.output.svg) {
      for (const name of [...svgNames.map(name => `${name}.svg`), svgManifest]) {
        generatedFiles.add(resolvePath(resolve(config.output.svg), name))
      }
    }
    if (config.output.jsonPackage) {
      for (const name of jsonPackageFiles) {
        generatedFiles.add(resolvePath(resolve(config.output.jsonPackage.dir), name))
      }
    }
    for (const file of [config.output.json, config.output.sprite, config.output.types, config.output.preview, config.output.changelog]) {
      if (!file) {
        continue
      }
      const target = resolvePath(resolve(file))
      // The package's Iconify JSON can intentionally share the primary JSON
      // output. All other generated files have distinct contents and owners.
      const sharedJson = file === config.output.json && config.output.jsonPackage
        && target === resolvePath(resolve(config.output.jsonPackage.dir), 'icons.json')
      if (generatedFiles.has(target) && !sharedJson) {
        throw new IconctlError(`Conflicting output targets: generated file and ${target}`)
      }
    }
    const previous = await readPreviousIconJson(resolve(config.output.json))
    const managed = config.output.svg
      ? await managedSvgFiles(resolve(config.output.svg), previous, options.signal)
      : []
    if (config.output.jsonPackage) {
      const pkg = config.output.jsonPackage
      const dir = resolve(pkg.dir)
      let existing: Record<string, unknown> = {}
      if (pkg.clean === false) {
        const contents = await readOptional(join(dir, 'package.json'))
        if (contents) {
          existing = JSON.parse(contents) as Record<string, unknown>
        }
        for (const file of jsonPackageFiles) {
          await checkpoint(options.signal)
          await rm(join(dir, file), { force: true })
        }
      }
      await exportJSONPackage(iconSet, {
        target: dir,
        cleanup: pkg.clean !== false,
        package: {
          name: pkg.name ?? `@iconify-json/${config.prefix}`,
          description: `Iconify JSON generated by iconctl`,
          ...(typeof existing['version'] === 'string' ? { version: existing['version'] } : {}),
          ...pkg.package,
        },
        customisePackage: (contents) => {
          if (pkg.clean !== false) {
            return
          }
          for (const [key, value] of Object.entries(existing)) {
            if (!Object.hasOwn(contents, key)) {
              // Retain user metadata without allowing a JSON __proto__ key to
              // change the generated package object's prototype.
              Object.defineProperty(contents, key, { value, enumerable: true, configurable: true, writable: true })
            }
          }
        },
      })
      files.push(dir)
    }

    await checkpoint(options.signal)
    const jsonFile = resolve(config.output.json)
    await mkdir(dirname(jsonFile), { recursive: true })
    await writeJSONFile(jsonFile, json)
    files.push(jsonFile)

    if (config.output.svg) {
      const svgDir = resolve(config.output.svg)
      await mkdir(svgDir, { recursive: true })
      const next = svgNames.map(name => `${name}.svg`)
      for (const file of managed) {
        await checkpoint(options.signal)
        if (!next.includes(file)) {
          await rm(join(svgDir, file), { force: true })
        }
      }
      for (const name of svgNames) {
        await checkpoint(options.signal)
        const contents = iconSet.toString(name, { width: 'auto', height: 'auto' })
        if (!contents) {
          continue
        }
        const file = `${name}.svg`
        const target = join(svgDir, file)
        const path = relative(svgDir, target)
        if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
          throw new IconctlError(`SVG name escapes the output directory: ${file}`)
        }
        await rm(target, { force: true })
        await writeTextFile(target, contents)
      }
      await checkpoint(options.signal)
      await rm(join(svgDir, svgManifest), { force: true })
      await writeFile(join(svgDir, svgManifest), `${JSON.stringify({ version: 1, files: next.sort() }, null, 2)}\n`)
      files.push(svgDir)
    }

    if (config.output.sprite && sprite !== undefined) {
      await checkpoint(options.signal)
      const spriteFile = resolve(config.output.sprite)
      await writeTextFile(spriteFile, sprite)
      files.push(spriteFile)
    }

    await checkpoint(options.signal)
    if (config.output.types) {
      const names = outputIconNames(iconSet)
      const typesFile = resolve(config.output.types)
      await writeTextFile(typesFile, generateIconNameTypes(config.prefix, names))
      files.push(typesFile)
    }
  }

  const order = [config.output.json, config.output.svg, config.output.sprite, config.output.jsonPackage?.dir, config.output.types]
    .flatMap(file => file ? [resolve(file)] : [])
  files.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { files, json }
}

export function outputTargets(config: ResolvedIconctlConfig, cwd: string): { path: string, directory?: boolean }[] {
  const output = config.output
  return [
    { path: resolvePath(cwd, output.json) },
    ...(output.svg ? [{ path: resolvePath(cwd, output.svg), directory: true }] : []),
    ...(output.sprite ? [{ path: resolvePath(cwd, output.sprite) }] : []),
    ...(output.jsonPackage ? [{ path: resolvePath(cwd, output.jsonPackage.dir), directory: true }] : []),
    ...[output.types, output.preview, output.changelog].flatMap(file => file ? [{ path: resolvePath(cwd, file) }] : []),
  ]
}

export function stagedConfig(config: ResolvedIconctlConfig, cwd: string, transaction: OutputTransaction): ResolvedIconctlConfig {
  const path = (file: string) => transaction.path(resolvePath(cwd, file))
  const output = config.output
  return {
    ...config,
    output: {
      json: path(output.json),
      ...(output.svg ? { svg: path(output.svg) } : {}),
      ...(output.sprite ? { sprite: path(output.sprite) } : {}),
      ...(output.jsonPackage ? { jsonPackage: { ...output.jsonPackage, dir: path(output.jsonPackage.dir) } } : {}),
      ...(output.types ? { types: path(output.types) } : {}),
      ...(output.preview ? { preview: path(output.preview) } : {}),
      ...(output.changelog ? { changelog: path(output.changelog) } : {}),
    },
  }
}

export async function exportOutputs(
  iconSet: IconSet,
  config: ResolvedIconctlConfig,
  options: { cwd: string, dryRun?: boolean, signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<ExportResult> {
  await checkpoint(options.signal)
  if (options.dryRun) {
    return generateOutputs(iconSet, config, options)
  }
  // Preview and changelog remain sync() responsibilities.
  const { preview: _preview, changelog: _changelog, ...output } = config.output
  const exportConfig = { ...config, output }
  const targets = outputTargets(exportConfig, options.cwd)
  const transaction = await OutputTransaction.create(targets, options.signal)
  try {
    const generatedConfig = stagedConfig(exportConfig, options.cwd, transaction)
    const result = await generateOutputs(iconSet, generatedConfig, options)
    await transaction.commit(options.signal)
    return { json: result.json, files: targets.map(target => target.path) }
  }
  finally {
    await transaction.dispose()
  }
}

import type { IconSet } from '@iconify/tools'
import type { IconifyJSON } from '@iconify/types'
import type { ResolvedFigmaIconifyConfig } from './config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { exportJSONPackage, exportToDirectory, writeJSONFile } from '@iconify/tools'
import { dirname, join } from 'pathe'

export interface ExportResult {
  files: string[]
  json: IconifyJSON
}

async function writeTextFile(file: string, contents: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
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

export async function exportOutputs(
  iconSet: IconSet,
  config: ResolvedFigmaIconifyConfig,
  options: { cwd: string, dryRun?: boolean } = { cwd: process.cwd() },
): Promise<ExportResult> {
  const files: string[] = []
  const json = iconSet.export()
  const resolve = (file: string) => file.startsWith('/') ? file : join(options.cwd, file)

  if (!options.dryRun) {
    const jsonFile = resolve(config.output.json)
    await writeJSONFile(jsonFile, json)
    files.push(jsonFile)

    if (config.output.svg) {
      const svgDir = resolve(config.output.svg)
      await exportToDirectory(iconSet, { target: svgDir })
      files.push(svgDir)
    }

    if (config.output.jsonPackage) {
      const dir = resolve(config.output.jsonPackage)
      await exportJSONPackage(iconSet, {
        target: dir,
        package: {
          name: `@iconify-json/${config.prefix}`,
          description: `Iconify JSON generated from Figma by figma-iconify`,
        },
      })
      files.push(dir)
    }

    if (config.output.types) {
      const names = Object.keys(json.icons).sort()
      const typesFile = resolve(config.output.types)
      await writeTextFile(typesFile, generateIconNameTypes(config.prefix, names))
      files.push(typesFile)
    }
  }

  return { files, json }
}

import { matchesGlob } from 'node:path'
import { parse } from 'yaml'

const CHANGESET_PATH = /^\.changeset\/[^/]+\.md$/

export function isReleaseBranch(ref) {
  return /^(?:pnpm-release\/|release\/pnpm-version)/.test(ref)
}

export function isPublishableManifest(manifest) {
  return Boolean(manifest && typeof manifest.name === 'string' && manifest.name.trim() && manifest.private !== true)
}

function workspacePatterns(content) {
  if (content === undefined) {
    throw new Error('pnpm-workspace.yaml is missing at the inspected commit')
  }
  const workspace = parse(content)
  const patterns = workspace?.packages ?? ['**']
  if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern === '!')) {
    throw new Error('pnpm-workspace.yaml packages must contain nonempty glob strings')
  }
  return patterns.map(pattern => pattern.replace(/^(!?)\.\//, '$1').replace(/\/$/, ''))
}

function includedDirectory(directory, patterns) {
  return patterns.some(pattern => !pattern.startsWith('!') && matchesGlob(directory, pattern))
    && !patterns.some(pattern => pattern.startsWith('!') && matchesGlob(directory, pattern.slice(1)))
}

function changedPaths(files) {
  return [...new Set(files.flatMap(file => typeof file === 'string'
    ? [file]
    : [file.filename, file.previous_filename].filter(Boolean)))]
}

/** Read only JSON/YAML data from the inspected commit; never import its code. */
export async function publishablePackagesForFiles(files, readContent) {
  const patterns = workspacePatterns(await readContent('pnpm-workspace.yaml'))
  const manifests = new Map()
  const names = new Set()
  for (const filename of changedPaths(files)) {
    const segments = filename.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..') || filename.includes('\0')) {
      throw new Error(`Invalid changed file path: ${filename}`)
    }
    if (segments.some(segment => ['dist', 'node_modules', '.git'].includes(segment))) {
      continue
    }
    // The nearest current workspace manifest owns a changed file. Removed
    // packages have no current version to release; moves use the new path.
    for (let length = segments.length - 1; length > 0; length--) {
      const directory = segments.slice(0, length).join('/')
      if (!includedDirectory(directory, patterns)) {
        continue
      }
      if (!manifests.has(directory)) {
        const content = await readContent(`${directory}/package.json`)
        manifests.set(directory, content === undefined ? undefined : JSON.parse(content))
      }
      const manifest = manifests.get(directory)
      if (!manifest) {
        continue
      }
      if (isPublishableManifest(manifest)) {
        names.add(manifest.name)
      }
      break
    }
  }
  return [...names].sort()
}

export function changedChangesets(files) {
  return [...new Set(files
    .filter(file => typeof file === 'string' || file.status !== 'removed')
    .map(file => typeof file === 'string' ? file : file.filename)
    .filter(filename => CHANGESET_PATH.test(filename)))]
}

export async function checkReleaseIntent(files, readContent) {
  const packages = await publishablePackagesForFiles(files, readContent)
  const covered = new Set()
  if (packages.length) {
    for (const filename of changedChangesets(files)) {
      const content = await readContent(filename)
      if (content === undefined) {
        continue
      }
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
      if (frontmatter === undefined) {
        throw new Error(`Invalid release intent frontmatter: ${filename}`)
      }
      const intent = parse(frontmatter)
      if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
        throw new Error(`Invalid release intent packages: ${filename}`)
      }
      for (const [name, level] of Object.entries(intent)) {
        if (!['patch', 'minor', 'major'].includes(level)) {
          throw new Error(`Invalid release level for ${name} in ${filename}`)
        }
        covered.add(name)
      }
    }
  }
  return { packages, missing: packages.filter(name => !covered.has(name)) }
}

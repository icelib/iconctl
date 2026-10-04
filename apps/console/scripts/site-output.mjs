import { constants } from 'node:fs'
import { access, lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The build owns this package's output, regardless of the caller's cwd.
const consoleRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const websiteRoot = path.resolve(consoleRoot, '../website')
export const source = path.join(websiteRoot, '.vitepress/dist')
export const target = path.join(consoleRoot, 'dist/public')
const reserved = new Set(['app', 'app.html', 'api', 'api.html', 'login', 'login.html'])

async function directory(location, optional = false) {
  const stat = await lstat(location).catch((error) => {
    if (optional && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Build directory must be a real directory, not a symbolic link: ${location}`)
  }
  return Boolean(stat)
}

/** Check both output components: rm(public) must never traverse a linked dist. */
export async function checkOutput() {
  await directory(path.join(consoleRoot, 'dist'), true)
  await directory(target, true)
}

async function checkTree(location, label) {
  for (const entry of await readdir(location, { withFileTypes: true })) {
    const child = path.join(location, entry.name)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`${label} contains an unsupported entry: ${child}`)
    }
    if (entry.isDirectory()) {
      await checkTree(child, label)
    }
    else {
      await access(child, constants.R_OK)
    }
  }
}

/** Direct assembly must not copy through leftover links in a destination subtree. */
export async function checkAssemblyOutput() {
  await checkOutput()
  if (await directory(target, true)) {
    await checkTree(target, 'Assembled output')
  }
}

/** Complete input validation runs before removing or copying any output. */
export async function checkWebsite() {
  await directory(websiteRoot)
  await directory(path.join(websiteRoot, '.vitepress'))
  await directory(source)
  const entries = await readdir(source)
  for (const name of entries) {
    if (reserved.has(name.toLowerCase())) {
      throw new Error(`Documentation output uses reserved route: ${name}`)
    }
  }
  const index = await lstat(path.join(source, 'index.html'))
  if (!index.isFile() || index.isSymbolicLink()) {
    throw new Error('Documentation output must include a regular index.html file')
  }
  await checkTree(source, 'Documentation output')
  return entries
}

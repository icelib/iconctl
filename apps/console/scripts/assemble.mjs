import { cp, mkdir, readdir } from 'node:fs/promises'
// Resolve paths relative to scripts/, not to the caller's working directory.
const source = new URL('../../website/.vitepress/dist/', import.meta.url)
const target = new URL('../dist/public/', import.meta.url)
await mkdir(target, { recursive: true })
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (['app', 'api', 'login', 'login.html', 'app.html'].includes(entry.name)) {
    throw new Error(`Documentation output uses reserved route: ${entry.name}`)
  }
  await cp(new URL(entry.name, source), new URL(entry.name, target), {
    recursive: true,
    force: true,
  })
}

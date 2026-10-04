import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { checkAssemblyOutput, checkWebsite, source, target } from './site-output.mjs'

// Recheck after Vite, before copying anything, in case the input has changed.
const entries = await checkWebsite()
await checkAssemblyOutput()
await mkdir(target, { recursive: true })
for (const name of entries) {
  await cp(path.join(source, name), path.join(target, name), {
    recursive: true,
    force: true,
  })
}

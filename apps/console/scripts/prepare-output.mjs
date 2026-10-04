import { mkdir, rm } from 'node:fs/promises'
import { checkOutput, checkWebsite, target } from './site-output.mjs'

await checkWebsite()
await checkOutput()
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

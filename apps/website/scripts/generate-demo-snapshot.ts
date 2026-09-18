#!/usr/bin/env -S node --experimental-strip-types
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolveConfig, sync } from '@iconctl/core'
import { DEMO_ICONS, DEMO_PREFIX } from '../figma-demo-icons.ts'

const websiteRoot = fileURLToPath(new URL('..', import.meta.url))
const jsonFile = '.vitepress/theme/data/figma-demo.json'
const svgDir = fileURLToPath(new URL('./lucide-svg', import.meta.url))

const files = new Set((await readdir(svgDir)).filter(name => name.endsWith('.svg')).map(name => name.slice(0, -4)))
const missing = DEMO_ICONS.filter(name => !files.has(name))
if (missing.length) {
  throw new Error(`Missing Lucide SVG fixtures: ${missing.join(', ')}`)
}

const result = await sync({
  cwd: websiteRoot,
  config: resolveConfig({
    prefix: DEMO_PREFIX,
    sources: [{ type: 'directory', dir: svgDir }],
    output: { json: jsonFile },
    validate: { width: 24, height: 24 },
  }),
})

const names = Object.keys(result.json.icons).sort()
if (names.length !== DEMO_ICONS.length) {
  throw new Error(`Expected ${DEMO_ICONS.length} icons, got ${names.length}: ${names.join(', ')}`)
}

await writeFile(join(websiteRoot, jsonFile), `${JSON.stringify(result.json, null, 2)}\n`, 'utf8')
process.stdout.write(`Wrote ${names.length} icons to ${jsonFile}\n`)

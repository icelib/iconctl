#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { COMPARE_ICONS } from '../.vitepress/theme/data/format-scores.ts'

const websiteRoot = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(tmpdir(), `iconctl-font-src-${Date.now()}`)
const outDir = join(tmpdir(), `iconctl-font-out-${Date.now()}`)
const svgDir = join(websiteRoot, 'scripts/lucide-svg')
const publicDir = join(websiteRoot, 'public/demo')

await mkdir(srcDir, { recursive: true })
await mkdir(outDir, { recursive: true })
await mkdir(publicDir, { recursive: true })

for (const name of COMPARE_ICONS) {
  await cp(join(svgDir, `${name}.svg`), join(srcDir, `${name}.svg`))
}

await new Promise<void>((resolve, reject) => {
  const child = spawn('npx', [
    '--yes',
    'fantasticon',
    srcDir,
    '-o',
    outDir,
    '--font-types',
    'woff2',
    '--asset-types',
    'json',
    '--name',
    'iconctl-compare',
    '--normalize',
    'true',
  ], { stdio: 'inherit' })
  child.on('exit', (code) => {
    if (code === 0) {
      resolve()
    }
    else {
      reject(new Error(`fantasticon exited ${code}`))
    }
  })
})

await cp(join(outDir, 'iconctl-compare.woff2'), join(publicDir, 'iconctl-compare.woff2'))
await cp(join(outDir, 'iconctl-compare.json'), join(publicDir, 'iconctl-compare.json'))
process.stdout.write(`Wrote ${join(publicDir, 'iconctl-compare.woff2')}\n`)

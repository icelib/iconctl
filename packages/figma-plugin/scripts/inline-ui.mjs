import { copyFile, readFile, writeFile } from 'node:fs/promises'

const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8')
const js = await readFile(new URL('../dist/ui.iife.js', import.meta.url), 'utf8')
await writeFile(
  new URL('../dist/ui.html', import.meta.url),
  html.replace('<script src="./ui.js"></script>', `<script>${js}</script>`),
)
await copyFile(new URL('../dist/code.iife.js', import.meta.url), new URL('../dist/code.js', import.meta.url))

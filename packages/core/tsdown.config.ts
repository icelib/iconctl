import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'index': './src/index.ts', 'figma-oauth': './src/figma/oauth.ts', 'watch-worker': './src/watch-worker.ts' },
  format: ['esm', 'cjs'],
  // Ship the fixed traversal stack; consumers do not inherit workspace patches.
  deps: { alwaysBundle: ['chokidar', 'readdirp'], onlyBundle: ['chokidar', 'readdirp'] },
  dts: true,
  clean: true,
  target: 'node18',
  failOnWarn: false,
  hooks: {
    'build:done': async function ({ options, chunks }) {
      // Node >=22.13 supports synchronous require(ESM). Share the ESM graph so
      // import-only dependencies and Error identities also work for require().
      await Promise.all(chunks.filter(chunk => chunk.type === 'chunk' && chunk.isEntry && chunk.fileName.endsWith('.cjs')).map(chunk => writeFile(
        join(options.outDir, chunk.fileName),
        `module.exports = require('./${chunk.fileName.replace(/\.cjs$/, '.mjs')}')\n`,
      )))
    },
  },
})

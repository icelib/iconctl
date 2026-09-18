import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['./src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'es2022',
    failOnWarn: false,
  },
  {
    entry: ['./src/code.ts'],
    format: ['iife'],
    dts: false,
    clean: false,
    platform: 'browser',
    target: 'es2022',
    failOnWarn: false,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: ['./src/ui.ts'],
    format: ['iife'],
    dts: false,
    clean: false,
    platform: 'browser',
    target: 'es2022',
    failOnWarn: false,
    outExtensions: () => ({ js: '.js' }),
  },
])

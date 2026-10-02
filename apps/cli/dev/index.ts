#!/usr/bin/env -S node --experimental-strip-types
import process from 'node:process'
import { runCli } from '../src/program.ts'

// Match the packaged entry: the rejected error has already been reported.
runCli().catch(() => {
  process.exitCode = 1
})

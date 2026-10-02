import process from 'node:process'
import { runCli } from './program'

// runCli owns diagnostics and preserves rejection for library callers.
runCli(process.argv).catch(() => {
  process.exitCode = 1
})

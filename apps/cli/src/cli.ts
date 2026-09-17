import process from 'node:process'
import { runCli } from './program'

runCli(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
})

import process from 'node:process'
import { run } from './index'

run().catch(() => {
  console.error(
    'iconctl console task failed. Open the console for the task stage and validation results.',
  )
  process.exitCode = 1
})

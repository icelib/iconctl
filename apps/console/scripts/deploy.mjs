import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { prepareConsoleDeployment } from './deployment.mjs'

const environment = process.argv[2]
if (environment === 'production') {
  throw new Error('Production deployment follows a completed stable release. Use pnpm -w exec repo docs deploy website --channel stable --release <record-id> in the managed Documentation workflow.')
}
const { cwd, args } = prepareConsoleDeployment(environment)
execFileSync('pnpm', [...args, '--dry-run'], { cwd, stdio: 'inherit' })
execFileSync('pnpm', args, { cwd, stdio: 'inherit' })

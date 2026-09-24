import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

const environment = process.argv[2]
if (!['production', 'staging'].includes(environment)) {
  throw new Error('Choose staging or production')
}
const root = new URL('../../../', import.meta.url)
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (
  execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
) {
  throw new Error('Commit all changes before deploying a pinned executor')
}
execFileSync('git', ['fetch', 'origin', 'main'], {
  cwd: root,
  stdio: 'inherit',
})
execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
  cwd: root,
  stdio: 'inherit',
})
const configuration = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
)
const origin
  = process.env.ICONCTL_APP_ORIGIN
    || (environment === 'staging'
      ? configuration.env.staging.vars.APP_ORIGIN
      : configuration.vars.APP_ORIGIN)
if (!/^https:\/\/[a-z0-9.-]+$/.test(origin) || origin.includes('REPLACE')) {
  throw new Error(
    'Set ICONCTL_APP_ORIGIN to the configured HTTPS callback origin',
  )
}
const flags = [
  'exec',
  'wrangler',
  'deploy',
  '--env',
  environment === 'staging' ? 'staging' : '',
  '--var',
  `EXECUTOR_COMMIT:${sha}`,
  '--var',
  `APP_ORIGIN:${origin}`,
]
execFileSync('pnpm', [...flags, '--dry-run'], { stdio: 'inherit' })
execFileSync('pnpm', flags, { stdio: 'inherit' })

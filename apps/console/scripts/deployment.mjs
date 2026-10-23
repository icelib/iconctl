import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Pin the executor to an unchanged commit that belongs to main. */
export function assertPinnedSource({ root = repositoryRoot, expectedSha, run = execFileSync } = {}) {
  const git = args => run('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const sha = git(['rev-parse', 'HEAD'])
  if (!/^[a-f\d]{40}$/u.test(sha) || (expectedSha && sha !== expectedSha)) {
    throw new Error('Deployment HEAD must equal the verified documentation source SHA')
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Commit all changes before deploying a pinned executor')
  }
  run('git', ['fetch', 'origin', 'main'], { cwd: root, stdio: 'inherit' })
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'inherit' })
  return sha
}

/** Shared by the managed production adapter and the explicit staging command. */
export function prepareConsoleDeployment(environment, {
  root = repositoryRoot,
  expectedSha,
  env = process.env,
  run = execFileSync,
  read = readFileSync,
} = {}) {
  if (!['production', 'staging'].includes(environment)) {
    throw new Error('Choose staging or production')
  }
  const sha = assertPinnedSource({ root, expectedSha, run })
  const cwd = path.join(root, 'apps/console')
  const configuration = JSON.parse(read(path.join(cwd, 'wrangler.jsonc'), 'utf8'))
  const target = environment === 'staging' ? configuration.env.staging : configuration
  const origin = env.ICONCTL_APP_ORIGIN || target.vars.APP_ORIGIN
  if (!/^https:\/\/[a-z0-9.-]+$/u.test(origin) || origin.includes('REPLACE')) {
    throw new Error('Set ICONCTL_APP_ORIGIN to the configured HTTPS callback origin')
  }
  return {
    cwd,
    sha,
    origin,
    args: [
      'exec',
      'wrangler',
      'deploy',
      '--env',
      environment === 'staging' ? 'staging' : '',
      '--var',
      `EXECUTOR_COMMIT:${sha}`,
      '--var',
      `APP_ORIGIN:${origin}`,
    ],
  }
}

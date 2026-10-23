import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertPinnedSource } from '../../apps/console/scripts/deployment.mjs'
import { assertDeploymentContext, buildIdentity, docsTargets } from './identity.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

export function buildCommands(channel) {
  if (channel === 'preview') {
    return [['exec', 'turbo', 'run', 'build', '--filter=@iconctl/website...', '--force']]
  }
  return [
    ['exec', 'turbo', 'run', 'build', '--filter=@iconctl/console...', '--filter=@iconctl/console-runner...', '--force'],
    ['--filter', '@iconctl/console', 'run', 'test:build'],
    ['--filter', '@iconctl/console', 'run', 'test:worker'],
  ]
}

export async function buildDocumentation({ root = repositoryRoot, env = process.env, run = execFileSync, write = writeFile } = {}) {
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const identity = buildIdentity(env, sha)
  if (identity.deploymentId || identity.channel === 'stable') {
    assertDeploymentContext(env, identity.channel)
    assertPinnedSource({ root, expectedSha: identity.sourceSha, run })
  }
  const buildEnv = { ...env, REPO_DOCS_CHANNEL: identity.channel }
  for (const args of buildCommands(identity.channel)) {
    run('pnpm', args, { cwd: root, env: buildEnv, stdio: 'inherit' })
  }
  const output = path.join(root, docsTargets[identity.channel].output, 'docs-build.json')
  await write(output, `${JSON.stringify(identity)}\n`)
  return identity
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildDocumentation()
}

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertPinnedSource, prepareConsoleDeployment } from '../../apps/console/scripts/deployment.mjs'
import { cloudflareClient, deployVerifiedVersion, previewUrl, readDeploymentVersion } from './cloudflare.mjs'
import { assertBuildIdentity, assertDeploymentContext, buildIdentity, deploymentMessage, docsTargets, resolveChannel } from './identity.mjs'

const channel = resolveChannel(process.argv[2])
assertDeploymentContext(process.env, channel)
const root = fileURLToPath(new URL('../../', import.meta.url))
const identity = buildIdentity(process.env)
const target = docsTargets[channel]
assertBuildIdentity(JSON.parse(await readFile(path.join(root, target.output, 'docs-build.json'), 'utf8')), identity)

let args
if (channel === 'stable') {
  const production = prepareConsoleDeployment('production', { root, expectedSha: identity.sourceSha })
  if (production.origin !== target.url) {
    throw new Error('Production callback origin must match the configured stable documentation URL.')
  }
  args = production.args
}
else {
  assertPinnedSource({ root, expectedSha: identity.sourceSha })
  args = ['exec', 'wrangler', 'deploy', '--config', 'wrangler.preview.jsonc']
}
args.push('--message', deploymentMessage(identity))
const client = cloudflareClient(process.env)
const url = target.url ?? await previewUrl(client, target.worker)
if (process.env.REPO_DOCS_URL && process.env.REPO_DOCS_URL !== url) {
  throw new Error('Configured documentation URL differs from the Cloudflare deployment target.')
}
const versionId = await deployVerifiedVersion({
  client,
  worker: target.worker,
  identity,
  upload: async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'iconctl-docs-deploy-'))
    try {
      const outputFile = path.join(temporary, 'wrangler.jsonl')
      const cwd = path.join(root, target.directory)
      execFileSync('pnpm', [...args, '--dry-run'], { cwd, stdio: 'inherit' })
      execFileSync('pnpm', args, {
        cwd,
        env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
        stdio: 'inherit',
      })
      return readDeploymentVersion(await readFile(outputFile, 'utf8'), target.worker)
    }
    finally {
      await rm(temporary, { recursive: true, force: true })
    }
  },
})
const result = { versionId, url }
await writeFile(process.env.REPO_DOCS_RESULT_FILE, `${JSON.stringify(result)}\n`)
console.log(JSON.stringify(result))

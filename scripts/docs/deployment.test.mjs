import assert from 'node:assert/strict'
import path from 'node:path'
// Deployment adapters run in Node independently of both application Vitest runtimes.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { assertPinnedSource, prepareConsoleDeployment } from '../../apps/console/scripts/deployment.mjs'
import { buildDocumentation } from './build.mjs'
import { activeMatchingVersion, cloudflareClient, deployVerifiedVersion, previewUrl, readDeploymentVersion } from './cloudflare.mjs'
import { assertBuildIdentity, assertDeploymentContext, buildIdentity, deploymentMessage } from './identity.mjs'

const sha = 'a'.repeat(40)
const versionId = '11111111-2222-4333-8444-555555555555'
const otherVersionId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const root = path.resolve('/tmp/iconctl-docs-test')
const env = {
  REPO_DOCS_SITE: 'website',
  REPO_DOCS_CHANNEL: 'stable',
  REPO_DOCS_SOURCE_SHA: sha,
  REPO_DOCS_RELEASE_ID: 'release-completion',
  REPO_DOCS_DEPLOYMENT_ID: 'b'.repeat(64),
  REPO_DOCS_RESULT_FILE: path.join(root, 'result.json'),
  REPO_DOCS_URL: 'https://iconctl.icebreaker.top',
  GITHUB_ACTIONS: 'true',
  GITHUB_RUN_ID: '123',
  GITHUB_REF: 'refs/heads/main',
  REPO_DOCS_CONCURRENCY_GROUP: 'docs-website-stable',
}
const identity = buildIdentity(env)

function gitRunner({ dirty = '', head = sha, ancestryError } = {}) {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'git' && args[0] === 'rev-parse') {
      return `${head}\n`
    }
    if (command === 'git' && args[0] === 'status') {
      return dirty
    }
    if (command === 'git' && args[0] === 'merge-base' && ancestryError) {
      throw ancestryError
    }
    return ''
  }
  return { calls, run }
}

function activeState(id = versionId, message = deploymentMessage(identity)) {
  return {
    deployments: [{ created_on: '2026-10-23T00:00:00Z', versions: [{ version_id: id, percentage: 100 }] }],
    version: { id, annotations: { 'workers/message': message } },
  }
}

function fakeCloudflare(readState) {
  return async (endpoint) => {
    const state = readState()
    if (endpoint.endsWith('/deployments')) {
      return state ? { deployments: state.deployments } : undefined
    }
    if (endpoint.includes('/versions/')) {
      return state.versions?.[endpoint.split('/').at(-1)] ?? state.version
    }
    throw new Error(`Unexpected Cloudflare request: ${endpoint}`)
  }
}

test('production requires managed release, identity, main and serialization context', () => {
  assert.doesNotThrow(() => assertDeploymentContext(env, 'stable'))
  for (const field of ['REPO_DOCS_RELEASE_ID', 'REPO_DOCS_DEPLOYMENT_ID', 'REPO_DOCS_SOURCE_SHA', 'REPO_DOCS_RESULT_FILE', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_REF', 'REPO_DOCS_CONCURRENCY_GROUP']) {
    assert.throws(() => assertDeploymentContext({ ...env, [field]: '' }, 'stable'))
  }
  assert.throws(() => assertDeploymentContext({ ...env, REPO_DOCS_URL: 'https://example.com' }, 'stable'))
  assert.throws(() => assertDeploymentContext(env, 'preview'))
})

test('build artifact identity cannot be reused across sources or channels', () => {
  assert.doesNotThrow(() => assertBuildIdentity({ ...identity }, identity))
  assert.throws(() => assertBuildIdentity({ ...identity, channel: 'preview' }, identity), /does not match/u)
  assert.throws(() => assertBuildIdentity({ ...identity, sourceSha: 'c'.repeat(40) }, identity), /does not match/u)
  assert.throws(() => assertBuildIdentity(null, identity), /does not match/u)
})

test('source validation rejects dirty files, another HEAD and commits outside main', () => {
  for (const dirty of [' M apps/console/worker/index.ts\n', 'M  apps/website/index.md\n', '?? unexpected.txt\n']) {
    const { calls, run } = gitRunner({ dirty })
    assert.throws(() => assertPinnedSource({ root, expectedSha: sha, run }), /Commit all changes/u)
    assert.equal(calls.some(call => call.args[0] === 'fetch'), false)
  }
  assert.throws(() => assertPinnedSource({ root, expectedSha: sha, run: gitRunner({ head: 'c'.repeat(40) }).run }), /HEAD must equal/u)
  assert.throws(() => assertPinnedSource({ root, expectedSha: sha, run: gitRunner({ ancestryError: new Error('not on main') }).run }), /not on main/u)
})

test('console deployment pins the verified executor and retains environment-specific origin', () => {
  const configuration = {
    vars: { APP_ORIGIN: env.REPO_DOCS_URL },
    env: { staging: { vars: { APP_ORIGIN: 'https://console-staging.example.com' } } },
  }
  for (const environment of ['production', 'staging']) {
    const { run, calls } = gitRunner()
    const result = prepareConsoleDeployment(environment, { root, expectedSha: sha, env: {}, run, read: () => JSON.stringify(configuration) })
    assert.ok(result.args.includes(`EXECUTOR_COMMIT:${sha}`))
    assert.ok(result.args.includes(`APP_ORIGIN:${environment === 'production' ? env.REPO_DOCS_URL : configuration.env.staging.vars.APP_ORIGIN}`))
    assert.equal(result.cwd, path.join(root, 'apps/console'))
    assert.ok(calls.some(call => call.args.join(' ') === `merge-base --is-ancestor ${sha} origin/main`))
  }
})

test('preview build includes documentation dependencies without building the console', async () => {
  const { run, calls } = gitRunner()
  let output
  const result = await buildDocumentation({
    root,
    env: {},
    run,
    write: async (...args) => {
      output = args
    },
  })
  const commands = calls.filter(call => call.command === 'pnpm')
  assert.equal(commands.length, 1)
  assert.ok(commands[0].args.includes('--filter=@iconctl/website...'))
  assert.equal(commands[0].options.env.REPO_DOCS_CHANNEL, 'preview')
  assert.equal(result.sourceSha, sha)
  assert.equal(output[0], path.join(root, 'apps/website/.vitepress/dist/docs-build.json'))
})

test('stable build validates source, builds the unified site and runner, then runs both console checks', async () => {
  const { run, calls } = gitRunner()
  let output
  await buildDocumentation({
    root,
    env,
    run,
    write: async (...args) => {
      output = args
    },
  })
  const commands = calls.filter(call => call.command === 'pnpm')
  assert.ok(commands[0].args.includes('--filter=@iconctl/console...'))
  assert.ok(commands[0].args.includes('--filter=@iconctl/console-runner...'))
  assert.equal(commands[0].options.env.REPO_DOCS_CHANNEL, 'stable')
  assert.deepEqual(commands.slice(1).map(call => call.args.at(-1)), ['test:build', 'test:worker'])
  assert.equal(output[0], path.join(root, 'apps/console/dist/public/docs-build.json'))
})

test('failed build does not write deployable metadata', async () => {
  let wrote = false
  const { run } = gitRunner()
  await assert.rejects(buildDocumentation({
    root,
    env,
    run: (command, args, options) => {
      if (command === 'pnpm') {
        throw new Error('Build failed')
      }
      return run(command, args, options)
    },
    write: async () => { wrote = true },
  }), /Build failed/u)
  assert.equal(wrote, false)
})

test('a retried deployment reconciles its active identity without uploading again', async () => {
  let uploads = 0
  const result = await deployVerifiedVersion({
    client: fakeCloudflare(() => activeState()),
    worker: 'iconctl-docs',
    identity,
    upload: async () => {
      uploads++
      return versionId
    },
  })
  assert.equal(result, versionId)
  assert.equal(uploads, 0)
})

test('new deployment succeeds only after its exact version and marker are active', async () => {
  let state
  const result = await deployVerifiedVersion({
    client: fakeCloudflare(() => state),
    worker: 'iconctl-docs',
    identity,
    upload: async () => {
      state = activeState()
      return versionId
    },
  })
  assert.equal(result, versionId)
  for (const after of [activeState(otherVersionId), activeState(versionId, 'another-deployment')]) {
    state = undefined
    await assert.rejects(deployVerifiedVersion({
      client: fakeCloudflare(() => state),
      worker: 'iconctl-docs',
      identity,
      upload: async () => {
        state = after
        return versionId
      },
    }), /not confirmed active/u)
  }
})

test('an upload with a lost response is recovered immediately without a second upload', async () => {
  let state
  let uploads = 0
  const options = {
    client: fakeCloudflare(() => state),
    worker: 'iconctl-docs',
    identity,
    upload: async () => {
      uploads++
      state = activeState()
      throw new Error('lost response')
    },
  }
  assert.equal(await deployVerifiedVersion(options), versionId)
  assert.equal(await deployVerifiedVersion(options), versionId)
  assert.equal(uploads, 1)
})

test('a superseded deployment in history cannot overwrite the newer active version', async () => {
  const state = activeState(otherVersionId, 'repoctl-docs:newer')
  const historical = activeState()
  historical.deployments[0].created_on = '2026-10-22T00:00:00Z'
  state.deployments.unshift(historical.deployments[0])
  state.versions = { [otherVersionId]: state.version, [versionId]: historical.version }
  let uploads = 0
  await assert.rejects(deployVerifiedVersion({
    client: fakeCloudflare(() => state),
    worker: 'iconctl-docs',
    identity,
    upload: async () => {
      uploads++
      return versionId
    },
  }), /superseded/u)
  assert.equal(uploads, 0)
  assert.equal(state.version.id, otherVersionId)
})

test('failed uploads without confirmed activation return no deployment result', async () => {
  let result
  await assert.rejects(async () => {
    result = await deployVerifiedVersion({
      client: fakeCloudflare(() => undefined),
      worker: 'iconctl-docs',
      identity,
      upload: async () => { throw new Error('upload failed') },
    })
  }, /upload failed/u)
  assert.equal(result, undefined)
})

test('split traffic and malformed provider state stop before upload', async () => {
  const state = activeState()
  state.deployments[0].versions[0].percentage = 50
  let uploaded = false
  await assert.rejects(deployVerifiedVersion({
    client: fakeCloudflare(() => state),
    worker: 'iconctl-docs',
    identity,
    upload: async () => { uploaded = true },
  }), /100% of traffic/u)
  assert.equal(uploaded, false)
  await assert.rejects(activeMatchingVersion(async () => ({}), 'iconctl-docs', identity), /invalid deployments/u)
})

test('structured Wrangler output must belong to the intended Worker and environment', () => {
  const deployment = { type: 'deploy', worker_name: 'iconctl-docs', version_id: versionId }
  assert.equal(readDeploymentVersion(`${JSON.stringify({ type: 'other' })}\n${JSON.stringify(deployment)}\n`, 'iconctl-docs'), versionId)
  assert.throws(() => readDeploymentVersion(JSON.stringify({ ...deployment, worker_name: 'wrong-worker' }), 'iconctl-docs'), /did not report/u)
  assert.throws(() => readDeploymentVersion(JSON.stringify({ ...deployment, wrangler_environment: 'staging' }), 'iconctl-docs'), /did not report/u)
  assert.throws(() => readDeploymentVersion('invalid JSON', 'iconctl-docs'))
})

test('preview URL uses the actual account workers.dev subdomain', async () => {
  assert.equal(await previewUrl(async () => ({ subdomain: 'my-account' }), 'iconctl-docs-preview'), 'https://iconctl-docs-preview.my-account.workers.dev')
  await assert.rejects(previewUrl(async () => ({ subdomain: 'invalid/domain' }), 'iconctl-docs-preview'), /valid workers.dev/u)
})

test('Cloudflare errors fail closed without including token or provider message', async () => {
  const secret = 'private-test-token'
  const client = cloudflareClient({ CLOUDFLARE_API_TOKEN: secret, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }, async () => ({
    ok: false,
    status: 403,
    json: async () => ({ success: false, errors: [{ code: 10000, message: secret }] }),
  }))
  await assert.rejects(client('subdomain'), (error) => {
    assert.match(error.message, /HTTP 403/u)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test('only confirmed missing Worker permits an initial deployment', async () => {
  const credentials = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }
  const client = cloudflareClient(credentials, async () => ({
    ok: false,
    status: 404,
    json: async () => ({ success: false, errors: [{ code: 10007 }] }),
  }))
  assert.equal(await client('scripts/new/deployments', true), undefined)
  await assert.rejects(client('subdomain'), /HTTP 404/u)
})

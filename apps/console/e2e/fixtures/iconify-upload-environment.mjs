import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Response } from 'miniflare'

// Only GitHub and Actions are adapters; all Console HTTP, storage, runner and
// core paths execute the shipped implementation. Repository lifetime is owned
// by worker-server's temporary directory and finally cleanup.
export async function createUploadEnvironment(directory) {
  const repository = join(directory, 'repository')
  await mkdir(repository)
  const exec = promisify(execFile)
  const git = args => exec('git', args, { cwd: repository })
  await git(['init', '-b', 'main'])
  await writeFile(join(repository, 'README.md'), 'No JSON source exists in this repository.\n')
  await git(['add', 'README.md'])
  await git(['-c', 'user.name=Browser fixture', '-c', 'user.email=browser@example.test', 'commit', '-m', 'fixture source'])
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'browser-actions', alg: 'RS256' }
  const runs = new Map()
  let nextRun = 303
  let release
  let gate
  let held = false
  const environment = {
    origin: '',
    workflow: undefined,
    bindings: { E2E_SOURCE_COMMIT: sha, E2E_REPOSITORY: repository },
    async outbound(request) {
      const url = new URL(request.url)
      if (url.origin === 'https://iconctl-browser.test') {
        const body = await request.json()
        if (url.pathname === '/runner') {
          const runId = String(nextRun++)
          runs.set(runId, body)
          const claims = { repository_id: '123', repository: 'fixture/icons', ref: 'refs/heads/main', workflow_ref: 'fixture/icons/.github/workflows/iconctl-console.yml@refs/heads/main', sha: body.workflowCommit, event_name: 'workflow_dispatch', runner_environment: 'github-hosted', run_id: runId, run_attempt: '1', iss: 'https://token.actions.githubusercontent.com', aud: environment.origin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }
          const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.')
          return Response.json({ token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}` })
        }
        if (body.action === 'hold') {
          gate = new Promise(resolve => release = resolve)
          held = false
        }
        if (body.action === 'release') {
          release?.()
          gate = undefined
        }
        return Response.json({ held })
      }
      if (url.origin === 'https://token.actions.githubusercontent.com') {
        return Response.json({ keys: [jwk] })
      }
      if (url.origin !== 'https://api.github.com') {
        return undefined
      }
      if (url.pathname === '/repos/fixture/icons/installation') {
        return Response.json({ id: 456, permissions: { contents: 'write', actions: 'write', pull_requests: 'write', workflows: 'write' } })
      }
      if (url.pathname === '/repos/fixture/icons') {
        if (gate) {
          held = true
          await gate
        }
        return Response.json({ id: 123, default_branch: 'main' })
      }
      if (url.pathname === '/repos/fixture/icons/git/ref/heads/main') {
        return Response.json({ object: { sha } })
      }
      if (url.pathname === '/repos/fixture/icons/contents/.github/workflows/iconctl-console.yml') {
        return Response.json({ content: environment.workflow(environment.origin) })
      }
      if (url.pathname === '/repos/fixture/icons/actions/workflows/iconctl-console.yml/dispatches') {
        return new Response(null, { status: 204 })
      }
      const run = runs.get(url.pathname.split('/').at(-1))
      if (run) {
        return Response.json({ display_title: `iconctl-${run.id}-${run.attempt}`, head_sha: run.workflowCommit, event: 'workflow_dispatch', path: '.github/workflows/iconctl-console.yml', status: 'in_progress' })
      }
      return undefined
    },
  }
  return environment
}

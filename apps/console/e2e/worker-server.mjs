import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from 'miniflare'

async function main() {
  const entrypoint = new Map([
    ['history', './fixtures/history-worker.mjs'],
    ['release-comparison', './fixtures/release-comparison-worker.mjs'],
    ['review-recovery', './fixtures/review-recovery-worker.mjs'],
  ]).get(process.argv[2])
  if (!entrypoint) {
    throw new Error('Select a known browser test fixture')
  }
  const directory = await mkdtemp(join(tmpdir(), 'iconctl-browser-worker-'))
  let runtime
  let stopping = false
  async function stop(code = 0) {
    if (stopping) {
      return
    }
    stopping = true
    try {
      await runtime?.dispose()
    }
    finally {
      await rm(directory, { recursive: true, force: true })
      process.exit(code)
    }
  }
  process.on('message', (message) => {
    if (message.type === 'stop') {
      void stop()
    }
  })
  process.once('disconnect', () => void stop())
  process.once('SIGTERM', () => void stop())
  process.once('SIGINT', () => void stop())

  try {
    const recoveryOrigin = process.argv[2] === 'review-recovery' ? 'https://review-recovery.test' : undefined
    let workflowContent
    if (recoveryOrigin) {
      const workflowBundle = join(directory, 'workflow.mjs')
      await build({
        entryPoints: [fileURLToPath(new URL('../worker/workflow.ts', import.meta.url))],
        outfile: workflowBundle,
        bundle: true,
        platform: 'node',
        format: 'esm',
      })
      const { runnerWorkflow } = await import(pathToFileURL(workflowBundle).href)
      workflowContent = Buffer.from(runnerWorkflow(recoveryOrigin, 'fixture/icons', 'a'.repeat(40))).toString('base64')
    }
    const bundle = join(directory, 'worker.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL(entrypoint, import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2023',
      external: ['cloudflare:*', 'node:*'],
    })
    const options = {
      name: 'iconctl-browser-test',
      host: '127.0.0.1',
      port: 0,
      cf: false,
      modules: true,
      // The temporary bundle is outside cwd; make its module identity local to
      // that directory so workerd can resolve built-in module imports correctly.
      modulesRoot: directory,
      scriptPath: bundle,
      compatibilityDate: '2026-09-24',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        APP_ORIGIN: recoveryOrigin ?? 'http://127.0.0.1',
        GITHUB_APP_ID: 'browser-fixture',
        GITHUB_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        EXECUTOR_REPOSITORY: 'fixture/icons',
        EXECUTOR_COMMIT: 'a'.repeat(40),
      },
      durableObjects: { ACCOUNT: { className: 'FixtureAccountState', useSQLite: true } },
      r2Buckets: ['ARTIFACTS'],
      assets: {
        directory: fileURLToPath(new URL('../dist/public', import.meta.url)),
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
      },
      outboundService(request) {
        const url = new URL(request.url)
        if (url.origin === 'https://api.github.com') {
          if (request.method === 'POST' && url.pathname === '/app/installations/456/access_tokens') {
            return WorkerResponse.json({ token: 'fixture-installation-token' })
          }
          if (request.method === 'GET' && decodeURIComponent(url.pathname) === '/repos/fixture/icons/git/ref/heads/iconctl/release-comparison') {
            return WorkerResponse.json({ object: { sha: 'b'.repeat(40) } })
          }
          if (recoveryOrigin && request.method === 'GET' && decodeURIComponent(url.pathname) === '/repos/fixture/icons/git/ref/heads/iconctl/review-recovery') {
            return WorkerResponse.json({ object: { sha: 'b'.repeat(40) } })
          }
          if (workflowContent && request.method === 'GET' && url.pathname === '/repos/fixture/icons/contents/.github/workflows/iconctl-console.yml' && url.searchParams.get('ref') === 'a'.repeat(40)) {
            return WorkerResponse.json({ content: workflowContent })
          }
          if (request.method === 'GET' && url.pathname === '/repos/fixture/icons/git/ref/heads/main') {
            return WorkerResponse.json({ object: { sha: 'a'.repeat(40) } })
          }
        }
        process.send?.({ type: 'unexpected-request', request: `${request.method} ${request.url}` })
        return new WorkerResponse('Unexpected external request', { status: 502 })
      },
    }
    // Use the same supported options converter as the installed Wrangler.
    runtime = new Miniflare(convertV4MiniflareOptions(options))
    const url = await runtime.ready
    // Retain the allocated port while configuring the real CSRF origin check.
    await runtime.setOptions(convertV4MiniflareOptions({
      ...options,
      port: Number(url.port),
      bindings: { ...options.bindings, APP_ORIGIN: recoveryOrigin ?? url.origin },
    }))
    process.send?.({ type: 'ready', origin: url.origin })
  }
  catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`)
    await stop(1)
  }
}

void main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})

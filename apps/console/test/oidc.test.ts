import type { Job } from '@iconctl/console-contracts'
import { projectInput } from '@iconctl/console-contracts'
import { env } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { expect, it, vi } from 'vitest'
import { verifyRunner } from '../worker/github'

it('verifies signed Actions identities and binds them to the exact dispatched job', async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'actions-test', alg: 'RS256' }
  const sha = 'a'.repeat(40)
  const job = {
    id: crypto.randomUUID(),
    attempt: 1,
    workflowCommit: sha,
    project: {
      ...projectInput.parse({
        name: 'icons',
        prefix: 'icons',
        packageName: '@test/icons',
        repository: 'Owner/Repo',
        sources: [{ type: 'directory', dir: 'raw' }],
      }),
      repositoryInfo: { id: 123, installationId: 1, defaultBranch: 'main' },
    },
  } as Job
  let title = `iconctl-${job.id}-1`
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/.well-known/jwks')) {
      return Response.json({ keys: [jwk] })
    }
    if (url.endsWith('/access_tokens')) {
      return Response.json({ token: 'installation-token' })
    }
    return Response.json({ display_title: title, head_sha: sha, event: 'workflow_dispatch', path: '.github/workflows/iconctl-console.yml' })
  })
  const claims = {
    repository_id: '123',
    repository: 'owner/repo',
    ref: 'refs/heads/main',
    workflow_ref: 'owner/repo/.github/workflows/iconctl-console.yml@refs/heads/main',
    sha,
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    run_id: '1234',
    run_attempt: '1',
  }
  const sign = (overrides = {}, audience: string = env.APP_ORIGIN) => new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey)
  try {
    expect((await verifyRunner(env, await sign(), job)).runId).toBe('1234')
    for (const invalid of [
      { repository_id: '456' },
      { repository: 'attacker/repo' },
      { ref: 'refs/heads/other' },
      { workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
      { sha: 'b'.repeat(40) },
      { event_name: 'pull_request' },
      { runner_environment: 'self-hosted' },
    ]) {
      await expect(verifyRunner(env, await sign(invalid), job)).rejects.toThrow()
    }
    await expect(verifyRunner(env, await sign({}, 'https://other.example'), job)).rejects.toThrow()
    title = 'iconctl-another-job-1'
    await expect(verifyRunner(env, await sign(), job)).rejects.toThrow('not associated')
  }
  finally {
    fetch.mockRestore()
  }
})

import type { Job, Repository } from '@iconctl/console-contracts'
import { createPrivateKey } from 'node:crypto'
import { WORKFLOW } from '@iconctl/console-contracts'
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose'
import { fail } from './security'

const keys = createRemoteJWKSet(
  new URL('https://token.actions.githubusercontent.com/.well-known/jwks'),
)
export class GitHubError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`GitHub request failed (HTTP ${status})`)
    this.status = status
  }
}
export async function github<T>(
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'iconctl-console',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new GitHubError(response.status)
  }
  return response.status === 204 ? (undefined as T) : response.json<T>()
}
export async function appToken(env: Env): Promise<string> {
  const pem = createPrivateKey(env.GITHUB_PRIVATE_KEY)
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const key = await importPKCS8(pem, 'RS256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime('9m')
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key)
}
export async function installationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  const result = await github<{ token: string }>(
    await appToken(env),
    `/app/installations/${installationId}/access_tokens`,
    'POST',
  )
  return result.token
}
export async function repositoryInfo(
  env: Env,
  repository: string,
): Promise<Repository> {
  const installation = await github<{
    id: number
    permissions: Record<string, string>
  }>(await appToken(env), `/repos/${repository}/installation`)
  for (const permission of [
    'contents',
    'actions',
    'pull_requests',
    'workflows',
  ]) {
    if (installation.permissions[permission] !== 'write') {
      fail(409, `GitHub App requires ${permission}: write`)
    }
  }
  const repo = await github<{ id: number, default_branch: string }>(
    await installationToken(env, installation.id),
    `/repos/${repository}`,
  )
  return {
    id: repo.id,
    installationId: installation.id,
    defaultBranch: repo.default_branch,
  }
}
export async function branchHead(
  token: string,
  repository: string,
  branch: string,
): Promise<string | null> {
  try {
    return (
      await github<{ object: { sha: string } }>(
        token,
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      )
    ).object.sha
  }
  catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return null
    }
    throw error
  }
}
export interface RunnerIdentity {
  runId: string
  runAttempt: string
  repositoryId: string
  workflowRef: string
  sha: string
  ref: string
}
export async function verifyRunner(
  env: Env,
  token: string,
  job: Job,
): Promise<RunnerIdentity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: env.APP_ORIGIN,
    algorithms: ['RS256'],
    maxTokenAge: '10m',
  })
  const project = job.project
  const ref = `refs/heads/${project.repositoryInfo.defaultBranch}`
  if (
    payload.repository_id !== String(project.repositoryInfo.id)
    || typeof payload.repository !== 'string'
    || payload.repository.toLowerCase() !== project.repository.toLowerCase()
    || payload.ref !== ref
    || payload.workflow_ref
    !== `${payload.repository}/.github/workflows/${WORKFLOW}@${ref}`
    || payload.sha !== job.workflowCommit
    || payload.event_name !== 'workflow_dispatch'
    || payload.runner_environment !== 'github-hosted'
    || typeof payload.run_id !== 'string'
    || typeof payload.run_attempt !== 'string'
  ) {
    fail(403, 'Runner identity does not match the job')
  }
  const run = await github<{
    display_title: string
    head_sha: string
    event: string
    path: string
  }>(
    await installationToken(env, project.repositoryInfo.installationId),
    `/repos/${project.repository}/actions/runs/${payload.run_id}`,
  )
  if (
    run.display_title !== `iconctl-${job.id}-${job.attempt}`
    || run.head_sha !== job.workflowCommit
    || run.event !== 'workflow_dispatch'
    || run.path !== `.github/workflows/${WORKFLOW}`
  ) {
    fail(403, 'Workflow run is not associated with the job')
  }
  return {
    runId: payload.run_id,
    runAttempt: payload.run_attempt,
    repositoryId: payload.repository_id as string,
    workflowRef: payload.workflow_ref as string,
    sha: payload.sha as string,
    ref,
  }
}

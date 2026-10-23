import path from 'node:path'

export const docsTargets = {
  preview: {
    worker: 'iconctl-docs-preview',
    directory: 'apps/website',
    output: 'apps/website/.vitepress/dist',
  },
  stable: {
    worker: 'iconctl-docs',
    directory: 'apps/console',
    output: 'apps/console/dist/public',
    url: 'https://iconctl.icebreaker.top',
  },
}

export function resolveChannel(value = 'preview') {
  if (!Object.hasOwn(docsTargets, value)) {
    throw new Error(`Unknown documentation channel: ${value}`)
  }
  return value
}

export function assertDeploymentContext(env, channel) {
  resolveChannel(channel)
  if (env.REPO_DOCS_SITE !== 'website' || env.REPO_DOCS_CHANNEL !== channel
    || !/^[a-f\d]{40}$/u.test(env.REPO_DOCS_SOURCE_SHA ?? '')
    || !/^[a-f\d]{64}$/u.test(env.REPO_DOCS_DEPLOYMENT_ID ?? '')
    || !env.REPO_DOCS_RESULT_FILE || !path.isAbsolute(env.REPO_DOCS_RESULT_FILE)) {
    throw new Error('Use repo docs deploy website with a verified source and channel; direct website deployment is disabled.')
  }
  if (channel === 'stable' && (env.REPO_DOCS_URL !== docsTargets.stable.url
    || !env.REPO_DOCS_RELEASE_ID || env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_RUN_ID
    || env.GITHUB_REF !== 'refs/heads/main' || env.REPO_DOCS_CONCURRENCY_GROUP !== 'docs-website-stable')) {
    throw new Error('Stable documentation requires a completed release and the managed docs-website-stable workflow.')
  }
}

export function buildIdentity(env, fallbackSha = '') {
  return {
    channel: resolveChannel(env.REPO_DOCS_CHANNEL || 'preview'),
    sourceSha: env.REPO_DOCS_SOURCE_SHA || fallbackSha,
    releaseId: env.REPO_DOCS_RELEASE_ID || '',
    deploymentId: env.REPO_DOCS_DEPLOYMENT_ID || '',
  }
}

export function assertBuildIdentity(actual, expected) {
  if (!actual || typeof actual !== 'object'
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error('Documentation artifact does not match this deployment; rebuild the selected snapshot.')
  }
}

export const deploymentMessage = identity => `repoctl-docs:${identity.deploymentId}`

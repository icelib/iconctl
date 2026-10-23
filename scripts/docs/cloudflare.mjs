import { deploymentMessage } from './identity.mjs'

export function cloudflareClient(env, request = fetch) {
  const token = env.CLOUDFLARE_API_TOKEN
  const account = env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !/^[a-f\d]{32}$/iu.test(account ?? '')) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to verify documentation deployments.')
  }
  return async (endpoint, allowMissing = false) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const payload = await response.json()
    if (allowMissing && response.status === 404 && payload.errors?.some(error => error.code === 10007)) {
      return undefined
    }
    if (!response.ok || !payload.success) {
      throw new Error(`Cloudflare verification failed (HTTP ${response.status}, codes: ${(payload.errors ?? []).map(error => error.code).join(', ')}).`)
    }
    return payload.result
  }
}

/** Recover only a fully active deployment; split traffic is never a success. */
export async function activeMatchingVersion(client, worker, identity, { rejectSuperseded = false } = {}) {
  const result = await client(`scripts/${worker}/deployments`, true)
  if (result === undefined) {
    return undefined
  }
  if (!Array.isArray(result.deployments)
    || result.deployments.some(deployment => typeof deployment.created_on !== 'string')) {
    throw new TypeError('Cloudflare returned an invalid deployments response.')
  }
  const deployments = [...result.deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))
  const deployment = deployments[0]
  if (!deployment) {
    return undefined
  }
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100) {
    throw new Error('Documentation Worker must have exactly one active version receiving 100% of traffic.')
  }
  const versionId = deployment.versions[0].version_id
  if (typeof versionId !== 'string' || !/^[a-f\d-]{36}$/iu.test(versionId)) {
    throw new Error('Cloudflare returned an invalid active version ID.')
  }
  const readVersion = async (id) => {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/iu.test(id)) {
      throw new Error('Cloudflare returned an invalid deployment history version ID.')
    }
    const version = await client(`scripts/${worker}/versions/${id}`)
    if (version?.id !== id) {
      throw new Error('Cloudflare returned a version that differs from its deployment record.')
    }
    return version
  }
  const marker = deploymentMessage(identity)
  if ((await readVersion(versionId)).annotations?.['workers/message'] === marker) {
    return versionId
  }
  if (rejectSuperseded) {
    const seen = new Set([versionId])
    for (const historical of deployments.slice(1)) {
      if (!Array.isArray(historical.versions)) {
        throw new TypeError('Cloudflare returned an invalid deployment history.')
      }
      for (const entry of historical.versions) {
        if (!seen.has(entry.version_id)) {
          seen.add(entry.version_id)
          const previous = await readVersion(entry.version_id)
          if (previous.annotations?.['workers/message'] === marker) {
            throw new Error('This documentation deployment was superseded by another active version; refusing to upload an older retry.')
          }
        }
      }
    }
  }
  return undefined
}

export function readDeploymentVersion(output, worker) {
  const entries = output.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line))
  const deployment = entries.findLast(entry => entry?.type === 'deploy' && entry.worker_name === worker
    && (entry.wrangler_environment ?? '') === '')
  if (typeof deployment?.version_id !== 'string' || !/^[a-f\d-]{36}$/iu.test(deployment.version_id)) {
    throw new Error(`Wrangler did not report a deployed version for ${worker}.`)
  }
  return deployment.version_id
}

export async function deployVerifiedVersion({ client, worker, identity, upload }) {
  const existing = await activeMatchingVersion(client, worker, identity, { rejectSuperseded: true })
  if (existing) {
    return existing
  }
  let versionId
  try {
    versionId = await upload()
  }
  catch (error) {
    const recovered = await activeMatchingVersion(client, worker, identity)
    if (recovered) {
      return recovered
    }
    throw error
  }
  const active = await activeMatchingVersion(client, worker, identity)
  if (active !== versionId) {
    throw new Error('The uploaded documentation version is not confirmed active; retry this same deployment.')
  }
  return versionId
}

export async function previewUrl(client, worker) {
  const { subdomain } = await client('subdomain')
  if (typeof subdomain !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(subdomain)) {
    throw new Error('Cloudflare did not return a valid workers.dev account subdomain.')
  }
  return `https://${worker}.${subdomain}.workers.dev`
}

import { z } from 'zod'

export const OWNER_ID = '15621541'
export const WORKFLOW = 'iconctl-console.yml'
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)
export const identifier = z.string().uuid()
export const commit = z.string().regex(/^[a-f0-9]{40}$/)
export const safePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    value =>
      !value.startsWith('/')
      && !/[\\:]/.test(value)
      && !Array.from(value).some(char => char.charCodeAt(0) < 32)
      && value
        .split('/')
        .every(
          part => part && part !== '.' && part !== '..' && part !== '.git',
        ),
    'Expected a safe relative path',
  )
export const packageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
const localSource = { dir: safePath, upload: identifier.optional() }
export const sourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('figma'),
      file: z.string().trim().min(1).max(500),
      connection: identifier,
      pages: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      depth: z.number().int().min(1).max(100).default(3),
    })
    .strict(),
  z
    .object({
      type: z.literal('mastergo'),
      fileId: z.string().min(1).max(200),
      layerId: z.string().min(1).max(200),
      connection: identifier,
    })
    .strict(),
  z
    .object({
      type: z.literal('iconfont'),
      url: z
        .url()
        .refine(
          url =>
            new URL(url).protocol === 'https:'
              && /^(?:at|www)\.alicdn\.com$/.test(new URL(url).hostname),
        ),
      stripPrefix: z.string().default('icon-'),
    })
    .strict(),
  z.object({ type: z.literal('directory'), ...localSource }).strict(),
  z.object({ type: z.literal('jsdesign'), ...localSource }).strict(),
])
export const projectInput = z
  .object({
    name: slug,
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    prefix: slug,
    packageName,
    sources: z.array(sourceSchema).min(1).max(20),
    color: z
      .union([z.string().max(100), z.literal(false)])
      .default('currentColor'),
    validate: z
      .object({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        name: z.string().max(200).optional(),
        skipPrefix: z.array(z.string()).default(['_', '.']),
      })
      .strict()
      .default({ skipPrefix: ['_', '.'] }),
    output: z
      .object({
        svg: z.boolean().default(true),
        types: z.boolean().default(true),
        preview: z.boolean().default(true),
        changelog: z.boolean().default(true),
      })
      .strict()
      .default({ svg: true, types: true, preview: true, changelog: true }),
    advancedConfig: z.object({ path: safePath, commit }).strict().optional(),
  })
  .strict()
export type Source = z.infer<typeof sourceSchema>
export type ProjectInput = z.infer<typeof projectInput>
export interface Repository {
  id: number
  installationId: number
  defaultBranch: string
}
export interface Project extends ProjectInput {
  id: string
  revision: number
  repositoryInfo: Repository
  createdAt: number
  snapshotId?: string
  releaseId?: string
  installationPr?: string
}
export type Operation = 'sync' | 'check' | 'preview' | 'dry-run' | 'publish'
export const operationSchema = z.enum(['sync', 'check', 'preview', 'dry-run'])
export type JobStatus
  = 'queued' | 'running' | 'succeeded' | 'failed' | 'reconciling'
export interface ReleaseIntent {
  snapshotId: string
  digest: string
  version: string
  baselineReleaseId?: string
  branchHead: string | null
  confirmation: string
}
export interface Job {
  id: string
  projectId: string
  project: Project
  operation: Operation
  status: JobStatus
  sourceCommit: string
  workflowCommit: string
  executorCommit: string
  workflowDigest: string
  createdAt: number
  updatedAt: number
  dispatchAttempts: number
  attempt: number
  runId?: string
  runAttempt?: string
  error?: string
  stage: string
  release?: ReleaseIntent
  snapshotId?: string
  integrity?: string
  releaseCommit?: string
  events?: { at: number, stage: string, status: JobStatus, error?: string }[]
  attemptStartedAt?: number
}
export interface IconJSON {
  prefix: string
  icons: Record<string, { body: string, width?: number, height?: number }>
  width?: number
  height?: number
}
export const iconJsonSchema = z
  .object({
    prefix: slug,
    icons: z.record(
      slug,
      z
        .object({
          body: z.string().max(512_000),
          width: z.number().optional(),
          height: z.number().optional(),
        })
        .passthrough(),
    ),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough()
export const snapshotInput = z
  .object({
    json: iconJsonSchema,
    files: z.record(safePath, z.string()),
    issues: z.array(
      z.object({ name: z.string().max(200), message: z.string().max(1000) }),
    ),
    failed: z.array(z.string().max(200)),
    sources: z.array(
      z.object({
        type: z.string(),
        notModified: z.boolean(),
        fileKey: z.string().optional(),
      }),
    ),
  })
  .strict()
export type SnapshotContent = z.infer<typeof snapshotInput>
export interface Snapshot {
  id: string
  jobId: string
  projectId: string
  createdAt: number
  digest: string
  iconCount: number
  issues: number
  baselineId?: string
}
export interface Release {
  id: string
  projectId: string
  jobId: string
  snapshotId: string
  version: string
  packageName: string
  integrity: string
  commit: string
  createdAt: number
  url: string
}
export interface ConnectionStatus {
  id: string
  type: 'figma' | 'mastergo'
  label: string
  expiresAt?: number
  reconnect: boolean
}
export interface PairingStatus {
  id: string
  code: string
  expiresAt: number
  projectId?: string
  label?: string
}
export interface ConsoleState {
  projects: Project[]
  jobs: Job[]
  snapshots: Snapshot[]
  releases: Release[]
  connections: ConnectionStatus[]
  pairings: PairingStatus[]
  devices: { id: string, projectId: string, label: string }[]
}

export function nextVersion(
  previous: string | undefined,
  bump: 'patch' | 'minor' | 'major',
): string {
  if (!previous) {
    return '0.1.0'
  }
  if (!/^\d+\.\d+\.\d+$/.test(previous)) {
    throw new Error('Only stable versions are supported')
  }
  const [major = 0, minor = 0, patch = 0] = previous.split('.').map(Number)
  return bump === 'major'
    ? `${major + 1}.0.0`
    : bump === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`
}

export function iconDiff(before: IconJSON | undefined, after: IconJSON) {
  const previous = before?.icons ?? {}
  const fingerprint = (json: IconJSON, name: string) =>
    JSON.stringify({
      ...json.icons[name],
      width: json.icons[name]?.width ?? json.width ?? 16,
      height: json.icons[name]?.height ?? json.height ?? 16,
    })
  return {
    added: Object.keys(after.icons)
      .filter(name => !Object.hasOwn(previous, name))
      .sort(),
    removed: Object.keys(previous)
      .filter(name => !Object.hasOwn(after.icons, name))
      .sort(),
    changed: Object.keys(after.icons)
      .filter(
        name =>
          Object.hasOwn(previous, name)
          && before
          && fingerprint(before, name) !== fingerprint(after, name),
      )
      .sort(),
  }
}

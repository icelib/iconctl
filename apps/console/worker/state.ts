import type {
  ConnectionStatus,
  ConsoleState,
  Job,
  Operation,
  PairingStatus,
  Project,
  ProjectInput,
  Release,
  ReleaseIntent,
  Snapshot,
  SnapshotContent,
} from '@iconctl/console-contracts'
import type { RunnerIdentity } from './github'
import {
  commit,
  nextVersion,
  OWNER_ID,
  snapshotInput,
} from '@iconctl/console-contracts'
import { requestFigmaToken } from '@iconctl/core/figma/oauth'
import { DurableObject } from 'cloudflare:workers'
import {
  branchHead,
  github,
  GitHubError,
  installationToken,
  repositoryInfo,
} from './github'
import {
  base64,
  decrypt,
  digest,
  encrypt,
  fail,
  randomToken,
} from './security'
import { runnerWorkflow, WORKFLOW } from './workflow'

interface Session {
  csrf: string
  expiresAt: number
}
interface OAuthState {
  provider: 'github' | 'figma'
  verifier: string
  browser: string
  expiresAt: number
  session?: string
  connectionId?: string
}
interface Connection extends ConnectionStatus {
  encrypted: string
  revision: number
  refreshing?: boolean
}
interface Credential {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}
interface Pairing extends PairingStatus {
  pollHash: string
  token?: string
}
interface Device {
  id: string
  projectId: string
  label: string
  hash: string
}
interface Confirmation {
  id: string
  projectId: string
  revision: number
  release: ReleaseIntent
  expiresAt: number
}

export class AccountState extends DurableObject<Env> {
  private releasePreparations = new Map<
    string,
    Promise<{ commit: string, integrity: string }>
  >()

  private refreshes = new Map<string, Promise<Credential>>()
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)',
      )
      ctx.storage.sql.exec('INSERT OR IGNORE INTO schema_version VALUES (1)')
    })
  }

  private get<T>(key: string): T | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM records WHERE key = ?', key)
      .toArray()
    return rows[0] ? (JSON.parse(rows[0].value) as T) : undefined
  }

  private put(key: string, value: unknown) {
    if (key.startsWith('job:')) {
      const job = value as Job
      const previous = this.get<Job>(key)
      if (
        !previous
        || previous.stage !== job.stage
        || previous.status !== job.status
        || previous.error !== job.error
      ) {
        value = {
          ...job,
          events: [
            ...(previous?.events ?? []),
            {
              at: Date.now(),
              stage: job.stage,
              status: job.status,
              ...(job.error ? { error: job.error } : {}),
            },
          ].slice(-500),
        }
      }
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO records(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    )
  }

  private remove(key: string) {
    this.ctx.storage.sql.exec('DELETE FROM records WHERE key = ?', key)
  }

  private list<T>(prefix: string): T[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        'SELECT value FROM records WHERE key GLOB ? ORDER BY key',
        `${prefix}:*`,
      )
      .toArray()
      .map(row => JSON.parse(row.value) as T)
  }

  private required<T>(key: string): T {
    const value = this.get<T>(key)
    if (!value) {
      fail(404, 'Record not found')
    }
    return value
  }

  private schedule() {
    return this.ctx.storage.setAlarm(Date.now() + 60_000)
  }

  private locked(projectId: string) {
    return this.list<Job>('job').some(
      job =>
        job.projectId === projectId
        && ['queued', 'running', 'reconciling'].includes(job.status),
    )
  }

  async newSession(owner: string) {
    if (owner !== OWNER_ID) {
      fail(403, 'This account is not allowed')
    }
    const token = randomToken()
    const session = {
      csrf: randomToken(),
      expiresAt: Date.now() + 7 * 86400_000,
    }
    this.put(`session:${await digest(token)}`, session)
    await this.schedule()
    return { token, ...session }
  }

  session(hash: string) {
    const value = this.get<Session>(`session:${hash}`)
    return value && value.expiresAt > Date.now() ? value : null
  }

  logout(hash: string) {
    this.remove(`session:${hash}`)
  }

  async saveOAuth(state: string, value: OAuthState) {
    this.put(`oauth:${await digest(state)}`, value)
    await this.schedule()
  }

  async consumeOAuth(
    state: string,
    browser: string,
    provider: OAuthState['provider'],
  ) {
    const key = `oauth:${await digest(state)}`
    const value = this.get<OAuthState>(key)
    if (
      !value
      || value.provider !== provider
      || value.expiresAt < Date.now()
      || value.browser !== browser
    ) {
      fail(400, 'OAuth state is invalid or expired')
    }
    this.remove(key)
    if (value.session && !this.session(value.session)) {
      fail(401, 'Session expired during authorization')
    }
    return value
  }

  async connectFigma(code: string, verifier: string, connectionId?: string) {
    if (!this.env.FIGMA_CLIENT_ID || !this.env.FIGMA_CLIENT_SECRET) {
      fail(503, 'Configure the website Figma OAuth App first')
    }
    const previous = connectionId
      ? this.required<Connection>(`connection:${connectionId}`)
      : undefined
    if (previous && previous.type !== 'figma') {
      fail(400, 'Expected a Figma connection')
    }
    const token = await requestFigmaToken(
      {
        clientId: this.env.FIGMA_CLIENT_ID,
        clientSecret: this.env.FIGMA_CLIENT_SECRET,
      },
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: `${this.env.APP_ORIGIN}/api/auth/figma/callback`,
      }),
    )
    const id = connectionId ?? crypto.randomUUID()
    const encrypted = await encrypt(
      this.env.CREDENTIAL_ENCRYPTION_KEY,
      id,
      token,
    )
    if (
      previous
      && this.get<Connection>(`connection:${id}`)?.revision !== previous.revision
    ) {
      fail(409, 'Connection changed while authorizing')
    }
    this.put(`connection:${id}`, {
      id,
      type: 'figma',
      label: 'Figma OAuth',
      encrypted,
      revision: (previous?.revision ?? 0) + 1,
      expiresAt: token.expiresAt,
      reconnect: false,
    } satisfies Connection)
    return id
  }

  async connectMastergo(label: string, accessToken: string) {
    const id = crypto.randomUUID()
    this.put(`connection:${id}`, {
      id,
      type: 'mastergo',
      label,
      encrypted: await encrypt(this.env.CREDENTIAL_ENCRYPTION_KEY, id, {
        accessToken,
      }),
      revision: 1,
      reconnect: false,
    } satisfies Connection)
    return id
  }

  disconnect(id: string) {
    this.remove(`connection:${id}`)
  }

  async credential(id: string, rejectedToken?: string): Promise<Credential> {
    const existing = this.refreshes.get(id)
    if (existing) {
      return existing
    }
    const pending = this.resolveCredential(id, rejectedToken)
    this.refreshes.set(id, pending)
    try {
      return await pending
    }
    finally {
      this.refreshes.delete(id)
    }
  }

  private async resolveCredential(
    id: string,
    rejectedToken?: string,
  ): Promise<Credential> {
    const connection = this.required<Connection>(`connection:${id}`)
    if (connection.reconnect || connection.refreshing) {
      fail(
        409,
        'Authorization needs reconnecting; the previous refresh did not finish safely',
      )
    }
    const credential = await decrypt<Credential>(
      this.env.CREDENTIAL_ENCRYPTION_KEY,
      id,
      connection.encrypted,
    )
    if (connection.type !== 'figma') {
      return credential
    }
    if (rejectedToken && rejectedToken !== credential.accessToken) {
      return credential
    }
    if (!rejectedToken && (credential.expiresAt ?? 0) > Date.now() + 300_000) {
      return credential
    }
    if (!credential.refreshToken) {
      fail(409, 'Figma authorization needs reconnecting')
    }
    if (
      this.get<Connection>(`connection:${id}`)?.revision !== connection.revision
    ) {
      fail(409, 'Authorization changed')
    }
    if (!this.env.FIGMA_CLIENT_ID || !this.env.FIGMA_CLIENT_SECRET) {
      fail(503, 'Configure the website Figma OAuth App first')
    }
    this.put(`connection:${id}`, { ...connection, refreshing: true })
    let result: Awaited<ReturnType<typeof requestFigmaToken>>
    try {
      result = await requestFigmaToken(
        {
          clientId: this.env.FIGMA_CLIENT_ID,
          clientSecret: this.env.FIGMA_CLIENT_SECRET,
        },
        new URLSearchParams({ refresh_token: credential.refreshToken }),
        true,
      )
    }
    catch (error) {
      if (
        this.get<Connection>(`connection:${id}`)?.revision
        === connection.revision
      ) {
        this.put(`connection:${id}`, {
          ...connection,
          reconnect: true,
          refreshing: false,
        })
      }
      // An interrupted/ambiguous rotating refresh must not replay the old token.
      throw error
    }
    const fresh = {
      ...result,
      refreshToken: result.refreshToken ?? credential.refreshToken,
    }
    const encrypted = await encrypt(
      this.env.CREDENTIAL_ENCRYPTION_KEY,
      id,
      fresh,
    )
    if (
      this.get<Connection>(`connection:${id}`)?.revision !== connection.revision
    ) {
      fail(409, 'Authorization disconnected during refresh')
    }
    this.put(`connection:${id}`, {
      ...connection,
      encrypted,
      revision: connection.revision + 1,
      expiresAt: fresh.expiresAt,
      refreshing: false,
    })
    return fresh
  }

  state(): ConsoleState {
    return {
      projects: this.list<Project>('project'),
      jobs: this.list<Job>('job').sort((a, b) => b.createdAt - a.createdAt),
      snapshots: this.list<Snapshot>('snapshot').sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
      releases: this.list<Release>('release').sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
      connections: this.list<Connection>('connection').map(
        ({ id, type, label, expiresAt, reconnect, refreshing }) => ({
          id,
          type,
          label,
          ...(expiresAt ? { expiresAt } : {}),
          reconnect: reconnect || Boolean(refreshing),
        }),
      ),
      pairings: this.list<Pairing>('pair')
        .filter(pair => !pair.projectId && pair.expiresAt > Date.now())
        .map(({ id, code, expiresAt }) => ({ id, code, expiresAt })),
      devices: this.list<Device>('device').map(({ id, projectId, label }) => ({
        id,
        projectId,
        label,
      })),
    }
  }

  async saveProject(
    input: ProjectInput,
    id?: string,
    expectedRevision?: number,
  ) {
    const existing = id ? this.required<Project>(`project:${id}`) : undefined
    if (
      existing
      && (this.locked(existing.id) || existing.revision !== expectedRevision)
    ) {
      fail(409, 'Project changed or a task is active')
    }
    if (
      existing?.releaseId
      && (input.name !== existing.name
        || input.packageName !== existing.packageName
        || input.repository !== existing.repository)
    ) {
      fail(
        409,
        'A published project cannot change its package, branch or repository identity',
      )
    }
    for (const source of input.sources) {
      if ('connection' in source) {
        const connection = this.required<Connection>(
          `connection:${source.connection}`,
        )
        if (connection.type !== source.type) {
          fail(400, 'Source connection type does not match')
        }
      }
      if ('upload' in source && source.upload) {
        this.required(`upload:${source.upload}`)
      }
    }
    const info = await repositoryInfo(this.env, input.repository)
    // Recheck after the GitHub request; another mutation may have completed.
    if (
      existing
      && (this.locked(existing.id)
        || this.required<Project>(`project:${existing.id}`).revision
        !== expectedRevision)
    ) {
      fail(409, 'Project changed')
    }
    if (
      this.list<Project>('project').some(
        project =>
          project.id !== id
          && (project.packageName === input.packageName
            || (project.repository === input.repository
              && project.name === input.name)),
      )
    ) {
      fail(409, 'Package or project branch is already used')
    }
    const project: Project = {
      ...existing,
      ...input,
      id: id ?? crypto.randomUUID(),
      revision: (existing?.revision ?? 0) + 1,
      repositoryInfo: info,
      createdAt: existing?.createdAt ?? Date.now(),
    }
    this.put(`project:${project.id}`, project)
    return project
  }

  async installWorkflow(id: string) {
    const project = this.required<Project>(`project:${id}`)
    const token = await installationToken(
      this.env,
      project.repositoryInfo.installationId,
    )
    const workflow = runnerWorkflow(
      this.env.APP_ORIGIN,
      this.env.EXECUTOR_REPOSITORY,
      this.env.EXECUTOR_COMMIT,
    )
    const head = await branchHead(
      token,
      project.repository,
      project.repositoryInfo.defaultBranch,
    )
    if (!head) {
      fail(409, 'Repository must have a default branch commit')
    }
    const branch = `iconctl-install-${crypto.randomUUID().slice(0, 8)}`
    await github(token, `/repos/${project.repository}/git/refs`, 'POST', {
      ref: `refs/heads/${branch}`,
      sha: head,
    })
    let existingSha: string | undefined
    try {
      existingSha = (
        await github<{ sha: string }>(
          token,
          `/repos/${project.repository}/contents/.github/workflows/${WORKFLOW}?ref=${head}`,
        )
      ).sha
    }
    catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) {
        throw error
      }
    }
    await github(
      token,
      `/repos/${project.repository}/contents/.github/workflows/${WORKFLOW}`,
      'PUT',
      {
        message: 'ci: install iconctl console runner',
        branch,
        content: base64(new TextEncoder().encode(workflow)),
        ...(existingSha ? { sha: existingSha } : {}),
      },
    )
    const pr = await github<{ html_url: string }>(
      token,
      `/repos/${project.repository}/pulls`,
      'POST',
      {
        title: 'ci: install iconctl console runner',
        head: branch,
        base: project.repositoryInfo.defaultBranch,
        body: 'Install the pinned iconctl console executor. Review and merge this workflow to enable private console tasks. Publishing uses npm OIDC or the repository NPM_BOOTSTRAP_TOKEN secret for the first release.',
      },
    )
    this.put(`project:${id}`, {
      ...this.required<Project>(`project:${id}`),
      installationPr: pr.html_url,
    })
    return pr.html_url
  }

  async createJob(
    projectId: string,
    operation: Operation,
    idempotency: string,
    confirmationId?: string,
  ) {
    const requestKey = `request:${projectId}:${idempotency}`
    const previous = this.get<string>(requestKey)
    if (previous) {
      return this.required<Job>(`job:${previous}`)
    }
    const project = this.required<Project>(`project:${projectId}`)
    if (this.locked(projectId)) {
      fail(409, 'This project already has an active task')
    }
    commit.parse(this.env.EXECUTOR_COMMIT)
    let release: ReleaseIntent | undefined
    if (operation === 'publish') {
      const confirmation = this.required<Confirmation>(
        `confirmation:${confirmationId}`,
      )
      if (
        confirmation.projectId !== projectId
        || confirmation.revision !== project.revision
        || confirmation.expiresAt < Date.now()
        || confirmation.release.baselineReleaseId !== project.releaseId
      ) {
        fail(409, 'Release confirmation is stale')
      }
      release = confirmation.release
    }
    const token = await installationToken(
      this.env,
      project.repositoryInfo.installationId,
    )
    const workflowCommit = await branchHead(
      token,
      project.repository,
      project.repositoryInfo.defaultBranch,
    )
    if (!workflowCommit) {
      fail(409, 'Repository has no default branch')
    }
    const workflow = await github<{ content: string }>(
      token,
      `/repos/${project.repository}/contents/.github/workflows/${WORKFLOW}?ref=${workflowCommit}`,
    )
    const expected = runnerWorkflow(
      this.env.APP_ORIGIN,
      this.env.EXECUTOR_REPOSITORY,
      this.env.EXECUTOR_COMMIT,
    )
    if (atob(workflow.content.replace(/\s/g, '')) !== expected) {
      fail(409, 'Install or update the pinned runner workflow first')
    }
    const workflowDigest = await digest(expected)
    const duplicate = this.get<string>(requestKey)
    if (duplicate) {
      return this.required<Job>(`job:${duplicate}`)
    }
    if (
      this.locked(projectId)
      || this.required<Project>(`project:${projectId}`).revision
      !== project.revision
    ) {
      fail(409, 'Project changed while preparing the task')
    }
    if (
      release
      && this.required<Project>(`project:${projectId}`).releaseId
      !== release.baselineReleaseId
    ) {
      fail(409, 'Release baseline changed')
    }
    const job: Job = {
      id: crypto.randomUUID(),
      projectId,
      project,
      operation,
      status: 'queued',
      sourceCommit: project.advancedConfig?.commit ?? workflowCommit,
      workflowCommit,
      executorCommit: this.env.EXECUTOR_COMMIT,
      workflowDigest,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dispatchAttempts: 0,
      attempt: 1,
      stage: 'queued',
      ...(release ? { release } : {}),
    }
    this.ctx.storage.transactionSync(() => {
      this.put(`job:${job.id}`, job)
      this.put(requestKey, job.id)
      if (confirmationId) {
        this.remove(`confirmation:${confirmationId}`)
      }
    })
    await this.schedule()
    // Alarm owns dispatch and retries, so disconnecting the browser cannot lose a task.
    return job
  }

  getJob(id: string) {
    return this.required<Job>(`job:${id}`)
  }

  claim(id: string, identity: RunnerIdentity, operation: string) {
    const job = this.getJob(id)
    if (
      operation !== job.operation
      || !['queued', 'running', 'reconciling'].includes(job.status)
    ) {
      fail(409, 'Task cannot be claimed')
    }
    if (
      job.runId
      && (job.runId !== identity.runId || job.runAttempt !== identity.runAttempt)
    ) {
      fail(409, 'Task was claimed by another run')
    }
    const updated: Job = {
      ...job,
      status: 'running',
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      stage: job.stage === 'queued' ? 'claimed' : job.stage,
      updatedAt: Date.now(),
    }
    this.put(`job:${id}`, updated)
    return updated
  }

  runnerJob(id: string, identity: RunnerIdentity) {
    const job = this.getJob(id)
    if (
      job.runId !== identity.runId
      || job.runAttempt !== identity.runAttempt
      || !['running', 'reconciling', 'succeeded'].includes(job.status)
    ) {
      fail(403, 'Run has not claimed this task')
    }
    return job
  }

  async jobCredential(
    id: string,
    identity: RunnerIdentity,
    connectionId: string,
    rejectedToken?: string,
  ) {
    const job = this.runnerJob(id, identity)
    if (
      job.operation === 'publish'
      || job.status !== 'running'
      || !job.project.sources.some(
        source =>
          'connection' in source && source.connection === connectionId,
      )
    ) {
      fail(403, 'Credential is outside task scope')
    }
    const token = await this.credential(connectionId, rejectedToken)
    return { accessToken: token.accessToken, expiresAt: token.expiresAt }
  }

  progress(id: string, identity: RunnerIdentity, stage: string) {
    const job = this.runnerJob(id, identity)
    if (job.status !== 'running') {
      return
    }
    if (
      ![
        'fetching',
        'validating',
        'packing',
        'publishing',
        'reconciling',
      ].includes(stage)
    ) {
      fail(400, 'Invalid stage')
    }
    this.put(`job:${id}`, { ...job, stage, updatedAt: Date.now() })
  }

  failJob(id: string, identity: RunnerIdentity, category: string) {
    const job = this.runnerJob(id, identity)
    if (job.status === 'succeeded') {
      return
    }
    const allowed = [
      'authorization',
      'permissions',
      'rate-limit',
      'configuration',
      'validation',
      'conflict',
      'runner',
    ]
    this.put(`job:${id}`, {
      ...job,
      status: job.integrity ? 'reconciling' : 'failed',
      error: allowed.includes(category) ? category : 'runner',
      updatedAt: Date.now(),
    })
  }

  async saveSnapshot(
    id: string,
    identity: RunnerIdentity,
    input: SnapshotContent,
  ) {
    const job = this.runnerJob(id, identity)
    if (job.operation === 'publish') {
      fail(403, 'Release jobs cannot replace snapshots')
    }
    const content = snapshotInput.parse(input)
    if (content.json.prefix !== job.project.prefix) {
      fail(400, 'Snapshot prefix does not match project')
    }
    const serialized = JSON.stringify(content)
    const hash = await digest(serialized)
    const snapshotId = job.id
    const existing = this.get<Snapshot>(`snapshot:${snapshotId}`)
    if (existing) {
      if (existing.digest !== hash) {
        fail(409, 'Snapshot is immutable')
      }
      return existing
    }
    if (job.status !== 'running') {
      fail(409, 'Task is not running')
    }
    const reserved = this.get<string>(`snapshot-reservation:${id}`)
    if (reserved && reserved !== hash) {
      fail(409, 'Snapshot upload already started')
    }
    this.put(`snapshot-reservation:${id}`, hash)
    await this.env.ARTIFACTS.put(
      `snapshots/${snapshotId}/${hash}`,
      serialized,
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      },
    )
    const current = this.getJob(id)
    if (current.runId !== identity.runId || current.status !== 'running') {
      fail(409, 'Task changed while uploading')
    }
    const snapshot: Snapshot = {
      id: snapshotId,
      jobId: id,
      projectId: job.projectId,
      createdAt: Date.now(),
      digest: hash,
      iconCount: Object.keys(content.json.icons).length,
      issues: content.issues.length + content.failed.length,
      ...(job.project.snapshotId ? { baselineId: job.project.snapshotId } : {}),
    }
    this.ctx.storage.transactionSync(() => {
      this.put(`snapshot:${snapshotId}`, snapshot)
      this.put(`job:${id}`, {
        ...current,
        snapshotId,
        status: snapshot.issues ? 'failed' : 'succeeded',
        stage: 'complete',
        updatedAt: Date.now(),
        ...(snapshot.issues ? { error: 'validation' } : {}),
      })
      if (
        !snapshot.issues
        && job.operation !== 'check'
        && job.operation !== 'dry-run'
      ) {
        this.put(`project:${job.projectId}`, {
          ...this.required<Project>(`project:${job.projectId}`),
          snapshotId,
        })
      }
    })
    return snapshot
  }

  snapshot(id: string) {
    return this.required<Snapshot>(`snapshot:${id}`)
  }

  async snapshotContent(id: string) {
    const snapshot = this.snapshot(id)
    const object = await this.env.ARTIFACTS.get(
      `snapshots/${id}/${snapshot.digest}`,
    )
    if (!object) {
      fail(404, 'Snapshot object is missing')
    }
    const text = await object.text()
    if ((await digest(text)) !== snapshot.digest) {
      fail(409, 'Snapshot digest mismatch')
    }
    return JSON.parse(text) as SnapshotContent
  }

  async snapshotDocument(id: string) {
    return JSON.stringify(await this.snapshotContent(id))
  }

  async confirmRelease(
    projectId: string,
    snapshotId: string,
    bump: 'patch' | 'minor' | 'major',
  ) {
    const project = this.required<Project>(`project:${projectId}`)
    if (this.locked(projectId)) {
      fail(409, 'Project has an active task')
    }
    const snapshot = this.snapshot(snapshotId)
    if (
      snapshot.projectId !== projectId
      || snapshot.issues
      || this.getJob(snapshot.jobId).operation === 'dry-run'
      || this.getJob(snapshot.jobId).operation === 'check'
    ) {
      fail(409, 'Snapshot is not publishable')
    }
    const sourceJob = this.getJob(snapshot.jobId)
    if (sourceJob.project.revision !== project.revision) {
      fail(409, 'Project configuration changed; generate a new snapshot')
    }
    const previous = project.releaseId
      ? this.required<Release>(`release:${project.releaseId}`)
      : undefined
    const head = await branchHead(
      await installationToken(this.env, project.repositoryInfo.installationId),
      project.repository,
      `iconctl/${project.name}`,
    )
    if (previous && head !== previous.commit) {
      fail(409, 'Project branch changed outside the console')
    }
    if (!previous && head) {
      fail(409, 'Project branch already exists; choose a new project name')
    }
    const id = crypto.randomUUID()
    const confirmation: Confirmation = {
      id,
      projectId,
      revision: project.revision,
      expiresAt: Date.now() + 600_000,
      release: {
        snapshotId,
        digest: snapshot.digest,
        version: nextVersion(previous?.version, bump),
        branchHead: head,
        confirmation: id,
        ...(previous ? { baselineReleaseId: previous.id } : {}),
      },
    }
    this.put(`confirmation:${id}`, confirmation)
    return {
      ...confirmation,
      packageName: project.packageName,
      iconCount: snapshot.iconCount,
    }
  }

  async saveUpload(body: ArrayBuffer) {
    const id = crypto.randomUUID()
    const hash = await digest(body)
    await this.env.ARTIFACTS.put(`uploads/${id}`, body)
    this.put(`upload:${id}`, { id, digest: hash, bytes: body.byteLength })
    return { id, digest: hash }
  }

  uploadAllowed(id: string, identity: RunnerIdentity, uploadId: string) {
    const job = this.runnerJob(id, identity)
    if (
      job.operation === 'publish'
      || !job.project.sources.some(
        source => 'upload' in source && source.upload === uploadId,
      )
    ) {
      fail(403, 'Upload is outside task scope')
    }
    return this.required<{ digest: string }>(`upload:${uploadId}`)
  }

  async startPairing() {
    const active = this.list<Pairing>('pair').filter(
      pair => pair.expiresAt > Date.now(),
    )
    if (active.length >= 20) {
      fail(429, 'Too many pending pairings')
    }
    const id = crypto.randomUUID()
    const pollToken = randomToken()
    let code: string
    do {
      code = randomToken(6).toUpperCase().slice(0, 8)
    } while (active.some(pair => pair.code === code))
    const pair: Pairing = {
      id,
      code,
      pollHash: await digest(pollToken),
      expiresAt: Date.now() + 300_000,
    }
    this.put(`pair:${id}`, pair)
    await this.schedule()
    return { id, code, pollToken, expiresAt: pair.expiresAt }
  }

  async approvePairing(code: string, projectId: string, label: string) {
    this.required<Project>(`project:${projectId}`)
    const pair = this.list<Pairing>('pair').find(
      item =>
        item.code === code && item.expiresAt > Date.now() && !item.projectId,
    )
    if (!pair) {
      fail(404, 'Pairing code is invalid or expired')
    }
    const token = randomToken()
    const hash = await digest(token)
    const encrypted = await encrypt(
      this.env.CREDENTIAL_ENCRYPTION_KEY,
      pair.id,
      token,
    )
    // All awaits precede the compare-and-set to prevent duplicate approvals.
    if (this.required<Pairing>(`pair:${pair.id}`).projectId) {
      fail(409, 'Pairing was already approved')
    }
    this.put(`device:${pair.id}`, {
      id: pair.id,
      projectId,
      label,
      hash,
    } satisfies Device)
    this.put(`pair:${pair.id}`, {
      ...pair,
      projectId,
      label,
      token: encrypted,
    })
  }

  async pollPairing(id: string, token: string) {
    const hash = await digest(token)
    const pair = this.required<Pairing>(`pair:${id}`)
    if (pair.pollHash !== hash || pair.expiresAt < Date.now()) {
      fail(403, 'Invalid or expired pairing')
    }
    if (!pair.projectId || !pair.token) {
      return { pending: true }
    }
    const credential = await decrypt<string>(
      this.env.CREDENTIAL_ENCRYPTION_KEY,
      id,
      pair.token,
    )
    return {
      pending: false,
      deviceId: id,
      projectId: pair.projectId,
      token: credential,
    }
  }

  revokeDevice(id: string) {
    this.remove(`device:${id}`)
    this.remove(`pair:${id}`)
  }

  async deviceJob(id: string, token: string, idempotency: string) {
    const hash = await digest(token)
    const device = this.required<Device>(`device:${id}`)
    if (device.hash !== hash) {
      fail(403, 'Plugin credential was revoked')
    }
    return this.createJob(
      device.projectId,
      'sync',
      `device:${id}:${idempotency}`,
    )
  }

  async deviceStatus(id: string, token: string, jobId: string) {
    const hash = await digest(token)
    const device = this.required<Device>(`device:${id}`)
    const job = this.getJob(jobId)
    if (device.hash !== hash || job.projectId !== device.projectId) {
      fail(403, 'Task is outside plugin scope')
    }
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error,
    }
  }

  async backup() {
    const rows = this.ctx.storage.sql
      .exec<{ key: string, value: string }>(
        'SELECT key,value FROM records WHERE key NOT GLOB ? AND key NOT GLOB ? AND key NOT GLOB ?',
        'session:*',
        'oauth:*',
        'pair:*',
      )
      .toArray()
    return encrypt(this.env.CREDENTIAL_ENCRYPTION_KEY, 'iconctl-backup-v1', {
      schema: 1,
      createdAt: Date.now(),
      rows,
    })
  }

  async restore(encrypted: string) {
    const backup = await decrypt<{
      schema: number
      rows: { key: string, value: string }[]
    }>(this.env.CREDENTIAL_ENCRYPTION_KEY, 'iconctl-backup-v1', encrypted)
    if (
      backup.schema !== 1
      || !Array.isArray(backup.rows)
      || backup.rows.length > 100_000
    ) {
      fail(400, 'Invalid backup schema')
    }
    if (
      this.list<Project>('project').length
      || this.list<Job>('job').length
      || this.list<Connection>('connection').length
    ) {
      fail(409, 'Restore requires an empty account')
    }
    const rows = backup.rows.filter(row =>
      /^(?:project|job|connection|snapshot|release|upload|request|snapshot-reservation):/.test(
        row.key,
      ),
    )
    const parsed = rows.map((row) => {
      const value = JSON.parse(row.value)
      if (row.key.startsWith('connection:')) {
        value.reconnect = true
        value.refreshing = false
      }
      if (
        row.key.startsWith('job:')
        && ['queued', 'running', 'reconciling'].includes(value.status)
      ) {
        value.status = 'failed'
        value.error = 'restored-reconcile-before-retry'
      }
      return { key: row.key, value }
    })
    this.ctx.storage.transactionSync(() => {
      for (const row of parsed) {
        this.put(row.key, row.value)
      }
    })
    return { restored: parsed.length }
  }

  async alarm() {
    const now = Date.now()
    for (const prefix of ['session', 'oauth', 'pair', 'confirmation']) {
      const rows = this.ctx.storage.sql
        .exec<{ key: string, value: string }>(
          'SELECT key,value FROM records WHERE key GLOB ?',
          `${prefix}:*`,
        )
        .toArray()
      for (const row of rows) {
        if ((JSON.parse(row.value) as { expiresAt: number }).expiresAt < now) {
          this.remove(row.key)
        }
      }
    }
    for (const job of this.list<Job>('job')) {
      if (job.status === 'queued' && job.updatedAt < now - 45_000) {
        if (job.dispatchAttempts >= 3) {
          this.put(`job:${job.id}`, {
            ...job,
            status: 'failed',
            error: 'dispatch',
            updatedAt: now,
          })
          continue
        }
        this.put(`job:${job.id}`, {
          ...job,
          dispatchAttempts: job.dispatchAttempts + 1,
          updatedAt: now,
        })
        try {
          const token = await installationToken(
            this.env,
            job.project.repositoryInfo.installationId,
          )
          await github(
            token,
            `/repos/${job.project.repository}/actions/workflows/${WORKFLOW}/dispatches`,
            'POST',
            {
              ref: job.project.repositoryInfo.defaultBranch,
              inputs: {
                job: job.id,
                attempt: String(job.attempt),
                operation: job.operation,
              },
            },
          )
        }
        catch {
          /* Persisted retry count bounds dispatch attempts. No provider response is logged. */
        }
      }
      else if (
        (job.status === 'running' || job.status === 'reconciling')
        && job.runId
      ) {
        try {
          await this.reconcileJob(job.id)
        }
        catch {
          /* Transient upstream errors are retried by the next alarm. */
        }
      }
    }
    if (
      this.list<Job>('job').some(job =>
        ['queued', 'running', 'reconciling'].includes(job.status),
      )
      || this.list<Session>('session').length
      || this.list<Pairing>('pair').length
      || this.list<OAuthState>('oauth').length
    ) {
      await this.schedule()
    }
  }

  async reconcileJob(id: string) {
    const job = this.getJob(id)
    if (job.status === 'succeeded' || job.status === 'failed') {
      return
    }
    const timedOut
      = Date.now() - (job.attemptStartedAt ?? job.createdAt) > 40 * 60_000
    try {
      if (job.integrity && job.releaseCommit && (await this.finishRelease(id))) {
        return
      }
    }
    catch (error) {
      if (
        (error instanceof Error
          && error.message.startsWith('ICONCTL_ERROR:409:'))
        || timedOut
      ) {
        this.put(`job:${id}`, {
          ...this.getJob(id),
          status: 'failed',
          error: timedOut ? 'reconciliation-timeout' : 'release-conflict',
          updatedAt: Date.now(),
        })
        return
      }
      throw error
    }
    if (timedOut) {
      this.put(`job:${id}`, {
        ...this.getJob(id),
        status: 'failed',
        error: 'runner-timeout',
        updatedAt: Date.now(),
      })
      return
    }
    if (!job.runId) {
      return
    }
    const token = await installationToken(
      this.env,
      job.project.repositoryInfo.installationId,
    )
    const run = await github<{ status: string, conclusion: string | null }>(
      token,
      `/repos/${job.project.repository}/actions/runs/${job.runId}`,
    )
    const current = this.getJob(id)
    if (current.status === 'succeeded' || current.status === 'failed') {
      return
    }
    if (
      run.status === 'completed'
      && job.integrity
      && Date.now() - job.updatedAt < 10 * 60_000
    ) {
      this.put(`job:${id}`, { ...current, status: 'reconciling' })
      return
    }
    if (
      run.status === 'completed'
      || Date.now() - (job.attemptStartedAt ?? job.createdAt) > 40 * 60_000
    ) {
      this.put(`job:${id}`, {
        ...current,
        status: 'failed',
        error: job.integrity ? 'publish-unconfirmed' : 'runner-interrupted',
        updatedAt: Date.now(),
      })
    }
  }

  async retry(id: string) {
    const job = this.getJob(id)
    if (job.status !== 'failed' || this.locked(job.projectId)) {
      fail(409, 'Task cannot be retried')
    }
    if (
      job.operation === 'publish'
      && job.integrity
      && (await this.finishRelease(id))
    ) {
      return this.getJob(id)
    }
    const project = this.required<Project>(`project:${job.projectId}`)
    if (
      project.revision !== job.project.revision
      || project.releaseId !== job.project.releaseId
    ) {
      fail(409, 'Project changed; create a new task')
    }
    const token = await installationToken(
      this.env,
      project.repositoryInfo.installationId,
    )
    if (
      (await branchHead(
        token,
        project.repository,
        project.repositoryInfo.defaultBranch,
      )) !== job.workflowCommit
    ) {
      fail(409, 'Workflow branch changed; create and confirm a new task')
    }
    const latest = this.required<Project>(`project:${job.projectId}`)
    if (
      this.getJob(id).status !== 'failed'
      || this.locked(job.projectId)
      || latest.revision !== project.revision
      || latest.releaseId !== project.releaseId
    ) {
      fail(409, 'Project or task changed')
    }
    const {
      runId: _run,
      runAttempt: _attempt,
      error: _error,
      ...remaining
    } = this.getJob(id)
    const updated: Job = {
      ...remaining,
      attempt: job.attempt + 1,
      status: 'queued',
      dispatchAttempts: 0,
      updatedAt: Date.now(),
      attemptStartedAt: Date.now(),
    }
    this.put(`job:${id}`, updated)
    await this.schedule()
    return updated
  }

  async prepareRelease(
    id: string,
    identity: RunnerIdentity,
    integrity: string,
    tarball: ArrayBuffer,
    files: Record<string, string>,
  ): Promise<{ commit: string, integrity: string }> {
    const current = this.releasePreparations.get(id)
    if (current) {
      await current
      return this.prepareRelease(id, identity, integrity, tarball, files)
    }
    const pending = this.prepareReleaseOnce(
      id,
      identity,
      integrity,
      tarball,
      files,
    )
    this.releasePreparations.set(id, pending)
    try {
      return await pending
    }
    finally {
      this.releasePreparations.delete(id)
    }
  }

  private async prepareReleaseOnce(
    id: string,
    identity: RunnerIdentity,
    integrity: string,
    tarball: ArrayBuffer,
    files: Record<string, string>,
  ) {
    const job = this.runnerJob(id, identity)
    if (
      job.operation !== 'publish'
      || !job.release
      || job.status !== 'running'
    ) {
      fail(409, 'Not an active release task')
    }
    if (job.integrity && job.integrity !== integrity) {
      fail(409, 'Release tarball is immutable')
    }
    const actual = `sha512-${base64(new Uint8Array(await crypto.subtle.digest('SHA-512', tarball)))}`
    if (actual !== integrity) {
      fail(400, 'Tarball integrity mismatch')
    }
    // Fixed file names are validated again before creating the Git tree.
    for (const name of Object.keys(files)) {
      if (
        !/^(?:package\.json|icons\.json|index\.d\.ts|preview\.html|CHANGELOG\.md|README\.md|svg\/[a-z0-9-]+\.svg)$/.test(
          name,
        )
      ) {
        fail(400, 'Unexpected package file')
      }
    }
    const manifest = JSON.parse(atob(files['package.json'] ?? '')) as {
      name: string
      version: string
      scripts?: unknown
    }
    if (
      manifest.name !== job.project.packageName
      || manifest.version !== job.release.version
      || manifest.scripts
    ) {
      fail(400, 'Package manifest does not match confirmation')
    }
    const snapshot = await this.snapshotContent(job.release.snapshotId)
    if (
      JSON.stringify(JSON.parse(atob(files['icons.json'] ?? '')))
      !== JSON.stringify(snapshot.json)
    ) {
      fail(409, 'Package icons differ from the confirmed snapshot')
    }
    for (const [name, content] of Object.entries(snapshot.files)) {
      if (name !== 'icons.json' && files[name] !== content) {
        fail(409, 'Package files differ from confirmed snapshot')
      }
    }
    if (
      Object.keys(files).some(
        name =>
          name !== 'package.json' && !Object.hasOwn(snapshot.files, name),
      )
    ) {
      fail(409, 'Unexpected file in release')
    }
    const project = this.required<Project>(`project:${job.projectId}`)
    if (project.releaseId !== job.release.baselineReleaseId) {
      fail(409, 'Release baseline changed')
    }
    const token = await installationToken(
      this.env,
      project.repositoryInfo.installationId,
    )
    const head = await branchHead(
      token,
      project.repository,
      `iconctl/${project.name}`,
    )
    if (head !== job.releaseCommit && head !== job.release.branchHead) {
      fail(409, 'Project branch changed; confirmation is required again')
    }
    await this.env.ARTIFACTS.put(`releases/${id}/package.tgz`, tarball, {
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (job.releaseCommit) {
      if (head !== job.releaseCommit) {
        if (job.release.branchHead) {
          await github(
            token,
            `/repos/${project.repository}/git/refs/heads/${encodeURIComponent(`iconctl/${project.name}`)}`,
            'PATCH',
            { sha: job.releaseCommit, force: false },
          )
        }
        else {
          await github(token, `/repos/${project.repository}/git/refs`, 'POST', {
            ref: `refs/heads/iconctl/${project.name}`,
            sha: job.releaseCommit,
          })
        }
      }
      return { commit: job.releaseCommit, integrity }
    }
    // Persist the exact npm bytes before any remote side effect.
    this.put(`job:${id}`, {
      ...this.getJob(id),
      integrity,
      stage: 'packing',
      updatedAt: Date.now(),
    })
    const tree: { path: string, mode: string, type: string, sha: string }[]
      = []
    for (const [path, content] of Object.entries(files)) {
      const blob = await github<{ sha: string }>(
        token,
        `/repos/${project.repository}/git/blobs`,
        'POST',
        { content, encoding: 'base64' },
      )
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const createdTree = await github<{ sha: string }>(
      token,
      `/repos/${project.repository}/git/trees`,
      'POST',
      { tree },
    )
    const createdCommit = await github<{ sha: string }>(
      token,
      `/repos/${project.repository}/git/commits`,
      'POST',
      {
        message: `release: ${project.packageName}@${job.release.version}\n\niconctl-job: ${id}\nsnapshot: ${job.release.digest}`,
        tree: createdTree.sha,
        parents: job.release.branchHead ? [job.release.branchHead] : [],
      },
    )
    // Save the commit before updating the ref, allowing a retry after a lost response.
    this.put(`job:${id}`, {
      ...this.getJob(id),
      releaseCommit: createdCommit.sha,
      integrity,
    })
    if (job.release.branchHead) {
      await github(
        token,
        `/repos/${project.repository}/git/refs/heads/${encodeURIComponent(`iconctl/${project.name}`)}`,
        'PATCH',
        { sha: createdCommit.sha, force: false },
      )
    }
    else {
      await github(token, `/repos/${project.repository}/git/refs`, 'POST', {
        ref: `refs/heads/iconctl/${project.name}`,
        sha: createdCommit.sha,
      })
    }
    return { commit: createdCommit.sha, integrity }
  }

  async authorizePublication(id: string, identity: RunnerIdentity) {
    const job = this.runnerJob(id, identity)
    if (
      job.operation !== 'publish'
      || !job.release
      || !job.integrity
      || !job.releaseCommit
      || job.status !== 'running'
    ) {
      fail(409, 'Release has not been prepared')
    }
    const project = this.required<Project>(`project:${job.projectId}`)
    if (project.releaseId !== job.release.baselineReleaseId) {
      fail(409, 'Release baseline changed')
    }
    const token = await installationToken(
      this.env,
      project.repositoryInfo.installationId,
    )
    if (
      (await branchHead(
        token,
        project.repository,
        `iconctl/${project.name}`,
      )) !== job.releaseCommit
    ) {
      fail(409, 'Project branch changed before npm publish')
    }
    this.progress(id, identity, 'publishing')
    return { authorized: true }
  }

  async finishRelease(id: string): Promise<boolean> {
    const job = this.getJob(id)
    if (!job.release || !job.integrity || !job.releaseCommit) {
      return false
    }
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(job.project.packageName)}/${job.release.version}`,
      { signal: AbortSignal.timeout(15_000), redirect: 'error' },
    )
    if (response.status === 404) {
      return false
    }
    if (!response.ok) {
      fail(502, 'Unable to reconcile npm registry')
    }
    const result = await response.json<{ dist?: { integrity?: string } }>()
    if (result.dist?.integrity !== job.integrity) {
      fail(409, 'npm version exists with different content')
    }
    const token = await installationToken(
      this.env,
      job.project.repositoryInfo.installationId,
    )
    if (
      (await branchHead(
        token,
        job.project.repository,
        `iconctl/${job.project.name}`,
      )) !== job.releaseCommit
    ) {
      fail(409, 'Published branch changed; manual reconciliation required')
    }
    const tag = `${job.project.name}/v${job.release.version}`
    try {
      await github(token, `/repos/${job.project.repository}/git/refs`, 'POST', {
        ref: `refs/tags/${tag}`,
        sha: job.releaseCommit,
      })
    }
    catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) {
        throw error
      }
      const ref = await github<{ object: { sha: string } }>(
        token,
        `/repos/${job.project.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      )
      if (ref.object.sha !== job.releaseCommit) {
        fail(409, 'Release tag points to different content')
      }
    }
    try {
      await github(
        token,
        `/repos/${job.project.repository}/releases/tags/${encodeURIComponent(tag)}`,
      )
    }
    catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) {
        throw error
      }
      await github(token, `/repos/${job.project.repository}/releases`, 'POST', {
        tag_name: tag,
        name: `${job.project.packageName}@${job.release.version}`,
        body: `Snapshot: ${job.release.digest}\n\nIntegrity: ${job.integrity}`,
        target_commitish: job.releaseCommit,
      })
    }
    const release: Release = {
      id,
      projectId: job.projectId,
      jobId: id,
      snapshotId: job.release.snapshotId,
      version: job.release.version,
      packageName: job.project.packageName,
      integrity: job.integrity,
      commit: job.releaseCommit,
      createdAt: Date.now(),
      url: `https://www.npmjs.com/package/${job.project.packageName}/v/${job.release.version}`,
    }
    this.ctx.storage.transactionSync(() => {
      this.put(`release:${id}`, release)
      this.put(`job:${id}`, {
        ...this.getJob(id),
        status: 'succeeded',
        stage: 'complete',
        updatedAt: Date.now(),
      })
      this.put(`project:${job.projectId}`, {
        ...this.required<Project>(`project:${job.projectId}`),
        releaseId: id,
      })
    })
    return true
  }
}

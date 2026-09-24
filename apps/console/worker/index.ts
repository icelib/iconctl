import type { SnapshotContent } from '@iconctl/console-contracts'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RunnerIdentity } from './github'
import {
  iconDiff,
  identifier,
  MAX_ARTIFACT_BYTES,
  MAX_UPLOAD_BYTES,
  operationSchema,
  OWNER_ID,
  projectInput,
  safePath,
  snapshotInput,
} from '@iconctl/console-contracts'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import { github, GitHubError, verifyRunner } from './github'
import {
  digest,
  fail,
  limitedBody,
  pkce,
  randomToken,
  unbase64,
  verifyWebhook,
} from './security'
import './env'

export { AccountState } from './state'
interface Bindings {
  Bindings: Env
  Variables: { sessionHash: string, csrf: string, runner: RunnerIdentity }
}
const app = new Hono<Bindings>()
const account = (env: Env) => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER_ID))
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const
const sessionCookie = '__Host-iconctl-session'
const oauthCookie = '__Host-iconctl-oauth'
async function jsonBody(c: Context<Bindings>, maximum = 64_000) {
  return JSON.parse(
    new TextDecoder().decode(await limitedBody(c.req.raw, maximum)),
  ) as unknown
}
function bearer(c: Context<Bindings>) {
  const value = c.req.header('Authorization')
  if (!value?.startsWith('Bearer ')) {
    fail(401, 'Bearer token required')
  }
  return value.slice(7)
}
async function session(c: Context<Bindings>) {
  const cookie = getCookie(c, sessionCookie)
  if (!cookie) {
    return null
  }
  const hash = await digest(cookie)
  const value = await account(c.env).session(hash)
  if (value) {
    c.set('sessionHash', hash)
    c.set('csrf', value.csrf)
  }
  return value
}
app.onError((error, c) => {
  const publicError
    = /^ICONCTL_ERROR:(400|401|403|404|409|413|429|502|503):([\s\S]+)$/.exec(
      error.message,
    )
  if (publicError) {
    return c.json(
      { error: publicError[2] },
      Number(publicError[1]) as ContentfulStatusCode,
    )
  }
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status)
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return c.json(
      { error: 'Invalid request; check configuration fields' },
      400,
    )
  }
  if (error instanceof GitHubError) {
    return c.json({ error: error.message }, error.status === 403 ? 403 : 502)
  }
  if (/^Figma OAuth|^Invalid Figma OAuth/.test(error.message)) {
    return c.json({ error: 'Figma authorization needs reconnecting' }, 409)
  }
  // Durable Object RPC may wrap errors. Never echo arbitrary upstream/provider text.
  return c.json(
    { error: 'Operation failed. Check service configuration and retry.' },
    500,
  )
})
app.use('*', async (c, next) => {
  let path = new URL(c.req.url).pathname
  try {
    for (let count = 0; count < 4 && path.includes('%'); count++) {
      path = decodeURIComponent(path)
    }
  }
  catch {
    fail(400, 'Invalid URL encoding')
  }
  path = new URL(path.replace(/\\/g, '/'), c.env.APP_ORIGIN).pathname
  // The Worker runs before every static lookup. Encoded paths cannot bypass
  // the private app boundary through the asset server's URL normalization.
  if (path === '/app' || path.startsWith('/app/')) {
    if (!(await session(c))) {
      return c.redirect('/login')
    }
  }
  if ((path === '/api' || path.startsWith('/api/')) && path !== c.req.path) {
    fail(400, 'Use canonical API paths')
  }
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  if (
    c.req.path.startsWith('/api/')
    || c.req.path.startsWith('/app')
    || c.req.path === '/login'
  ) {
    c.header('Cache-Control', 'private, no-store')
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header(
        'Content-Security-Policy',
        'default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data: blob:; frame-src \'self\' blob:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'',
      )
    }
  }
})
app.get('/login', c =>
  c.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>登录 · iconctl</title><body><main><h1>iconctl 私有控制台</h1><p>仅向 sonofmagic 开放。公开文档无需登录。</p><a href="/api/auth/github/login">使用 GitHub 登录</a> · <a href="/">浏览文档</a></main></body></html>`,
  ))
app.get('/api/auth/github/login', async (c) => {
  const state = randomToken()
  const verifier = randomToken()
  const browser = randomToken()
  await account(c.env).saveOAuth(state, {
    provider: 'github',
    verifier,
    browser,
    expiresAt: Date.now() + 300_000,
  })
  setCookie(c, oauthCookie, browser, { ...cookieOptions, maxAge: 300 })
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${c.env.APP_ORIGIN}/api/auth/github/callback`,
    state,
    code_challenge: await pkce(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return c.redirect(url.toString())
})
app.get('/api/auth/github/callback', async (c) => {
  const state = z.string().min(30).max(200).parse(c.req.query('state'))
  const oauth = await account(c.env).consumeOAuth(
    state,
    getCookie(c, oauthCookie) ?? '',
    'github',
  )
  deleteCookie(c, oauthCookie, cookieOptions)
  const code = z.string().min(1).max(1000).parse(c.req.query('code'))
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: oauth.verifier,
      redirect_uri: `${c.env.APP_ORIGIN}/api/auth/github/callback`,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    fail(502, 'GitHub login failed')
  }
  const token = await response.json<{ access_token?: string }>()
  if (!token.access_token) {
    fail(401, 'GitHub authorization was denied')
  }
  const user = await github<{ id: number }>(token.access_token, '/user')
  if (String(user.id) !== OWNER_ID) {
    fail(403, 'Only the configured owner may access this console')
  }
  const created = await account(c.env).newSession(String(user.id))
  setCookie(c, sessionCookie, created.token, {
    ...cookieOptions,
    maxAge: 7 * 86400,
  })
  return c.redirect('/app/', 303)
})
app.get('/api/auth/figma/callback', async (c) => {
  const state = z.string().min(30).max(200).parse(c.req.query('state'))
  const oauth = await account(c.env).consumeOAuth(
    state,
    getCookie(c, oauthCookie) ?? '',
    'figma',
  )
  deleteCookie(c, oauthCookie, cookieOptions)
  if (!(await session(c)) || oauth.session !== c.get('sessionHash')) {
    fail(401, 'Login again before connecting Figma')
  }
  await account(c.env).connectFigma(
    z.string().min(1).max(1000).parse(c.req.query('code')),
    oauth.verifier,
    oauth.connectionId,
  )
  return c.redirect('/app/?view=connections', 303)
})
app.post('/api/webhooks/github', async (c) => {
  const body = await limitedBody(c.req.raw, 1024 * 1024)
  if (
    !(await verifyWebhook(
      c.env.GITHUB_WEBHOOK_SECRET,
      body,
      c.req.header('x-hub-signature-256') ?? null,
    ))
  ) {
    fail(401, 'Invalid webhook signature')
  }
  if (c.req.header('x-github-event') === 'workflow_run') {
    const event = JSON.parse(new TextDecoder().decode(body)) as {
      repository?: { id: number }
      workflow_run?: { id: number }
    }
    const state = await account(c.env).state()
    for (const job of state.jobs) {
      if (
        job.runId === String(event.workflow_run?.id)
        && job.project.repositoryInfo.id === event.repository?.id
      ) {
        c.executionCtx.waitUntil(
          account(c.env)
            .reconcileJob(job.id)
            .catch(() => undefined),
        )
      }
    }
  }
  return c.json({ accepted: true }, 202)
})
app.use(
  '/api/plugin/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  }),
)
app.post('/api/plugin/pair', async c =>
  c.json(await account(c.env).startPairing(), 201))
app.get('/api/plugin/pair/:id', async c =>
  c.json(
    await account(c.env).pollPairing(
      identifier.parse(c.req.param('id')),
      bearer(c),
    ),
  ))
app.post('/api/plugin/devices/:id/jobs', async (c) => {
  const job = await account(c.env).deviceJob(
    identifier.parse(c.req.param('id')),
    bearer(c),
    identifier.parse(c.req.header('Idempotency-Key')),
  )
  return c.json(
    { id: job.id, url: `${c.env.APP_ORIGIN}/app/?job=${job.id}` },
    202,
  )
})
app.get('/api/plugin/devices/:id/jobs/:jobId', async c =>
  c.json(
    await account(c.env).deviceStatus(
      identifier.parse(c.req.param('id')),
      bearer(c),
      identifier.parse(c.req.param('jobId')),
    ),
  ))

app.use('/api/runner/:id/*', async (c, next) => {
  const job = await account(c.env).getJob(identifier.parse(c.req.param('id')))
  let identity: RunnerIdentity
  try {
    identity = await verifyRunner(c.env, bearer(c), job)
  }
  catch {
    fail(403, 'Runner identity validation failed')
  }
  c.set('runner', identity)
  await next()
})
app.post('/api/runner/:id/claim', async (c) => {
  const input = z.object({ operation: z.string() }).parse(await jsonBody(c))
  const job = await account(c.env).claim(
    c.req.param('id'),
    c.get('runner'),
    input.operation,
  )
  return c.json(job)
})
app.post('/api/runner/:id/credentials', async (c) => {
  const input = z
    .object({
      connectionId: identifier,
      rejectedToken: z.string().max(4096).optional(),
    })
    .parse(await jsonBody(c))
  return c.json(
    await account(c.env).jobCredential(
      c.req.param('id'),
      c.get('runner'),
      input.connectionId,
      input.rejectedToken,
    ),
  )
})
app.post('/api/runner/:id/progress', async (c) => {
  const input = z.object({ stage: z.string() }).parse(await jsonBody(c))
  await account(c.env).progress(
    c.req.param('id'),
    c.get('runner'),
    input.stage,
  )
  return c.json({ ok: true })
})
app.post('/api/runner/:id/failure', async (c) => {
  const input = z.object({ category: z.string() }).parse(await jsonBody(c))
  await account(c.env).failJob(
    c.req.param('id'),
    c.get('runner'),
    input.category,
  )
  return c.json({ ok: true })
})
app.post('/api/runner/:id/snapshot', async c =>
  c.json(
    await account(c.env).saveSnapshot(
      c.req.param('id'),
      c.get('runner'),
      snapshotInput.parse(await jsonBody(c, MAX_ARTIFACT_BYTES)),
    ),
    201,
  ))
app.get('/api/runner/:id/snapshot/:snapshotId', async (c) => {
  const job = await account(c.env).runnerJob(
    c.req.param('id'),
    c.get('runner'),
  )
  const snapshotId = identifier.parse(c.req.param('snapshotId'))
  if (
    snapshotId !== job.project.snapshotId
    && snapshotId !== job.release?.snapshotId
  ) {
    fail(403, 'Snapshot is outside task scope')
  }
  return c.body(await account(c.env).snapshotDocument(snapshotId), 200, {
    'Content-Type': 'application/json',
  })
})
app.get('/api/runner/:id/uploads/:uploadId', async (c) => {
  const uploadId = identifier.parse(c.req.param('uploadId'))
  const upload = await account(c.env).uploadAllowed(
    c.req.param('id'),
    c.get('runner'),
    uploadId,
  )
  const body = await c.env.ARTIFACTS.get(`uploads/${uploadId}`)
  if (!body) {
    fail(404, 'Upload not found')
  }
  return new Response(body.body, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Content-SHA256': upload.digest,
    },
  })
})
app.post('/api/runner/:id/release/prepare', async (c) => {
  const input = z
    .object({
      integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
      tarball: z.string(),
      files: z.record(safePath, z.string()),
    })
    .parse(await jsonBody(c, MAX_ARTIFACT_BYTES))
  return c.json(
    await account(c.env).prepareRelease(
      c.req.param('id'),
      c.get('runner'),
      input.integrity,
      unbase64(input.tarball).buffer,
      input.files,
    ),
  )
})
app.get('/api/runner/:id/release/tarball', async (c) => {
  const job = await account(c.env).runnerJob(
    c.req.param('id'),
    c.get('runner'),
  )
  if (!job.release || !job.integrity) {
    fail(404, 'Release has not been prepared')
  }
  const object = await c.env.ARTIFACTS.get(`releases/${job.id}/package.tgz`)
  if (!object) {
    fail(404, 'Release tarball missing')
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'X-Package-Integrity': job.integrity,
    },
  })
})
app.post('/api/runner/:id/release/authorize', async c =>
  c.json(
    await account(c.env).authorizePublication(
      c.req.param('id'),
      c.get('runner'),
    ),
  ))
app.post('/api/runner/:id/release/complete', async (c) => {
  await account(c.env).runnerJob(c.req.param('id'), c.get('runner'))
  return c.json({
    completed: await account(c.env).finishRelease(c.req.param('id')),
  })
})

// All owner APIs below this boundary require a live server-side session.
app.use('/api/*', async (c, next) => {
  if (!(await session(c))) {
    fail(401, 'Login required')
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (
      c.req.header('Origin') !== c.env.APP_ORIGIN
      || c.req.header('X-CSRF-Token') !== c.get('csrf')
    ) {
      fail(403, 'Invalid origin or CSRF token')
    }
  }
  await next()
})
app.get('/api/session', c =>
  c.json({ owner: 'sonofmagic', csrf: c.get('csrf') }))
app.post('/api/logout', async (c) => {
  await account(c.env).logout(c.get('sessionHash'))
  deleteCookie(c, sessionCookie, cookieOptions)
  return c.json({ ok: true })
})
app.get('/api/state', async c => c.json(await account(c.env).state()))
app.post('/api/connections/figma', async (c) => {
  if (!c.env.FIGMA_CLIENT_ID || !c.env.FIGMA_CLIENT_SECRET) {
    fail(503, 'Configure the website Figma OAuth App first')
  }
  const input = z
    .object({ connectionId: identifier.optional() })
    .parse(await jsonBody(c))
  const state = randomToken()
  const verifier = randomToken()
  const browser = randomToken()
  await account(c.env).saveOAuth(state, {
    provider: 'figma',
    verifier,
    browser,
    expiresAt: Date.now() + 300_000,
    session: c.get('sessionHash'),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  })
  setCookie(c, oauthCookie, browser, { ...cookieOptions, maxAge: 300 })
  const url = new URL('https://www.figma.com/oauth')
  url.search = new URLSearchParams({
    client_id: c.env.FIGMA_CLIENT_ID,
    redirect_uri: `${c.env.APP_ORIGIN}/api/auth/figma/callback`,
    scope: 'file_content:read',
    state,
    response_type: 'code',
    code_challenge: await pkce(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return c.json({ url: url.toString() })
})
app.post('/api/connections/mastergo', async (c) => {
  const input = z
    .object({
      label: z.string().min(1).max(80),
      token: z.string().min(1).max(4096),
    })
    .parse(await jsonBody(c))
  return c.json(
    { id: await account(c.env).connectMastergo(input.label, input.token) },
    201,
  )
})
app.delete('/api/connections/:id', async (c) => {
  await account(c.env).disconnect(identifier.parse(c.req.param('id')))
  return c.json({ ok: true })
})
app.post('/api/projects', async c =>
  c.json(
    await account(c.env).saveProject(projectInput.parse(await jsonBody(c))),
    201,
  ))
app.put('/api/projects/:id', async (c) => {
  const input = z
    .object({ project: projectInput, revision: z.number().int() })
    .parse(await jsonBody(c))
  return c.json(
    await account(c.env).saveProject(
      input.project,
      identifier.parse(c.req.param('id')),
      input.revision,
    ),
  )
})
app.post('/api/projects/:id/install', async c =>
  c.json({
    url: await account(c.env).installWorkflow(
      identifier.parse(c.req.param('id')),
    ),
  }))
app.post('/api/projects/:id/jobs', async (c) => {
  const input = z
    .object({ operation: operationSchema })
    .parse(await jsonBody(c))
  return c.json(
    await account(c.env).createJob(
      identifier.parse(c.req.param('id')),
      input.operation,
      identifier.parse(c.req.header('Idempotency-Key')),
    ),
    202,
  )
})
app.post('/api/projects/:id/release/preview', async (c) => {
  const input = z
    .object({
      snapshotId: identifier,
      bump: z.enum(['patch', 'minor', 'major']),
    })
    .parse(await jsonBody(c))
  return c.json(
    await account(c.env).confirmRelease(
      identifier.parse(c.req.param('id')),
      input.snapshotId,
      input.bump,
    ),
  )
})
app.post('/api/projects/:id/release/confirm', async (c) => {
  const input = z
    .object({ confirmationId: identifier })
    .parse(await jsonBody(c))
  return c.json(
    await account(c.env).createJob(
      identifier.parse(c.req.param('id')),
      'publish',
      identifier.parse(c.req.header('Idempotency-Key')),
      input.confirmationId,
    ),
    202,
  )
})
app.post('/api/jobs/:id/retry', async c =>
  c.json(await account(c.env).retry(identifier.parse(c.req.param('id'))), 202))
app.get('/api/snapshots/:id', async (c) => {
  const snapshot = await account(c.env).snapshot(
    identifier.parse(c.req.param('id')),
  )
  const content = JSON.parse(
    await account(c.env).snapshotDocument(snapshot.id),
  ) as SnapshotContent
  const previous = snapshot.baselineId
    ? (JSON.parse(
        await account(c.env).snapshotDocument(snapshot.baselineId),
      ) as SnapshotContent)
    : undefined
  return c.json({
    snapshot,
    content,
    previous: previous?.json,
    diff: iconDiff(previous?.json, content.json),
  })
})
app.get('/api/snapshots/:id/files/*', async (c) => {
  const content = JSON.parse(
    await account(c.env).snapshotDocument(identifier.parse(c.req.param('id'))),
  ) as SnapshotContent
  const name = safePath.parse(
    decodeURIComponent(c.req.path.split('/files/')[1] ?? ''),
  )
  const file = content.files[name]
  if (!file) {
    fail(404, 'Artifact not found')
  }
  return new Response(unbase64(file), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.split('/').pop()}"`,
      'Content-Security-Policy': 'sandbox; default-src \'none\'',
    },
  })
})
app.get('/api/releases/:id/package.tgz', async (c) => {
  const state = await account(c.env).state()
  const release = state.releases.find(
    item => item.id === identifier.parse(c.req.param('id')),
  )
  if (!release) {
    fail(404, 'Release not found')
  }
  const object = await c.env.ARTIFACTS.get(
    `releases/${release.id}/package.tgz`,
  )
  if (!object) {
    fail(404, 'Package not found')
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${release.version}.tgz"`,
    },
  })
})
app.post('/api/uploads', async c =>
  c.json(
    await account(c.env).saveUpload(
      await limitedBody(c.req.raw, MAX_UPLOAD_BYTES),
    ),
    201,
  ))
app.post('/api/pairings/approve', async (c) => {
  const input = z
    .object({
      code: z.string().length(8),
      projectId: identifier,
      label: z.string().min(1).max(80),
    })
    .parse(await jsonBody(c))
  await account(c.env).approvePairing(input.code, input.projectId, input.label)
  return c.json({ ok: true })
})
app.delete('/api/devices/:id', async (c) => {
  await account(c.env).revokeDevice(identifier.parse(c.req.param('id')))
  return c.json({ ok: true })
})
app.get('/api/backup', async c =>
  c.body(await account(c.env).backup(), 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="iconctl-backup.enc"',
  }))
app.post('/api/restore', async c =>
  c.json(
    await account(c.env).restore(
      new TextDecoder().decode(
        await limitedBody(c.req.raw, MAX_ARTIFACT_BYTES),
      ),
    ),
  ))
app.all('/api/*', c => c.json({ error: 'Not found' }, 404))

app.use('/app', async (c, next) => {
  if (!(await session(c))) {
    return c.redirect('/login')
  }
  await next()
})
app.use('/app/*', async (c, next) => {
  if (!(await session(c))) {
    return c.redirect('/login')
  }
  await next()
})
app.get('/app', c => c.redirect('/app/'))
app.get('/app/*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw)
  if (response.status !== 404 || c.req.path.startsWith('/app/assets/')) {
    return response
  }
  return c.env.ASSETS.fetch(
    new Request(new URL('/app/index.html', c.req.url), c.req.raw),
  )
})
app.get('*', c => c.env.ASSETS.fetch(c.req.raw))
export default app

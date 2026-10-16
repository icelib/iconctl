# Server-side SDK

Use `@iconctl/core` to run icon synchronization inside a Node.js service, worker process or existing job runner. It requires Node.js 22.13 or newer and access to a writable filesystem. Keep Figma credentials and SDK execution on the server; the browser can submit a job and read the host's progress and error responses.

```bash
pnpm add @iconctl/core
```

The examples below depend only on `@iconctl/core`. They do not require the `iconctl` CLI package or a child process.

## Configure and run

Create a trusted `iconctl.config.ts` in the job's working directory:

```ts
import type { IconctlConfig } from '@iconctl/core'

export default {
  prefix: 'brand',
  sources: [
    {
      type: 'figma',
      file: 'https://www.figma.com/design/AbCdEf123456/Icons',
      pages: ['Icons'],
    },
  ],
  output: {
    json: 'generated/icons.json',
    preview: 'generated/preview.html',
  },
} satisfies IconctlConfig
```

The type-only import works in a service that installs only core. `defineConfig` is also exported by `@iconctl/core` if you prefer a runtime helper. Configuration loading executes the config and its imports, so load application-owned configuration.

```ts
import { loadConfig, serializeIconctlError, sync } from '@iconctl/core'

const cwd = '/srv/icon-jobs/brand'
const env = process.env
const controller = new AbortController()
const secrets = [
  env.FIGMA_TOKEN,
  env.FIGMA_CLIENT_ID,
  env.FIGMA_CLIENT_SECRET,
  env.FIGMA_REFRESH_TOKEN,
].filter((value): value is string => Boolean(value))

try {
  const config = await loadConfig({ cwd, configFile: 'iconctl.config.ts' })
  const result = await sync({
    cwd,
    config,
    env,
    signal: controller.signal,
    requestTimeoutMs: 30_000,
    oauthTimeoutMs: 15_000,
    onProgress(event) {
      console.info('icon-sync-progress', event)
    },
  })

  console.info({ complete: result.complete, processed: result.processed })
}
catch (error) {
  const diagnostic = serializeIconctlError(error, { secrets })
  console.error(JSON.stringify(diagnostic))
}

// In the host's cancellation handler: controller.abort()
```

Use the same `cwd` for `loadConfig` and `sync`: relative source, cache and output paths resolve from that directory, including when the config is in a subdirectory. `loadConfig` returns a resolved configuration and does not load `.env` files; supply the intended server environment through `env`. For configuration already held in memory, call `resolveConfig(config)` before `sync`.

By default, import, processing and validation failures reject without replacing existing outputs. `continueOnError: true` explicitly permits partial output; inspect `result.complete`, `result.issues` and `result.diff.deletionsReliable` before publishing. A partial result has unreliable deletions, does not report removals and skips changelog updates. Authentication failures, unreadable sources and a Figma source with no valid imported icons still reject.

## Progress and host jobs

`onProgress` receives immutable `SyncProgressEvent` objects. Stages include `prepare`, `source`, `document`, `export-url`, `download`, `import`, `process`, `validate`, `export` and `complete`. Events include `timestamp` and may include source coordinates, an icon name, and `completed` / `total`.

Counts describe finished attempts, including failures. The `source` stage counts configured sources, and Figma loading stages count work within that Figma source. `process` and `validate` count the entire merged icon collection, even when an individual event includes that icon's source coordinates. These counts are not an overall success count or global job percentage.

Callbacks are invoked in event order. Returned promises are **not awaited**, so asynchronous writes may finish in a different order and do not apply backpressure. A thrown exception or rejected callback promise does not fail the sync; the host must report its own observer failures. For asynchronous delivery, adapt your own queue:

```ts
import type { SerializedIconctlError, SyncProgressEvent } from '@iconctl/core'
import { serializeIconctlError } from '@iconctl/core'

// Implement these in the host application.
declare function enqueueProgress(event: SyncProgressEvent): Promise<void>
declare function reportProgressFailure(error: SerializedIconctlError): void

function onProgress(event: SyncProgressEvent): void {
  try {
    void enqueueProgress(event).catch((error) => {
      reportProgressFailure(serializeIconctlError(error))
    })
  }
  catch (error) {
    reportProgressFailure(serializeIconctlError(error))
  }
}
```

Bound queue memory, coalesce progress updates or limit write concurrency in the host. Keep the callback short. Treat the settled `sync()` promise and its result as the authoritative job outcome, even when progress delivery fails.

Core does not create job IDs, durable job records, a retry queue or browser subscriptions. The host assigns the job ID, persists its state and sanitized diagnostics, authorizes access, and chooses retry and retention policies. Serialize jobs targeting the same output paths; use independent working directories for concurrent projects. Publish generated artifacts only after the host accepts the result. See [output integrity](/quick-start#sync-integrity-and-cancellation).

## Structured errors

Call `serializeIconctlError(error, { secrets })` before storing an error or sending it through an API. It produces plain JSON with `name` and `message`, plus known optional metadata:

| Field | Meaning |
| --- | --- |
| `code` | Machine-readable classification, such as `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `FIGMA_HTTP_ERROR` or `ABORT_ERR` |
| `httpStatus` | Provider HTTP status when known |
| `retryable`, `retryAfterMs` | Retry guidance; the host decides whether and when to retry |
| `sourceType`, `sourceIndex`, `operation` | Known source and operation context |
| `issues` | Per-icon failures with stage and available source coordinates |
| `cause`, `errors` | Bounded nested causes and aggregate errors |
| `truncated` | Some details exceeded the serializer's limits |

The serializer excludes stacks, request/response objects and arbitrary properties. It redacts recognized credential forms and the supplied secrets, including URL-encoded values. Supply every application-known credential, including tokens from source configuration or a custom authentication provider. It does not discover all application secrets or remove every filesystem path: include sensitive host values in `secrets` or map diagnostics to the public fields your API exposes. Render messages as text.

A timeout or rate limit can be retried under a bounded host policy; invalid credentials and missing file access need a configuration change. Preserve the diagnostic and job ID so an operator can identify the failed stage and source.

## Figma deadlines and cancellation

| Option | Default | Scope |
| --- | --- | --- |
| `requestTimeoutMs` | `30_000` ms | Each Figma API or SVG download request, including headers and the complete body |
| `oauthTimeoutMs` | `15_000` ms | Each Figma OAuth token or refresh request, including headers and the complete body |
| `signal` | Unset | Caller cancellation of the sync or inspection |

Timeout values must be finite positive integers. They are request deadlines, not a deadline for the entire job. When OAuth refresh is shared, `oauthTimeoutMs` bounds each token waiter's wait independently. The shared transport follows the latest deadline of its joined waiters; a later waiter with a longer deadline can extend it. A short waiter's timeout or cancellation does not truncate another waiter's refresh. The identity session retains rotated credentials across different timeout policies. These options are SDK options; they do not imply corresponding CLI flags. Remote Iconify sources retain their own documented transport limits.

Cancellation before output commit preserves previous outputs; once commit begins, the operation completes that commit. Processing observes cancellation between synchronous icon operations. Cancelling a waiter does not cancel an OAuth refresh shared with other jobs: that refresh may finish and save renewed local credentials after the cancelled waiter rejects. PATs never refresh automatically. See [Figma authorization](/figma#oauth-login-and-automatic-renewal) for credential priority and authorization setup.

## Inspect Figma credentials

`inspectFigmaAuth()` reports all credential sources without exposing tokens or credential file paths. The default performs local reads only: **no network requests, no refreshes and no writes**. It does not load your project config; pass a source's configured PAT as `token` when that source has one.

```ts
import { inspectFigmaAuth } from '@iconctl/core'

const offlineReport = await inspectFigmaAuth({ env: process.env })

// An explicit network check of the selected source's access to this file.
const verifiedReport = await inspectFigmaAuth({
  env: process.env,
  verify: true,
  file: 'https://www.figma.com/design/AbCdEf123456/Icons',
  requestTimeoutMs: 30_000,
  oauthTimeoutMs: 15_000,
})
```

The result is `{ source, sources }`. Each source reports `configured`, `selected`, `validity`, `expiresAt` and an optional sanitized `error`. Selection follows this order:

1. `config-token`: the explicit `token` option.
2. `environment-token`: `FIGMA_TOKEN`.
3. `environment-oauth`: `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET` and `FIGMA_REFRESH_TOKEN` together.
4. `local-oauth`: saved credentials.

`source` is `none` when no credentials are configured. Partial environment OAuth remains an invalid selected source when no PAT takes precedence, matching normal authentication's error instead of silently falling back. Malformed local files are reported even when another source is selected.

| Validity | Interpretation |
| --- | --- |
| `unknown` | Not checked, or the check could not establish credential validity; inspect `error` for file access, scope, rate limit or network failures |
| `valid` | The selected source passed the requested network check |
| `invalid` | Incomplete/malformed configuration or an explicit credential rejection |
| `expired` | A saved local access token has expired |

Only `verify: true` performs network checks, and only for the selected source. Without `file`, it requests `/v1/me`; with `file`, it makes a minimal file request with `depth=1`. HTTP 401 marks credentials invalid. An ordinary file HTTP 403 or 429 reports `unknown` with the HTTP diagnostic; it does not prove that the token is invalid. Nonselected sources are not verified, while locally known configuration errors and expiry remain visible.

Verification never refreshes local OAuth, including expired credentials, and does not write credentials or response caches. Environment OAuth verification uses the same identity's in-memory session as normal sync and refreshes it when needed, retaining rotated credentials for subsequent syncs. Its `expiresAt` remains `null` because that session does not expose expiry metadata. A refresh rejection with HTTP 400, 401 or 403 is invalid. A network refresh can affect the provider's active token, so coordinate jobs sharing an authorization across processes. Caller abort rejects with `IconctlAbortError`; other check failures appear in the selected source's sanitized `error`. `unknown` should remain distinguishable from invalid credentials in the host UI.

# Maintained dependency patches

`readdirp@5.1.1.patch` treats `ENOTDIR` like a directory that disappeared during traversal. A directory can be replaced by a file between Chokidar’s stat and readdir. Without this classification readdirp destroys its stream, while Chokidar 5 suppresses the error and awaits an end event that never arrives. The application then waits indefinitely for readiness.

The patch is generated and registered by `pnpm patch` / `pnpm patch-commit`. Keep its exact version and lockfile hash; do not change installed dependency files or suppress unused-patch failures. A future dependency update must verify this race before removing the patch.

Core bundles Chokidar and readdirp because package consumers do not inherit workspace patch settings. Both module entry points load that same implementation; CommonJS uses synchronous `require(ESM)` on the existing Node.js >=22.13 baseline. The included `THIRD_PARTY_NOTICES` preserves both dependency licenses.

Run `pnpm --filter @iconctl/core test:package` to build and pack the actual core and CLI, install them with npm in a temporary consumer, and verify native ESM/CJS resolution, declarations, exported identities, watcher startup/replacement/recreation/cancellation, and CLI signal shutdown. A separate package with the former external dependency boundary must still reproduce the ENOTDIR readiness hang. The script deletes only its own temporary fixture and uses no registry publication, global installation, workspace links, or consumer patch policy. It requires registry access to install normal consumer dependencies. To repeat with a specific existing Node executable, run the script after building with `node packages/core/scripts/test-watch-package.mjs /absolute/path/to/node`.

`Package consumer CI` runs this check on Linux with Node 22 and 24. Source-level startup and handover regressions live in `packages/core/test/watch-enotdir.test.ts`; the existing watcher suites cover broader lifecycle behavior.

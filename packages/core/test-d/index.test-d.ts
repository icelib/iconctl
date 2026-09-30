import type { SyncIssue, SyncResult } from '..'
import { expectType } from 'tsd'
import { defineConfig, IconctlAbortError, IconctlSyncError, parseFigmaFileKey, resolveConfig, sync } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
expectType<{ prefix: string, sources: [{ type: 'figma', file: string }] }>(defineConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
}))

const config = resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'svg' }] })
expectType<Promise<SyncResult>>(sync({ config, signal: new AbortController().signal }))
declare const result: SyncResult
expectType<boolean>(result.complete)
expectType<boolean>(result.diff.deletionsReliable)
expectType<SyncIssue[]>(result.issues)
expectType<SyncIssue[]>(new IconctlSyncError([]).issues)
expectType<'ABORT_ERR'>(new IconctlAbortError().code)

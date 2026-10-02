import type { CheckInputOptions, CheckIssue, CheckOptions, CheckReport, CheckResult, SyncIssue, SyncResult } from '..'
import { expectError, expectType } from 'tsd'
import { check, defineConfig, IconctlAbortError, IconctlCheckError, IconctlSyncError, parseFigmaFileKey, resolveConfig, sync, watch } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
expectType<{ prefix: string, sources: [{ type: 'figma', file: string }] }>(defineConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
}))

const config = resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'svg' }] })
interface ExtendedCheckOptions extends CheckOptions { extra: boolean }
declare const checkOptions: ExtendedCheckOptions
expectType<typeof config>(checkOptions.config)
expectType<Promise<CheckResult>>(check(checkOptions))
const inputOptions: CheckInputOptions = { input: 'icons.json', validate: { name: /^[a-z]+$/g, width: 16 } }
expectType<Promise<CheckResult>>(check(inputOptions))
expectError(check({ input: 'icons.json', config }))
expectError(check({}))
declare const checked: CheckResult
expectType<string>(checked.prefix)
declare const report: CheckReport
expectType<CheckIssue[]>(new IconctlCheckError(report).issues)
expectType<CheckReport>(new IconctlCheckError(report).report)
expectType<Promise<SyncResult>>(sync({ config, signal: new AbortController().signal }))
declare const result: SyncResult
expectType<boolean>(result.complete)
expectType<boolean>(result.diff.deletionsReliable)
expectType<SyncIssue[]>(result.issues)
expectType<SyncIssue[]>(new IconctlSyncError([]).issues)
expectType<'ABORT_ERR'>(new IconctlAbortError().code)
expectType<{ prefix: string, sources: [{ type: 'iconify', file: string, include: string[], namePrefix: string }] }>(defineConfig({
  prefix: 'brand',
  sources: [{ type: 'iconify', file: './vendor.json', include: ['home'], namePrefix: 'vendor-' }],
}))
expectType<Promise<void>>(watch({ signal: new AbortController().signal, onEvent(event) {
  if (event.type === 'result') {
    expectType<SyncResult>(event.result)
  }
  if (event.type === 'start') {
    expectType<'initial' | 'source' | 'config'>(event.reason)
  }
} }))

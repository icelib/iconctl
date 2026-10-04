import type { CheckInputOptions, CheckIssue, CheckOptions, CheckReport, CheckResult, IconDiff, IconSetComparison, SyncIssue, SyncResult } from '..'
import { expectError, expectType } from 'tsd'
import { check, compareIconSets, defineConfig, diffIconSets, IconctlAbortError, IconctlCheckError, IconctlSyncError, parseFigmaFileKey, renderDiffHtml, resolveConfig, sync, watch, writeDiffHtml } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
const comparison = compareIconSets(undefined, { prefix: 'brand', icons: { arrow: { body: '<path/>' } } })
expectType<IconSetComparison>(comparison)
expectType<IconDiff>(diffIconSets(undefined, { prefix: 'brand', icons: {} }))
expectType<boolean>(comparison.prefixChanged)
expectType<string>(renderDiffHtml(comparison))
expectType<Promise<void>>(writeDiffHtml('diff.html', comparison, { inputs: ['icons.json'], dryRun: true }))
expectType<{ prefix: string, sources: [{ type: 'figma', file: string }] }>(defineConfig({
  prefix: 'brand',
  sources: [{ type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv' }],
}))

const config = resolveConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'svg' }] })
const spriteConfig = defineConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'raw' }], output: { sprite: 'icons.svg' } })
expectType<string>(spriteConfig.output.sprite)
expectType<string | undefined>(resolveConfig(spriteConfig).output.sprite)
expectError(defineConfig({ prefix: 'fixture', sources: [{ type: 'directory', dir: 'raw' }], output: { sprite: true } }))
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

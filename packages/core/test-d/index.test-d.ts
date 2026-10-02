import type { IconDiff, IconSetComparison, SyncIssue, SyncResult } from '..'
import { expectType } from 'tsd'
import { compareIconSets, defineConfig, diffIconSets, IconctlAbortError, IconctlSyncError, parseFigmaFileKey, renderDiffHtml, resolveConfig, sync, watch, writeDiffHtml } from '..'

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
expectType<Promise<SyncResult>>(sync({ config, signal: new AbortController().signal }))
declare const result: SyncResult
expectType<boolean>(result.complete)
expectType<boolean>(result.diff.deletionsReliable)
expectType<SyncIssue[]>(result.issues)
expectType<SyncIssue[]>(new IconctlSyncError([]).issues)
expectType<'ABORT_ERR'>(new IconctlAbortError().code)
expectType<Promise<void>>(watch({ signal: new AbortController().signal, onEvent(event) {
  if (event.type === 'result') {
    expectType<SyncResult>(event.result)
  }
  if (event.type === 'start') {
    expectType<'initial' | 'source' | 'config'>(event.reason)
  }
} }))

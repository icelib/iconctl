import type { CheckInputOptions, CheckIssue, CheckOptions, CheckReport, CheckResult, IconDiff, IconNameTypesSummary, IconSetComparison, SvgSpriteSummary, SyncIssue, SyncResult, WriteIconNameTypesOptions, WritePreviewHtmlOptions, WriteSvgSpriteOptions } from '..'
import { expectError, expectType } from 'tsd'
import { check, compareIconSets, defineConfig, diffIconSets, IconctlAbortError, IconctlCheckError, IconctlSyncError, parseFigmaFileKey, renderDiffHtml, renderIconNameTypes, renderPreviewHtml, renderSvgSprite, resolveConfig, sync, watch, writeDiffHtml, writeIconNameTypes, writePreviewHtml, writeSvgSprite } from '..'

expectType<string>(parseFigmaFileKey('AbCdEfGhIjKlMnOpQrStUv'))
const comparison = compareIconSets(undefined, { prefix: 'brand', icons: { arrow: { body: '<path/>' } } })
expectType<IconSetComparison>(comparison)
expectType<IconDiff>(diffIconSets(undefined, { prefix: 'brand', icons: {} }))
expectType<boolean>(comparison.prefixChanged)
expectType<string>(renderDiffHtml(comparison))
expectType<Promise<void>>(writeDiffHtml('diff.html', comparison, { inputs: ['icons.json'], dryRun: true }))
const previewOptions: WritePreviewHtmlOptions = { inputs: ['icons.json'] as const, dryRun: true }
const previewIcons = { prefix: 'brand', icons: {} }
expectType<string>(renderPreviewHtml(previewIcons))
expectType<Promise<void>>(writePreviewHtml('preview.html', previewIcons))
expectType<Promise<void>>(writePreviewHtml('preview.html', previewIcons, previewOptions))
expectError(writePreviewHtml('preview.html', previewIcons, { inputs: 'icons.json' }))
expectError(writePreviewHtml('preview.html', previewIcons, { dryRun: 'true' }))
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

const spriteOptions: WriteSvgSpriteOptions = { inputs: ['icons.json'] as const, dryRun: true }
expectType<Promise<string>>(renderSvgSprite(previewIcons))
expectType<Promise<SvgSpriteSummary>>(writeSvgSprite('icons.svg', previewIcons))
expectType<Promise<SvgSpriteSummary>>(writeSvgSprite('icons.svg', previewIcons, spriteOptions))
expectError(writeSvgSprite('icons.svg', previewIcons, { inputs: 'icons.json' }))
expectError(writeSvgSprite('icons.svg', previewIcons, { dryRun: 'true' }))
expectError(renderSvgSprite({ icons: {} }))

const typesOptions: WriteIconNameTypesOptions = { inputs: ['icons.json'] as const, dryRun: true }
expectType<string>(renderIconNameTypes(previewIcons))
expectType<Promise<IconNameTypesSummary>>(writeIconNameTypes('icons.d.ts', previewIcons))
expectType<Promise<IconNameTypesSummary>>(writeIconNameTypes('icons.ts', previewIcons, typesOptions))
expectError(writeIconNameTypes('icons.ts', previewIcons, { inputs: 'icons.json' }))
expectError(writeIconNameTypes('icons.ts', previewIcons, { dryRun: 'true' }))
expectError(renderIconNameTypes({ icons: {} }))

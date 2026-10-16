import type { FigmaImportNodeData } from '@iconify/tools/lib/import/figma/types/nodes'
import type { FigmaNamingManifest, FigmaNamingMapping, FigmaNamingPlan, FigmaNamingPreflightResult, FigmaSourceConfig, FigmaNamingNode as RootNode, FigmaNamingOptions as RootOptions, FigmaNameTransform as RootTransform, SyncResult } from '..'
import type { FigmaNameTransform, FigmaNamingNode, FigmaNamingOptions, FigmaNamingParentNode, IconNameOptions } from '../src/naming'
import { expectAssignable, expectError, expectType } from 'tsd'
import { defineConfig, preflightFigmaNaming, resolveConfig } from '..'
import { defaultIconNameForNode, shouldSkipName, toIconName } from '../src/naming'

declare const importedNode: FigmaImportNodeData
expectAssignable<FigmaNamingNode>(importedNode)
expectType<string | null>(defaultIconNameForNode(importedNode))
const parent: FigmaNamingParentNode = { id: '1:1', name: 'Icons', type: 'CANVAS' }
const node: FigmaNamingNode = { id: '2:1', name: 'Bell', type: 'COMPONENT', parents: [parent] as const }
expectType<string | null>(defaultIconNameForNode(node))
expectType<string>(toIconName('HTTPServer'))
expectType<boolean>(shouldSkipName('_hidden'))
const filter: IconNameOptions = { skipPrefix: ['_'] }
expectType<string | null>(defaultIconNameForNode(node, filter))
const transform: FigmaNameTransform = (name, namingNode) => namingNode.type === 'FRAME' ? null : `${name}-${namingNode.id}`
const options: FigmaNamingOptions = { duplicates: 'suffix-node-id', preserveNames: true, namespace: 'system', transform }
expectAssignable<RootNode>(node)
expectAssignable<RootTransform>(transform)
expectAssignable<RootOptions>(options)
expectAssignable<FigmaNamingOptions>({ duplicates: 'error' })
expectError(defaultIconNameForNode({ id: '1:1', name: 'Bell', type: 'COMPONENT' }))
expectError<FigmaNamingOptions>({ duplicates: 'ignore' })
expectError<FigmaNamingOptions>({ preserveNames: 'true' })
expectError<FigmaNamingOptions>({ transform: () => undefined })

const source: FigmaSourceConfig = { type: 'figma', file: 'fixture', naming: options }
const resolved = resolveConfig(defineConfig({ prefix: 'brand', namingManifest: 'names.json', sources: [source] }))
expectType<Promise<FigmaNamingPreflightResult>>(preflightFigmaNaming({ config: resolved }))
expectError(defineConfig({ prefix: 'brand', sources: [{ type: 'figma', file: 'fixture', naming: { duplicates: 'skip' } }] }))
expectError(defineConfig({ prefix: 'brand', namingManifest: false, sources: [source] }))
declare const result: SyncResult
expectType<FigmaNamingPlan[] | undefined>(result.naming)
declare const plan: FigmaNamingPlan
expectType<FigmaNamingMapping[]>(plan.mappings)
expectType<number>(plan.sourceIndex)
expectType<string>(plan.namespace)
const manifest: FigmaNamingManifest = { version: 1, sources: {} }
expectType<1>(manifest.version)

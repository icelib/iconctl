import type { IconifyCacheEntry, IconifyCacheReport, InspectIconifyCacheOptions } from '..'
import { expectError, expectType } from 'tsd'
import { inspectIconifyCache } from '..'

const options: InspectIconifyCacheOptions = { cwd: '.', cacheDir: '.cache', url: 'https://example.com/icons.json' }
expectType<Promise<IconifyCacheReport>>(inspectIconifyCache(options))
expectType<Promise<IconifyCacheReport>>(inspectIconifyCache())
declare const report: IconifyCacheReport
expectType<IconifyCacheEntry[]>(report.entries)
expectType<number>(report.missing)
expectError(report.entries[0]!.body)
expectError(inspectIconifyCache({ url: true }))

import type { inspectComponents } from '..'
import { expectAssignable, expectType } from 'tsd'
import { inspectComponent, toIconName } from '..'

expectType<string>(toIconName('Arrow Left'))

const legacy = { id: '1:1', name: 'Arrow', iconName: 'arrow', skipped: false, width: 24, height: 24, issues: ['Old host issue'] }
expectAssignable<ReturnType<typeof inspectComponent>>(legacy)
expectAssignable<ReturnType<typeof inspectComponents>>([legacy])
const result = inspectComponent({ id: '1:1', name: 'Arrow', type: 'COMPONENT', width: 24, height: 24 })
expectType<string[]>(result.issues)
expectType<{ code: string, message: string }[] | undefined>(result.diagnostics)
expectAssignable<ReturnType<typeof inspectComponent>>({ ...legacy, diagnostics: [{ code: 'future-check', message: 'Old host issue' }] })

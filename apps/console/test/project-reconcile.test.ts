import type { ProjectInput } from '@iconctl/console-contracts'
import { expect, it } from 'vitest'
import { applyProjectReconciliation, prepareProjectReconciliation, projectInputSignature, projectValueEqual } from '../src/features/projects/project-reconcile'

const base: ProjectInput = {
  name: 'icons',
  repository: 'owner/repo',
  prefix: 'brand',
  packageName: '@owner/icons',
  sources: [{ type: 'directory', dir: 'raw' }],
  color: 'currentColor',
  validate: { skipPrefix: ['_', '.'] },
  output: { svg: true, types: true, preview: true, changelog: true },
}

it('compares object keys independent of order while keeping arrays ordered', () => {
  expect(projectValueEqual({ width: 24, height: 24 }, { height: 24, width: 24 })).toBe(true)
  expect(projectValueEqual({ skipPrefix: ['_', '.'] }, { skipPrefix: ['.', '_'] })).toBe(false)
  expect(projectValueEqual(undefined, {})).toBe(false)
  expect(projectInputSignature({ ...base, output: { changelog: true, preview: true, types: true, svg: true } }))
    .toBe(projectInputSignature(base))
})

it('prepares nine atomic groups and applies independent changes without treating the result as saved', () => {
  const local = { ...base, prefix: 'local', validate: { skipPrefix: ['_', '.', 'local'] } }
  const server = { ...base, packageName: '@owner/server', validate: { skipPrefix: ['_', '.', 'server'] } }
  const result = prepareProjectReconciliation(base, local, server, 1, 2)
  expect(result.fields).toHaveLength(9)
  expect(result.fields.find(field => field.key === 'prefix')).toMatchObject({ localChanged: true, serverChanged: false, conflict: false })
  expect(result.fields.find(field => field.key === 'packageName')).toMatchObject({ localChanged: false, serverChanged: true, conflict: false })
  expect(result.fields.find(field => field.key === 'validate')).toMatchObject({ conflict: true })
  expect(applyProjectReconciliation(result, {})).toBeUndefined()
  const merged = applyProjectReconciliation(result, { validate: 'local' })!
  expect(merged.prefix).toBe('local')
  expect(merged.packageName).toBe('@owner/server')
  expect(merged.validate.skipPrefix).toEqual(['_', '.', 'local'])
  expect(projectInputSignature(merged)).not.toBe(projectInputSignature(server))
})

it('keeps advancedConfig absence distinct from an empty object', () => {
  const result = prepareProjectReconciliation(base, base, { ...base, advancedConfig: { path: 'iconctl.config.ts', commit: 'a'.repeat(40) } }, 1, 2)
  const field = result.fields.find(item => item.key === 'advancedConfig')!
  expect(field.serverChanged).toBe(true)
  expect(field.conflict).toBe(false)
  expect(applyProjectReconciliation(result, {})).toMatchObject({ advancedConfig: { path: 'iconctl.config.ts' } })
})

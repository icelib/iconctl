import { describe, expect, it } from 'vitest'
import { iconDiff, nextVersion, projectInput, safePath } from '../src'

describe('console contracts', () => {
  it('uses stable semantic versions and starts at 0.1.0', () => {
    expect(nextVersion(undefined, 'major')).toBe('0.1.0')
    expect(nextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(nextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(nextVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(() => nextVersion('1.2.3-beta.1', 'patch')).toThrow()
  })
  it('compares inherited dimensions and reports removals', () => {
    const before = {
      prefix: 'test',
      width: 24,
      icons: {
        arrow: { body: '<path/>', width: 24 },
        removed: { body: '<circle/>' },
      },
    }
    expect(
      iconDiff(before, {
        prefix: 'test',
        width: 24,
        icons: { arrow: { body: '<path/>' }, added: { body: '<rect/>' } },
      }),
    ).toEqual({ added: ['added'], removed: ['removed'], changed: [] })
    expect(
      iconDiff(before, {
        ...before,
        width: 16,
        icons: { arrow: { body: '<path/>' } },
      }).changed,
    ).toEqual(['arrow'])
  })
  it('rejects embedded secrets, unsafe paths and arbitrary network targets', () => {
    expect(() => safePath.parse('../credentials')).toThrow()
    expect(() =>
      projectInput.parse({
        name: 'icons',
        prefix: 'icons',
        packageName: '@test/icons',
        repository: 'owner/repo',
        sources: [
          {
            type: 'figma',
            file: 'file',
            connection: crypto.randomUUID(),
            token: 'secret',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      projectInput.parse({
        name: 'icons',
        prefix: 'icons',
        packageName: '@test/icons',
        repository: 'owner/repo',
        sources: [{ type: 'iconfont', url: 'https://127.0.0.1/internal' }],
      }),
    ).toThrow()
  })
})

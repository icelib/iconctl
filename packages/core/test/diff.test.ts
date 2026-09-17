import { diffIconSets } from '../src/diff'

describe('diffIconSets', () => {
  it('reports added removed and changed icons', () => {
    const diff = diffIconSets(
      {
        prefix: 'brand',
        icons: {
          'arrow-left': { body: '<path d="old"/>' },
          'user': { body: '<path d="user"/>' },
        },
      },
      {
        prefix: 'brand',
        icons: {
          'arrow-left': { body: '<path d="new"/>' },
          'arrow-right': { body: '<path d="right"/>' },
        },
      },
    )

    expect(diff.added).toEqual(['arrow-right'])
    expect(diff.removed).toEqual(['user'])
    expect(diff.changed).toEqual(['arrow-left'])
  })
})

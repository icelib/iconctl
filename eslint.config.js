import { defineEslintConfig } from 'repoctl/tooling'

export default await defineEslintConfig(
  {},
  {
    ignores: ['**/*.md', '**/fixtures/**', 'packages/icons/icons.json', 'packages/icons/preview.html', 'packages/icons/svg/**'],
  },
)

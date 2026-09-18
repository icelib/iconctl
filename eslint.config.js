import { defineEslintConfig } from 'repoctl/tooling'

export default await defineEslintConfig(
  {},
  {
    ignores: [
      '**/*.md',
      '**/fixtures/**',
      'packages/icons/icons.json',
      'packages/icons/preview.html',
      'packages/icons/svg/**',
      'examples/app-json/src/icons.json',
      'examples/app-json/preview.html',
    ],
  },
)

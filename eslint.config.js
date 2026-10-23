import { defineEslintConfig } from 'repoctl/tooling'

export default await defineEslintConfig({ cwd: import.meta.dirname })

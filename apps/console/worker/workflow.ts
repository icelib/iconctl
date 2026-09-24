import { commit, WORKFLOW } from '@iconctl/console-contracts'

export function runnerWorkflow(
  origin: string,
  repository: string,
  executorCommit: string,
): string {
  commit.parse(executorCommit)
  if (
    !/^https:\/\/[a-z0-9.-]+$/.test(origin)
    || !/^[\w.-]+\/[\w.-]+$/.test(repository)
  ) {
    throw new Error('Invalid executor configuration')
  }
  return `# Managed by iconctl console. Reinstall from the console when the executor changes.
name: iconctl console
run-name: iconctl-\${{ inputs.job }}-\${{ inputs.attempt }}
on:
  workflow_dispatch:
    inputs:
      job:
        required: true
        type: string
      attempt:
        required: true
        type: string
      operation:
        required: true
        type: choice
        options: [sync, check, preview, dry-run, publish]
permissions:
  contents: read
  id-token: write
concurrency:
  group: iconctl-console
  cancel-in-progress: false
jobs:
  execute:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          repository: ${repository}
          ref: ${executorCommit}
          path: executor
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
        with:
          package_json_file: executor/package.json
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - name: Build pinned executor
        working-directory: executor
        env:
          HUSKY: 0
        run: |
          pnpm install --frozen-lockfile
          pnpm exec turbo run build --filter=@iconctl/console-runner...
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          path: project
          persist-credentials: false
          fetch-depth: 0
      - name: Execute immutable job
        env:
          ICONCTL_CONSOLE_ORIGIN: ${origin}
          ICONCTL_JOB_ID: \${{ inputs.job }}
          ICONCTL_OPERATION: \${{ inputs.operation }}
          NPM_BOOTSTRAP_TOKEN: \${{ inputs.operation == 'publish' && secrets.NPM_BOOTSTRAP_TOKEN || '' }}
        run: node executor/apps/console-runner/dist/cli.mjs
`
}
export { WORKFLOW }

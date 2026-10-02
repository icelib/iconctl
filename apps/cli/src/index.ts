export { runCli } from './program'
export {
  check,
  compareIconSets,
  defineConfig,
  diffIconSets,
  IconctlAbortError,
  IconctlError,
  IconctlSyncError,
  loadConfig,
  parseFigmaFileKey,
  renderDiffHtml,
  resolveConfig,
  sync,
  writeDiffHtml,
} from '@iconctl/core'
export type {
  IconComparisonEntry,
  IconctlConfig,
  IconDiff,
  IconSetComparison,
  SourceConfig,
  SyncIssue,
  SyncOptions,
  SyncResult,
  WriteDiffHtmlOptions,
} from '@iconctl/core'

import type { ResolvedIconctlConfig } from '../../src/config'
import type { WatchSession } from '../../src/watch-session'
import { loadConfigDetails } from '../../src/load-config'
import { sync } from '../../src/sync'
import { watchInputDescriptor } from '../../src/watch-paths'

/** Keep deterministic state-machine gates; package consumers exercise real workers. */
export function createWatchSession(cwd: string): WatchSession {
  let config: ResolvedIconctlConfig
  return {
    async load(options, onConfigFile, onConfigRead) {
      const loaded = await loadConfigDetails(options, true, onConfigFile, onConfigRead)
      config = loaded.config
      return { input: watchInputDescriptor(config), files: loaded.files, entryFile: loaded.entryFile, configReadSnapshot: loaded.configReadSnapshot }
    },
    async sync(options) {
      return await sync({ cwd, config, ...options })
    },
    async close() {},
  }
}

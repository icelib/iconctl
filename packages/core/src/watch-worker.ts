import type { ResolvedIconctlConfig } from './config'
import type { WatchRequest, WatchResponse } from './watch-protocol'
import process from 'node:process'
import { parentPort, workerData } from 'node:worker_threads'
import { IconctlError } from './errors'
import { loadConfigDetails } from './load-config'
import { sync } from './sync'
import { watchInputDescriptor } from './watch-paths'
import { packWatchFailure, unpackWatchFailure } from './watch-protocol'

const port = parentPort!
const { cwd, argv } = workerData as { cwd: string, argv: string[] }
process.argv.splice(0, process.argv.length, ...argv)
let config: ResolvedIconctlConfig | undefined
let active: { id: number, controller: AbortController } | undefined
const send = (message: WatchResponse) => port.postMessage(message)

port.on('message', (message: WatchRequest) => {
  if (message.type === 'abort') {
    if (active?.id === message.id) {
      active.controller.abort(unpackWatchFailure(message.reason))
    }
    return
  }
  if (active) {
    send({ id: message.id, type: 'error', error: packWatchFailure(new IconctlError('Watch configuration worker received overlapping requests.')) })
    return
  }
  const controller = new AbortController()
  active = { id: message.id, controller }
  const execute = async () => {
    if (message.type === 'load') {
      config = undefined
      const loaded = await loadConfigDetails(message.options, true, file => send({ id: message.id, type: 'config-file', file }), snapshot => send({ id: message.id, type: 'config-snapshot', snapshot }))
      config = loaded.config
      send({ id: message.id, type: 'loaded', value: { input: watchInputDescriptor(config), files: loaded.files, entryFile: loaded.entryFile, configReadSnapshot: loaded.configReadSnapshot } })
    }
    else {
      if (!config) {
        throw new IconctlError('Watch configuration worker has no loaded configuration.')
      }
      const result = await sync({
        cwd,
        config,
        signal: controller.signal,
        ...(message.dryRun !== undefined ? { dryRun: message.dryRun } : {}),
        ...(message.continueOnError !== undefined ? { continueOnError: message.continueOnError } : {}),
      })
      send({ id: message.id, type: 'result', value: result })
    }
  }
  void execute().catch((error: unknown) => {
    send({ id: message.id, type: 'error', error: packWatchFailure(error) })
  }).finally(() => {
    active = undefined
  })
})

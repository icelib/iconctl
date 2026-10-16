import type { FigmaAuthInspection, FigmaAuthOptions, InspectFigmaAuthOptions, RequestOptions, SerializedIconctlError, SyncProgressEvent, SyncProgressHandler, SyncProgressStage } from '..'
import { expectError, expectType } from 'tsd'
import { IconctlError, inspectFigmaAuth, resolveConfig, serializeIconctlError, sync } from '..'
import { refreshFigmaCredentials } from '../src/figma/oauth'

const config = resolveConfig({ prefix: 'brand', sources: [{ type: 'directory', dir: 'raw' }] })
const requests: RequestOptions = { requestTimeoutMs: 1000, oauthTimeoutMs: 2000 }
const auth: FigmaAuthOptions = { ...requests, signal: new AbortController().signal }
const inspect: InspectFigmaAuthOptions = { ...auth, env: {}, verify: true, file: 'file123456789' }
expectType<Promise<FigmaAuthInspection>>(inspectFigmaAuth(inspect))
expectType<SerializedIconctlError>(serializeIconctlError(new IconctlError('failed', { code: 'TEST', httpStatus: 429, retryable: true, retryAfterMs: 1000 }), { secrets: ['private'] }))
const onProgress: SyncProgressHandler = async (event) => {
  expectType<SyncProgressEvent>(event)
  expectType<SyncProgressStage>(event.stage)
  expectType<number | undefined>(event.completed)
  expectType<number | undefined>(event.total)
  expectError(event.stage = 'complete')
}
sync({ config, ...requests, onProgress })
refreshFigmaCredentials({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, auth)
expectError(sync({ config, requestTimeoutMs: '1000' }))
expectError(inspectFigmaAuth({ verify: 'yes' }))
expectError(serializeIconctlError(new Error('failed'), { secrets: [123] }))

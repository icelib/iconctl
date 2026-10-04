import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rm } from 'node:fs/promises'
import process from 'node:process'
import { synchronize } from '../../../console-runner/dist/index.mjs'

const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
const requests = []
const client = {
  async request(path, body) {
    const response = await fetch(`${input.origin}/api/runner/${input.job.id}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    requests.push({ path, status: response.status, mime: response.headers.get('content-type'), digest: response.headers.get('x-content-sha256') })
    if (!response.ok) {
      throw new Error(`Runner HTTP ${response.status}: ${await response.text()}`)
    }
    return response
  },
  async json(path, body) { return (await this.request(path, body)).json() },
}
const tree = (await promisify(execFile)('git', ['ls-tree', '-r', '--name-only', input.job.sourceCommit], { cwd: input.repository })).stdout.trim().split('\n')
if (tree.some(path => path.endsWith('.json')) || tree.length !== 1 || tree[0] !== 'README.md') {
  throw new Error('Fixture Git repository unexpectedly contains an icon source')
}
let outcome
try {
  await mkdir(input.work, { recursive: true })
  const job = await client.json('claim', { operation: 'sync' })
  await synchronize(job, client, input.repository, input.work)
  outcome = { succeeded: true }
}
catch (error) { outcome = { succeeded: false, error: error.message } }
finally { await rm(input.work, { recursive: true, force: true }) }
process.stdout.write(`${JSON.stringify({ ...outcome, requests, gitTree: tree, sourceCommit: input.job.sourceCommit, workRemoved: true })}\n`)

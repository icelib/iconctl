import { execFile } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { checkReleaseIntent, isReleaseBranch } from './packages.mjs'

const exec = promisify(execFile)

export async function checkGitReleaseIntent({ base, head, branch = '' }) {
  if (isReleaseBranch(branch)) {
    return { packages: [], missing: [], skipped: true }
  }
  for (const commit of [base, head]) {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit ?? '')) {
      throw new Error('Release intent check requires full base and head commit SHAs')
    }
    await exec('git', ['cat-file', '-e', `${commit}^{commit}`])
  }
  const { stdout } = await exec('git', ['diff', '--name-status', '--no-renames', '-z', base, head, '--'], { maxBuffer: 16 * 1024 * 1024 })
  const parts = stdout.split('\0')
  const files = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    files.push({ filename: parts[index + 1], status: parts[index] === 'D' ? 'removed' : 'modified' })
  }
  return checkReleaseIntent(files, async (filename) => {
    try {
      return (await exec('git', ['show', `${head}:${filename}`], { maxBuffer: 4 * 1024 * 1024 })).stdout
    }
    catch (error) {
      if (error.code === 128 && /does not exist in|exists on disk, but not in/.test(error.stderr ?? '')) {
        return undefined
      }
      throw error
    }
  })
}

async function main() {
  const report = await checkGitReleaseIntent({ base: process.env.RELEASE_BASE_SHA, head: process.env.RELEASE_HEAD_SHA, branch: process.env.RELEASE_HEAD_REF })
  if (report.missing.length) {
    process.stderr.write(`Missing release intents for: ${report.missing.join(', ')}. Run pnpm change and include each package in .changeset/*.md.\n`)
    process.exitCode = 1
  }
  else {
    const message = report.skipped ? 'Generated release PR; skipping intent validation.' : report.packages.length ? `Release intents cover: ${report.packages.join(', ')}.` : 'No publishable package changes detected.'
    process.stdout.write(`${message}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}

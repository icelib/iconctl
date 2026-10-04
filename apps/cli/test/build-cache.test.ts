import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../..', import.meta.url))
const packages = ['apps/cli', 'apps/console', 'apps/console-runner', 'apps/website', 'packages/core', 'packages/console-contracts', 'packages/figma-plugin', 'packages/icons']
const configs = ['apps/cli', 'apps/console', 'apps/website', 'packages/figma-plugin'].map(directory => `${directory}/turbo.json`)
const websiteTasks = ['@iconctl/website#build', '@iconctl/website#typecheck', '@iconctl/console#build', '@iconctl/console#typecheck']
const consoleTasks = ['@iconctl/console#build', '@iconctl/console#typecheck']
const probes = [
  ['apps/website/quick-start.md', websiteTasks],
  ['apps/website/.vitepress/config.ts', websiteTasks],
  ['apps/website/.vitepress/theme/Layout.vue', websiteTasks],
  ['apps/website/public/robots.txt', websiteTasks],
  ['packages/icons/icons.json', websiteTasks],
  ['packages/icons/CHANGELOG.md', websiteTasks],
  ['packages/figma-plugin/scripts/inline-ui.mjs', ['@iconctl/figma-plugin#build', ...consoleTasks]],
  ['apps/console/index.html', consoleTasks],
  ['apps/console/scripts/assemble.mjs', consoleTasks],
  ['apps/console/e2e/console.spec.ts', consoleTasks],
  ['apps/console/vitest.worker.config.ts', consoleTasks],
  ['apps/cli/dev/index.ts', ['iconctl#typecheck']],
] as const

describe('workspace build-cache inputs', () => {
  let directory: string
  let fixture: string
  let baseline: Record<string, string>
  const originals = new Map<string, string>()
  let env: NodeJS.ProcessEnv

  async function hashes() {
    // Only ask the actual Turbo engine to hash; never execute fixture tasks.
    // The installed binary is read-only, and cache/daemon state stays isolated.
    const { stdout } = await exec(process.execPath, [
      join(root, 'node_modules/turbo/bin/turbo'),
      'run',
      'build',
      'typecheck',
      '--filter=@iconctl/console...',
      '--filter=iconctl',
      '--dry=json',
      '--no-daemon',
      '--cache=local:rw',
      `--cache-dir=${join(directory, 'cache')}`,
    ], { cwd: fixture, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
    const report = JSON.parse(stdout) as { tasks: { taskId: string, hash: string }[] }
    return Object.fromEntries(report.tasks.map(task => [task.taskId, task.hash]))
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iconctl-cache-contract-'))
    fixture = join(directory, 'workspace')
    await mkdir(fixture)
    env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }
    for (const key of ['TURBO_TOKEN', 'TURBO_TEAM', 'TURBO_REMOTE_CACHE_SIGNATURE_KEY', 'TURBO_CACHE_DIR', 'TURBO_FORCE']) {
      delete env[key]
    }
    // Use the real package graph and configuration, with only representative
    // tracked inputs. No source outputs, node_modules or user cache are copied.
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', '.gitignore', 'apps/console/.gitignore', 'apps/website/.gitignore', ...packages.map(path => `${path}/package.json`), ...configs]) {
      await mkdir(dirname(join(fixture, file)), { recursive: true })
      await copyFile(join(root, file), join(fixture, file))
    }
    for (const [file] of probes) {
      const contents = await readFile(join(root, file), 'utf8')
      originals.set(file, contents)
      await mkdir(dirname(join(fixture, file)), { recursive: true })
      await writeFile(join(fixture, file), contents)
    }
    await exec('git', ['init', '--quiet'], { cwd: fixture, env })
    await exec('git', ['add', '.'], { cwd: fixture, env })
    baseline = await hashes()
  }, 30000)

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(probes)('invalidates real task hashes when %s changes', async (file, tasks) => {
    const original = originals.get(file)!
    try {
      await writeFile(join(fixture, file), `${original}\ncache-input-change\n`)
      const changed = await hashes()
      for (const task of tasks) {
        expect(baseline[task], task).toBeTruthy()
        expect(changed[task], task).toBeTruthy()
        expect(changed[task], `${file} must invalidate ${task}`).not.toBe(baseline[task])
      }
    }
    finally {
      await writeFile(join(fixture, file), original)
    }
  })

  it('keeps hashes stable for unchanged inputs and ignored generated files', async () => {
    expect(await hashes()).toEqual(baseline)
    for (const file of [
      'apps/website/.vitepress/dist/probe.html',
      'apps/website/.vitepress/cache/probe.json',
      'apps/console/dist/public/probe.html',
      'apps/console/worker-configuration.d.ts',
      'apps/console/.wrangler/probe.json',
      'packages/figma-plugin/dist/ui.html',
      'apps/cli/dist/cli.mjs',
      'apps/cli/node_modules/.tmp/probe',
    ]) {
      const target = resolve(fixture, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'generated-cache-probe')
    }
    expect(await hashes()).toEqual(baseline)
  })
})

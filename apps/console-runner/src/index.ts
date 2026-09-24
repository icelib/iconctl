import type { Job, SnapshotContent, Source } from '@iconctl/console-contracts'
import type { FigmaAuth, IconctlConfig, SourceConfig } from '@iconctl/core'
import type { RunnerApi } from './client'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { commit, identifier, snapshotInput } from '@iconctl/console-contracts'
import { loadConfig, resolveConfig, sync } from '@iconctl/core'
import { RunnerClient } from './client'
import {
  collectFiles,
  extractSvgArchive,
  integrity,
  resolveInside,
  sha256,
  validateDirectory,
} from './files'

const exec = promisify(execFile)
interface SourceMapping {
  source: Source
  config: SourceConfig
}
async function sourcesFor(
  job: Job,
  client: RunnerApi,
  root: string,
  work: string,
): Promise<SourceMapping[]> {
  const result: SourceMapping[] = []
  for (const [index, source] of job.project.sources.entries()) {
    if (source.type === 'figma') {
      result.push({
        source,
        config: {
          type: 'figma',
          file: source.file,
          depth: source.depth,
          ...(source.pages?.length ? { pages: source.pages } : {}),
          ...(source.ids?.length ? { ids: source.ids } : {}),
        },
      })
    }
    else if (source.type === 'mastergo') {
      const token = await client.json<{ accessToken: string }>('credentials', {
        connectionId: source.connection,
      })
      result.push({
        source,
        config: {
          type: 'mastergo',
          fileId: source.fileId,
          layerId: source.layerId,
          token: token.accessToken,
        },
      })
    }
    else if (source.type === 'iconfont') {
      result.push({
        source,
        config: {
          type: 'iconfont',
          url: source.url,
          stripPrefix: source.stripPrefix,
        },
      })
    }
    else {
      let directory: string
      if (source.upload) {
        const response = await client.request(`uploads/${source.upload}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (sha256(bytes) !== response.headers.get('X-Content-SHA256')) {
          throw new Error('Upload digest mismatch')
        }
        const target = join(work, `upload-${index}`)
        await extractSvgArchive(bytes, target)
        directory
          = source.dir === 'svg'
            ? target
            : await validateDirectory(target, source.dir)
      }
      else {
        directory = await validateDirectory(root, source.dir)
      }
      result.push({ source, config: { type: source.type, dir: directory } })
    }
  }
  return result
}
export async function synchronize(
  job: Job,
  client: RunnerApi,
  repository: string,
  work: string,
) {
  // User code runs only here, never in the publishing path or with an npm secret.
  delete process.env['NPM_BOOTSTRAP_TOKEN']
  delete process.env['NODE_AUTH_TOKEN']
  commit.parse(job.sourceCommit)
  await exec('git', ['checkout', '--detach', job.sourceCommit], {
    cwd: repository,
  })
  const actual = await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })
  if (actual.stdout.trim() !== job.sourceCommit) {
    throw new Error('Source checkout does not match task')
  }
  await client.json('progress', { stage: 'fetching' })
  const mappings = await sourcesFor(job, client, repository, work)
  const output = join(work, 'output')
  await mkdir(output, { recursive: true })
  if (job.project.snapshotId) {
    const previous = await client.json<SnapshotContent>(
      `snapshot/${job.project.snapshotId}`,
    )
    await writeFile(join(output, 'icons.json'), JSON.stringify(previous.json))
    if (previous.files['CHANGELOG.md']) {
      await writeFile(
        join(output, 'CHANGELOG.md'),
        Buffer.from(previous.files['CHANGELOG.md'], 'base64'),
      )
    }
  }
  const config: IconctlConfig = {
    prefix: job.project.prefix,
    sources: mappings.map(item => item.config),
    color: job.project.color,
    validate: {
      skipPrefix: job.project.validate.skipPrefix,
      ...(job.project.validate.width
        ? { width: job.project.validate.width }
        : {}),
      ...(job.project.validate.height
        ? { height: job.project.validate.height }
        : {}),
      ...(job.project.validate.name ? { name: job.project.validate.name } : {}),
    },
    cacheDir: join(work, 'cache'),
    output: {
      json: join(output, 'icons.json'),
      ...(job.project.output.svg ? { svg: join(output, 'svg') } : {}),
      ...(job.project.output.types
        ? { types: join(output, 'index.d.ts') }
        : {}),
      ...(job.project.output.preview
        ? { preview: join(output, 'preview.html') }
        : {}),
      ...(job.project.output.changelog
        ? { changelog: join(output, 'CHANGELOG.md') }
        : {}),
    },
  }
  if (job.project.advancedConfig) {
    const advanced = await loadConfig({
      cwd: repository,
      configFile: resolveInside(repository, job.project.advancedConfig.path),
    })
    // The advanced configuration provides only the code-valued naming hook. Paths,
    // credentials, sources, package identity and output remain bound to the job.
    for (const [index, source] of config.sources.entries()) {
      const other = advanced.sources[index]
      if (
        source.type === 'figma'
        && other?.type === 'figma'
        && other.iconNameForNode
      ) {
        source.iconNameForNode = other.iconNameForNode
      }
    }
  }
  const providers = new Map<string, FigmaAuth>()
  const result = await sync({
    cwd: repository,
    config: resolveConfig(config),
    env: {},
    continueOnError: true,
    dryRun: job.operation === 'dry-run' || job.operation === 'check',
    async figmaAuthProvider(_source, sourceIndex) {
      const binding
        = sourceIndex === undefined ? undefined : mappings[sourceIndex]?.source
      if (!binding || binding.type !== 'figma') {
        throw new Error('Figma source was not bound to a connection')
      }
      let provider = providers.get(binding.connection)
      if (!provider) {
        let current: { accessToken: string, expiresAt: number } | undefined
        provider = {
          kind: 'oauth',
          cacheIdentity: binding.connection,
          async token(rejectedToken) {
            if (
              !current
              || current.expiresAt < Date.now() + 300_000
              || rejectedToken === current.accessToken
            ) {
              current = await client.json('credentials', {
                connectionId: binding.connection,
                ...(rejectedToken ? { rejectedToken } : {}),
              })
            }
            return current!.accessToken
          },
        }
        providers.set(binding.connection, provider)
      }
      return provider
    },
  })
  await client.json('progress', { stage: 'validating' })
  const files
    = job.operation === 'dry-run' || job.operation === 'check'
      ? {}
      : await collectFiles(output)
  const content = snapshotInput.parse({
    json: result.json,
    files,
    issues: result.issues,
    failed: result.failed,
    sources: result.sources,
  })
  await client.json('snapshot', content)
  if (content.issues.length || content.failed.length) {
    throw new Error('Icon validation failed')
  }
}
export async function packageSnapshot(
  job: Job,
  content: SnapshotContent,
  directory: string,
) {
  if (!job.release) {
    throw new Error('Release confirmation is required')
  }
  await mkdir(directory, { recursive: true })
  for (const [name, value] of Object.entries(content.files)) {
    if (
      !/^(?:icons\.json|index\.d\.ts|preview\.html|CHANGELOG\.md|svg\/[a-z0-9-]+\.svg)$/.test(
        name,
      )
    ) {
      throw new Error('Unexpected snapshot file')
    }
    const path = resolveInside(directory, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(value, 'base64'))
  }
  // Normalise JSON to the exact validated snapshot, preserving no fetched state.
  await writeFile(join(directory, 'icons.json'), JSON.stringify(content.json))
  const manifest = {
    name: job.project.packageName,
    version: job.release.version,
    description: `Iconify icons: ${job.project.prefix}`,
    license: 'MIT',
    ...(content.files['index.d.ts'] ? { types: './index.d.ts' } : {}),
    main: './icons.json',
    exports: {
      '.': './icons.json',
      './icons.json': './icons.json',
      './package.json': './package.json',
    },
    files: Object.keys(content.files),
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
      tag: 'latest',
    },
    repository: {
      type: 'git',
      url: `https://github.com/${job.project.repository}.git`,
    },
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(manifest, null, 2),
  )
  const files = await collectFiles(directory)
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: directory,
    env: { ...process.env, NODE_AUTH_TOKEN: '', NPM_BOOTSTRAP_TOKEN: '' },
  })
  const [pack] = JSON.parse(packed.stdout) as { filename: string }[]
  if (!pack) {
    throw new Error('npm pack produced no package')
  }
  const tarball = await readFile(resolveInside(directory, pack.filename))
  return { files, tarball, integrity: integrity(tarball) }
}
async function publish(job: Job, client: RunnerApi, work: string) {
  if (!job.release) {
    throw new Error('Release confirmation is required')
  }
  await client.json('progress', { stage: 'packing' })
  let tarball: Buffer
  let expected: string
  if (job.integrity) {
    const response = await client.request('release/tarball')
    tarball = Buffer.from(await response.arrayBuffer())
    expected = job.integrity
    const content = await client.json<SnapshotContent>(
      `snapshot/${job.release.snapshotId}`,
    )
    if (sha256(JSON.stringify(content)) !== job.release.digest) {
      throw new Error('Confirmed snapshot digest mismatch')
    }
    const packed = await packageSnapshot(job, content, join(work, 'package'))
    await client.json('release/prepare', {
      files: packed.files,
      tarball: tarball.toString('base64'),
      integrity: expected,
    })
  }
  else {
    const content = await client.json<SnapshotContent>(
      `snapshot/${job.release.snapshotId}`,
    )
    if (sha256(JSON.stringify(content)) !== job.release.digest) {
      throw new Error('Confirmed snapshot digest mismatch')
    }
    const packed = await packageSnapshot(job, content, join(work, 'package'))
    expected = packed.integrity
    tarball = packed.tarball
    await client.json('release/prepare', {
      files: packed.files,
      tarball: tarball.toString('base64'),
      integrity: expected,
    })
  }
  if (integrity(tarball) !== expected) {
    throw new Error('Stored tarball integrity mismatch')
  }
  const complete = await client.json<{ completed: boolean }>(
    'release/complete',
    {},
  )
  if (complete.completed) {
    return
  }
  // Registry conflicts are checked before npm publish. A successful lost callback
  // is completed without attempting to publish an existing version again.
  const registry = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(job.project.packageName)}/${job.release.version}`,
    { signal: AbortSignal.timeout(15_000) },
  )
  if (registry.status !== 404) {
    throw new Error('Version is already present or registry is unavailable')
  }
  const path = join(work, 'package.tgz')
  await writeFile(path, tarball)
  await client.json('release/authorize', {})
  const token = process.env['NPM_BOOTSTRAP_TOKEN']
  const npmrc = join(work, '.npmrc')
  if (token) {
    await writeFile(
      npmrc,
      // npm expands this reference at publish time; the file contains no token.
      '//registry.npmjs.org/:_authToken=' + '$' + '{NODE_AUTH_TOKEN}\n',
      { mode: 0o600 },
    )
  }
  try {
    await exec(
      'npm',
      [
        'publish',
        path,
        '--access',
        'public',
        '--tag',
        'latest',
        '--ignore-scripts',
        ...(token ? [] : ['--provenance']),
      ],
      {
        cwd: work,
        timeout: 120_000,
        env: {
          ...process.env,
          NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
          NPM_CONFIG_USERCONFIG: npmrc,
          NODE_AUTH_TOKEN: token ?? '',
        },
      },
    )
  }
  finally {
    await rm(npmrc, { force: true })
  }
  await client.json('release/complete', {})
}
export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/reconnect|authorization|credentials|HTTP 401/i.test(message)) {
    return 'authorization'
  }
  if (/HTTP 403|permission|scope/i.test(message)) {
    return 'permissions'
  }
  if (/HTTP 429|rate limit/i.test(message)) {
    return 'rate-limit'
  }
  if (/validation|Invalid width|Invalid height/i.test(message)) {
    return 'validation'
  }
  if (
    /HTTP 409|mismatch|conflict|already present|branch changed/i.test(message)
  ) {
    return 'conflict'
  }
  if (/config|directory|source|ZIP|path|HTTP 400|HTTP 503/i.test(message)) {
    return 'configuration'
  }
  return 'runner'
}

export async function run() {
  const origin = process.env['ICONCTL_CONSOLE_ORIGIN']
  if (!origin) {
    throw new Error('Missing console origin')
  }
  const id = identifier.parse(process.env['ICONCTL_JOB_ID'])
  const client = new RunnerClient(origin, id)
  const job = await client.json<Job>('claim', {
    operation: process.env['ICONCTL_OPERATION'],
  })
  const work = await mkdtemp(join(tmpdir(), 'iconctl-runner-'))
  try {
    if (job.operation === 'publish') {
      await publish(job, client, work)
    }
    else {
      await synchronize(job, client, resolve('project'), work)
    }
  }
  catch (error) {
    // Raw exceptions may contain SVG text, provider responses or credentials.
    await client
      .json('failure', { category: classifyFailure(error) })
      .catch(() => undefined)
    throw new Error(
      `Task ${id} failed; inspect the console task stage and validation results`,
    )
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

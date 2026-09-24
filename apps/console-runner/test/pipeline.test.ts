import type { Job, SnapshotContent } from '@iconctl/console-contracts'
import type { RunnerApi } from '../src/client'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { projectInput } from '@iconctl/console-contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { integrity } from '../src/files'
import { packageSnapshot, synchronize } from '../src/index'

const exec = promisify(execFile)
const svg
  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M3 10l9-7 9 7v10H3z"/></svg>'
afterEach(() => vi.unstubAllGlobals())
it('runs all five sources through outputs and packs only the confirmed snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iconctl-pipeline-'))
  try {
    const repository = join(root, 'repo')
    const work = join(root, 'work')
    await mkdir(join(repository, 'raw'), { recursive: true })
    await mkdir(join(repository, 'jsdesign'), { recursive: true })
    await mkdir(work)
    await writeFile(join(repository, 'raw/local.svg'), svg)
    await writeFile(join(repository, 'jsdesign/design.svg'), svg)
    await exec('git', ['init', '--quiet'], { cwd: repository })
    await exec('git', ['add', '.'], { cwd: repository })
    await exec(
      'git',
      [
        '-c',
        'user.name=Iconctl Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: repository },
    )
    const sourceCommit = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim()
    const figma = crypto.randomUUID()
    const mastergo = crypto.randomUUID()
    const config = projectInput.parse({
      name: 'test',
      prefix: 'test',
      packageName: '@test/icons',
      repository: 'owner/repo',
      sources: [
        { type: 'directory', dir: 'raw' },
        { type: 'jsdesign', dir: 'jsdesign' },
        { type: 'figma', file: 'AbCdEfGhIjKlMnOpQrStUv', connection: figma },
        { type: 'mastergo', fileId: '1', layerId: '1:1', connection: mastergo },
        { type: 'iconfont', url: 'https://at.alicdn.com/t/test.js' },
      ],
    })
    const project = {
      ...config,
      id: crypto.randomUUID(),
      revision: 1,
      createdAt: Date.now(),
      repositoryInfo: { id: 1, installationId: 1, defaultBranch: 'main' },
    }
    const job: Job = {
      id: crypto.randomUUID(),
      projectId: project.id,
      project,
      operation: 'sync',
      status: 'running',
      sourceCommit,
      executorCommit: sourceCommit,
      workflowCommit: sourceCommit,
      workflowDigest: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dispatchAttempts: 1,
      attempt: 1,
      stage: 'claimed',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit) => {
        const url = new URL(input)
        if (url.hostname === 'api.figma.com') {
          expect(new Headers(init.headers).get('Authorization')).toBe(
            'Bearer figma-access',
          )
          if (url.pathname.includes('/files/')) {
            return Response.json({
              editorType: 'figma',
              version: 'v1',
              lastModified: '2026-09-24',
              document: {
                id: '0:0',
                name: 'Document',
                type: 'DOCUMENT',
                children: [
                  {
                    id: '0:1',
                    name: 'Icons',
                    type: 'CANVAS',
                    children: [
                      {
                        id: '1:1',
                        name: 'figma',
                        type: 'COMPONENT',
                        absoluteBoundingBox: {
                          width: 24,
                          height: 24,
                          x: 0,
                          y: 0,
                        },
                        children: [],
                      },
                    ],
                  },
                ],
              },
            })
          }
          return Response.json({
            images: { '1:1': 'https://cdn.example.com/figma.svg' },
          })
        }
        if (url.hostname === 'cdn.example.com') {
          expect(init.headers).toBeUndefined()
          return new Response(svg)
        }
        if (url.hostname === 'mastergo.com') {
          return Response.json({
            totalCount: 1,
            count: 1,
            hasMore: false,
            svgs: [{ id: '1:1', name: 'mastergo', svg }],
          })
        }
        if (url.hostname === 'at.alicdn.com') {
          return new Response(
            '<svg><symbol id="icon-font" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol></svg>',
          )
        }
        throw new Error('Unexpected network request')
      }),
    )
    let snapshot: SnapshotContent | undefined
    const client: RunnerApi = {
      request: async () => {
        throw new Error('Unexpected binary request')
      },
      async json<T>(path: string, body?: unknown): Promise<T> {
        if (path === 'credentials') {
          return {
            accessToken:
              (body as { connectionId: string }).connectionId === figma
                ? 'figma-access'
                : 'mastergo-access',
            expiresAt: Date.now() + 3600_000,
          } as T
        }
        if (path === 'snapshot') {
          snapshot = body as SnapshotContent
        }
        return {} as T
      },
    }
    await synchronize(job, client, repository, work)
    expect(Object.keys(snapshot!.json.icons).sort()).toEqual([
      'design',
      'figma',
      'font',
      'local',
      'mastergo',
    ])
    expect(snapshot!.issues).toEqual([])
    expect(Object.keys(snapshot!.files)).toEqual(
      expect.arrayContaining([
        'icons.json',
        'index.d.ts',
        'preview.html',
        'CHANGELOG.md',
        'svg/figma.svg',
      ]),
    )
    expect(JSON.stringify(snapshot)).not.toMatch(
      /figma-access|mastergo-access/,
    )
    const releaseJob: Job = {
      ...job,
      operation: 'publish',
      release: {
        snapshotId: job.id,
        digest: 'snapshot-digest',
        version: '0.1.0',
        branchHead: null,
        confirmation: crypto.randomUUID(),
      },
    }
    const packed = await packageSnapshot(
      releaseJob,
      snapshot!,
      join(root, 'package'),
    )
    expect(integrity(packed.tarball)).toBe(packed.integrity)
    const manifest = JSON.parse(
      Buffer.from(packed.files['package.json']!, 'base64').toString(),
    )
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.scripts).toBeUndefined()
    expect(
      JSON.parse(await readFile(join(root, 'package/icons.json'), 'utf8')),
    ).toEqual(snapshot!.json)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
// This test runs directly with Node, outside the workspace Vitest projects.
// eslint-disable-next-line test/no-import-node-test
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const websiteRoot = fileURLToPath(new URL('../', import.meta.url))

test('preview and stable builds isolate banners, indexing and console links', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'iconctl-docs-channels-'))
  const read = name => readFile(path.join(outDir, name), 'utf8')
  try {
    for (const channel of ['preview', 'stable']) {
      await exec('pnpm', ['exec', 'vitepress', 'build', '--outDir', outDir], {
        cwd: websiteRoot,
        env: {
          ...process.env,
          REPO_DOCS_CHANNEL: channel,
          REPO_DOCS_URL: channel === 'preview' ? 'https://preview.example.com' : 'https://iconctl.icebreaker.top',
        },
        maxBuffer: 10 * 1024 * 1024,
      })
      const english = await read('index.html')
      const chinese = await read('zh/index.html')
      const robots = await read('robots.txt')
      if (channel === 'preview') {
        assert.match(english, /Preview docs · Unreleased changes/)
        assert.match(english, /href="https:\/\/iconctl\.icebreaker\.top\/"[^>]*>View stable docs/)
        assert.match(chinese, /预览文档 · 尚未正式发布/)
        assert.match(chinese, /href="https:\/\/iconctl\.icebreaker\.top\/zh\/"[^>]*>查看正式文档/)
        assert.match(english, /name="robots" content="noindex, nofollow"/)
        assert.match(chinese, /name="robots" content="noindex, nofollow"/)
        assert.equal(robots, 'User-agent: *\nDisallow: /\n')
        assert.match(await read('_headers'), /X-Robots-Tag: noindex, nofollow/)
        await assert.rejects(read('sitemap.xml'), { code: 'ENOENT' })
      }
      else {
        assert.doesNotMatch(english, /Preview docs · Unreleased changes|noindex, nofollow/)
        assert.doesNotMatch(chinese, /预览文档 · 尚未正式发布|noindex, nofollow/)
        assert.match(robots, /Allow: \/\n/)
        assert.match(robots, /Sitemap: https:\/\/iconctl\.icebreaker\.top\/sitemap.xml/)
        assert.match(await read('sitemap.xml'), /https:\/\/iconctl\.icebreaker\.top\//)
        await assert.rejects(read('_headers'), { code: 'ENOENT' })
      }
      assert.match(await read('console.html'), /href="https:\/\/iconctl\.icebreaker\.top\/app\/"[^>]*>production console/)
      assert.match(await read('zh/console.html'), /href="https:\/\/iconctl\.icebreaker\.top\/app\/"[^>]*>打开正式控制台/)
      for (const name of ['app', 'api', 'login.html']) {
        await assert.rejects(read(name), { code: 'ENOENT' })
      }
    }
  }
  finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

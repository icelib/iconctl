import { generateKeyPairSync } from 'node:crypto'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          GITHUB_APP_ID: 'test-app',
          GITHUB_CLIENT_ID: 'test-client',
          GITHUB_CLIENT_SECRET: 'test-secret',
          GITHUB_PRIVATE_KEY: generateKeyPairSync('rsa', {
            modulusLength: 2048,
          })
            .privateKey
            .export({ type: 'pkcs8', format: 'pem' })
            .toString(),
          GITHUB_WEBHOOK_SECRET: 'webhook-test',
          FIGMA_CLIENT_ID: 'figma-test',
          FIGMA_CLIENT_SECRET: 'figma-secret',
          CREDENTIAL_ENCRYPTION_KEY:
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          EXECUTOR_COMMIT: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})

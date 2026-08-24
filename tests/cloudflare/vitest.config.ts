import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const d1Migrations = await readD1Migrations(
  fileURLToPath(new URL('../../packages/migrations/sql', import.meta.url)),
)

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL('./worker.ts', import.meta.url)),
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          REALTIME_TICKET_SECRET: 'integration-test-only-secret',
          LIVE_LOG_TEST_FAULT_INJECTION: 'enabled',
        },
        d1Databases: ['DB'],
        r2Buckets: ['BACKUPS'],
        durableObjects: {
          ORGANIZATION_EVENTS: {
            className: 'OrganizationEventsDO',
            useSQLite: true,
          },
          LIVE_LOG_STREAM: {
            className: 'LiveLogStreamDO',
            useSQLite: true,
          },
        },
      },
    }),
  ],
  root: repositoryRoot,
  test: {
    include: ['tests/cloudflare/**/*.integration.ts'],
    provide: {
      gridoraD1Migrations: d1Migrations,
    },
  },
})

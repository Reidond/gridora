/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { LiveLogStreamDO, OrganizationEventsDO } from '../../workers/realtime/src/index.js'

declare module 'vitest' {
  export interface ProvidedContext {
    readonly gridoraD1Migrations: ReadonlyArray<D1Migration>
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      readonly DB: D1Database
      readonly BACKUPS: R2Bucket
      readonly LIVE_LOG_TEST_FAULT_INJECTION: 'enabled'
      readonly ORGANIZATION_EVENTS: DurableObjectNamespace<OrganizationEventsDO>
      readonly LIVE_LOG_STREAM: DurableObjectNamespace<LiveLogStreamDO>
    }
  }
}

export {}

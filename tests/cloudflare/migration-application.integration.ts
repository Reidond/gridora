/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { describe, expect, inject, it } from 'vitest'

describe('complete Gridora D1 migration catalog in the Workers runtime', () => {
  it('applies the node runtime lifecycle receipt guards on Cloudflare D1', async () => {
    for (const migration of inject('gridoraD1Migrations')) {
      try {
        await applyD1Migrations(env.DB, [migration])
      } catch (cause) {
        throw new Error(`Cloudflare D1 rejected migration ${migration.name}`, { cause })
      }
    }

    const intentTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'node_runtime_lifecycle_intents'`,
    ).first<{ readonly name: string }>()
    const coreGuard = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'node_runtime_lifecycle_intent_atomic_guard'`,
    ).first<{ readonly name: string }>()
    const providerGuard = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name = 'node_runtime_lifecycle_intent_provider_snapshot_guard'`,
    ).first<{ readonly name: string }>()

    expect(intentTable).toEqual({ name: 'node_runtime_lifecycle_intents' })
    expect(coreGuard).toEqual({ name: 'node_runtime_lifecycle_intent_atomic_guard' })
    expect(providerGuard).toEqual({ name: 'node_runtime_lifecycle_intent_provider_snapshot_guard' })
  })
})

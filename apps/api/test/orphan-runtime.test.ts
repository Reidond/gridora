import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrphanD1Database, OrphanD1Statement } from '@gridora/orphan-d1'
import { makeOrphanAccountLoader } from '../src/orphan-runtime.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrationFiles = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
  '0004_provider_account_credentials.sql',
  '0005_registration_policy_audit.sql',
  '0006_lifecycle_reservations.sql',
  '0007_audit_export_outbox.sql',
  '0008_tunnel_credential_delivery.sql',
  '0009_orphan_findings.sql',
  '0010_backup_wrapped_keys.sql',
  '0011_provider_account_lifecycle.sql',
  '0012_node_provision_acceptance.sql',
  '0013_server_plan.sql',
  '0014_agent_observation_ingestion.sql',
  '0015_node_provision_execution_lease.sql',
  '0016_platform_provider_control.sql',
  '0017_game_server_lifecycle_execution.sql',
  '0018_backup_orchestration.sql',
  '0019_destructive_lifecycle_termination.sql',
  '0020_logs_health_aggregates.sql',
  '0021_scheduled_orphan_reconciliation.sql',
] as const

class SqliteStatement implements OrphanD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): OrphanD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.statement.all(...(this.values as ReadonlyArray<SQLInputValue>)) }
  }
}

class SqliteD1 implements OrphanD1Database {
  constructor(readonly database: DatabaseSync) {}
  prepare(sql: string): OrphanD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
  async batch(): Promise<ReadonlyArray<unknown>> {
    throw new Error('account-loader tests do not write')
  }
}

let database: DatabaseSync
let load: ReturnType<typeof makeOrphanAccountLoader>

const seedOrganization = (id: string, slug: string) => {
  database
    .prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, 'now')`)
    .run(id, id, slug)
}

const allocate = (organizationId: string, accountId: string) =>
  database
    .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
       max_active_nodes, status, revision)
      VALUES (?, ?, '["eu-west"]', '["small"]', 10, 'active', 1)`)
    .run(organizationId, accountId)

describe('orphan runtime account allocation', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const file of migrationFiles) database.exec(readFileSync(`${sqlDirectory}${file}`, 'utf8'))
    seedOrganization('org-a', 'organization-a')
    seedOrganization('org-b', 'organization-b')
    load = makeOrphanAccountLoader(new SqliteD1(database))
  })

  afterEach(() => database.close())

  it('loads a platform account only through the exact active tenant allocation', async () => {
    database
      .prepare(`INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference,
         status, revision, created_at, updated_at)
        VALUES ('platform-a', 'platform', NULL, 'ovhcloud', 'platform-secret-a',
         'active', 4, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO platform_secret_envelopes
        (id, scope_type, scope_id, ciphertext, wrapped_data_key,
         key_version, revision, created_at, rotated_at)
        VALUES ('platform-secret-a', 'provider-account', 'platform-a',
         'ciphertext', 'wrapped', 1, 1, 'now', NULL)`)
      .run()
    allocate('org-a', 'platform-a')

    await expect(
      Effect.runPromise(
        load({
          organizationId: 'org-a',
          providerAccountId: 'platform-a',
          providerType: 'ovhcloud',
        }),
      ),
    ).resolves.toMatchObject({
      id: 'platform-a',
      scope: 'platform',
      organizationId: 'org-a',
      accountOrganizationId: null,
      credentialReference: 'platform-secret-a',
      credentialRevision: 1,
    })

    await expect(
      Effect.runPromise(
        load({
          organizationId: 'org-b',
          providerAccountId: 'platform-a',
          providerType: 'ovhcloud',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })

  it('loads an organization account only with its exact envelope and allocation', async () => {
    database
      .prepare(`INSERT INTO secret_envelopes
        (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
         key_version, revision, created_at, rotated_at)
        VALUES ('org-a', 'organization-secret-a', 'provider-account', 'organization-a',
         'ciphertext', 'wrapped', 1, 3, 'now', NULL)`)
      .run()
    database
      .prepare(`INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference,
         status, revision, created_at, updated_at)
        VALUES ('organization-a', 'organization', 'org-a', 'contabo',
         'organization-secret-a', 'active', 7, 'now', 'now')`)
      .run()
    allocate('org-a', 'organization-a')

    await expect(
      Effect.runPromise(
        load({
          organizationId: 'org-a',
          providerAccountId: 'organization-a',
          providerType: 'contabo',
        }),
      ),
    ).resolves.toMatchObject({
      scope: 'organization',
      organizationId: 'org-a',
      accountOrganizationId: 'org-a',
      credentialRevision: 3,
    })

    await expect(
      Effect.runPromise(
        load({
          organizationId: 'org-a',
          providerAccountId: 'organization-a',
          providerType: 'ovhcloud',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/index.js'

const sqlDirectory = fileURLToPath(new URL('../sql/', import.meta.url))
let database: DatabaseSync

const applyMigrations = () => {
  for (const migration of migrations)
    database.exec(readFileSync(`${sqlDirectory}${migration.file}`, 'utf8'))
}

const seedTenant = (organizationId: string, slug: string, identityId: string) => {
  database
    .prepare(`INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(
      identityId,
      `access-${identityId}`,
      `${identityId}@example.com`,
      identityId,
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:00:00.000Z',
    )
  database
    .prepare(`INSERT INTO organizations
    (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
    VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'organization', 1, 1, ?)`)
    .run(organizationId, organizationId, slug, '2026-08-23T10:00:00.000Z')
}

describe('MVP D1 schema', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    applyMigrations()
  })
  afterEach(() => database.close())

  it('applies every migration with foreign keys enabled', () => {
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    expect(tables).toContainEqual({ name: 'nodes' })
    expect(tables).toContainEqual({ name: 'game_servers' })
    expect(tables).toContainEqual({ name: 'secret_envelopes' })
    expect(tables).toContainEqual({ name: 'automation_identities' })
    expect(tables).toContainEqual({ name: 'organization_membership_leave_receipts' })
    expect(tables).toContainEqual({ name: 'audit_event_envelopes' })
    expect(tables).toContainEqual({ name: 'audit_envelope_staging' })
    expect(tables).toContainEqual({ name: 'platform_operations' })
    expect(tables).toContainEqual({ name: 'platform_audit_export_outbox' })
    expect(tables).toContainEqual({ name: 'organization_terms_acceptances' })
    expect(tables).toContainEqual({ name: 'node_registration_tokens' })
    expect(tables).toContainEqual({ name: 'node_credentials' })
    expect(tables).toContainEqual({ name: 'orphan_findings' })
    expect(tables).toContainEqual({ name: 'orphan_reconciliation_runs' })
    expect(tables).toContainEqual({ name: 'game_mod_metadata_acceptances' })
    expect(tables).toContainEqual({ name: 'backup_wrapped_keys' })
    expect(tables).toContainEqual({ name: 'provider_account_action_idempotency' })
    expect(tables).toContainEqual({ name: 'server_plugin_channels' })
    expect(tables).toContainEqual({ name: 'node_runtime_capacity' })
    expect(tables).toContainEqual({ name: 'server_capacity_reservations' })
    expect(tables).toContainEqual({ name: 'server_create_reservations' })
    expect(tables).toContainEqual({ name: 'agent_observation_streams' })
    expect(tables).toContainEqual({ name: 'agent_observation_aggregates' })
    expect(tables).toContainEqual({ name: 'node_provision_execution_leases' })
    expect(tables).toContainEqual({ name: 'node_provision_registration_bindings' })
    expect(tables).toContainEqual({ name: 'platform_administrators' })
    expect(tables).toContainEqual({ name: 'platform_secret_envelopes' })
    expect(tables).toContainEqual({ name: 'platform_provider_mutations' })
    expect(tables).toContainEqual({ name: 'platform_allocation_mutations' })
    const leaseGuards = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
        AND name IN (
          'provider_account_node_execution_lease_update_guard',
          'provider_envelope_node_execution_lease_update_guard',
          'node_provision_execution_lease_release_fence'
          ,'node_provision_registration_binding_insert_fence'
          ,'node_provision_registration_binding_update_fence'
        ) ORDER BY name`)
      .all()
    expect(leaseGuards).toEqual([
      { name: 'node_provision_execution_lease_release_fence' },
      { name: 'node_provision_registration_binding_insert_fence' },
      { name: 'node_provision_registration_binding_update_fence' },
      { name: 'provider_account_node_execution_lease_update_guard' },
      { name: 'provider_envelope_node_execution_lease_update_guard' },
    ])
  })

  it('keeps trigger assertions compatible with the remote D1 statement splitter', () => {
    for (const migration of migrations) {
      const sql = readFileSync(`${sqlDirectory}${migration.file}`, 'utf8')
      expect(sql, migration.file).not.toMatch(/RAISE\([^;\n]+\)\s+END;/)
    }
  })

  it('rejects a deployment that combines a server and node from different organizations', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    seedTenant('org-b', 'organization-b', 'identity-b')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, 'now', 'now'),
             ('provider-b', 'organization', 'org-b', 'ovhcloud', 'secret-b', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-b', 'provider-b', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-1', '1.0.0', 'sum', 'signature', '{}', 'promoted', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_type, region, plan, image_id, placement_mode,
       desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-b', 'node-b', 'provider-b', 'ovhcloud', 'eu-west', 'small', 'image-1', 'shared',
       'ready', 'ready', 1, 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
      .run()
    database
      .prepare(`INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'unknown', '{}', 1, 0, 1, 'now', 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO deployments
      (organization_id, id, server_id, node_id, desired_revision, observed_revision, observed_state, created_at, updated_at)
      VALUES ('org-a', 'deployment-a', 'server-a', 'node-b', 1, 0, 'unknown', 'now', 'now')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it("rejects a node using another organization's provider allocation", () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    seedTenant('org-b', 'organization-b', 'identity-b')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-b', 'organization', 'org-b', 'ovhcloud', 'secret-b', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-b', 'provider-b', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-1', '1.0.0', 'sum', 'signature', '{}', 'promoted', 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_type, region, plan, image_id, placement_mode,
       desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-b', 'ovhcloud', 'eu-west', 'small', 'image-1', 'shared',
       'ready', 'ready', 1, 1, 'now', 'now')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })

  it("rejects allocating another organization's provider account", () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    seedTenant('org-b', 'organization-b', 'identity-b')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-b', 'organization', 'org-b', 'ovhcloud', 'secret-b', 'active', 1, 'now', 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-b', '["eu-west"]', '["small"]', 2, 'active', 1)`)
        .run(),
    ).toThrow(/provider account scope mismatch/)
  })

  it('rejects a node whose driver type differs from its provider account', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-1', '1.0.0', 'sum', 'signature', '{}', 'promoted', 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_type, region, plan, image_id, placement_mode,
       desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-a', 'contabo', 'eu-west', 'small', 'image-1', 'shared',
       'ready', 'ready', 1, 1, 'now', 'now')`)
        .run(),
    ).toThrow(/node provider type mismatch/)
  })

  it('keeps the tenant scope and driver type immutable after provider allocation', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()

    expect(() =>
      database
        .prepare("UPDATE provider_accounts SET provider_type = 'contabo' WHERE id = 'provider-a'")
        .run(),
    ).toThrow(/allocated provider account identity is immutable/)
    expect(() =>
      database
        .prepare(
          "UPDATE provider_accounts SET scope = 'platform', organization_id = NULL WHERE id = 'provider-a'",
        )
        .run(),
    ).toThrow(/allocated provider account identity is immutable/)

    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-platform', 'platform', NULL, 'contabo', 'secret-platform', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-platform', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    expect(() =>
      database
        .prepare(
          "UPDATE provider_accounts SET scope = 'organization', organization_id = 'org-a' WHERE id = 'provider-platform'",
        )
        .run(),
    ).toThrow(/allocated provider account identity is immutable/)
  })

  it('binds a registration token to the exact node, provider instance, and operation', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-1', '1.0.0', 'sum', 'signature', '{}', 'promoted', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
       placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-a', 'instance-a', 'ovhcloud', 'eu-west', 'small', 'image-1',
       'shared', 'ready', 'ready', 1, 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-a', 'org-a', 'node.provision', 'node', 'node-a', 'identity-a', 'running', 50,
       'key-a', 'correlation-a', 1, 'now', 'now')`)
      .run()

    database
      .prepare(`INSERT INTO node_registration_tokens
      (token_hash, organization_id, node_id, provider_instance_id, operation_id, expires_at, issued_at)
      VALUES ('hash-a', 'org-a', 'node-a', 'instance-a', 'operation-a', 'tomorrow', 'now')`)
      .run()
    expect(() =>
      database
        .prepare(`INSERT INTO node_registration_tokens
      (token_hash, organization_id, node_id, provider_instance_id, operation_id, expires_at, issued_at)
      VALUES ('hash-b', 'org-a', 'node-a', 'foreign-instance', 'operation-a', 'tomorrow', 'now')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/)

    database
      .prepare(`INSERT INTO node_credentials
      (organization_id, node_id, id, credential_hash, version, status, issued_at)
      VALUES ('org-a', 'node-a', 'credential-a', 'credential-hash-a', 1, 'active', 'now')`)
      .run()
    expect(() =>
      database
        .prepare(`INSERT INTO node_credentials
      (organization_id, node_id, id, credential_hash, version, status, issued_at)
      VALUES ('org-a', 'node-a', 'credential-b', 'credential-hash-b', 2, 'active', 'now')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('reuses a released port but does not double-allocate a live port', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'secret-a', 'active', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO provider_allocations
      (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES ('org-a', 'provider-a', '["eu-west"]', '["small"]', 2, 'active', 1)`)
      .run()
    database
      .prepare(`INSERT INTO node_images
      (id, version, checksum, signature, provider_mappings_json, status, created_at)
      VALUES ('image-1', '1.0.0', 'sum', 'signature', '{}', 'promoted', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO nodes
      (organization_id, id, provider_account_id, provider_type, region, plan, image_id, placement_mode,
       desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES ('org-a', 'node-a', 'provider-a', 'ovhcloud', 'eu-west', 'small', 'image-1', 'shared',
       'ready', 'ready', 1, 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
      .run()
    database
      .prepare(`INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'unknown', '{}', 1, 0, 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES ('operation-a', 'org-a', 'server.create', 'server', 'server-a', 'identity-a', 'running', 50,
       'key-a', 'correlation-a', 1, 'now', 'now')`)
      .run()
    database
      .prepare(`INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port, state, operation_id, revision, created_at)
      VALUES ('org-a', 'lease-released', 'node-a', 'server-a', 'udp', 2001, 2001, 'released', 'operation-a', 1, 'now')`)
      .run()
    database
      .prepare(`INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port, state, operation_id, revision, created_at)
      VALUES ('org-a', 'lease-active', 'node-a', 'server-a', 'udp', 2001, 2001, 'active', 'operation-a', 1, 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO port_leases
      (organization_id, id, node_id, server_id, protocol, public_port, container_port, state, operation_id, revision, created_at)
      VALUES ('org-a', 'lease-duplicate', 'node-a', 'server-a', 'udp', 2001, 2001, 'reserved', 'operation-a', 1, 'now')`)
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('rejects backup keys outside the owning organization prefix', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`)
      .run()
    database
      .prepare(`INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '1.0.0', 'running', 'unknown', '{}', 1, 0, 1, 'now', 'now')`)
      .run()

    expect(() =>
      database
        .prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version, metadata_json, state, created_at)
      VALUES ('org-a', 'backup-a', 'server-a', 'organizations/org-b/backups/a', 'sum', 1, '{}', 'available', 'now')`)
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('rolls back a provider credential mutation that lacks strict operation and audit provenance', () => {
    seedTenant('org-a', 'organization-a', 'identity-a')
    database
      .prepare(`INSERT INTO secret_envelopes
      (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
       key_version, revision, created_at, rotated_at)
      VALUES ('org-a', 'provider-a.credentials', 'provider-account', 'provider-a',
       'cipher-v1', 'wrapped-v1', 1, 1, 'now', NULL)`)
      .run()
    database
      .prepare(`INSERT INTO provider_accounts
      (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES ('provider-a', 'organization', 'org-a', 'ovhcloud', 'provider-a.credentials',
       'active', 1, 'now', 'now')`)
      .run()

    expect(() =>
      database.exec(`
      BEGIN IMMEDIATE;
      UPDATE secret_envelopes SET ciphertext = 'cipher-v2', wrapped_data_key = 'wrapped-v2',
        revision = 2, rotated_at = 'later'
        WHERE organization_id = 'org-a' AND id = 'provider-a.credentials' AND revision = 1;
      INSERT INTO provider_account_mutation_idempotency
        (organization_id, idempotency_key, action, account_id, request_fingerprint,
         expected_revision, result_revision, expected_credential_revision,
         result_credential_revision, response_json, created_at)
        VALUES ('org-a', 'update-a', 'update-credentials', 'provider-a', 'fingerprint',
          1, 2, 1, 2, '{"id":"provider-a"}', 'later');
      COMMIT;
    `),
    ).toThrow(/provider account mutation requires exact v1 operation and audit provenance/)
    if (database.isTransaction) database.exec('ROLLBACK')

    expect(
      database
        .prepare(
          "SELECT ciphertext, revision FROM secret_envelopes WHERE organization_id = 'org-a' AND id = 'provider-a.credentials'",
        )
        .get(),
    ).toEqual({ ciphertext: 'cipher-v1', revision: 1 })
    expect(
      database
        .prepare(
          "SELECT revision FROM provider_accounts WHERE organization_id = 'org-a' AND id = 'provider-a'",
        )
        .get(),
    ).toEqual({ revision: 1 })
    expect(
      database.prepare('SELECT count(*) AS count FROM provider_account_mutation_idempotency').get(),
    ).toEqual({ count: 0 })
  })
})

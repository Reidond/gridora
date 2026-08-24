import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  makeNodeTerminationD1Repository,
  makeTerminationD1Repository,
  makeWorkflowStepD1Repository,
  type LifecycleTerminationD1Database,
  type LifecycleTerminationD1Statement,
} from '@gridora/lifecycle-termination-d1'
import {
  ProviderNotFoundError,
  ProviderTemporaryError,
  type ComputeProviderShape,
  type ProviderNode,
} from '@gridora/provider-sdk'
import {
  executeNodeTerminationWorkflowEffect,
  observeNodeTerminationWorkflowEffect,
  type NodeTerminationExecutionDependencies,
} from '../src/node-termination-execution-runtime.js'

const migrationDirectory = fileURLToPath(
  new URL('../../../packages/migrations/sql/', import.meta.url),
)
const acceptedAt = '2026-08-24T12:00:00.000Z'
let lastDatabaseError: unknown

class Statement implements LifecycleTerminationD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): Statement {
    return new Statement(this.database, this.sql, values)
  }
  async first<T = unknown>(): Promise<T | null> {
    return (
      (this.database.prepare(this.sql).get(...(this.values as SQLInputValue[])) as T | undefined) ??
      null
    )
  }
  async all<T = unknown>(): Promise<{ readonly results: ReadonlyArray<T> }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as SQLInputValue[])) as unknown as ReadonlyArray<T>,
    }
  }
  run() {
    const result = this.database.prepare(this.sql).run(...(this.values as SQLInputValue[]))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

const wrap = (database: DatabaseSync): LifecycleTerminationD1Database => ({
  prepare: (sql) => new Statement(database, sql),
  batch: async (statements) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const results = []
      for (const statement of statements) results.push((statement as Statement).run())
      database.exec('COMMIT')
      return results
    } catch (error) {
      lastDatabaseError = error
      if (database.isTransaction) database.exec('ROLLBACK')
      throw error
    }
  },
})

const auditRequestContext: AuditRequestContextValue = {
  origin: 'http',
  requestId: 'request-node-termination-runtime',
  correlationId: 'correlation-node-termination-runtime',
  source: {
    ip: { state: 'captured', value: '203.0.113.14' },
    access: {
      state: 'captured',
      value: {
        subject: 'access-owner-a',
        identityId: 'owner-a',
        issuer: 'https://team.cloudflareaccess.com',
        email: 'owner-a@example.test',
      },
    },
  },
}

const provider = (overrides: Partial<ComputeProviderShape>): ComputeProviderShape =>
  ({
    capabilities: {
      hourlyBilling: true,
      immediateDelete: true,
      scheduledCancellation: false,
      cloudInit: true,
      customImages: true,
      snapshots: true,
      nativeFirewall: true,
      privateNetworking: false,
      floatingIp: false,
      rebuild: true,
    },
    listRegions: () => Effect.succeed([]),
    listPlans: () => Effect.succeed([]),
    listImages: () => Effect.succeed([]),
    createNode: () => Effect.die('not used'),
    getNode: () => Effect.die('not configured'),
    listNodes: () => Effect.succeed([]),
    startNode: () => Effect.die('not used'),
    stopNode: () => Effect.die('not used'),
    rebootNode: () => Effect.die('not used'),
    rebuildNode: () => Effect.die('not configured'),
    retireNode: () => Effect.die('not configured'),
    createSnapshot: () => Effect.die('not used'),
    deleteSnapshot: () => Effect.die('not used'),
    applyFirewall: () => Effect.die('not used'),
    ...overrides,
  }) as ComputeProviderShape

const providerNode = (operationId: string): ProviderNode => ({
  id: 'provider-node-a',
  name: 'Gridora node A',
  state: 'active',
  regionId: 'eu-west',
  planId: 'small',
  addresses: ['192.0.2.20'],
  metadata: {
    managedBy: 'gridora',
    organizationId: 'org-a',
    nodeId: 'node-a',
    operationId,
    imageVersion: '2026.08.24',
  },
})

describe('production node termination execution runtime', () => {
  let database: DatabaseSync
  let d1: LifecycleTerminationD1Database
  let operationSequence = 0

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    lastDatabaseError = undefined
    for (const migration of readdirSync(migrationDirectory)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort())
      database.exec(readFileSync(`${migrationDirectory}${migration}`, 'utf8'))
    d1 = wrap(database)
    database.exec(`
      INSERT INTO identities
        (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner-a', 'access-owner-a', 'owner-a@example.test', 'Owner A', 'active',
          '${acceptedAt}', '${acceptedAt}');
      INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step,
         policy_revision, revision, created_at)
        VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu-west',
          'complete', 1, 1, '${acceptedAt}');
      INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, revision)
        VALUES ('org-a', 'owner-a', 'owner', 'active', '${acceptedAt}', 1);
      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status, revision,
         created_at, updated_at)
        VALUES ('platform-provider-a', 'platform', NULL, 'ovhcloud', 'platform-secret-a',
          'active', 1, '${acceptedAt}', '${acceptedAt}');
      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json,
         max_active_nodes, monthly_budget_minor, status, revision)
        VALUES ('org-a', 'platform-provider-a', '["eu-west"]', '["small"]', 5, NULL,
          'active', 1);
      INSERT INTO platform_secret_envelopes
        (id, scope_type, scope_id, ciphertext, wrapped_data_key, key_version, revision,
         created_at, rotated_at)
        VALUES ('platform-secret-a', 'provider-account', 'platform-provider-a', 'ciphertext-a',
          'wrapped-key-a', 1, 1, '${acceptedAt}', NULL);
      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
        VALUES
          ('image-current', '2026.08.23', 'sha256:${'a'.repeat(64)}', 'signature-current', '{}',
            'promoted', '${acceptedAt}', '${acceptedAt}'),
          ('image-target', '2026.08.24', 'sha256:${'b'.repeat(64)}', 'signature-target', '{}',
            'promoted', '${acceptedAt}', '${acceptedAt}');
      INSERT INTO node_image_lifecycle_records
        (image_id, source_commit, architecture, artifact_digest, manifest_digest, sbom_digest,
         build_log_digest, signature_evidence_json, scan_evidence_json, smoke_test_evidence_json,
         state, revision, legacy_unattested, created_at, updated_at, promoted_at,
         deprecated_at, revoked_at)
        VALUES ('image-target', '${'c'.repeat(40)}', 'amd64', 'sha256:${'b'.repeat(64)}',
          'sha256:${'d'.repeat(64)}', 'sha256:${'e'.repeat(64)}', 'sha256:${'f'.repeat(64)}',
          '{"verified":true}', '{"critical":0}', '{"passed":true}', 'promoted', 1, 0,
          '${acceptedAt}', '${acceptedAt}', '${acceptedAt}', NULL, NULL);
      INSERT INTO node_image_policy_scopes
        (id, provider_type, provider_account_id, region, architecture,
         allow_stock_ubuntu_cloud_init_fallback, promoted_image_id, last_known_good_image_id,
         revision, created_at, updated_at)
        VALUES ('scope-a', 'ovhcloud', 'platform-provider-a', 'eu-west', 'amd64', 0,
          'image-target', 'image-target', 1, '${acceptedAt}', '${acceptedAt}');
      INSERT INTO node_image_provider_registrations
        (id, image_id, scope_id, provider_type, provider_account_id, provider_account_revision,
         credential_reference, region, architecture, mode, provider_image_id,
         provider_request_id, cloud_init_template_digest, state, degraded_reason, revision,
         created_at, updated_at)
        VALUES ('registration-a', 'image-target', 'scope-a', 'ovhcloud', 'platform-provider-a',
          1, 'platform-secret-a', 'eu-west', 'amd64', 'custom-image', 'provider-image-target',
          'provider-registration-a', NULL, 'registered', NULL, 1, '${acceptedAt}', '${acceptedAt}');
      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region,
         plan, image_id, placement_mode, desired_state, observed_state, desired_revision,
         observed_revision, reconciliation_error, last_reconciled_at, created_at, updated_at)
        VALUES ('org-a', 'node-a', 'platform-provider-a', 'provider-node-a', 'ovhcloud',
          'eu-west', 'small', 'image-current', 'dedicated', 'ready', 'ready', 1, 1, NULL,
          '${acceptedAt}', '${acceptedAt}', '${acceptedAt}');
    `)
  })

  afterEach(() => database.close())

  const accept = async (action: 'rebuild-node' | 'retire-node') => {
    const operationId = `node-${action}-${++operationSequence}`
    const repository = makeTerminationD1Repository(d1, {
      now: () => acceptedAt,
      operationId: () => operationId,
      auditEventId: () => `audit-${operationId}`,
      outboxEventId: () => `outbox-${operationId}`,
      workflowStartRecordId: (id) => `start-${id}`,
      auditRequestContext,
    })
    const acceptance = await Effect.runPromise(
      repository.acceptNodeLifecycle(
        {
          organizationId: 'org-a',
          actorId: 'owner-a',
          role: 'owner',
          actorMembershipRevision: 1,
          correlationId: auditRequestContext.correlationId,
          idempotencyKey: `idempotency-${action}-${operationSequence}`,
          action,
          nodeId: 'node-a',
          expectedNodeRevision: 1,
          force: false,
          backupPolicy: 'skip-authorized',
          ...(action === 'rebuild-node' ? { targetImageId: 'image-target' } : {}),
        },
        action === 'rebuild-node' ? 'a'.repeat(64) : 'b'.repeat(64),
      ),
    )
    await Effect.runPromise(
      makeNodeTerminationD1Repository(d1).completeNodeDrain({
        organizationId: 'org-a',
        operationId,
        nodeId: 'node-a',
        now: acceptedAt,
      }),
    )
    return acceptance
  }

  const claim = async (
    operationId: string,
    workflowType: 'RebuildNodeWorkflow' | 'RetireNodeWorkflow',
    stepName: string,
    ordinal: number,
  ) => {
    const result = await Effect.runPromise(
      makeWorkflowStepD1Repository(d1).claimStep({
        organizationId: 'org-a',
        operationId,
        workflowType,
        workflowInstanceId: operationId,
        stepName,
        ordinal,
        destructive: true,
        claimId: `claim-${operationId}-${ordinal}`,
        leaseExpiresAt: '2026-08-24T12:10:00.000Z',
        now: acceptedAt,
      }),
    )
    if (result.lease === undefined) throw new Error('workflow step lease was not committed')
    return result.lease
  }

  it('rebuilds once, adopts provider response loss by observation, and emits strict machine audit evidence', async () => {
    const accepted = await accept('rebuild-node')
    const operationId = accepted.operation.id
    const lease = await claim(operationId, 'RebuildNodeWorkflow', 'rebuild-provider-instance', 2)
    let rebuildCalls = 0
    let observeCalls = 0
    const adapter = provider({
      rebuildNode: () => {
        rebuildCalls += 1
        return Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'rebuild',
            message: 'response lost after provider accepted rebuild',
          }),
        )
      },
      getNode: () => {
        observeCalls += 1
        return Effect.succeed(providerNode(operationId))
      },
    })
    const dependencies: NodeTerminationExecutionDependencies = {
      providers: {
        openExact: (target) => {
          expect(target).toMatchObject({
            organizationId: 'org-a',
            operationId,
            nodeId: 'node-a',
            providerNodeId: 'provider-node-a',
            credentialBinding: {
              providerAccountId: 'platform-provider-a',
              providerAccountRevision: 1,
              providerAllocationRevision: 1,
              providerCredentialReference: 'platform-secret-a',
              providerCredentialRevision: 1,
            },
          })
          return Effect.succeed({
            provider: adapter,
            capabilities: { start: true, stop: true, reboot: true, observe: true },
          })
        },
      },
      rebuildBootstrap: {
        registrationTokens: {
          hashFor: () => Effect.succeed({ keyVersion: 1, tokenHash: 'c'.repeat(64) }),
          recoverBytes: () => Effect.succeed(Uint8Array.from({ length: 32 }, (_, index) => index)),
        },
        trusted: {
          controlPlaneUrl: 'https://api.gridora.test',
          expectedControlPlaneHost: 'api.gridora.test',
          allowLoopbackHttp: false,
          agentVersion: '1.0.0',
          dockerSocket: '/var/run/docker.sock',
          pollWaitSeconds: 10,
          registrationTtlSeconds: 600,
          commandSigningPublicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
          providerInstanceDiscovery: {
            mode: 'image-metadata-helper-v1',
            helperUnit: 'gridora-node-bootstrap.service',
          },
        },
        cloudInit: {
          render: ({ registrationTokenBytes }) => {
            expect(registrationTokenBytes).toHaveLength(64)
            return Effect.succeed(new TextEncoder().encode('#cloud-config\n'))
          },
        },
      },
    }
    const envelope = {
      organizationId: 'org-a',
      operationId,
      workflowType: 'RebuildNodeWorkflow' as const,
      workflowInstanceId: operationId,
      stepName: 'rebuild-provider-instance',
      ordinal: 2,
      destructive: true,
    }

    const first = await Effect.runPromise(
      Effect.result(executeNodeTerminationWorkflowEffect(d1, envelope, lease, dependencies)),
    )
    if (first._tag === 'Failure')
      throw new Error(
        `${first.failure.code}: ${lastDatabaseError instanceof Error ? lastDatabaseError.message : String(lastDatabaseError)} ${JSON.stringify(
          database
            .prepare(`SELECT node.desired_state AS nodeState, node.desired_revision AS nodeRevision,
            node.pending_lifecycle_operation_id AS pending, run.state AS runState,
            run.target_image_id AS targetImageId, run.target_image_version_snapshot AS targetVersion,
            run.target_image_checksum_snapshot AS targetChecksum,
            run.target_provider_image_id AS providerImageId, facts.phase,
            facts.active_step_name AS stepName, facts.active_step_ordinal AS ordinal,
            operation.status, lifecycle.state AS lifecycleState
            FROM node_lifecycle_runs run
            JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
            JOIN operations operation ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
            JOIN destructive_lifecycle_operations lifecycle ON lifecycle.organization_id = run.organization_id AND lifecycle.operation_id = run.operation_id
            JOIN operation_cancellation_facts facts ON facts.organization_id = run.organization_id AND facts.operation_id = run.operation_id
            WHERE run.operation_id = ?`)
            .get(operationId),
        )}`,
      )
    expect(first.success).toMatchObject({ effectId: expect.stringContaining(operationId) })
    await expect(
      Effect.runPromise(executeNodeTerminationWorkflowEffect(d1, envelope, lease, dependencies)),
    ).resolves.toMatchObject({ effectId: expect.stringContaining(operationId) })
    expect(rebuildCalls).toBe(1)
    expect(observeCalls).toBe(2)
    await expect(
      Effect.runPromise(
        observeNodeTerminationWorkflowEffect(d1, { envelope, lease }, dependencies),
      ),
    ).resolves.toMatchObject({ state: 'applied' })
    expect(
      database
        .prepare(`SELECT state FROM node_lifecycle_rebuild_bootstraps
        WHERE organization_id = 'org-a' AND operation_id = ?`)
        .get(operationId),
    ).toEqual({ state: 'awaiting-agent' })
    const audit = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
      WHERE scope = 'tenant' AND event_id = ?`)
      .get(`termination-node-provider-rebuild-awaiting-agent:org-a:${operationId}:audit`) as {
      readonly envelope: string
    }
    expect(JSON.parse(audit.envelope)).toMatchObject({
      action: 'node.provider.rebuild.observed',
      result: 'succeeded',
      source: { origin: 'machine' },
      target: { type: 'node', id: 'node-a' },
    })
  })

  it('retires once after response loss, deletes only the exact tunnel, and finalizes terminal audit evidence', async () => {
    const accepted = await accept('retire-node')
    const operationId = accepted.operation.id
    database.exec(`
      INSERT INTO tunnels
        (organization_id, node_id, tunnel_id, hostname, state, credential_reference, revision)
        VALUES ('org-a', 'node-a', 'tunnel-a', 'node-a.example.test', 'connected',
          'tunnel-secret-a', 1);
      INSERT INTO node_credentials
        (organization_id, node_id, id, credential_hash, version, status, issued_at,
         last_used_at, revoked_at)
        VALUES ('org-a', 'node-a', 'credential-a', 'credential-hash-a', 1, 'active',
          '${acceptedAt}', NULL, NULL);
      INSERT INTO agent_sessions
        (organization_id, node_id, credential_id, session_version, agent_version, session_state,
         last_seen_at, revision)
        VALUES ('org-a', 'node-a', 'credential-a', 1, '1.0.0', 'connected', '${acceptedAt}', 1);
      INSERT INTO node_registration_tokens
        (token_hash, organization_id, node_id, provider_instance_id, operation_id, credential_id,
         expires_at, consumed_at, revoked_at, issued_at)
        VALUES ('retire-token-a', 'org-a', 'node-a', 'provider-node-a', '${operationId}',
          'credential-a', '2026-08-24T13:00:00.000Z', NULL, NULL, '${acceptedAt}');
    `)
    const localLease = {
      claimId: `local-${operationId}`,
      attempt: 1,
      expiresAt: '2026-08-24T12:10:00.000Z',
    }
    await Effect.runPromise(
      executeNodeTerminationWorkflowEffect(
        d1,
        {
          organizationId: 'org-a',
          operationId,
          workflowType: 'RetireNodeWorkflow',
          workflowInstanceId: operationId,
          stepName: 'revoke-node-credentials',
          ordinal: 2,
          destructive: false,
        },
        localLease,
      ),
    )
    const lease = await claim(operationId, 'RetireNodeWorkflow', 'delete-provider-instance', 3)
    let retireCalls = 0
    const adapter = provider({
      retireNode: () => {
        retireCalls += 1
        return Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'delete',
            message: 'response lost after delete',
          }),
        )
      },
      getNode: () =>
        Effect.fail(
          new ProviderNotFoundError({
            provider: 'ovhcloud',
            operation: 'get',
            message: 'provider instance no longer exists',
          }),
        ),
    })
    let deletedTunnel: string | undefined
    const dependencies: NodeTerminationExecutionDependencies = {
      providers: {
        openExact: () =>
          Effect.succeed({
            provider: adapter,
            capabilities: { start: true, stop: true, reboot: true, observe: true },
          }),
      },
      tunnels: {
        deleteExact: (target) =>
          Effect.sync(() => {
            deletedTunnel = target.tunnelId
            return { disposition: 'deleted' as const }
          }),
        observeExact: () => Effect.succeed('deleted'),
      },
    }
    const providerEnvelope = {
      organizationId: 'org-a',
      operationId,
      workflowType: 'RetireNodeWorkflow' as const,
      workflowInstanceId: operationId,
      stepName: 'delete-provider-instance',
      ordinal: 3,
      destructive: true,
    }
    await expect(
      Effect.runPromise(
        executeNodeTerminationWorkflowEffect(d1, providerEnvelope, lease, dependencies),
      ),
    ).resolves.toMatchObject({ effectId: expect.stringContaining(operationId) })
    await expect(
      Effect.runPromise(
        observeNodeTerminationWorkflowEffect(
          d1,
          { envelope: providerEnvelope, lease },
          dependencies,
        ),
      ),
    ).resolves.toMatchObject({ state: 'applied' })
    expect(retireCalls).toBe(1)
    await Effect.runPromise(
      executeNodeTerminationWorkflowEffect(
        d1,
        {
          organizationId: 'org-a',
          operationId,
          workflowType: 'RetireNodeWorkflow',
          workflowInstanceId: operationId,
          stepName: 'cleanup-networking',
          ordinal: 4,
          destructive: false,
        },
        localLease,
        dependencies,
      ),
    )
    expect(deletedTunnel).toBe('tunnel-a')
    expect(
      database.prepare(`SELECT status, progress FROM operations WHERE id = ?`).get(operationId),
    ).toEqual({ status: 'succeeded', progress: 100 })
    expect(
      database
        .prepare(`SELECT desired_state AS desiredState, observed_state AS observedState
        FROM nodes WHERE organization_id = 'org-a' AND id = 'node-a'`)
        .get(),
    ).toEqual({ desiredState: 'deleted', observedState: 'deleted' })
    const audit = database
      .prepare(`SELECT envelope_json AS envelope FROM audit_event_envelopes
      WHERE scope = 'tenant' AND event_id = ?`)
      .get(`termination-node-retirement-finalized:org-a:${operationId}:audit`) as {
      readonly envelope: string
    }
    expect(JSON.parse(audit.envelope)).toMatchObject({
      action: 'node.retirement.finalized',
      result: 'succeeded',
      source: { origin: 'machine' },
      target: { type: 'node', id: 'node-a' },
    })
  })
})

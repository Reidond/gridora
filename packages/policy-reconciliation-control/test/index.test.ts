import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  planPolicyReconciliation,
  PolicyReconciliationRequest,
  type PolicyReconciliationSnapshot,
} from '../src/index.js'

const now = new Date('2026-08-23T10:30:00.000Z')

const policy = (overrides: Partial<OrganizationPolicyV1> = {}): OrganizationPolicyV1 => ({
  schemaVersion: 1,
  organizationId: 'org-a',
  revision: 1,
  allowedProviders: ['ovhcloud'],
  allowedRegions: ['eu-west'],
  allowedPlans: ['small'],
  capacity: {
    maxActiveNodes: 10,
    maxDedicatedNodes: 5,
    maxServersPerNode: 8,
    maxDeploymentCpuMillis: 8_000,
    maxDeploymentRamBytes: 16_000,
    maxDeploymentDiskBytes: 100_000,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 10_000,
    hardLimitMinor: 20_000,
  },
  temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
  idle: { action: 'shutdown', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [{ dayOfWeekUtc: 0, startMinuteUtc: 600, durationMinutes: 120 }],
  updates: { automatic: 'security', requireMaintenanceWindow: true },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
  ...overrides,
})

const request = Schema.decodeUnknownSync(PolicyReconciliationRequest)({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  policyRevision: 1,
  scheduleSlot: '2026-08-23T10:30:00.000Z',
  runId: 'policy-run-a',
  idempotencyKey: 'policy-idempotency-a',
  leaseToken: 'policy-lease-a',
})

const snapshot = (
  overrides: Partial<PolicyReconciliationSnapshot> = {},
): PolicyReconciliationSnapshot => ({
  organizationId: 'org-a',
  actorId: 'policy-scheduler-a',
  policyRevision: 1,
  observedAt: now.toISOString(),
  policy: policy(),
  usage: {
    organizationId: 'org-a',
    observedAtEpochMilliseconds: now.getTime(),
    activeNodes: 1,
    dedicatedNodes: 0,
    serversByNode: {},
    estimatedCommittedMonthlyMinor: 0,
    currency: 'EUR',
  },
  nodes: [],
  servers: [],
  ...overrides,
})

describe('policy reconciliation planning', () => {
  it('plans only immutable, expired temporary nodes and keeps legacy NULL expiry non-actionable', async () => {
    const actions = await Effect.runPromise(
      planPolicyReconciliation(
        request,
        snapshot({
          nodes: [
            {
              organizationId: 'org-a',
              nodeId: 'node-expired',
              desiredRevision: 4,
              desiredState: 'ready',
              observedState: 'ready',
              temporaryExpiresAt: '2026-08-23T10:29:59.000Z',
            },
            {
              organizationId: 'org-a',
              nodeId: 'node-legacy',
              desiredRevision: 1,
              desiredState: 'ready',
              observedState: 'ready',
              temporaryExpiresAt: null,
            },
          ],
        }),
        now,
      ),
    )

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      resourceKind: 'node',
      resourceId: 'node-expired',
      resourceRevision: 4,
      kind: 'retire-node',
      resourceExpiresAt: '2026-08-23T10:29:59.000Z',
    })
  })

  it('requires fresh zero-player health evidence for idle shutdown and binds exact activity facts', async () => {
    const actions = await Effect.runPromise(
      planPolicyReconciliation(
        request,
        snapshot({
          servers: [
            {
              organizationId: 'org-a',
              serverId: 'server-idle',
              desiredRevision: 5,
              desiredState: 'running',
              observedState: 'running',
              activeConfigRevision: 2,
              desiredModRevision: 1,
              pendingLifecycleOperationId: null,
              lastActivityAt: '2026-08-23T09:00:00.000Z',
              healthSampledAt: '2026-08-23T10:29:00.000Z',
              healthRevision: 9,
              currentPlayerCount: 0,
              updateCandidate: null,
            },
            {
              organizationId: 'org-a',
              serverId: 'server-stale-health',
              desiredRevision: 1,
              desiredState: 'running',
              observedState: 'running',
              activeConfigRevision: 1,
              desiredModRevision: 0,
              pendingLifecycleOperationId: null,
              lastActivityAt: '2026-08-23T09:00:00.000Z',
              healthSampledAt: '2026-08-23T10:20:00.000Z',
              healthRevision: 2,
              currentPlayerCount: 0,
              updateCandidate: null,
            },
          ],
        }),
        now,
      ),
    )

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      resourceKind: 'server',
      resourceId: 'server-idle',
      kind: 'shutdown-server',
      activityLastAt: '2026-08-23T09:00:00.000Z',
      healthSampledAt: '2026-08-23T10:29:00.000Z',
      healthRevision: 9,
    })
  })

  it('permits reviewed security updates only inside the maintenance window and never combines them with idle work', async () => {
    const server = {
      organizationId: 'org-a',
      serverId: 'server-update',
      desiredRevision: 7,
      desiredState: 'running' as const,
      observedState: 'running' as const,
      activeConfigRevision: 3,
      desiredModRevision: 2,
      pendingLifecycleOperationId: null,
      lastActivityAt: null,
      healthSampledAt: null,
      healthRevision: null,
      currentPlayerCount: null,
      updateCandidate: {
        id: 'candidate-security',
        revision: 4,
        category: 'security' as const,
        targetVersion: '1.2.3',
      },
    }
    const inside = await Effect.runPromise(
      planPolicyReconciliation(request, snapshot({ servers: [server] }), now),
    )
    const outside = await Effect.runPromise(
      planPolicyReconciliation(
        request,
        snapshot({ servers: [server], observedAt: '2026-08-23T12:30:00.000Z' }),
        new Date('2026-08-23T12:30:00.000Z'),
      ),
    )

    expect(inside).toMatchObject([
      {
        resourceId: 'server-update',
        kind: 'update-server',
        updateCandidateId: 'candidate-security',
        updateCandidateRevision: 4,
      },
    ])
    expect(outside).toEqual([])
  })

  it('rejects a forged tenant snapshot before action planning', async () => {
    await expect(
      Effect.runPromise(
        planPolicyReconciliation(request, snapshot({ organizationId: 'org-b' }), now),
      ),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })
})

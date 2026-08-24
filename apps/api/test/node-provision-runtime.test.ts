import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeProvisionAcceptance } from '@gridora/node-provision-control'
import {
  makePlatformSecretEnvelope,
  type PlatformSecretRecord,
} from '@gridora/platform-secret-envelope'
import type { KekPortShape } from '@gridora/secret-envelope'
import {
  makeExactProviderCredentialPort,
  makeNodeProvisionWorkflowStarter,
  type NodeProvisionRuntimeDatabase,
} from '../src/node-provision-runtime.js'

const acceptance: NodeProvisionAcceptance = {
  disposition: 'created',
  organizationId: 'org-a',
  nodeId: 'node-a',
  operationId: 'op-a',
  idempotencyKey: 'node-create-a',
  fingerprint: 'a'.repeat(64),
  providerType: 'ovhcloud',
  placementMode: 'dedicated',
  billing: {
    providerType: 'ovhcloud',
    currency: 'EUR',
    estimatedMonthlyMinor: 1000,
    billingCadence: 'hourly',
    contractMonths: 1,
    committedMonthlyBeforeMinor: 0,
    projectedCommittedMonthlyMinor: 1000,
    warnings: [],
  },
  workflowStart: {
    id: 'workflow-start:op-a',
    state: 'pending',
    attempts: 0,
    lastError: null,
  },
}

const workflowRow = {
  actorId: 'identity-a',
  correlationId: 'corr-a',
  idempotencyKey: acceptance.idempotencyKey,
  resourceId: acceptance.nodeId,
  operationStatus: 'queued',
  operationType: 'provision-node',
  fingerprint: acceptance.fingerprint,
  workflowStartId: acceptance.workflowStart.id,
  workflowState: 'pending',
  startEventType: 'lifecycle.workflow-start.requested',
  startAggregateId: acceptance.operationId,
  eventOperationId: acceptance.operationId,
  eventWorkflowStartId: acceptance.workflowStart.id,
  eventResourceKind: 'node',
  eventResourceId: acceptance.nodeId,
  eventAction: 'provision-node',
}

const databaseReturning = (value: unknown): NodeProvisionRuntimeDatabase => ({
  prepare: () => ({
    bind() {
      return this
    },
    first: async () => value,
    all: async () => ({ results: [], meta: { changes: 0 } }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  }),
  batch: async () => [],
})

afterEach(() => vi.restoreAllMocks())

describe('node provision API runtime composition', () => {
  it('adopts an ambiguous Workflow create only after exact immutable ledger proof', async () => {
    let creates = 0
    let gets = 0
    const starter = makeNodeProvisionWorkflowStarter(databaseReturning(workflowRow), {
      create: async () => {
        creates += 1
        throw new Error('response lost')
      },
      get: async (id) => {
        gets += 1
        return { id }
      },
    })
    await expect(Effect.runPromise(starter.start(acceptance))).resolves.toBeUndefined()
    expect({ creates, gets }).toEqual({ creates: 1, gets: 1 })
  })

  it('does not create or adopt a Workflow when immutable ledger metadata is wrong', async () => {
    let calls = 0
    const starter = makeNodeProvisionWorkflowStarter(
      databaseReturning({ ...workflowRow, eventResourceId: 'node-foreign' }),
      {
        create: async () => {
          calls += 1
          return { id: acceptance.operationId }
        },
        get: async () => {
          calls += 1
          return { id: acceptance.operationId }
        },
      },
    )
    await expect(Effect.runPromise(starter.start(acceptance))).rejects.toMatchObject({
      _tag: 'NodeProvisionWorkflowStartError',
    })
    expect(calls).toBe(0)
  })

  it('clears opened provider plaintext when the post-open revision read fails', async () => {
    const canary = 'provider-credential-canary'
    const kek: KekPortShape = {
      activeKeyVersion: Effect.succeed(1),
      wrap: (_version, bytes) => Effect.succeed(bytes.slice()),
      unwrap: (_version, bytes) => Effect.succeed(bytes.slice()),
    }
    let record: PlatformSecretRecord | undefined
    const prepared = makePlatformSecretEnvelope(
      {
        get: () => (record === undefined ? Effect.die('missing') : Effect.succeed(record)),
        create: (value) => Effect.sync(() => (record = value)),
        replace: (value) => Effect.sync(() => (record = value)),
        remove: () => Effect.void,
      },
      kek,
    )
    const plaintext = new TextEncoder().encode(canary)
    record = await Effect.runPromise(
      prepared.prepareSeal({
        id: 'platform-provider-platform-ovh',
        accountId: 'platform-ovh',
        plaintext,
        now: '2026-08-23T12:00:00.000Z',
      }),
    )

    let exactReads = 0
    const database: NodeProvisionRuntimeDatabase = {
      prepare: (sql) => ({
        bind() {
          return this
        },
        first: async () => {
          if (sql.includes('FROM node_provision_acceptances')) {
            exactReads += 1
            if (exactReads === 2) throw new Error('post-open D1 failure')
            return {
              accountId: 'platform-ovh',
              scope: 'platform',
              accountOrganizationId: null,
              providerType: 'ovhcloud',
              status: 'active',
              accountRevision: 1,
              credentialReference: record!.id,
              organizationSlug: 'org-a',
              actorId: 'identity-a',
              correlationId: 'corr-a',
              envelopeRevision: 1,
            }
          }
          return {
            id: record!.id,
            accountId: record!.accountId,
            ciphertext: record!.ciphertext,
            wrappedDataKey: record!.wrappedDataKey,
            keyVersion: record!.keyVersion,
            revision: record!.revision,
            createdAt: record!.createdAt,
            rotatedAt: record!.rotatedAt,
          }
        },
        all: async () => ({ results: [], meta: { changes: 0 } }),
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
      batch: async () => [],
    }

    const originalFillMethod = Reflect.get(Uint8Array.prototype, 'fill') as (
      this: Uint8Array,
      value: number,
      start?: number,
      end?: number,
    ) => Uint8Array
    const originalFill = (
      target: Uint8Array,
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array => Reflect.apply(originalFillMethod, target, [value, start, end])
    let cleared = false
    vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(
      function (this: Uint8Array, value, start, end) {
        if (value === 0 && new TextDecoder().decode(this) === canary) cleared = true
        return originalFill(this, value, start, end)
      },
    )
    const result = await Effect.runPromise(
      Effect.exit(
        makeExactProviderCredentialPort(database, kek).openExact({
          organizationId: 'org-a',
          nodeId: 'node-a',
          operationId: 'op-a',
          providerAccountId: 'platform-ovh',
          expectedAccountRevision: 1,
          expectedProviderType: 'ovhcloud',
        }),
      ),
    )
    expect(result._tag).toBe('Failure')
    expect(cleared).toBe(true)
  })
})

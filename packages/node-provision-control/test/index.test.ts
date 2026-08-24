import { describe, expect, it } from 'vitest'
import { Effect, Exit } from 'effect'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  decodeCreateNodeIntent,
  makeHmacRegistrationTokenSecret,
  makeNodeProvisionControl,
  makeWebCryptoNodeProvisionIdentity,
  nodeProvisionPolicyAdmission,
  reviewNodeProvision,
  NodeProvisionIdempotencyConflictError,
  NodeProvisionPersistenceError,
  NodeProvisionWorkflowStartError,
  type AuthoritativeProvisionFacts,
  type CreateNodeIntent,
  type NodeProvisionAcceptance,
  type NodeProvisionAtomicInput,
  type NodeProvisionCommand,
  type NodeProvisionRepositoryShape,
} from '../src/index.js'

const intent: CreateNodeIntent = {
  schemaVersion: 1,
  placementMode: 'shared',
  temporaryLifetimeHours: null,
  nonHourlyCommitmentConfirmed: true,
}

const policy: OrganizationPolicyV1 = {
  schemaVersion: 1,
  organizationId: 'org-a',
  revision: 7,
  allowedProviders: ['ovhcloud', 'contabo'],
  allowedRegions: ['region-a'],
  allowedPlans: ['plan-a'],
  capacity: {
    maxActiveNodes: 4,
    maxDedicatedNodes: 2,
    maxServersPerNode: 8,
    maxDeploymentCpuMillis: 8_000,
    maxDeploymentRamBytes: 16_000,
    maxDeploymentDiskBytes: 100_000,
  },
  monthlyBudget: {
    currency: 'EUR',
    setupWarningMinor: null,
    softLimitMinor: 5_000,
    hardLimitMinor: 10_000,
  },
  temporaryNodes: { automaticExpiryRequired: false, maxLifetimeHours: 72 },
  idle: { action: 'none', afterMinutes: 60 },
  backups: { requiredBeforeDelete: true },
  maintenanceWindows: [],
  updates: { automatic: 'disabled', requireMaintenanceWindow: false },
  contabo: { maxContractMonths: 12 },
  nonHourlyCommitment: { explicitConfirmationRequired: true },
}

const facts: AuthoritativeProvisionFacts = {
  organizationId: 'org-a',
  providerAccountId: 'account-a',
  providerAccountRevision: 3,
  providerType: 'ovhcloud',
  allocationRevision: 5,
  allocationMaxActiveNodes: 4,
  allocationMonthlyBudgetMinor: 10_000,
  allocationActiveNodes: 0,
  region: 'region-a',
  plan: 'plan-a',
  catalogRefreshedAt: '2026-08-23T10:00:00.000Z',
  catalogValidUntilEpochMilliseconds: Date.parse('2026-08-24T10:00:00.000Z'),
  imageId: 'image-a',
  imageVersion: '2026.08.23',
  imageChecksum: `sha256:${'a'.repeat(64)}`,
  providerImageId: 'provider-image-a',
  policy,
  usage: {
    organizationId: 'org-a',
    observedAtEpochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
    activeNodes: 0,
    dedicatedNodes: 0,
    serversByNode: {},
    estimatedCommittedMonthlyMinor: 0,
    currency: 'EUR',
  },
  price: {
    currency: 'EUR',
    estimatedMonthlyMinor: 1_500,
    billingCadence: 'hourly',
    contractMonths: 1,
  },
}

const command = (overrides: Partial<NodeProvisionCommand> = {}): NodeProvisionCommand => ({
  organizationId: 'org-a',
  actorId: 'actor-a',
  actorRole: 'administrator',
  idempotencyKey: 'create-node-0001',
  correlationId: 'correlation-a',
  intent,
  ...overrides,
})

const acceptance = (input: NodeProvisionAtomicInput): NodeProvisionAcceptance => ({
  disposition: 'created',
  organizationId: input.command.organizationId,
  nodeId: input.identity.nodeId,
  operationId: input.identity.operationId,
  idempotencyKey: input.command.idempotencyKey,
  fingerprint: input.fingerprint,
  providerType: input.facts.providerType,
  placementMode: input.command.intent.placementMode,
  billing: input.billing,
  workflowStart: {
    id: input.identity.workflowStartRecordId,
    state: 'pending',
    attempts: 0,
    lastError: null,
  },
})

const repository = () => {
  const records = new Map<string, NodeProvisionAcceptance>()
  let accepts = 0
  const port: NodeProvisionRepositoryShape = {
    findReplay: (organizationId, idempotencyKey, fingerprint) => {
      const existing = records.get(`${organizationId}:${idempotencyKey}`)
      if (existing !== undefined && existing.fingerprint !== fingerprint)
        return Effect.fail(new NodeProvisionIdempotencyConflictError({ idempotencyKey }))
      return Effect.succeed(existing ?? null)
    },
    acceptAtomic: (input) =>
      Effect.sync(() => {
        accepts += 1
        const next = acceptance(input)
        records.set(`${input.command.organizationId}:${input.command.idempotencyKey}`, next)
        return next
      }),
    markWorkflowStarted: (organizationId, operationId) =>
      Effect.sync(() => {
        for (const [key, value] of records) {
          if (value.organizationId === organizationId && value.operationId === operationId)
            records.set(key, {
              ...value,
              workflowStart: { ...value.workflowStart, state: 'started', attempts: 1 },
            })
        }
      }),
    recordWorkflowStartFailure: (organizationId, operationId, message) =>
      Effect.sync(() => {
        for (const [key, value] of records) {
          if (value.organizationId === organizationId && value.operationId === operationId)
            records.set(key, {
              ...value,
              workflowStart: {
                ...value.workflowStart,
                attempts: value.workflowStart.attempts + 1,
                lastError: message,
              },
            })
        }
      }),
  }
  return { port, records, accepts: () => accepts }
}

const secret = makeHmacRegistrationTokenSecret({
  activeVersion: 2,
  keys: {
    1: 'one-registration-key-material-that-is-at-least-32-bytes',
    2: 'two-registration-key-material-that-is-at-least-32-bytes',
  },
})

describe('node provision control', () => {
  it('keeps the public intent client-safe and strict', async () => {
    await expect(
      Effect.runPromise(
        decodeCreateNodeIntent({
          ...intent,
          providerType: 'contabo',
          providerAccountId: 'account-a',
          price: 1,
          credential: 'secret',
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionValidationError' })
  })

  it('derives stable identities and changes them with the intent', async () => {
    const identities = makeWebCryptoNodeProvisionIdentity()
    const firstFingerprint = await Effect.runPromise(identities.fingerprint(command()))
    const againFingerprint = await Effect.runPromise(identities.fingerprint(command()))
    const changedFingerprint = await Effect.runPromise(
      identities.fingerprint(command({ intent: { ...intent, placementMode: 'dedicated' } })),
    )
    expect(firstFingerprint).toBe(againFingerprint)
    expect(changedFingerprint).not.toBe(firstFingerprint)
    expect(await Effect.runPromise(identities.derive(command(), firstFingerprint))).toEqual(
      await Effect.runPromise(identities.derive(command(), firstFingerprint)),
    )
  })

  it('uses a versioned deterministic registration token while storing only its hash', async () => {
    const scope = {
      organizationId: 'org-a',
      nodeId: 'node-a',
      operationId: 'op-a',
      tokenRecordId: 'token-a',
    }
    const hashed = await Effect.runPromise(secret.hashFor(scope))
    expect(hashed).toMatchObject({ keyVersion: 2 })
    expect(hashed.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    const recovered = await Effect.runPromise(
      secret.recoverBytes(scope, hashed.keyVersion, hashed.tokenHash),
    )
    expect(recovered.some((byte) => byte !== 0)).toBe(true)
    recovered.fill(0)
    expect([...recovered].every((byte) => byte === 0)).toBe(true)
    await expect(
      Effect.runPromise(secret.recoverBytes(scope, 1, hashed.tokenHash)),
    ).rejects.toMatchObject({ _tag: 'RegistrationTokenSecretError' })
  })

  it('adopts an exact replay before reading current facts or policy', async () => {
    const store = repository()
    let factReads = 0
    let policyReads = 0
    const service = makeNodeProvisionControl({
      repository: store.port,
      facts: {
        resolve: () => {
          factReads += 1
          return Effect.succeed(facts)
        },
      },
      policy: {
        admit: (nextIntent, nextFacts, now) => {
          policyReads += 1
          return nodeProvisionPolicyAdmission.admit(nextIntent, nextFacts, now)
        },
      },
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: {
        now: Effect.succeed({
          iso: '2026-08-23T10:00:00.000Z',
          epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
        }),
      },
      workflows: { start: () => Effect.void },
    })
    expect((await Effect.runPromise(service.submit(command()))).disposition).toBe('created')
    factReads = 0
    policyReads = 0
    expect((await Effect.runPromise(service.submit(command()))).disposition).toBe('adopted')
    expect({ factReads, policyReads, accepts: store.accepts() }).toEqual({
      factReads: 0,
      policyReads: 0,
      accepts: 1,
    })
  })

  it('accepts an immutable reviewed selection, rejects drift, and adopts a lost response first', async () => {
    const store = repository()
    const now = {
      iso: '2026-08-23T10:00:00.000Z',
      epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
    }
    const billing = await Effect.runPromise(
      nodeProvisionPolicyAdmission.admit(intent, facts, now.epochMilliseconds),
    )
    const reviewed = await Effect.runPromise(reviewNodeProvision(facts, billing))
    let reviewedFactReads = 0
    let policyReads = 0
    let returnDrift = false
    let starts = 0
    const service = makeNodeProvisionControl({
      repository: store.port,
      facts: {
        resolve: () => {
          throw new Error('submitAccepted must not use replacement selection')
        },
        resolveReviewed: () => {
          reviewedFactReads += 1
          return Effect.succeed(
            returnDrift
              ? { ...facts, allocationRevision: facts.allocationRevision + 1 }
              : {
                  ...facts,
                  usage: {
                    ...facts.usage,
                    // The live sampling clock is intentionally not part of a reviewed digest.
                    observedAtEpochMilliseconds: facts.usage.observedAtEpochMilliseconds + 1,
                  },
                },
          )
        },
      },
      policy: {
        admit: (nextIntent, nextFacts, nowEpochMilliseconds) => {
          policyReads += 1
          return nodeProvisionPolicyAdmission.admit(nextIntent, nextFacts, nowEpochMilliseconds)
        },
      },
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: { now: Effect.succeed(now) },
      workflows: {
        start: (accepted) => {
          starts += 1
          return starts === 1
            ? Effect.fail(
                new NodeProvisionWorkflowStartError({
                  operationId: accepted.operationId,
                  message: 'ambiguous post-commit workflow response loss',
                }),
              )
            : Effect.void
        },
      },
    })
    expect(
      (await Effect.runPromise(service.submitAccepted(command(), reviewed))).workflowState,
    ).toBe('pending-reconciliation')
    reviewedFactReads = 0
    policyReads = 0
    expect(await Effect.runPromise(service.submitAccepted(command(), reviewed))).toMatchObject({
      disposition: 'adopted',
      workflowState: 'started',
    })
    expect({ reviewedFactReads, policyReads, accepts: store.accepts(), starts }).toEqual({
      reviewedFactReads: 0,
      policyReads: 0,
      accepts: 1,
      starts: 2,
    })

    returnDrift = true
    await expect(
      Effect.runPromise(
        service.submitAccepted(command({ idempotencyKey: 'reviewed-drift-0002' }), reviewed),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionFactsUnavailableError' })
    expect(store.accepts()).toBe(1)
  })

  it('creates no operation when current admission denies the request', async () => {
    const store = repository()
    const service = makeNodeProvisionControl({
      repository: store.port,
      facts: {
        resolve: () => Effect.succeed({ ...facts, policy: { ...policy, allowedPlans: [] } }),
      },
      policy: nodeProvisionPolicyAdmission,
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: {
        now: Effect.succeed({
          iso: '2026-08-23T10:00:00.000Z',
          epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
        }),
      },
      workflows: { start: () => Effect.void },
    })
    await expect(Effect.runPromise(service.submit(command()))).rejects.toMatchObject({
      _tag: 'NodeProvisionAdmissionDeniedError',
    })
    expect(store.accepts()).toBe(0)
  })

  it('enforces the selected provider allocation budget in addition to organization policy', async () => {
    const decision = await Effect.runPromise(
      Effect.result(
        nodeProvisionPolicyAdmission.admit(
          intent,
          { ...facts, allocationMonthlyBudgetMinor: 1_000 },
          Date.parse('2026-08-23T10:00:00.000Z'),
        ),
      ),
    )
    expect(decision._tag).toBe('Failure')
    if (decision._tag === 'Failure')
      expect(decision.failure.code).toBe('allocation_budget_exceeded')
  })

  it('returns pending on lost workflow response and safely adopts on retry', async () => {
    const store = repository()
    let starts = 0
    const service = makeNodeProvisionControl({
      repository: store.port,
      facts: { resolve: () => Effect.succeed(facts) },
      policy: nodeProvisionPolicyAdmission,
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: {
        now: Effect.succeed({
          iso: '2026-08-23T10:00:00.000Z',
          epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
        }),
      },
      workflows: {
        start: (accepted) => {
          starts += 1
          return starts === 1
            ? Effect.fail(
                new NodeProvisionWorkflowStartError({
                  operationId: accepted.operationId,
                  message: 'ambiguous response loss',
                }),
              )
            : Effect.void
        },
      },
    })
    expect((await Effect.runPromise(service.submit(command()))).workflowState).toBe(
      'pending-reconciliation',
    )
    const adopted = await Effect.runPromise(service.submit(command()))
    expect(adopted).toMatchObject({ disposition: 'adopted', workflowState: 'started' })
    expect(starts).toBe(2)
    expect(store.accepts()).toBe(1)
  })

  it('rejects a changed fingerprint and a non-administrator before acceptance', async () => {
    const store = repository()
    const service = makeNodeProvisionControl({
      repository: store.port,
      facts: { resolve: () => Effect.succeed(facts) },
      policy: nodeProvisionPolicyAdmission,
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: {
        now: Effect.succeed({
          iso: '2026-08-23T10:00:00.000Z',
          epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
        }),
      },
      workflows: { start: () => Effect.void },
    })
    await Effect.runPromise(service.submit(command()))
    await expect(
      Effect.runPromise(
        service.submit(command({ intent: { ...intent, placementMode: 'dedicated' } })),
      ),
    ).rejects.toMatchObject({ _tag: 'NodeProvisionIdempotencyConflictError' })
    const unauthorized = await Effect.runPromiseExit(
      service.submit(command({ actorRole: 'operator', idempotencyKey: 'create-node-0002' })),
    )
    expect(Exit.isFailure(unauthorized)).toBe(true)
    expect(store.accepts()).toBe(1)
  })

  it('does not report workflow start success when its durable mark fails', async () => {
    const store = repository()
    const service = makeNodeProvisionControl({
      repository: {
        ...store.port,
        markWorkflowStarted: () =>
          Effect.fail(new NodeProvisionPersistenceError({ operation: 'mark-started' })),
      },
      facts: { resolve: () => Effect.succeed(facts) },
      policy: nodeProvisionPolicyAdmission,
      identities: makeWebCryptoNodeProvisionIdentity(),
      registrationTokens: secret,
      clock: {
        now: Effect.succeed({
          iso: '2026-08-23T10:00:00.000Z',
          epochMilliseconds: Date.parse('2026-08-23T10:00:00.000Z'),
        }),
      },
      workflows: { start: () => Effect.void },
    })
    expect((await Effect.runPromise(service.submit(command()))).workflowState).toBe(
      'pending-reconciliation',
    )
  })
})

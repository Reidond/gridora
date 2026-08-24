import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  decodeServerCreateIntent,
  evaluateServerPlan,
  ServerPlacementRejectedError,
  ServerApplyIntent,
  ServerApplyPlanSchema,
  ServerProvisionAcceptedPlanSchema,
  ServerProvisionValidationError,
  canonicalServerProvisionCommercialReviewScope,
  makeServerProvisionPlanControl,
  publicServerProvisionPlan,
  type ServerProvisionAcceptance,
  type ServerProvisionAtomicInput,
  type ServerProvisionCommercialReviewScope,
  type ServerProvisionNodePlan,
  type ServerProvisionReviewedNodeProvision,
  type ServerProvisionRepositoryShape,
  type ServerPlanControlShape,
  type ServerPlanFacts,
  type ServerPlanRequest,
} from '../src/index.js'

const request: ServerPlanRequest = {
  context: {
    organizationId: 'org-a',
    actorId: 'operator-a',
    actorRole: 'operator',
    correlationId: 'correlation-a',
  },
  intent: {
    schemaVersion: 1,
    name: 'Eastern Front',
    pluginId: 'arma-reforger',
    placementMode: 'auto',
    resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
    nonHourlyCommitmentConfirmed: false,
  },
}

const facts: ServerPlanFacts = {
  organizationId: 'org-a',
  policy: {
    schemaVersion: 1,
    organizationId: 'org-a',
    revision: 3,
    allowedProviders: ['ovhcloud'],
    allowedRegions: ['eu-west'],
    allowedPlans: ['b2-15'],
    capacity: {
      maxActiveNodes: 5,
      maxDedicatedNodes: 2,
      maxServersPerNode: 4,
      maxDeploymentCpuMillis: 4_000,
      maxDeploymentRamBytes: 8_589_934_592,
      maxDeploymentDiskBytes: 107_374_182_400,
    },
    monthlyBudget: {
      currency: 'EUR',
      setupWarningMinor: null,
      softLimitMinor: 10_000,
      hardLimitMinor: 20_000,
    },
    temporaryNodes: { automaticExpiryRequired: true, maxLifetimeHours: 168 },
    idle: { action: 'none', afterMinutes: 60 },
    backups: { requiredBeforeDelete: true },
    maintenanceWindows: [],
    updates: { automatic: 'disabled', requireMaintenanceWindow: false },
    contabo: { maxContractMonths: 1 },
    nonHourlyCommitment: { explicitConfirmationRequired: true },
  },
  usage: {
    organizationId: 'org-a',
    observedAtEpochMilliseconds: 2_000_000_000_000,
    activeNodes: 1,
    dedicatedNodes: 0,
    serversByNode: { 'node-a': 0 },
    estimatedCommittedMonthlyMinor: 5_000,
    currency: 'EUR',
  },
  plugin: {
    pluginId: 'arma-reforger',
    pluginVersion: '0.1.0',
    selectionRevision: 2,
    contract: {
      architecture: 'amd64',
      sharedNodeAllowed: true,
      minimum: { cpuMillis: 1_000, ramBytes: 2_147_483_648, diskBytes: 21_474_836_480 },
      maximum: { cpuMillis: 4_000, ramBytes: 8_589_934_592, diskBytes: 107_374_182_400 },
      ports: [
        { name: 'game', protocol: 'udp', containerPort: 20_001, preferredPublicPort: 20_001 },
      ],
    },
  },
  nodes: [
    {
      nodeId: 'node-a',
      providerType: 'ovhcloud',
      region: 'eu-west',
      plan: 'b2-15',
      placementMode: 'shared',
      desiredRevision: 4,
      capacityRevision: 7,
      allocationRevision: 2,
      catalogRefreshedAt: '2026-08-23T12:00:00.000Z',
      capacityReportedAt: '2026-08-23T12:00:00.000Z',
      architecture: 'amd64',
      healthy: true,
      capacity: { cpuMillis: 8_000, ramBytes: 17_179_869_184, diskBytes: 214_748_364_800 },
      reserved: { cpuMillis: 0, ramBytes: 0, diskBytes: 0 },
      serverCount: 0,
      reservationCount: 0,
      ports: [],
    },
  ],
}

describe('server plan decision', () => {
  it('initializes and decodes the combined plan/apply schemas without an index cycle', async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(ServerApplyPlanSchema)({
          kind: 'existing-node',
          pluginId: 'arma-reforger',
          pluginVersion: '0.1.0',
          placementMode: 'shared',
          nodeId: 'node-a',
          resources: request.intent.resources,
          ports: [],
          newPaidInfrastructure: false,
          estimatedMonthlyIncreaseMinor: 0,
          explanation: 'ready node',
          warnings: [],
          candidates: [],
        }),
      ),
    ).resolves.toMatchObject({ kind: 'existing-node', nodeId: 'node-a' })
    expect(ServerApplyIntent.fields.server).toBeDefined()
    expect(ServerApplyIntent.fields.game).toBeDefined()
  })

  it('rejects client-selected server, operation, deployment, and provider identifiers', async () => {
    await expect(
      Effect.runPromise(
        decodeServerCreateIntent({
          ...request.intent,
          serverId: 'server-client',
          deploymentId: 'deployment-client',
          operationId: 'operation-client',
          providerAccountId: 'provider-client',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'ServerPlanValidationError',
      code: 'invalid_server_create_intent',
    })
  })

  it('normalizes legacy v1 intent without commercial confirmation to an explicit refusal', async () => {
    await expect(
      Effect.runPromise(
        decodeServerCreateIntent({
          schemaVersion: 1,
          name: 'Eastern Front',
          pluginId: 'arma-reforger',
          placementMode: 'auto',
          resources: { cpuMillis: 2_000, ramBytes: 4_294_967_296, diskBytes: 42_949_672_960 },
        }),
      ),
    ).resolves.toMatchObject({ nonHourlyCommitmentConfirmed: false })
  })

  it('selects only an authoritative ready node and reports no paid infrastructure', async () => {
    const prepared = await Effect.runPromise(
      evaluateServerPlan(request, facts, Date.parse('2026-08-23T12:00:00.000Z')),
    )
    expect(prepared.decision).toMatchObject({
      nodeId: 'node-a',
      pluginVersion: '0.1.0',
      newPaidInfrastructure: false,
      estimatedMonthlyIncreaseMinor: 0,
    })
    expect(prepared.fences).toEqual({
      policyRevision: 3,
      pluginSelectionRevision: 2,
      nodeDesiredRevision: 4,
      capacityRevision: 7,
      allocationRevision: 2,
      catalogRefreshedAt: '2026-08-23T12:00:00.000Z',
    })
  })

  it('fails closed for unaccounted legacy deployment capacity', async () => {
    const unsafe: ServerPlanFacts = {
      ...facts,
      nodes: [{ ...facts.nodes[0]!, serverCount: 1, reservationCount: 0 }],
    }
    await expect(
      Effect.runPromise(
        evaluateServerPlan(request, unsafe, Date.parse('2026-08-23T12:00:00.000Z')),
      ),
    ).rejects.toBeInstanceOf(ServerPlacementRejectedError)
  })

  it('fails closed when a required fixed port is already leased', async () => {
    const occupied: ServerPlanFacts = {
      ...facts,
      nodes: [{ ...facts.nodes[0]!, ports: [{ protocol: 'udp', publicPort: 20_001 }] }],
    }
    await expect(
      Effect.runPromise(
        evaluateServerPlan(request, occupied, Date.parse('2026-08-23T12:00:00.000Z')),
      ),
    ).rejects.toBeInstanceOf(ServerPlacementRejectedError)
  })

  it('fails closed when agent health or provider catalog facts are stale', async () => {
    await expect(
      Effect.runPromise(evaluateServerPlan(request, facts, Date.parse('2026-08-25T12:00:00.000Z'))),
    ).rejects.toMatchObject({
      _tag: 'ServerPlacementRejectedError',
      code: 'no_existing_node_fit',
    })
  })
})

const acceptedNoFitPlan = (
  requiresNonHourlyCommitmentConfirmation = false,
  commercialConsentRequired = false,
): ServerProvisionNodePlan => ({
  kind: 'provision-node',
  pluginId: 'arma-reforger',
  pluginVersion: '0.1.0',
  pluginSelectionRevision: 2,
  placementMode: 'shared',
  nodeIntent: {
    schemaVersion: 1,
    placementMode: 'shared',
    temporaryLifetimeHours: null,
    nonHourlyCommitmentConfirmed: false,
  },
  selectedInfrastructure: { providerType: 'ovhcloud', region: 'eu-west', plan: 'b2-15' },
  billing: {
    currency: 'EUR',
    estimatedMonthlyIncreaseMinor: 5000,
    billingCadence: 'monthly',
    contractMonths: 1,
    committedMonthlyBeforeMinor: 5000,
    projectedCommittedMonthlyMinor: 10000,
  },
  requiresNonHourlyCommitmentConfirmation,
  commercialConsentRequired,
  implications: {
    dns: 'publish after verification',
    mods: 'validate before activation',
    backups: 'apply after deployment',
    downtime: 'new server',
    billing: 'starts after acceptance',
  },
  warnings: [],
  explanation: 'no existing capacity fits',
  newPaidInfrastructure: true,
})

const commercialReviews = () => {
  const tokens = new Map<string, string>()
  const tokenFor = (scope: ServerProvisionCommercialReviewScope) => {
    const key = canonicalServerProvisionCommercialReviewScope(scope)
    const existing = tokens.get(key)
    if (existing !== undefined) return existing
    const token = tokens.size.toString(16).padStart(64, '0')
    tokens.set(key, token)
    return token
  }
  return {
    issue: (scope: ServerProvisionCommercialReviewScope) => Effect.succeed(tokenFor(scope)),
    verify: (scope: ServerProvisionCommercialReviewScope, token: string) =>
      Effect.succeed(tokenFor(scope) === token),
  }
}

const reviewedNodeProvision = (): ServerProvisionReviewedNodeProvision => ({
  facts: {
    organizationId: 'org-a',
    providerAccountId: 'provider-account-a',
    providerAccountRevision: 3,
    providerType: 'ovhcloud',
    allocationRevision: 2,
    allocationMaxActiveNodes: 5,
    allocationMonthlyBudgetMinor: 20_000,
    allocationActiveNodes: 1,
    region: 'eu-west',
    plan: 'b2-15',
    catalogRefreshedAt: '2026-08-24T00:00:00.000Z',
    catalogValidUntilEpochMilliseconds: 2_000_000_360_000,
    imageId: 'image-a',
    imageVersion: '1.0.0',
    imageChecksum: `sha256:${'a'.repeat(64)}`,
    providerImageId: 'ovh-image-a',
    policy: facts.policy,
    usage: facts.usage,
    price: {
      currency: 'EUR',
      estimatedMonthlyMinor: 5_000,
      billingCadence: 'monthly',
      contractMonths: 1,
    },
  },
  billing: {
    providerType: 'ovhcloud',
    currency: 'EUR',
    estimatedMonthlyMinor: 5_000,
    billingCadence: 'monthly',
    contractMonths: 1,
    committedMonthlyBeforeMinor: 5_000,
    projectedCommittedMonthlyMinor: 10_000,
    warnings: [],
  },
  selectionDigest: 'b'.repeat(64),
})

const serverApplyCommand = () => ({
  context: { ...request.context, actorRole: 'owner' as const },
  idempotencyKey: 'server-apply-key-a',
  intent: {
    schemaVersion: 1 as const,
    server: request.intent,
    game: {
      schemaVersion: 1 as const,
      name: request.intent.name,
      pluginId: request.intent.pluginId,
      placement: { mode: 'shared' as const },
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 40 },
      config: {},
      mods: [],
    },
  },
  auditRequestContext: {
    origin: 'http' as const,
    requestId: 'request-a',
    correlationId: request.context.correlationId,
    source: {
      ip: { state: 'captured' as const, value: '203.0.113.10' },
      access: {
        state: 'captured' as const,
        value: {
          subject: 'access-operator-a',
          identityId: request.context.actorId,
          issuer: 'https://access.example.test',
          email: 'operator@example.test',
        },
      },
    },
  },
})

const commercialApplyCommand = (token: string) => {
  const command = serverApplyCommand()
  return {
    ...command,
    intent: {
      ...command.intent,
      server: { ...command.intent.server, nonHourlyCommitmentConfirmed: true },
      commercialReviewToken: token,
    },
  }
}

describe('durable no-fit server apply', () => {
  it('persists the reviewed provider, price, cadence, and plugin selection as the immutable parent plan', async () => {
    const selected = acceptedNoFitPlan()
    let atomicInput: ServerProvisionAtomicInput | undefined
    const repository: ServerProvisionRepositoryShape = {
      findReplay: () => Effect.succeed(null),
      acceptAtomic: (input) => {
        atomicInput = input
        const acceptance: ServerProvisionAcceptance = {
          disposition: 'created',
          organizationId: input.command.context.organizationId,
          operationId: input.identity.operationId,
          resourceId: input.identity.resourceId,
          idempotencyKey: input.command.idempotencyKey,
          fingerprint: input.fingerprint,
          state: 'queued',
          plan: publicServerProvisionPlan(input.plan),
        }
        return Effect.succeed(acceptance)
      },
      markWorkflowStarted: () => Effect.void,
      recordWorkflowStartFailure: () => Effect.void,
    }
    const serverPlan: ServerPlanControlShape = {
      plan: () =>
        Effect.fail(
          new ServerPlacementRejectedError({
            code: 'no_existing_node_fit',
            message: 'no ready node fits',
            reasons: [],
          }),
        ),
      create: () => Effect.die('unused in no-fit parent test'),
    }
    const control = makeServerProvisionPlanControl({
      serverPlan,
      preview: {
        preview: () =>
          Effect.succeed({ plan: selected, reviewedNodeProvision: reviewedNodeProvision() }),
      },
      repository,
      identities: {
        fingerprint: () => Effect.succeed('a'.repeat(64)),
        derive: () =>
          Effect.succeed({
            resourceId: 'server-provision-a',
            operationId: 'operation-server-provision-a',
            workflowStartRecordId: 'workflow-start-server-provision-a',
            auditEventId: 'audit-server-provision-a',
            outboxEventId: 'outbox-server-provision-a',
          }),
      },
      commercialReviews: commercialReviews(),
      clock: { now: Effect.succeed({ iso: '2026-08-24T00:00:00.000Z', epochMilliseconds: 0 }) },
      workflows: { start: () => Effect.void },
    })

    const accepted = await Effect.runPromise(control.apply(serverApplyCommand()))

    expect(accepted.workflowState).toBe('started')
    expect(atomicInput?.plan).toMatchObject({
      ...selected,
      reviewedNodeProvision: reviewedNodeProvision(),
    })
    expect(atomicInput?.plan).toMatchObject({
      pluginVersion: '0.1.0',
      pluginSelectionRevision: 2,
      selectedInfrastructure: { providerType: 'ovhcloud', region: 'eu-west', plan: 'b2-15' },
      billing: {
        currency: 'EUR',
        estimatedMonthlyIncreaseMinor: 5000,
        billingCadence: 'monthly',
        contractMonths: 1,
      },
    })
    expect(atomicInput?.plan).toMatchObject({
      reviewedNodeProvision: {
        facts: {
          providerAccountId: 'provider-account-a',
          providerAccountRevision: 3,
          allocationRevision: 2,
          catalogValidUntilEpochMilliseconds: 2_000_000_360_000,
          usage: { observedAtEpochMilliseconds: 2_000_000_000_000 },
        },
        selectionDigest: 'b'.repeat(64),
      },
    })
    expect(accepted.plan).not.toHaveProperty('reviewedNodeProvision')
  })

  it('shows a non-hourly offer but refuses to accept it before exact acknowledgement', async () => {
    let accepted = false
    const control = makeServerProvisionPlanControl({
      serverPlan: {
        plan: () =>
          Effect.fail(
            new ServerPlacementRejectedError({
              code: 'no_existing_node_fit',
              message: 'no ready node fits',
              reasons: [],
            }),
          ),
        create: () => Effect.die('unused in no-fit parent test'),
      },
      preview: {
        preview: () =>
          Effect.succeed({
            plan: acceptedNoFitPlan(true),
            reviewedNodeProvision: reviewedNodeProvision(),
          }),
      },
      repository: {
        findReplay: () => Effect.succeed(null),
        acceptAtomic: () => {
          accepted = true
          return Effect.die('must not accept')
        },
        markWorkflowStarted: () => Effect.void,
        recordWorkflowStartFailure: () => Effect.void,
      },
      identities: {
        fingerprint: () => Effect.succeed('a'.repeat(64)),
        derive: () => Effect.die('must not derive'),
      },
      commercialReviews: commercialReviews(),
      clock: { now: Effect.succeed({ iso: '2026-08-24T00:00:00.000Z', epochMilliseconds: 0 }) },
      workflows: { start: () => Effect.void },
    })

    await expect(Effect.runPromise(control.apply(serverApplyCommand()))).rejects.toBeInstanceOf(
      ServerProvisionValidationError,
    )
    expect(accepted).toBe(false)
  })

  it('binds a reviewed commercial offer to the exact organization, actor, intent, and immutable selection', async () => {
    let current = {
      plan: acceptedNoFitPlan(false, true),
      reviewedNodeProvision: reviewedNodeProvision(),
    }
    let accepted = 0
    const reviews = commercialReviews()
    const control = makeServerProvisionPlanControl({
      serverPlan: {
        plan: () =>
          Effect.fail(
            new ServerPlacementRejectedError({
              code: 'no_existing_node_fit',
              message: 'no ready node fits',
              reasons: [],
            }),
          ),
        create: () => Effect.die('unused in no-fit parent test'),
      },
      preview: { preview: () => Effect.succeed(current) },
      repository: {
        findReplay: () => Effect.succeed(null),
        acceptAtomic: (input) => {
          accepted += 1
          return Effect.succeed({
            disposition: 'created' as const,
            organizationId: input.command.context.organizationId,
            operationId: input.identity.operationId,
            resourceId: input.identity.resourceId,
            idempotencyKey: input.command.idempotencyKey,
            fingerprint: input.fingerprint,
            state: 'queued' as const,
            plan: publicServerProvisionPlan(input.plan),
          })
        },
        markWorkflowStarted: () => Effect.void,
        recordWorkflowStartFailure: () => Effect.void,
      },
      identities: {
        fingerprint: () => Effect.succeed('a'.repeat(64)),
        derive: () =>
          Effect.succeed({
            resourceId: 'server-provision-a',
            operationId: 'operation-server-provision-a',
            workflowStartRecordId: 'workflow-start-server-provision-a',
            auditEventId: 'audit-server-provision-a',
            outboxEventId: 'outbox-server-provision-a',
          }),
      },
      commercialReviews: reviews,
      clock: { now: Effect.succeed({ iso: '2026-08-24T00:00:00.000Z', epochMilliseconds: 0 }) },
      workflows: { start: () => Effect.void },
    })

    const preview = await Effect.runPromise(
      control.plan({ context: { ...request.context, actorRole: 'owner' }, intent: request.intent }),
    )
    expect(preview.kind).toBe('provision-node')
    if (preview.kind !== 'provision-node' || preview.commercialReviewToken === undefined)
      throw new Error('expected opaque commercial review proof')
    const reviewedToken = preview.commercialReviewToken

    current = {
      plan: {
        ...acceptedNoFitPlan(false, true),
        selectedInfrastructure: { providerType: 'ovhcloud', region: 'eu-west', plan: 'b2-30' },
        billing: {
          ...acceptedNoFitPlan(false, true).billing,
          estimatedMonthlyIncreaseMinor: 7_000,
          projectedCommittedMonthlyMinor: 12_000,
        },
      },
      reviewedNodeProvision: { ...reviewedNodeProvision(), selectionDigest: 'c'.repeat(64) },
    }
    await expect(
      Effect.runPromise(control.apply(commercialApplyCommand(reviewedToken))),
    ).rejects.toMatchObject({
      _tag: 'ServerProvisionValidationError',
      code: 'commercial_review_required',
    })

    current = {
      plan: acceptedNoFitPlan(false, true),
      reviewedNodeProvision: reviewedNodeProvision(),
    }
    await expect(
      Effect.runPromise(control.apply(commercialApplyCommand('f'.repeat(64)))),
    ).rejects.toMatchObject({ code: 'commercial_review_required' })

    const crossTenant = commercialApplyCommand(reviewedToken)
    await expect(
      Effect.runPromise(
        control.apply({
          ...crossTenant,
          context: { ...crossTenant.context, organizationId: 'org-b' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'commercial_review_required' })

    const replayedScope = commercialApplyCommand(reviewedToken)
    await expect(
      Effect.runPromise(
        control.apply({
          ...replayedScope,
          context: { ...replayedScope.context, actorId: 'owner-b' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'commercial_review_required' })

    const exact = await Effect.runPromise(control.apply(commercialApplyCommand(reviewedToken)))
    expect(exact.workflowState).toBe('started')
    expect(exact.plan).not.toHaveProperty('commercialReviewToken')
    expect(accepted).toBe(1)
  })

  it('rejects an expired commercial review even when its opaque proof otherwise matches', async () => {
    let epochMilliseconds = 2_000_000_360_000 - 1
    let accepted = false
    const selected = acceptedNoFitPlan(false, true)
    const reviewed = reviewedNodeProvision()
    const control = makeServerProvisionPlanControl({
      serverPlan: {
        plan: () =>
          Effect.fail(
            new ServerPlacementRejectedError({
              code: 'no_existing_node_fit',
              message: 'no ready node fits',
              reasons: [],
            }),
          ),
        create: () => Effect.die('unused in no-fit parent test'),
      },
      preview: {
        preview: () => Effect.succeed({ plan: selected, reviewedNodeProvision: reviewed }),
      },
      repository: {
        findReplay: () => Effect.succeed(null),
        acceptAtomic: () => {
          accepted = true
          return Effect.die('expired commercial review must not accept')
        },
        markWorkflowStarted: () => Effect.void,
        recordWorkflowStartFailure: () => Effect.void,
      },
      identities: {
        fingerprint: () => Effect.succeed('a'.repeat(64)),
        derive: () => Effect.die('expired commercial review must not derive an identity'),
      },
      commercialReviews: commercialReviews(),
      clock: {
        now: Effect.sync(() => ({
          iso: new Date(epochMilliseconds).toISOString(),
          epochMilliseconds,
        })),
      },
      workflows: { start: () => Effect.void },
    })
    const preview = await Effect.runPromise(
      control.plan({ context: { ...request.context, actorRole: 'owner' }, intent: request.intent }),
    )
    if (preview.kind !== 'provision-node' || preview.commercialReviewToken === undefined)
      throw new Error('expected commercial review proof before catalog expiry')

    epochMilliseconds = reviewed.facts.catalogValidUntilEpochMilliseconds
    await expect(
      Effect.runPromise(control.apply(commercialApplyCommand(preview.commercialReviewToken))),
    ).rejects.toMatchObject({ code: 'commercial_review_required' })
    expect(accepted).toBe(false)
  })

  it('strictly decodes internal reviewed evidence but keeps the public schema free of it', async () => {
    const acceptedPlan = { ...acceptedNoFitPlan(), reviewedNodeProvision: reviewedNodeProvision() }
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(ServerProvisionAcceptedPlanSchema, {
          onExcessProperty: 'error',
        })(acceptedPlan),
      ),
    ).resolves.toMatchObject({
      kind: 'provision-node',
      reviewedNodeProvision: { selectionDigest: 'b'.repeat(64) },
    })
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(ServerApplyPlanSchema, { onExcessProperty: 'error' })(
          acceptedPlan,
        ),
      ),
    ).rejects.toBeDefined()
  })
})

import { Effect, Schema } from 'effect'
import { type GameLifecycleRepository, planGameServer } from '@gridora/game-lifecycle-control'
import { type GameLifecyclePlanningD1Repository } from '@gridora/game-lifecycle-d1'
import { makeNodeProvisionFactsD1 } from '@gridora/node-provision-d1'
import {
  NodeProvisionAdmissionDeniedError,
  nodeProvisionPolicyAdmission,
  reviewNodeProvision,
} from '@gridora/node-provision-control'
import {
  makeNodeProvisionControlRuntime,
  type NodeProvisionRuntimeBindings,
} from './node-provision-runtime.js'
import { startOrAdoptGameLifecycleWorkflow } from './game-lifecycle-routes.js'
import type { NativeLifecycleWorkflowBinding } from './lifecycle-runtime.js'
import {
  canonicalServerProvisionCommercialReviewScope,
  CommercialReviewRequiredValidationCode,
  type ServerProvisionCommercialReviewTokenPort,
  type ServerProvisionCommercialReviewScope,
  makeServerProvisionPlanControl,
  makeWebCryptoServerProvisionIdentity,
  type ServerPlanControlShape,
  type ServerProvisionPlanControlShape,
  type ServerProvisionNodePlan,
  type ServerProvisionPreviewRequest,
  ServerProvisionPersistenceError,
  ServerProvisionValidationError,
  ServerProvisionWorkflowStartError,
} from '@gridora/server-plan-control'
import {
  makeServerPlanRepositoryD1,
  makeServerProvisionRepositoryD1,
  type ServerProvisionCompensableNode,
  type ServerProvisionExecutionRepository,
  type ServerProvisionRun,
} from '@gridora/server-plan-d1'
import {
  makeTerminationControl,
  type NodeLifecycleAcceptance,
} from '@gridora/lifecycle-termination-control'
import { makeTerminationD1Repository } from '@gridora/lifecycle-termination-d1'
import { makeCancellationSignal, type CancellationRuntimeBindings } from './cancellation-runtime.js'
import {
  startRetireNodeWorkflow,
  type NodeTerminationWorkflowBinding,
} from './node-termination-runtime.js'

interface ServerProvisionWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: 'server-provision'
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: { readonly acceptanceFingerprint: string }
}

interface ServerProvisionWorkflowBinding {
  create(options?: {
    readonly id?: string
    readonly params: ServerProvisionWorkflowParams
  }): Promise<{ readonly id: string }>
  get(id: string): Promise<{ readonly id: string }>
}

export interface ServerProvisionRuntimeBindings extends NodeProvisionRuntimeBindings {
  readonly SERVER_PROVISION_PLAN: ServerProvisionWorkflowBinding
  readonly DEPLOY_GAME_SERVER: NativeLifecycleWorkflowBinding
  readonly RETIRE_NODE: NodeTerminationWorkflowBinding
  /** Dedicated server-only HMAC key for opaque commercial review proof. */
  readonly SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET: string
}

const bufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const decodeHex = (value: string): Uint8Array | undefined => {
  if (!/^[a-f0-9]{64}$/.test(value)) return undefined
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

const commercialReviewTokenFailure = () =>
  new ServerProvisionPersistenceError({
    operation: 'server-provision.commercial-review-token',
    message: 'Commercial review proof could not be verified',
  })

const staleCommercialReviewError = (
  commercialReviewProvided: boolean | undefined,
  error: unknown,
): ServerProvisionValidationError | undefined =>
  commercialReviewProvided === true &&
  error instanceof NodeProvisionAdmissionDeniedError &&
  error.code === 'price_stale'
    ? new ServerProvisionValidationError({
        code: CommercialReviewRequiredValidationCode,
        message:
          'The reviewed commercial provider offer is no longer current; review it again before applying',
      })
    : undefined

const previewPolicyError = (commercialReviewProvided: boolean | undefined, error: unknown) =>
  staleCommercialReviewError(commercialReviewProvided, error) ??
  new ServerProvisionPersistenceError({
    operation: 'server-provision.preview.policy',
    message: 'Authoritative node provision admission is unavailable',
  })

/**
 * The client receives only this opaque MAC.  The strict reviewed-node snapshot
 * remains in D1; its selection digest is included in the authenticated scope
 * so an offer cannot be transplanted to another organization, actor, or intent.
 */
export const makeHmacServerProvisionCommercialReviews = (
  secret: string,
): ServerProvisionCommercialReviewTokenPort => {
  if (new TextEncoder().encode(secret).byteLength < 32)
    throw new Error('SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET must contain at least 32 bytes')
  const signedPayload = (scope: ServerProvisionCommercialReviewScope) =>
    new TextEncoder().encode(
      `gridora:server-provision-commercial-review:v1:${canonicalServerProvisionCommercialReviewScope(scope)}`,
    )
  const key = (usage: KeyUsage[]) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          'raw',
          bufferSource(new TextEncoder().encode(secret)),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          usage,
        ),
      catch: commercialReviewTokenFailure,
    })
  return {
    issue: (scope) =>
      Effect.gen(function* () {
        const cryptoKey = yield* key(['sign'])
        const signature = yield* Effect.tryPromise({
          try: async () =>
            new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, signedPayload(scope))),
          catch: commercialReviewTokenFailure,
        })
        return hex(signature)
      }),
    verify: (scope, token) =>
      Effect.gen(function* () {
        const signature = decodeHex(token)
        if (signature === undefined) return false
        const cryptoKey = yield* key(['verify'])
        return yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.verify('HMAC', cryptoKey, bufferSource(signature), signedPayload(scope)),
          catch: commercialReviewTokenFailure,
        })
      }),
  }
}

export const ServerProvisionWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.Literal('server-provision'),
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Struct({
    acceptanceFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  stepName: Schema.Literals([
    'submit-node',
    'wait-node-ready',
    'reserve-and-deploy',
    'wait-game-deployment',
    'compensate-node',
    'wait-compensation',
  ]),
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export interface ServerProvisionWorkflowPayload {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: 'server-provision'
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: { readonly acceptanceFingerprint: string }
  readonly stepName:
    | 'submit-node'
    | 'wait-node-ready'
    | 'reserve-and-deploy'
    | 'wait-game-deployment'
    | 'compensate-node'
    | 'wait-compensation'
  readonly ordinal: number
}

const workflowStarter = (
  bindings: ServerProvisionRuntimeBindings,
  repository: ReturnType<typeof makeServerProvisionRepositoryD1>,
) => ({
  start: (acceptance: {
    readonly organizationId: string
    readonly operationId: string
    readonly resourceId: string
    readonly idempotencyKey: string
    readonly fingerprint: string
  }) =>
    Effect.gen(function* () {
      const run = yield* repository.load(acceptance.organizationId, acceptance.operationId).pipe(
        Effect.mapError(
          () =>
            new ServerProvisionWorkflowStartError({
              operationId: acceptance.operationId,
              message: 'authoritative parent acceptance is unavailable for workflow start',
            }),
        ),
      )
      if (
        run.resourceId !== acceptance.resourceId ||
        run.idempotencyKey !== acceptance.idempotencyKey ||
        run.fingerprint !== acceptance.fingerprint
      )
        return yield* new ServerProvisionWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'authoritative parent acceptance does not match workflow start request',
        })
      const params: ServerProvisionWorkflowParams = {
        operationId: acceptance.operationId,
        organizationId: acceptance.organizationId,
        resourceId: acceptance.resourceId,
        resourceType: 'server-provision',
        actorId: run.actorId,
        correlationId: run.correlationId,
        idempotencyKey: acceptance.idempotencyKey,
        input: { acceptanceFingerprint: acceptance.fingerprint },
      }
      const created = yield* Effect.result(
        Effect.tryPromise({
          try: () => bindings.SERVER_PROVISION_PLAN.create({ id: acceptance.operationId, params }),
          catch: () =>
            new ServerProvisionWorkflowStartError({
              operationId: acceptance.operationId,
              message: 'workflow create result is ambiguous',
            }),
        }),
      )
      if (created._tag === 'Success' && created.success.id === acceptance.operationId) return
      const adopted = yield* Effect.tryPromise({
        try: () => bindings.SERVER_PROVISION_PLAN.get(acceptance.operationId),
        catch: () =>
          new ServerProvisionWorkflowStartError({
            operationId: acceptance.operationId,
            message: 'workflow cannot be adopted after an ambiguous create',
          }),
      })
      if (adopted.id !== acceptance.operationId)
        return yield* new ServerProvisionWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'workflow identity does not match parent operation',
        })
    }),
})

/** Read-only preview uses the exact node-provision catalog/policy admission port. */
const previewPort = (bindings: ServerProvisionRuntimeBindings) => ({
  preview: (request: ServerProvisionPreviewRequest) =>
    Effect.gen(function* () {
      // The same authoritative plugin selection used by the existing-capacity
      // planner decides whether auto is allowed to use shared infrastructure.
      // A client cannot turn a dedicated-only plugin into a shared placement.
      const serverFacts = yield* makeServerPlanRepositoryD1(bindings.DB)
        .readFacts(request.organizationId, request.intent.pluginId)
        .pipe(
          Effect.mapError(
            () =>
              new ServerProvisionPersistenceError({
                operation: 'server-provision.preview.plugin',
                message: 'Authoritative plugin placement facts are unavailable',
              }),
          ),
        )
      const placementMode =
        request.intent.placementMode === 'auto'
          ? serverFacts.plugin.contract.sharedNodeAllowed
            ? 'shared'
            : 'dedicated'
          : request.intent.placementMode
      const nodeIntent = {
        schemaVersion: 1 as const,
        placementMode,
        temporaryLifetimeHours: null,
        nonHourlyCommitmentConfirmed: request.intent.nonHourlyCommitmentConfirmed,
      }
      // The facts adapter owns provider/account/catalog/image selection. This
      // read performs no provider mutation and never accepts client fields.
      const facts = yield* makeNodeProvisionFactsD1(bindings.DB)
        .resolve({
          organizationId: request.organizationId,
          nodeId: `preview-${request.intent.pluginId}`,
          intent: nodeIntent,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ServerProvisionPersistenceError({
                operation: 'server-provision.preview.facts',
                message: 'Authoritative node provision facts are unavailable',
              }),
          ),
        )
      const now = yield* Effect.sync(Date.now)
      // A non-hourly offer can be reviewed before the user has acknowledged
      // it.  The plan remains non-accepting until the exact public intent is
      // resubmitted with confirmation; all other policy denials fail closed.
      const admitted = yield* Effect.result(
        nodeProvisionPolicyAdmission.admit(nodeIntent, facts, now),
      )
      const staleCommercialOffer =
        admitted._tag === 'Failure'
          ? staleCommercialReviewError(request.commercialReviewProvided, admitted.failure)
          : undefined
      if (staleCommercialOffer !== undefined) return yield* staleCommercialOffer
      const requiresNonHourlyCommitmentConfirmation =
        admitted._tag === 'Failure' &&
        admitted.failure instanceof NodeProvisionAdmissionDeniedError &&
        admitted.failure.code === 'non_hourly_confirmation_required'
      const billing =
        admitted._tag === 'Success'
          ? admitted.success
          : requiresNonHourlyCommitmentConfirmation
            ? yield* nodeProvisionPolicyAdmission
                .admit({ ...nodeIntent, nonHourlyCommitmentConfirmed: true }, facts, now)
                .pipe(
                  Effect.mapError((error) =>
                    previewPolicyError(request.commercialReviewProvided, error),
                  ),
                )
            : yield* new ServerProvisionPersistenceError({
                operation: 'server-provision.preview.policy',
                message: 'Authoritative node provision admission is unavailable',
              })
      const plan = {
        kind: 'provision-node' as const,
        pluginId: request.intent.pluginId,
        pluginVersion: serverFacts.plugin.pluginVersion,
        pluginSelectionRevision: serverFacts.plugin.selectionRevision,
        placementMode,
        nodeIntent,
        selectedInfrastructure: {
          providerType: facts.providerType,
          region: facts.region,
          plan: facts.plan,
        },
        billing: {
          currency: billing.currency,
          estimatedMonthlyIncreaseMinor: billing.estimatedMonthlyMinor,
          billingCadence: billing.billingCadence,
          contractMonths: billing.contractMonths,
          committedMonthlyBeforeMinor: billing.committedMonthlyBeforeMinor,
          projectedCommittedMonthlyMinor: billing.projectedCommittedMonthlyMinor,
        },
        requiresNonHourlyCommitmentConfirmation,
        // Hourly capacity does not create a non-hourly commercial commitment.
        // The opaque offer review is therefore deliberately absent for it.
        commercialConsentRequired:
          facts.policy.nonHourlyCommitment.explicitConfirmationRequired &&
          billing.billingCadence !== 'hourly',
        implications: {
          dns: 'A DNS record is published only after the plugin deployment reaches its verified endpoint step.',
          mods: 'Plugin-declared mods are validated and resolved before game activation.',
          backups:
            'The plugin backup policy applies after deployment; no existing server data is replaced.',
          downtime:
            'This is a new server deployment; no existing game server is intentionally stopped.',
          billing:
            'Provider billing begins only if the separately admitted node provision operation is accepted.',
        },
        warnings: billing.warnings,
        explanation: `No ready capacity fits; admission selects ${facts.providerType} ${facts.region}/${facts.plan} from the organization allocation.`,
        newPaidInfrastructure: true as const,
      } satisfies ServerProvisionNodePlan
      const reviewedNodeProvision = yield* reviewNodeProvision(facts, billing).pipe(
        Effect.mapError(
          () =>
            new ServerProvisionPersistenceError({
              operation: 'server-provision.preview.reviewed-selection',
              message: 'The reviewed node provision evidence could not be derived',
            }),
        ),
      )
      return { plan, reviewedNodeProvision }
    }),
})

export const makeServerProvisionPlanControlRuntime = (
  bindings: ServerProvisionRuntimeBindings,
  serverPlan: ServerPlanControlShape,
): ServerProvisionPlanControlShape => {
  const repository = makeServerProvisionRepositoryD1(bindings.DB)
  return makeServerProvisionPlanControl({
    serverPlan,
    preview: previewPort(bindings),
    repository,
    identities: makeWebCryptoServerProvisionIdentity(),
    commercialReviews: makeHmacServerProvisionCommercialReviews(
      bindings.SERVER_PROVISION_COMMERCIAL_REVIEW_SECRET,
    ),
    clock: {
      now: Effect.sync(() => {
        const now = new Date()
        return { iso: now.toISOString(), epochMilliseconds: now.getTime() }
      }),
    },
    workflows: workflowStarter(bindings, repository),
  })
}

const childIdempotencyKey = (kind: 'node' | 'game', operationId: string) =>
  `server-provision-${kind}:${operationId}`

const asExecutionRepository = (
  bindings: ServerProvisionRuntimeBindings,
): ServerProvisionExecutionRepository => makeServerProvisionRepositoryD1(bindings.DB)

/**
 * Node capacity is intentionally read again at reservation time, but an
 * accepted no-fit parent must never silently switch its reviewed plugin
 * channel or image selection.  A changed channel is a terminal parent
 * failure and enters compensation; it is not a request to re-plan.
 */
export const matchesAcceptedPluginChannel = (
  plan: ServerProvisionNodePlan,
  catalog: readonly {
    readonly pluginId: string
    readonly activeVersion: string
    readonly selectionRevision: number
  }[],
) =>
  catalog.some(
    (entry) =>
      entry.pluginId === plan.pluginId &&
      entry.activeVersion === plan.pluginVersion &&
      entry.selectionRevision === plan.pluginSelectionRevision,
  )

/**
 * The parent has no provider mutation. It accepts retirement through the
 * existing destructive-lifecycle boundary and leaves dispatch until after the
 * plan repository has durably bound the exact child operation.
 */
export interface ServerProvisionRetirementPort {
  readonly acceptRetirement: (input: {
    readonly run: ServerProvisionRun
    readonly node: ServerProvisionCompensableNode
    readonly now: string
  }) => Effect.Effect<NodeLifecycleAcceptance, ServerProvisionPersistenceError>
  readonly startRetireWorkflow: (
    acceptance: NodeLifecycleAcceptance,
  ) => Effect.Effect<void, ServerProvisionPersistenceError>
}

const retirementOperationId = (parentOperationId: string) => `${parentOperationId}-retire`
const retirementIdempotencyKey = (parentOperationId: string) =>
  `server-provision-retire:${parentOperationId}`

export const makeServerProvisionRetirementPort = (
  bindings: ServerProvisionRuntimeBindings & CancellationRuntimeBindings,
): ServerProvisionRetirementPort => ({
  acceptRetirement: ({ run, node, now }) =>
    Effect.gen(function* () {
      if (run.actorRole !== 'owner' && run.actorRole !== 'administrator')
        return yield* new ServerProvisionPersistenceError({
          operation: 'server-provision.compensation.authority',
          message: 'Only the accepted Owner or Administrator can authorize automatic retirement',
        })
      return yield* makeTerminationControl(
        makeTerminationD1Repository(bindings.DB, {
          operationId: () => retirementOperationId(run.operationId),
          now: () => now,
          auditRequestContext: run.auditRequestContext,
        }),
        makeCancellationSignal(bindings),
      )
        .beginNodeLifecycle({
          organizationId: run.organizationId,
          actorId: run.actorId,
          role: run.actorRole,
          ...(run.actorMembershipRevision === undefined
            ? {}
            : { actorMembershipRevision: run.actorMembershipRevision }),
          correlationId: run.correlationId,
          idempotencyKey: retirementIdempotencyKey(run.operationId),
          action: 'retire-node',
          nodeId: node.nodeId,
          expectedNodeRevision: node.expectedNodeRevision,
          force: false,
          backupPolicy: 'required',
        })
        .pipe(
          Effect.mapError(
            () =>
              new ServerProvisionPersistenceError({
                operation: 'server-provision.compensation.accept',
                message: 'The accepted node retirement could not be durably adopted',
              }),
          ),
        )
    }),
  startRetireWorkflow: (acceptance) =>
    startRetireNodeWorkflow(bindings.DB, bindings.RETIRE_NODE, acceptance).pipe(
      Effect.asVoid,
      Effect.mapError(
        () =>
          new ServerProvisionPersistenceError({
            operation: 'server-provision.compensation.start',
            message: 'The accepted node retirement Workflow is pending reconciliation',
          }),
      ),
    ),
})

/**
 * Called only by the signed parent Workflow. Child controls remain the sole
 * writers for provider work and game capacity/port reservations.
 */
export const executeServerProvisionPlanStep = (input: {
  readonly bindings: ServerProvisionRuntimeBindings
  readonly payload: ServerProvisionWorkflowPayload
  readonly gameRepository: GameLifecycleRepository
  readonly gamePlanning: GameLifecyclePlanningD1Repository
  readonly retirement: ServerProvisionRetirementPort
  readonly now: string
}) =>
  Effect.gen(function* () {
    const repository = asExecutionRepository(input.bindings)
    const run = yield* repository.load(input.payload.organizationId, input.payload.operationId)
    if (
      run.resourceId !== input.payload.resourceId ||
      run.fingerprint !== input.payload.input.acceptanceFingerprint ||
      run.actorId !== input.payload.actorId ||
      run.correlationId !== input.payload.correlationId
    )
      return yield* Effect.fail(
        new Error('signed server provision Workflow payload does not match immutable acceptance'),
      )
    const compensate = (reason: string) =>
      Effect.gen(function* () {
        // Existing capacity was selected before this parent existed. It is
        // never retired or otherwise modified by a failed server plan.
        if (run.plan.kind === 'existing-node') {
          yield* repository.markFailed(run.organizationId, run.operationId, reason, input.now)
          return { status: 'completed' as const }
        }
        if (run.phase === 'compensated') return { status: 'completed' as const }
        const node = yield* repository.readCompensableNode(run.organizationId, run.operationId)
        const accepted = yield* input.retirement.acceptRetirement({ run, node, now: input.now })
        if (
          accepted.operation.id !== retirementOperationId(run.operationId) ||
          accepted.operation.organizationId !== run.organizationId ||
          accepted.nodeId !== node.nodeId
        )
          return yield* new ServerProvisionPersistenceError({
            operation: 'server-provision.compensation.accept',
            message: 'The retirement acceptance does not match the server plan child identity',
          })
        // This record is deliberately committed before Workflow dispatch. A
        // lost response after either transaction retries the same derived
        // child rather than creating or retiring another node.
        yield* repository.recordCompensation(
          run.organizationId,
          run.operationId,
          node.nodeId,
          accepted.operation.id,
          input.now,
        )
        // A failed start is not a false successful compensation. The exact
        // accepted child remains in `compensating` and the next workflow turn
        // can adopt its start record; the waiter never treats it as terminal.
        yield* Effect.result(input.retirement.startRetireWorkflow(accepted))
        return { status: 'completed' as const }
      })
    switch (input.payload.stepName) {
      case 'submit-node': {
        if (run.phase !== 'accepted') return { status: 'completed' as const }
        if (run.plan.kind === 'existing-node') {
          yield* repository.recordExistingNode(
            run.organizationId,
            run.operationId,
            run.plan.nodeId,
            input.now,
          )
          return { status: 'completed' as const }
        }
        // The node-control adapter verifies the persisted digest and rechecks
        // the exact reviewed account/allocation/catalog/image/policy facts
        // before it accepts a child. It never runs mutable candidate ranking.
        // A response loss adopts this same parent-scoped idempotency key and
        // reviewed fingerprint rather than creating a second paid node.
        const accepted = yield* makeNodeProvisionControlRuntime(
          input.bindings,
          run.auditRequestContext,
        )
          .submitAccepted(
            {
              organizationId: run.organizationId,
              actorId: run.actorId,
              actorRole: run.actorRole,
              idempotencyKey: childIdempotencyKey('node', run.operationId),
              correlationId: run.correlationId,
              intent: run.plan.nodeIntent,
            },
            run.plan.reviewedNodeProvision,
          )
          .pipe(
            Effect.mapError(
              () =>
                new ServerProvisionPersistenceError({
                  operation: 'server-provision.submit-node.reviewed-binding',
                  message: 'The reviewed node selection was rejected before child acceptance',
                }),
            ),
          )
        yield* repository.recordNodeProvision(
          run.organizationId,
          run.operationId,
          accepted.nodeId,
          accepted.operationId,
          input.now,
        )
        return { status: 'completed' as const }
      }
      case 'wait-node-ready': {
        const readiness = yield* repository.readNodeReadiness(
          run.organizationId,
          run.operationId,
          input.now,
        )
        if (readiness.state === 'failed') {
          // A no-fit parent owns a temporary node once submit-node has
          // recorded it.  Let the Workflow enter the exact retirement path
          // rather than terminally failing with paid infrastructure live.
          if (run.plan.kind === 'existing-node')
            yield* repository.markFailed(
              run.organizationId,
              run.operationId,
              readiness.reason ?? 'node provisioning failed',
              input.now,
            )
          return { status: 'failed' as const, reason: readiness.reason }
        }
        if (readiness.state === 'waiting')
          return { status: 'waiting' as const, reason: readiness.reason }
        yield* repository.markReadyForServer(run.organizationId, run.operationId, input.now)
        return { status: 'completed' as const }
      }
      case 'reserve-and-deploy': {
        if (run.gameOperationId !== undefined) return { status: 'completed' as const }
        const ready =
          run.nodeId === undefined
            ? yield* repository.load(run.organizationId, run.operationId)
            : run
        const nodeId = ready.nodeId
        if (nodeId === undefined || ready.phase !== 'ready-for-server')
          return {
            status: 'waiting' as const,
            reason: 'authoritative capacity readiness has not been recorded',
          }
        const intent = {
          ...ready.gameIntent,
          placement: { mode: ready.plan.placementMode, nodeId },
        }
        const facts = yield* input.gamePlanning.readPlanningFacts(ready.organizationId)
        const acceptedNoFitPlan = ready.plan.kind === 'provision-node' ? ready.plan : undefined
        const catalog =
          acceptedNoFitPlan === undefined
            ? facts.catalog
            : facts.catalog.filter(
                (entry) =>
                  entry.pluginId === acceptedNoFitPlan.pluginId &&
                  entry.activeVersion === acceptedNoFitPlan.pluginVersion &&
                  entry.selectionRevision === acceptedNoFitPlan.pluginSelectionRevision,
              )
        if (
          acceptedNoFitPlan !== undefined &&
          !matchesAcceptedPluginChannel(acceptedNoFitPlan, facts.catalog)
        )
          return {
            status: 'failed' as const,
            reason: 'reviewed plugin channel changed after node provisioning acceptance',
          }
        const plan = yield* planGameServer(ready.organizationId, intent, facts.nodes, catalog)
        const accepted = yield* input.gameRepository.create({
          organizationId: ready.organizationId,
          actorId: ready.actorId,
          auditRequestContext: ready.auditRequestContext,
          auditActorType: 'human',
          idempotencyKey: childIdempotencyKey('game', ready.operationId),
          correlationId: ready.correlationId,
          intent,
          plan,
        })
        yield* repository.recordGameProvision(
          ready.organizationId,
          ready.operationId,
          accepted.operation.serverId,
          accepted.operation.operationId,
          input.now,
        )
        yield* startOrAdoptGameLifecycleWorkflow(
          input.gamePlanning,
          facts.catalog,
          input.bindings.DEPLOY_GAME_SERVER,
          accepted,
        )
        return { status: 'completed' as const }
      }
      case 'wait-game-deployment': {
        const game = yield* repository.readGameStatus(
          run.organizationId,
          run.operationId,
          input.now,
        )
        if (game.state === 'failed') return { status: 'failed' as const, reason: game.reason }
        return game.state === 'succeeded'
          ? { status: 'completed' as const }
          : { status: 'waiting' as const, reason: game.reason }
      }
      case 'compensate-node':
        return yield* compensate('game deployment did not reach a verified terminal success')
      case 'wait-compensation': {
        if (run.plan.kind === 'existing-node')
          return run.phase === 'failed'
            ? { status: 'completed' as const }
            : { status: 'waiting' as const, reason: 'waiting for terminal failure audit' }
        if (run.phase === 'compensated') return { status: 'completed' as const }
        const compensation = yield* repository.readCompensationStatus(
          run.organizationId,
          run.operationId,
        )
        if (compensation.state === 'failed')
          return { status: 'failed' as const, reason: compensation.reason }
        if (compensation.state === 'waiting')
          return { status: 'waiting' as const, reason: compensation.reason }
        yield* repository.markCompensated(
          run.organizationId,
          run.operationId,
          'game deployment failed after the plan created new infrastructure',
          input.now,
        )
        return { status: 'completed' as const }
      }
    }
  })

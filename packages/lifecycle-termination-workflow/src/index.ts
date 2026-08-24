import { Effect, Schema } from 'effect'
import {
  CancellationSignalError,
  type CancellationSignalInput,
  type CancellationSignalReceipt,
  type OperationCancellationSignalShape,
  type TerminationWorkflowStartRepositoryShape,
  TerminationWorkflowStartError,
  type WorkflowStepEffectObservation,
  type WorkflowStepEffectReceipt,
  type WorkflowStepLease,
  type WorkflowStepRepositoryShape,
} from '@gridora/lifecycle-termination-control'
import { verifyInternalRequest } from '@gridora/auth-cloudflare-access'

export interface DestructiveWorkflowMetadata {
  readonly organizationId: string
  readonly operationId: string
  readonly workflowType: string
  readonly paramsFingerprint: string
}

export interface DestructiveWorkflowInstance {
  readonly id: string
  readonly metadata?: DestructiveWorkflowMetadata
}

export interface DestructiveWorkflowBinding {
  readonly create: (input: {
    readonly id: string
    readonly params: unknown
    readonly metadata: DestructiveWorkflowMetadata
  }) => Promise<DestructiveWorkflowInstance>
  readonly get: (id: string) => Promise<DestructiveWorkflowInstance>
}

export interface DestructiveWorkflowStartInput {
  readonly organizationId: string
  readonly operationId: string
  readonly startRecordId: string
  readonly workflowType: string
  readonly workflowInstanceId: string
  readonly paramsFingerprint: string
  readonly params: unknown
  readonly now: string
}

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  ('code' in cause || 'message' in cause) &&
  (String('code' in cause ? cause.code : '')
    .toLowerCase()
    .includes('already') ||
    String('message' in cause ? cause.message : '')
      .toLowerCase()
      .includes('already'))

const metadataMatches = (
  left: DestructiveWorkflowMetadata,
  right: DestructiveWorkflowMetadata | undefined,
): boolean =>
  right !== undefined &&
  left.organizationId === right.organizationId &&
  left.operationId === right.operationId &&
  left.workflowType === right.workflowType &&
  left.paramsFingerprint === right.paramsFingerprint

/**
 * Starts exactly the workflow recorded at acceptance. A create response loss never starts a second
 * instance: it is adopted only after the native instance metadata matches the durable start row.
 */
export const makeDestructiveWorkflowStarter = (
  repository: TerminationWorkflowStartRepositoryShape,
  binding: DestructiveWorkflowBinding,
) => ({
  start: (
    input: DestructiveWorkflowStartInput,
  ): Effect.Effect<'started' | 'adopted', TerminationWorkflowStartError> =>
    Effect.gen(function* () {
      const record = yield* repository
        .loadExact({
          organizationId: input.organizationId,
          operationId: input.operationId,
          startRecordId: input.startRecordId,
        })
        .pipe(
          Effect.mapError(
            () =>
              new TerminationWorkflowStartError({
                operationId: input.operationId,
                code: 'durable_start_record_unavailable',
              }),
          ),
        )
      if (
        record.workflowType !== input.workflowType ||
        record.workflowInstanceId !== input.workflowInstanceId ||
        record.workflowInstanceId !== input.operationId ||
        record.paramsFingerprint !== input.paramsFingerprint
      )
        return yield* Effect.fail(
          new TerminationWorkflowStartError({
            operationId: input.operationId,
            code: 'workflow_start_binding_mismatch',
          }),
        )
      const metadata: DestructiveWorkflowMetadata = {
        organizationId: input.organizationId,
        operationId: input.operationId,
        workflowType: input.workflowType,
        paramsFingerprint: input.paramsFingerprint,
      }
      const mark = (state: 'started' | 'adopted') =>
        repository
          .markStartedOrAdopted({
            organizationId: input.organizationId,
            operationId: input.operationId,
            startRecordId: input.startRecordId,
            state,
            now: input.now,
          })
          .pipe(
            Effect.mapError(
              () =>
                new TerminationWorkflowStartError({
                  operationId: input.operationId,
                  code: 'workflow_start_evidence_not_persisted',
                }),
            ),
          )
      const create = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            binding.create({
              id: input.operationId,
              params: input.params,
              metadata,
            }),
          catch: (cause) => cause,
        }),
      )
      if (create._tag === 'Success') {
        if (
          create.success.id !== input.operationId ||
          !metadataMatches(metadata, create.success.metadata)
        )
          return yield* Effect.fail(
            new TerminationWorkflowStartError({
              operationId: input.operationId,
              code: 'workflow_create_identity_mismatch',
            }),
          )
        yield* mark('started')
        return 'started' as const
      }
      // Both explicit already-exists and ambiguous transport failures take the same safe adoption
      // path. A lookup that cannot prove metadata remains pending in the start ledger.
      const existing = yield* Effect.result(
        Effect.tryPromise({ try: () => binding.get(input.operationId), catch: (cause) => cause }),
      )
      if (
        existing._tag === 'Success' &&
        existing.success.id === input.operationId &&
        metadataMatches(metadata, existing.success.metadata)
      ) {
        yield* mark('adopted')
        return 'adopted' as const
      }
      const code = isAlreadyExists(create.failure)
        ? 'workflow_existing_metadata_mismatch'
        : 'workflow_start_pending_reconciliation'
      yield* repository
        .recordStartFailure({
          organizationId: input.organizationId,
          operationId: input.operationId,
          startRecordId: input.startRecordId,
          code,
          now: input.now,
        })
        .pipe(Effect.ignore)
      return yield* Effect.fail(
        new TerminationWorkflowStartError({ operationId: input.operationId, code }),
      )
    }),
})

export interface ResourceOperationCancellationTarget {
  readonly requestCancellation: (input: {
    readonly organizationId: string
    readonly resourceId: string
    readonly operationId: string
    readonly resourceOperationDoName: string
  }) => Promise<{
    readonly operationId: string
    readonly resourceOperationDoName: string
    readonly accepted: boolean
  }>
}

export interface WorkflowCancellationTarget {
  readonly workflowType: string
  readonly requestCancellation: (input: {
    readonly organizationId: string
    readonly operationId: string
    readonly workflowInstanceId: string
    readonly workflowType: string
  }) => Promise<{
    readonly operationId: string
    readonly workflowInstanceId: string
    readonly workflowType: string
    readonly accepted: boolean
  }>
}

/**
 * No type-derived fallback is permitted here. Composition passes an explicit key-to-Workflow map
 * and both durable targets must acknowledge the exact stored ids before the receipt becomes true.
 */
export const makeExactCancellationSignal = (
  resourceOperation: ResourceOperationCancellationTarget,
  workflows: Readonly<Record<string, WorkflowCancellationTarget>>,
): OperationCancellationSignalShape => ({
  signal: (
    input: CancellationSignalInput,
  ): Effect.Effect<CancellationSignalReceipt, CancellationSignalError> =>
    Effect.gen(function* () {
      const workflow = workflows[input.workflowBinding]
      if (workflow === undefined || workflow.workflowType !== input.workflowType)
        return { resourceOperationSignalled: false, workflowSignalled: false }
      const resource = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            resourceOperation.requestCancellation({
              organizationId: input.organizationId,
              resourceId: input.resourceId,
              operationId: input.operationId,
              resourceOperationDoName: input.resourceOperationDoName,
            }),
          catch: () => new Error('resource operation cancellation delivery failed'),
        }),
      )
      const workflowResult = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            workflow.requestCancellation({
              organizationId: input.organizationId,
              operationId: input.operationId,
              workflowInstanceId: input.workflowInstanceId,
              workflowType: input.workflowType,
            }),
          catch: () => new Error('workflow cancellation delivery failed'),
        }),
      )
      return {
        resourceOperationSignalled:
          resource._tag === 'Success' &&
          resource.success.accepted &&
          resource.success.operationId === input.operationId &&
          resource.success.resourceOperationDoName === input.resourceOperationDoName,
        workflowSignalled:
          workflowResult._tag === 'Success' &&
          workflowResult.success.accepted &&
          workflowResult.success.operationId === input.operationId &&
          workflowResult.success.workflowInstanceId === input.workflowInstanceId &&
          workflowResult.success.workflowType === input.workflowType,
      }
    }),
})

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const TerminationWorkflowStepEnvelope = Schema.Struct({
  organizationId: Identifier,
  operationId: Identifier,
  workflowType: Identifier,
  workflowInstanceId: Identifier,
  stepName: Identifier,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  destructive: Schema.Boolean,
})
export type TerminationWorkflowStepEnvelope = typeof TerminationWorkflowStepEnvelope.Type

export class TerminationWorkflowStepError extends Schema.TaggedError<TerminationWorkflowStepError>()(
  'TerminationWorkflowStepError',
  { code: Schema.String },
) {}

export interface SignedTerminationWorkflowStepInput {
  readonly request: Request
  readonly secret: string
  readonly now: number
  readonly repository: WorkflowStepRepositoryShape
  /**
   * Performs the side effect with the supplied opaque lease as its provider/agent idempotency
   * identity, then returns only stable evidence of the observed outcome. It must not return until
   * the resource-operation owner can later observe this exact claim.
   */
  readonly execute: (
    envelope: TerminationWorkflowStepEnvelope,
    lease: WorkflowStepLease,
  ) => Effect.Effect<WorkflowStepEffectReceipt, TerminationWorkflowStepError>
  /**
   * Reconciles an expired claimant before a retry. `unknown` is deliberately non-executable;
   * this prevents a response loss after a paid provider mutation from becoming a second mutation.
   */
  readonly observeExpiredEffect: (input: {
    readonly envelope: TerminationWorkflowStepEnvelope
    readonly lease: WorkflowStepLease
  }) => Effect.Effect<WorkflowStepEffectObservation, TerminationWorkflowStepError>
  /** Injected for deterministic tests; production uses a cryptographically random opaque id. */
  readonly nextClaimId?: () => string
  /** Defaults to five minutes and is deliberately bounded away from an immediate reclaim. */
  readonly leaseDurationMs?: number
}

/**
 * Verifies the HMAC-bound workflow routing before claiming a step. A duplicate Workflow delivery
 * therefore returns adoption, an in-progress claimant executes no duplicate side effect, and a
 * cancellation request wins before execution.
 */
export const executeSignedTerminationWorkflowStep = (
  input: SignedTerminationWorkflowStepInput,
): Effect.Effect<
  { readonly status: 'completed' | 'adopted' | 'cancelled' },
  TerminationWorkflowStepError
> =>
  Effect.gen(function* () {
    yield* verifyInternalRequest(input.request, input.secret, input.now).pipe(
      Effect.mapError(
        () => new TerminationWorkflowStepError({ code: 'invalid_internal_signature' }),
      ),
    )
    const body = yield* Effect.tryPromise({
      try: () => input.request.text(),
      catch: () => new TerminationWorkflowStepError({ code: 'invalid_step_body' }),
    })
    const decoded = yield* Schema.decodeUnknownEffect(TerminationWorkflowStepEnvelope)(
      yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new TerminationWorkflowStepError({ code: 'invalid_step_body' }),
      }),
    ).pipe(Effect.mapError(() => new TerminationWorkflowStepError({ code: 'invalid_step_body' })))
    if (
      input.request.headers.get('x-gridora-workflow') !== decoded.workflowType ||
      input.request.headers.get('x-gridora-workflow-step') !== decoded.stepName ||
      input.request.headers.get('x-gridora-workflow-step-ordinal') !== String(decoded.ordinal) ||
      input.request.headers.get('x-gridora-organization-id') !== decoded.organizationId
    )
      return yield* Effect.fail(
        new TerminationWorkflowStepError({ code: 'workflow_routing_mismatch' }),
      )
    const now = new Date(input.now).toISOString()
    const leaseDurationMs = input.leaseDurationMs ?? 5 * 60_000
    if (
      !Number.isInteger(leaseDurationMs) ||
      leaseDurationMs < 30_000 ||
      leaseDurationMs > 60 * 60_000
    )
      return yield* Effect.fail(
        new TerminationWorkflowStepError({ code: 'invalid_workflow_step_lease' }),
      )
    const nextClaimId = input.nextClaimId ?? (() => crypto.randomUUID())
    const nextLease = (): WorkflowStepLease => ({
      claimId: nextClaimId(),
      // D1 assigns the monotonically fenced attempt; this placeholder is not sent with a claim.
      attempt: 0,
      expiresAt: new Date(input.now + leaseDurationMs).toISOString(),
    })
    const initialLease = nextLease()
    let claim = yield* input.repository
      .claimStep({
        ...decoded,
        claimId: initialLease.claimId,
        leaseExpiresAt: initialLease.expiresAt,
        now,
      })
      .pipe(
        Effect.mapError(
          () => new TerminationWorkflowStepError({ code: 'workflow_step_claim_failed' }),
        ),
      )
    if (claim.disposition === 'already-completed') return { status: 'adopted' as const }
    if (claim.disposition === 'in-progress')
      return yield* Effect.fail(
        new TerminationWorkflowStepError({ code: 'workflow_step_in_progress' }),
      )
    if (claim.disposition === 'cancelled') {
      yield* input.repository
        .finalizeCancellation({
          organizationId: decoded.organizationId,
          operationId: decoded.operationId,
          now,
        })
        .pipe(
          Effect.mapError(
            () => new TerminationWorkflowStepError({ code: 'cancellation_finalize_failed' }),
          ),
        )
      return { status: 'cancelled' as const }
    }
    if (claim.disposition === 'reconciliation-required') {
      if (claim.lease === undefined)
        return yield* Effect.fail(
          new TerminationWorkflowStepError({ code: 'workflow_step_claim_missing_lease' }),
        )
      const observation = yield* input.observeExpiredEffect({
        envelope: decoded,
        lease: claim.lease,
      })
      const replacementLease = nextLease()
      claim = yield* input.repository
        .resolveExpiredStepClaim({
          organizationId: decoded.organizationId,
          operationId: decoded.operationId,
          stepName: decoded.stepName,
          ordinal: decoded.ordinal,
          destructive: decoded.destructive,
          previousLease: claim.lease,
          observation,
          nextClaimId: replacementLease.claimId,
          nextLeaseExpiresAt: replacementLease.expiresAt,
          now,
        })
        .pipe(
          Effect.mapError(
            () => new TerminationWorkflowStepError({ code: 'workflow_step_reconciliation_failed' }),
          ),
        )
      if (claim.disposition === 'reconciliation-required')
        return yield* Effect.fail(
          new TerminationWorkflowStepError({ code: 'workflow_step_reconciliation_required' }),
        )
      if (claim.disposition === 'in-progress')
        return yield* Effect.fail(
          new TerminationWorkflowStepError({ code: 'workflow_step_in_progress' }),
        )
      if (claim.disposition === 'cancelled') {
        yield* input.repository
          .finalizeCancellation({
            organizationId: decoded.organizationId,
            operationId: decoded.operationId,
            now,
          })
          .pipe(
            Effect.mapError(
              () => new TerminationWorkflowStepError({ code: 'cancellation_finalize_failed' }),
            ),
          )
        return { status: 'cancelled' as const }
      }
      if (claim.disposition === 'already-completed') return { status: 'adopted' as const }
    }
    if (claim.lease === undefined)
      return yield* Effect.fail(
        new TerminationWorkflowStepError({ code: 'workflow_step_claim_missing_lease' }),
      )
    if (claim.disposition === 'execute') {
      const receipt = yield* input.execute(decoded, claim.lease)
      yield* input.repository
        .recordStepEffectReceipt({
          organizationId: decoded.organizationId,
          operationId: decoded.operationId,
          stepName: decoded.stepName,
          ordinal: decoded.ordinal,
          lease: claim.lease,
          receipt,
          now,
        })
        .pipe(
          Effect.mapError(
            () =>
              new TerminationWorkflowStepError({ code: 'workflow_step_effect_evidence_failed' }),
          ),
        )
    }
    // `effect-adopted` only appears after D1 has committed exact side-effect evidence. It is
    // therefore safe to complete without invoking the provider again.
    yield* input.repository
      .completeStep({
        organizationId: decoded.organizationId,
        operationId: decoded.operationId,
        stepName: decoded.stepName,
        ordinal: decoded.ordinal,
        lease: claim.lease,
        now,
      })
      .pipe(
        Effect.mapError(
          () => new TerminationWorkflowStepError({ code: 'workflow_step_complete_failed' }),
        ),
      )
    return { status: 'completed' as const }
  })

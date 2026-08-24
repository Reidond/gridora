import { Effect, Schema } from 'effect'
import { signInternalRequest, verifyInternalRequest } from '@gridora/auth-cloudflare-access'
import {
  NodeImageWorkflowStartError,
  type NodeImageAcceptance,
  type NodeImageWorkflowStarterShape,
} from '@gridora/node-image-control'

const WorkflowAction = Schema.Literals([
  'create',
  'test',
  'configure-scope',
  'register-provider',
  'promote',
  'rollback',
  'revoke',
])

export const NodeImageWorkflowPayload = Schema.Struct({
  operationId: Schema.String,
  workflowStartRecordId: Schema.String,
  requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  action: WorkflowAction,
  imageId: Schema.NullOr(Schema.String),
  scopeId: Schema.NullOr(Schema.String),
})
export type NodeImageWorkflowPayload = typeof NodeImageWorkflowPayload.Type

export interface NodeImageWorkflowMetadata {
  readonly operationId: string
  readonly workflowStartRecordId: string
  readonly requestFingerprint: string
  readonly action: NodeImageWorkflowPayload['action']
  readonly imageId: string | null
  readonly scopeId: string | null
}
export interface NodeImageWorkflowInstance {
  readonly id: string
  /** Native Workflow reads may omit params; D1 remains the authoritative params store. */
  readonly metadata?: NodeImageWorkflowMetadata | undefined
}
export interface NodeImageWorkflowBinding {
  readonly create: (options: {
    readonly id: string
    readonly params: NodeImageWorkflowPayload
  }) => Promise<NodeImageWorkflowInstance>
  readonly get: (id: string) => Promise<NodeImageWorkflowInstance>
}

const payloadFor = (acceptance: NodeImageAcceptance): NodeImageWorkflowPayload => ({
  operationId: acceptance.operation.id,
  workflowStartRecordId: acceptance.workflowStart.id,
  requestFingerprint: acceptance.operation.requestFingerprint,
  action: acceptance.operation.action,
  imageId: acceptance.operation.imageId,
  scopeId: acceptance.operation.scopeId,
})
const metadataFor = (payload: NodeImageWorkflowPayload): NodeImageWorkflowMetadata => ({
  ...payload,
})
const sameMetadata = (left: NodeImageWorkflowMetadata, right: NodeImageWorkflowMetadata) =>
  left.operationId === right.operationId &&
  left.workflowStartRecordId === right.workflowStartRecordId &&
  left.requestFingerprint === right.requestFingerprint &&
  left.action === right.action &&
  left.imageId === right.imageId &&
  left.scopeId === right.scopeId
const isAlreadyExists = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const detail = error as { readonly status?: unknown; readonly code?: unknown }
  return (
    detail.status === 409 ||
    detail.code === 409 ||
    detail.code === 'instance_already_exists' ||
    detail.code === 'WORKFLOW_INSTANCE_ALREADY_EXISTS'
  )
}
const failure = (operationId: string, message: string) =>
  new NodeImageWorkflowStartError({ operationId, message })

/** A Workflow binding is fixed in application composition; no route can select one. */
export const makeNodeImageWorkflowStarter = (
  binding: NodeImageWorkflowBinding,
): NodeImageWorkflowStarterShape => ({
  start: (acceptance) =>
    Effect.tryPromise({
      try: async () => {
        const payload = payloadFor(acceptance)
        if (
          acceptance.workflowStart.operationId !== acceptance.operation.id ||
          acceptance.workflowStart.workflowInstanceId !== acceptance.operation.id ||
          acceptance.workflowStart.paramsFingerprint !== acceptance.operation.requestFingerprint
        )
          throw failure(acceptance.operation.id, 'workflow_start_authoritative_mismatch')
        try {
          const created = await binding.create({ id: acceptance.operation.id, params: payload })
          if (created.id !== acceptance.operation.id)
            throw failure(acceptance.operation.id, 'workflow_start_identity_mismatch')
          return
        } catch (error) {
          if (error instanceof NodeImageWorkflowStartError) throw error
          if (!isAlreadyExists(error))
            throw failure(acceptance.operation.id, 'workflow_start_ambiguous_create')
        }
        let existing: NodeImageWorkflowInstance
        try {
          existing = await binding.get(acceptance.operation.id)
        } catch {
          throw failure(acceptance.operation.id, 'workflow_start_lookup_failed')
        }
        if (existing.id !== acceptance.operation.id)
          throw failure(acceptance.operation.id, 'workflow_start_identity_mismatch')
        // Cloudflare's native Workflow get only proves the fixed instance ID.
        // The D1 acceptance already binds all params to that ID. If a test
        // adapter does supply metadata, reject a mismatch; absence is normal
        // and must not make an accepted response-loss operation unrecoverable.
        if (
          existing.metadata !== undefined &&
          !sameMetadata(metadataFor(payload), existing.metadata)
        )
          throw failure(acceptance.operation.id, 'workflow_start_existing_metadata_mismatch')
      },
      catch: (error) =>
        error instanceof NodeImageWorkflowStartError
          ? error
          : failure(acceptance.operation.id, 'workflow_start_unavailable'),
    }),
})

export interface NodeImageSignedWorkflowStep {
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

const WorkflowStepEnvelope = Schema.Struct({
  operationId: Schema.String,
  workflowStartRecordId: Schema.String,
  requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  action: WorkflowAction,
  imageId: Schema.NullOr(Schema.String),
  scopeId: Schema.NullOr(Schema.String),
  stepName: Schema.Literal('apply-node-image-lifecycle'),
  ordinal: Schema.Literal(0),
})
export type NodeImageWorkflowStepEnvelope = typeof WorkflowStepEnvelope.Type

/**
 * D1 is the authority for a Workflow step. The signed body only locates an
 * exact reservation; it cannot choose a different action or provider scope.
 */
export interface NodeImageWorkflowReservationLoaderShape {
  readonly loadExact: (input: {
    readonly operationId: string
    readonly workflowStartRecordId: string
    readonly requestFingerprint: string
  }) => Effect.Effect<
    {
      readonly operationId: string
      readonly workflowStartRecordId: string
      readonly requestFingerprint: string
      readonly action: NodeImageWorkflowPayload['action']
      readonly imageId: string | null
      readonly scopeId: string | null
      readonly commandJson: string
    },
    unknown
  >
}
export interface NodeImageWorkflowStepExecutorShape {
  /**
   * This implementation must claim and complete/adopt the D1 step receipt
   * before it performs a provider mutation. It receives no caller authority.
   */
  readonly execute: (reservation: {
    readonly operationId: string
    readonly workflowStartRecordId: string
    readonly requestFingerprint: string
    readonly action: NodeImageWorkflowPayload['action']
    readonly imageId: string | null
    readonly scopeId: string | null
    readonly commandJson: string
  }) => Effect.Effect<
    { readonly status: 'completed' | 'adopted' | 'waiting-external' | 'failed-terminal' },
    unknown
  >
}
export class NodeImageWorkflowStepError extends Schema.TaggedError<NodeImageWorkflowStepError>()(
  'NodeImageWorkflowStepError',
  {
    code: Schema.Literals([
      'invalid_internal_signature',
      'invalid_step_body',
      'workflow_routing_mismatch',
      'workflow_reservation_mismatch',
      'workflow_reservation_unavailable',
      'workflow_execution_failed',
    ]),
  },
) {}

const stepError = (code: NodeImageWorkflowStepError['code']) =>
  new NodeImageWorkflowStepError({ code })

/**
 * Verify the HMAC-bound route, load the exact D1 operation, and compare every
 * coordinate before the executor can claim a side-effect receipt. This blocks
 * forged scope/action bodies and signed-body replay into another reservation.
 */
export const executeSignedNodeImageWorkflowStep = (input: {
  readonly request: Request
  readonly secret: string
  readonly now?: number
  readonly reservations: NodeImageWorkflowReservationLoaderShape
  readonly executor: NodeImageWorkflowStepExecutorShape
}): Effect.Effect<
  { readonly status: 'completed' | 'adopted' | 'waiting-external' | 'failed-terminal' },
  NodeImageWorkflowStepError
> =>
  Effect.gen(function* () {
    yield* verifyInternalRequest(input.request, input.secret, input.now).pipe(
      Effect.mapError(() => stepError('invalid_internal_signature')),
    )
    const raw = yield* Effect.tryPromise({
      try: () => input.request.text(),
      catch: () => stepError('invalid_step_body'),
    })
    const envelope = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => stepError('invalid_step_body'),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(WorkflowStepEnvelope, { onExcessProperty: 'error' })(value).pipe(
          Effect.mapError(() => stepError('invalid_step_body')),
        ),
      ),
    )
    if (
      input.request.headers.get('x-gridora-workflow') !== 'NodeImageLifecycleWorkflow' ||
      input.request.headers.get('x-gridora-workflow-step') !== envelope.stepName ||
      input.request.headers.get('x-gridora-workflow-step-ordinal') !== '0' ||
      input.request.headers.get('x-gridora-organization-id') !== 'platform'
    )
      return yield* stepError('workflow_routing_mismatch')
    const reservation = yield* input.reservations
      .loadExact({
        operationId: envelope.operationId,
        workflowStartRecordId: envelope.workflowStartRecordId,
        requestFingerprint: envelope.requestFingerprint,
      })
      .pipe(Effect.mapError(() => stepError('workflow_reservation_unavailable')))
    if (
      reservation.operationId !== envelope.operationId ||
      reservation.workflowStartRecordId !== envelope.workflowStartRecordId ||
      reservation.requestFingerprint !== envelope.requestFingerprint ||
      reservation.action !== envelope.action ||
      reservation.imageId !== envelope.imageId ||
      reservation.scopeId !== envelope.scopeId
    )
      return yield* stepError('workflow_reservation_mismatch')
    return yield* input.executor
      .execute(reservation)
      .pipe(Effect.mapError(() => stepError('workflow_execution_failed')))
  })
/**
 * The Workflow signs only immutable, D1-issued coordinates. The internal API
 * must re-verify the HMAC and call `loadExact` before any provider request.
 */
export const makeSignedNodeImageWorkflowStep = (
  payload: NodeImageWorkflowPayload,
  internalServiceSecret: string,
  now = Date.now(),
  nonce: string = crypto.randomUUID(),
): Effect.Effect<NodeImageSignedWorkflowStep, NodeImageWorkflowStartError> => {
  const body = JSON.stringify({
    operationId: payload.operationId,
    workflowStartRecordId: payload.workflowStartRecordId,
    requestFingerprint: payload.requestFingerprint,
    action: payload.action,
    imageId: payload.imageId,
    scopeId: payload.scopeId,
    stepName: 'apply-node-image-lifecycle',
    ordinal: 0,
  })
  return signInternalRequest(body, internalServiceSecret, now, nonce, {
    method: 'POST',
    path: '/v1/internal/node-image-workflow/execute',
    workflow: 'NodeImageLifecycleWorkflow',
    workflowStep: 'apply-node-image-lifecycle',
    workflowStepOrdinal: '0',
    organizationId: 'platform',
  }).pipe(
    Effect.map((headers) => ({
      body,
      headers: {
        'content-type': 'application/json',
        'x-gridora-workflow': 'NodeImageLifecycleWorkflow',
        'x-gridora-workflow-step': 'apply-node-image-lifecycle',
        'x-gridora-workflow-step-ordinal': '0',
        'x-gridora-organization-id': 'platform',
        ...headers,
      },
    })),
    Effect.mapError(
      () =>
        new NodeImageWorkflowStartError({
          operationId: payload.operationId,
          message: 'node_image_workflow_step_signing_failed',
        }),
    ),
  )
}

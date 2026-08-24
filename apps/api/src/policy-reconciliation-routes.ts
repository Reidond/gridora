import { Effect, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { ConflictError, PersistenceError } from '@gridora/contracts'
import type { GameLifecycleRepository } from '@gridora/game-lifecycle-control'
import {
  GameLifecycleD1Error,
  GameLifecycleIdempotencyConflictError,
  GameLifecycleRevisionConflictError,
} from '@gridora/game-lifecycle-d1'
import {
  PolicyActionExecutionError,
  PolicyReconciliationError,
  PolicyReconciliationResult,
  type PolicyActionExecutorShape,
  type PolicyReconciliationActionRecord,
  type PolicyReconciliationControlShape,
  type PolicyReconciliationResult as PolicyReconciliationResultType,
} from '@gridora/policy-reconciliation-control'
import {
  PolicyScheduleError,
  PolicyScheduleTask,
  type PolicyScheduleStore,
  type PolicyScheduleTask as PolicyScheduleTaskType,
} from '@gridora/policy-schedule'
import {
  TerminationAuthorizationError,
  TerminationConflictError,
  TerminationPersistenceError,
  TerminationValidationError,
  type TerminationControlShape,
} from '@gridora/lifecycle-termination-control'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

export class PolicyReconciliationRequestValidationError extends Schema.TaggedError<PolicyReconciliationRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

const invalid = (message: string) => new PolicyReconciliationRequestValidationError({ message })

/**
 * The real action adapter submits only to existing lifecycle acceptance boundaries.
 * An accepted receipt is not a provider, node-agent, or game-process success.
 */
export interface PolicyLifecycleActionExecutorDependencies {
  readonly gameLifecycle: GameLifecycleRepository
  readonly termination: TerminationControlShape
}

const dispatchReceipt = (input: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      actionId: Schema.String,
      operationId: Schema.String,
      disposition: Schema.Literals(['accepted', 'adopted']),
      workflowState: Schema.Literals(['started', 'pending-reconciliation']),
    }),
    { onExcessProperty: 'error' },
  )(input).pipe(
    Effect.mapError(
      () =>
        new PolicyActionExecutionError({
          code: 'unavailable',
          operation: 'policy-reconciliation.lifecycle.receipt',
        }),
    ),
  )

const executionFailure = (error: unknown, operation: string): PolicyActionExecutionError => {
  if (
    error instanceof TerminationConflictError ||
    error instanceof GameLifecycleRevisionConflictError
  )
    return new PolicyActionExecutionError({ code: 'stale-resource', operation })
  if (
    error instanceof TerminationValidationError ||
    error instanceof TerminationAuthorizationError ||
    error instanceof GameLifecycleIdempotencyConflictError
  )
    return new PolicyActionExecutionError({ code: 'policy-rejected', operation })
  // A D1 failure, transport ambiguity, or an unknown game-boundary error must
  // remain retryable. It cannot be reclassified as a successful side effect.
  if (error instanceof TerminationPersistenceError || error instanceof GameLifecycleD1Error)
    return new PolicyActionExecutionError({ code: 'unavailable', operation })
  return new PolicyActionExecutionError({ code: 'unavailable', operation })
}

const gameDispatch = (
  dependencies: PolicyLifecycleActionExecutorDependencies,
  action: PolicyReconciliationActionRecord,
) => {
  const intent =
    action.kind === 'shutdown-server'
      ? ({ action: 'stop' } as const)
      : action.kind === 'delete-server'
        ? ({ action: 'delete', backupPolicy: 'required' } as const)
        : action.configRevision === null || action.modRevision === null
          ? undefined
          : {
              action: 'update' as const,
              expectedConfigRevision: action.configRevision,
              expectedModRevision: action.modRevision,
              backupBeforeUpdate: true,
            }
  if (intent === undefined)
    return Effect.fail(
      new PolicyActionExecutionError({
        code: 'policy-rejected',
        operation: 'policy-reconciliation.game.update-binding',
      }),
    )
  return dependencies.gameLifecycle
    .mutate({
      organizationId: action.organizationId,
      actorId: action.actorId,
      auditActorType: 'system',
      auditRequestContext: {
        origin: 'scheduler',
        requestId: action.id,
        correlationId: action.correlationId,
        source: {
          ip: { state: 'not-available', reason: 'policy scheduler has no client IP' },
          access: { state: 'not-available', reason: 'policy scheduler has no Access assertion' },
        },
      } satisfies AuditRequestContextValue,
      idempotencyKey: action.idempotencyKey,
      correlationId: action.correlationId,
      serverId: action.resourceId,
      expectedRevision: action.resourceRevision,
      intent,
      policyReconciliationActionId: action.id,
    })
    .pipe(
      Effect.map((accepted) => ({
        actionId: action.id,
        operationId: accepted.operation.operationId,
        disposition:
          accepted.disposition === 'created' ? ('accepted' as const) : ('adopted' as const),
        workflowState: accepted.workflowState,
      })),
      Effect.mapError((error) => executionFailure(error, 'policy-reconciliation.game.accept')),
      Effect.flatMap(dispatchReceipt),
    )
}

/** The scheduler-only retire exception is bound to its exact pending action row. */
const retirementDispatch = (
  dependencies: PolicyLifecycleActionExecutorDependencies,
  action: PolicyReconciliationActionRecord,
) =>
  dependencies.termination
    .beginNodeLifecycle({
      organizationId: action.organizationId,
      actorId: action.actorId,
      role: 'automation',
      correlationId: action.correlationId,
      idempotencyKey: action.idempotencyKey,
      action: 'retire-node',
      nodeId: action.resourceId,
      expectedNodeRevision: action.resourceRevision,
      force: false,
      backupPolicy: 'required',
      policySchedulerRetire: { actionId: action.id },
    })
    .pipe(
      Effect.map((accepted) => ({
        actionId: action.id,
        operationId: accepted.operation.id,
        disposition:
          accepted.disposition === 'created' ? ('accepted' as const) : ('adopted' as const),
        workflowState:
          accepted.workflowStart.state === 'pending'
            ? ('pending-reconciliation' as const)
            : ('started' as const),
      })),
      Effect.mapError((error) =>
        executionFailure(error, 'policy-reconciliation.node-retirement.accept'),
      ),
      Effect.flatMap(dispatchReceipt),
    )

export const makePolicyLifecycleActionExecutor = (
  dependencies: PolicyLifecycleActionExecutorDependencies,
): PolicyActionExecutorShape => ({
  dispatch: (action) =>
    action.kind === 'retire-node'
      ? retirementDispatch(dependencies, action)
      : gameDispatch(dependencies, action),
})

export interface PolicyReconciliationRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Verify the fixed internal service identity over the raw body before decoding it. */
  readonly authenticate: (request: Request, rawBody: Uint8Array) => Effect.Effect<void, unknown, R>
  readonly schedule: (bindings: E['Bindings']) => Effect.Effect<PolicyScheduleStore, never, R>
  readonly control: (
    bindings: E['Bindings'],
  ) => Effect.Effect<PolicyReconciliationControlShape, never, R>
  /** Publish only redacted acceptance/rejection facts after authoritative D1 reconciliation. */
  readonly publish: (
    bindings: E['Bindings'],
    result: PolicyReconciliationResultType,
  ) => Effect.Effect<void, unknown, R>
}

export const readPolicyReconciliationBody = (request: Request, maximumBytes = 65_536) =>
  Effect.tryPromise({
    try: async () => {
      const declared = request.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
        throw new Error('The request body exceeds the policy reconciliation limit')
      if (request.body === null) return new Uint8Array()
      const reader = request.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const read = await reader.read()
        if (read.done) break
        size += read.value.byteLength
        if (size > maximumBytes) {
          await reader.cancel()
          throw new Error('The request body exceeds the policy reconciliation limit')
        }
        chunks.push(read.value)
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return body
    },
    catch: () => invalid('The request body is missing or exceeds the policy reconciliation limit'),
  })

const decodeTask = (body: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(body)) as unknown,
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(PolicyScheduleTask, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() => invalid('The request is not a scheduled policy reconciliation task')),
      ),
    ),
  )

const mapRouteError = (error: unknown) => {
  if (error instanceof PolicyReconciliationRequestValidationError) return error
  if (error instanceof PolicyScheduleError)
    return error.code === 'persistence-failed'
      ? new PersistenceError({
          operation: error.operation,
          message: 'Scheduled policy reconciliation state is unavailable',
        })
      : new ConflictError({
          code: error.code,
          message: 'The scheduled policy task is no longer current',
        })
  if (error instanceof PolicyReconciliationError)
    return error.code === 'persistence-failed'
      ? new PersistenceError({
          operation: error.operation,
          message: 'Policy reconciliation state is unavailable',
        })
      : new ConflictError({
          code: error.code,
          message: 'Policy reconciliation did not pass its authority fence',
        })
  return error
}

const routeBindingMatches = (request: Request, task: PolicyScheduleTaskType): boolean =>
  request.headers.get('x-gridora-workflow') === 'reconcile-policy' &&
  request.headers.get('x-gridora-organization-id') === task.organizationId &&
  request.headers.get('idempotency-key') === `workflow:${task.idempotencyKey}`

/**
 * Registers a deliberately internal, signed endpoint. The API composition root
 * supplies the real D1 stores, lifecycle executor, event publisher, and service
 * authentication; this module never accepts a caller-selected tenant or actor.
 */
export const registerPolicyReconciliationRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: PolicyReconciliationRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    '/v1/internal/policy-reconciliations/execute',
    handler((context) =>
      Effect.gen(function* () {
        const rawBody = yield* readPolicyReconciliationBody(context.req.raw)
        yield* dependencies.authenticate(context.req.raw, rawBody)
        const task = yield* decodeTask(rawBody)
        if (!routeBindingMatches(context.req.raw, task))
          return yield* invalid('Signed policy Workflow routing does not match the durable task')
        const schedule = yield* dependencies.schedule(context.env)
        yield* schedule.assertExecutionLease(task).pipe(Effect.mapError(mapRouteError))
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .reconcile({
            organizationId: task.organizationId,
            actorId: task.actorId,
            policyRevision: task.policyRevision,
            scheduleSlot: task.scheduleSlot,
            runId: task.runId,
            idempotencyKey: task.idempotencyKey,
            leaseToken: task.leaseToken,
          })
          .pipe(Effect.mapError(mapRouteError))
        yield* dependencies.publish(context.env, result)
        yield* schedule.complete(task).pipe(Effect.mapError(mapRouteError))
        return jsonResponse(result)
      }),
    ),
  )
  return app
}

export { PolicyReconciliationResult }

import { Effect, Schema } from 'effect'
import { AuditRequestContext, type AuditRequestContextValue } from '@gridora/audit-contracts'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import { IdempotencyKey, roleAtLeast, type OrganizationContext } from '@gridora/domain'
import {
  canonicalGameMutationPayload,
  GameLifecycleValidationError,
  GamePlacementError,
  GamePluginUnavailableError,
  canonicalGameMutationFingerprint,
  decodeGameCreateIntent,
  decodeGameMutationIntent,
  planGameServer,
  type GameCreateIntent as GameCreateIntentType,
  type GameLifecycleOperation,
  type GameLifecycleRepository,
} from '@gridora/game-lifecycle-control'
import {
  GameLifecycleD1Error,
  GameLifecycleIdempotencyConflictError,
  type GameLifecyclePlanningD1Repository,
  type GameLifecycleWorkflowData,
} from '@gridora/game-lifecycle-d1'
import {
  GameWorkflowPayload,
  type GameWorkflowPayload as GameWorkflowPayloadType,
} from '@gridora/game-lifecycle-execution'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import type { NativeLifecycleWorkflowBinding } from './lifecycle-runtime.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const PositiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export class GameLifecycleRequestValidationError extends Schema.TaggedError<GameLifecycleRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export type GameLifecycleRouteRole = 'operator' | 'administrator'

/**
 * The API root supplies one fixed native Workflow binding for each reviewed
 * action.  A request never supplies a binding name or a Workflow class.
 */
export interface GameLifecycleRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Resolves the route organization and enforces an active membership. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: GameLifecycleRouteRole,
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly repository: (bindings: E['Bindings']) => Effect.Effect<GameLifecycleRepository, never, R>
  readonly planning: (
    bindings: E['Bindings'],
  ) => Effect.Effect<GameLifecyclePlanningD1Repository, never, R>
  readonly workflow: (
    bindings: E['Bindings'],
    action: GameLifecycleOperation['action'],
  ) => NativeLifecycleWorkflowBinding | undefined
  /** The edge-owned request provenance used by strict v1 audit envelopes. */
  readonly auditRequestContext: (context: HonoContext<E>) => AuditRequestContextValue
}

type RequestFailure =
  | GameLifecycleRequestValidationError
  | AuthorizationError
  | ConflictError
  | NotFoundError
  | PersistenceError

const invalid = (message: string) => new GameLifecycleRequestValidationError({ message })

const decodeServerId = (value: string) =>
  Schema.decodeUnknownEffect(Identifier)(value).pipe(
    Effect.mapError(() => invalid('Server id does not match the API contract')),
  )

const decodeBodyJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  })

const decodeCreateBody = (request: Request) =>
  decodeBodyJson(request).pipe(
    Effect.flatMap((value) =>
      decodeGameCreateIntent(value).pipe(
        Effect.mapError(() => invalid('The request does not match the game create contract')),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeMutationBody = (request: Request) =>
  decodeBodyJson(request).pipe(
    Effect.flatMap((value) => {
      if (!isRecord(value)) return Effect.fail(invalid('The mutation body must be an object'))
      const expectedRevision = value.expectedRevision
      const withoutRevision = { ...value }
      delete withoutRevision.expectedRevision
      return Schema.decodeUnknownEffect(PositiveRevision)(expectedRevision).pipe(
        Effect.mapError(() => invalid('expectedRevision must be a positive integer')),
        Effect.flatMap((revision) =>
          decodeGameMutationIntent(withoutRevision).pipe(
            Effect.mapError(() => invalid('The request does not match the game mutation contract')),
            Effect.map((intent) => ({ expectedRevision: revision, intent })),
          ),
        ),
      )
    }),
  )

const requireRole = (actor: OrganizationContext, minimumRole: GameLifecycleRouteRole) =>
  roleAtLeast(actor.role, minimumRole)
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: `${minimumRole === 'administrator' ? 'Administrator' : 'Operator'} role is required`,
        }),
      )

const requireRouteOrganization = (actor: OrganizationContext, routeOrganization: string) =>
  routeOrganization === actor.organizationSlug || routeOrganization === actor.organizationId
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'membership_required',
          message: 'The authenticated membership does not belong to this organization',
        }),
      )

const mapGameError = (error: unknown): RequestFailure => {
  if (error instanceof GameLifecycleRequestValidationError) return error
  if (error instanceof AuthorizationError) return error
  if (error instanceof ConflictError) return error
  if (error instanceof NotFoundError) return error
  if (error instanceof PersistenceError) return error
  if (error instanceof GameLifecycleValidationError)
    return invalid('The request does not match the reviewed game lifecycle contract')
  if (error instanceof GamePluginUnavailableError)
    return new ConflictError({
      code: 'plugin_unavailable',
      message: 'The requested game plugin is not available in the reviewed build catalog',
    })
  if (error instanceof GamePlacementError)
    return new ConflictError({ code: error.code, message: error.message })
  if (error instanceof GameLifecycleIdempotencyConflictError)
    return new ConflictError({
      code: 'idempotency_conflict',
      message: 'The idempotency key was already used for a different request',
    })
  if (error instanceof GameLifecycleD1Error)
    return new PersistenceError({
      operation: error.operation,
      message: 'Authoritative game lifecycle state is unavailable',
    })
  return new PersistenceError({
    operation: 'game-lifecycle',
    message: 'Authoritative game lifecycle state is unavailable',
  })
}

const workflowExpiresAt = (createdAt: string): string | undefined => {
  const timestamp = Date.parse(createdAt)
  if (!Number.isFinite(timestamp)) return undefined
  return new Date(timestamp + 24 * 60 * 60 * 1000).toISOString()
}

const workflowPayload = (
  data: GameLifecycleWorkflowData,
  image: { readonly installer: string; readonly runtime: string },
): Effect.Effect<GameWorkflowPayloadType, GameLifecycleRequestValidationError> => {
  const expiresAt = workflowExpiresAt(data.createdAt)
  if (expiresAt === undefined)
    return Effect.fail(invalid('The accepted operation has an invalid creation timestamp'))
  const candidate = {
    schemaVersion: 1 as const,
    organizationId: data.organizationId,
    actorId: data.actorId,
    operationId: data.operationId,
    serverId: data.serverId,
    nodeId: data.nodeId,
    ...(data.targetNodeId === undefined ? {} : { targetNodeId: data.targetNodeId }),
    deploymentId: data.deploymentId,
    plugin: { id: data.pluginId, version: data.pluginVersion },
    image,
    ports: data.ports,
    resources: data.resources,
    config: data.config,
    mods: data.mods,
    configRevision: data.configRevision,
    modRevision: data.modRevision,
    expectedPriorRevision: data.expectedPriorRevision,
    action: data.action,
    expiresAt,
    ...(data.steamCredentialRef === undefined
      ? {}
      : { steamCredentialRef: data.steamCredentialRef }),
    ...(data.domain === undefined ? {} : { domain: data.domain }),
    ...(data.backupBeforeUpdate === undefined
      ? {}
      : { backupBeforeUpdate: data.backupBeforeUpdate }),
    ...(data.backupPolicy === undefined ? {} : { backupPolicy: data.backupPolicy }),
    ...(data.forcedCleanup === undefined ? {} : { forcedCleanup: data.forcedCleanup }),
    ...(data.movePhase === undefined ? {} : { movePhase: data.movePhase }),
    ...(data.moveSourcePreserved === undefined
      ? {}
      : { moveSourcePreserved: data.moveSourcePreserved }),
    ...(data.moveBackupId === undefined ? {} : { moveBackupId: data.moveBackupId }),
  }
  return Schema.decodeUnknownEffect(GameWorkflowPayload, { onExcessProperty: 'error' })(
    candidate,
  ).pipe(
    Effect.mapError(() =>
      invalid('The accepted operation cannot be represented by the game Workflow contract'),
    ),
  )
}

/** Rebuilds the exact accepted Workflow input from tenant D1 state. */
export const makeAuthoritativeGameWorkflowPayload = workflowPayload

/**
 * The Workflow receives a signed snapshot of the accepted move.  Its source
 * coordinates remain part of that acceptance boundary even after cutover,
 * while the coordinator-owned progress fields are deliberately mutable D1
 * evidence.  Comparing those progress fields would make a successful prior
 * step invalidate every subsequent Workflow turn.
 */
export const acceptedGameWorkflowPayload = (payload: GameWorkflowPayloadType) => {
  const {
    movePhase: _movePhase,
    moveSourcePreserved: _moveSourcePreserved,
    moveBackupId: _moveBackupId,
    ...accepted
  } = payload
  return accepted
}

/** Compares only immutable accepted Workflow coordinates and request facts. */
export const matchesAcceptedGameWorkflowPayload = (
  supplied: GameWorkflowPayloadType,
  authoritative: GameWorkflowPayloadType,
): boolean =>
  canonicalGameMutationPayload(acceptedGameWorkflowPayload(supplied)) ===
  canonicalGameMutationPayload(acceptedGameWorkflowPayload(authoritative))

type WorkflowStartState = 'started' | 'pending-reconciliation'

/**
 * Starts or adopts exactly the durable Workflow named by the accepted
 * operation.  Every error after the atomic D1 acceptance becomes a
 * pending-reconciliation response; no HTTP response claims execution began.
 */
export const startOrAdoptGameLifecycleWorkflow = (
  planning: GameLifecyclePlanningD1Repository,
  catalog: readonly {
    readonly pluginId: string
    readonly activeVersion: string
    readonly image: { readonly installer: string; readonly runtime: string }
  }[],
  binding: NativeLifecycleWorkflowBinding | undefined,
  acceptance: {
    readonly operation: GameLifecycleOperation
  },
): Effect.Effect<WorkflowStartState> =>
  Effect.gen(function* () {
    if (binding === undefined) return 'pending-reconciliation' as const
    const dataResult = yield* planning
      .readWorkflowData(acceptance.operation.organizationId, acceptance.operation.operationId)
      .pipe(Effect.result)
    if (dataResult._tag === 'Failure') return 'pending-reconciliation' as const
    const data = dataResult.success
    if (
      data.organizationId !== acceptance.operation.organizationId ||
      data.actorId !== acceptance.operation.actorId ||
      data.operationId !== acceptance.operation.operationId ||
      data.serverId !== acceptance.operation.serverId ||
      data.action !== acceptance.operation.action ||
      data.expectedPriorRevision !== acceptance.operation.expectedRevision
    )
      return 'pending-reconciliation' as const

    const lookup = (instance: { readonly id: string } | undefined) =>
      instance === undefined || instance.id !== data.operationId ? undefined : instance
    const existing = yield* Effect.tryPromise({
      try: async () => lookup(await binding.get(data.operationId)),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (existing !== undefined) {
      if (data.workflowState === 'pending') {
        const marked = yield* planning
          .markWorkflowStarted(data.organizationId, data.operationId)
          .pipe(Effect.result)
        return marked._tag === 'Success'
          ? ('started' as const)
          : ('pending-reconciliation' as const)
      }
      return 'started' as const
    }

    const image =
      data.image ??
      catalog.find(
        (entry) => entry.pluginId === data.pluginId && entry.activeVersion === data.pluginVersion,
      )?.image
    if (image === undefined) return 'pending-reconciliation' as const
    const payloadResult = yield* workflowPayload(data, image).pipe(Effect.result)
    if (payloadResult._tag === 'Failure') return 'pending-reconciliation' as const
    const params = {
      operationId: data.operationId,
      organizationId: data.organizationId,
      resourceId: data.serverId,
      resourceType: 'server' as const,
      actorId: data.actorId,
      correlationId: data.correlationId,
      idempotencyKey: data.idempotencyKey,
      input: payloadResult.success,
    }
    const created = yield* Effect.tryPromise({
      try: () => binding.create({ id: data.operationId, params }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (created !== undefined) {
      if (created.id !== data.operationId) return 'pending-reconciliation' as const
      const marked = yield* planning
        .markWorkflowStarted(data.organizationId, data.operationId)
        .pipe(Effect.result)
      return marked._tag === 'Success' ? ('started' as const) : ('pending-reconciliation' as const)
    }
    const adopted = yield* Effect.tryPromise({
      try: async () => lookup(await binding.get(data.operationId)),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (adopted === undefined) return 'pending-reconciliation' as const
    const marked = yield* planning
      .markWorkflowStarted(data.organizationId, data.operationId)
      .pipe(Effect.result)
    return marked._tag === 'Success' ? ('started' as const) : ('pending-reconciliation' as const)
  })

const assertAcceptedOperation = (
  actor: OrganizationContext,
  acceptance: { readonly operation: GameLifecycleOperation },
  serverId?: string,
) => {
  if (acceptance.operation.organizationId !== actor.organizationId)
    return Effect.fail(
      new PersistenceError({
        operation: 'game-lifecycle.acceptance',
        message: 'The accepted operation is not bound to the authenticated tenant and actor',
      }),
    )
  if (acceptance.operation.actorId !== actor.identityId)
    return Effect.fail(
      new ConflictError({
        code: 'idempotency_conflict',
        message: 'The idempotency key is bound to another actor',
      }),
    )
  if (serverId !== undefined && acceptance.operation.serverId !== serverId)
    return Effect.fail(
      new PersistenceError({
        operation: 'game-lifecycle.acceptance',
        message: 'The accepted operation is not bound to the requested server',
      }),
    )
  return Effect.void
}

const responseFor = (
  organization: string,
  acceptance: { readonly operation: GameLifecycleOperation },
) =>
  jsonResponse(
    {
      operationId: acceptance.operation.operationId,
      resourceId: acceptance.operation.serverId,
      // Replays expose the operation ledger's current state.  A response-loss
      // retry must not make a succeeded/failed operation look newly queued.
      status: acceptance.operation.state,
      links: {
        operation: `/v1/organizations/${encodeURIComponent(organization)}/operations/${encodeURIComponent(acceptance.operation.operationId)}`,
      },
    },
    202,
  )

const actionForPath = (value: string): GameLifecycleOperation['action'] | undefined => {
  if (
    value === 'start' ||
    value === 'stop' ||
    value === 'restart' ||
    value === 'update' ||
    value === 'apply-config' ||
    value === 'sync-mods' ||
    value === 'delete' ||
    value === 'move'
  )
    return value
  return undefined
}

/**
 * Standalone game lifecycle HTTP adapter.  The API root can register this
 * module once its auth, D1 repositories, and fixed Workflow bindings are
 * composed; this file intentionally does not edit that central composition.
 */
export const registerGameLifecycleRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: GameLifecycleRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) =>
    effectHandler<E, R, Failure>(
      (context) => dependencies.runtimeFor(context.env),
      (context) =>
        program(context).pipe(
          Effect.provideService(AuditRequestContext, dependencies.auditRequestContext(context)),
        ) as Effect.Effect<Response, Failure, R>,
    )

  const collectionPath = '/v1/organizations/:organization/game-servers'
  const memberPath = `${collectionPath}/:serverId`

  const authorizeRequest = (context: HonoContext<E>, minimumRole: GameLifecycleRouteRole) =>
    Effect.gen(function* () {
      const actor = yield* dependencies.authorize(context, minimumRole)
      yield* requireRole(actor, minimumRole)
      yield* requireRouteOrganization(actor, context.req.param('organization') ?? '')
      return actor
    })

  const submitMutation = (
    context: HonoContext<E>,
    expectedAction: GameLifecycleOperation['action'],
  ): Effect.Effect<Response, RequestFailure, R> =>
    Effect.gen(function* () {
      const actor = yield* authorizeRequest(
        context,
        expectedAction === 'delete' ? 'administrator' : 'operator',
      ).pipe(Effect.mapError(mapGameError))
      const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
      const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
      const auditRequestContext = dependencies.auditRequestContext(context)
      const body = yield* decodeMutationBody(context.req.raw)
      if (body.intent.action !== expectedAction)
        return yield* invalid(`The request action must be ${expectedAction}`)
      const repository = yield* dependencies.repository(context.env)
      const accepted = yield* repository
        .mutate({
          organizationId: actor.organizationId,
          actorId: actor.identityId,
          auditRequestContext,
          auditActorType: 'human',
          idempotencyKey,
          correlationId: actor.correlationId,
          serverId,
          expectedRevision: body.expectedRevision,
          intent: body.intent,
        })
        .pipe(Effect.mapError(mapGameError))
      yield* assertAcceptedOperation(actor, accepted, serverId)

      const planning = yield* dependencies.planning(context.env)
      const factsResult = yield* planning
        .readPlanningFacts(actor.organizationId)
        .pipe(Effect.result)
      const catalog = factsResult._tag === 'Success' ? factsResult.success.catalog : []
      yield* startOrAdoptGameLifecycleWorkflow(
        planning,
        catalog,
        dependencies.workflow(context.env, accepted.operation.action),
        accepted,
      )
      return responseFor(context.req.param('organization') ?? actor.organizationSlug, accepted)
    })

  app.post(
    collectionPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* authorizeRequest(context, 'operator').pipe(
          Effect.mapError(mapGameError),
        )
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const auditRequestContext = dependencies.auditRequestContext(context)
        const intent = yield* decodeCreateBody(context.req.raw)
        const requestFingerprint = yield* Effect.tryPromise({
          try: () =>
            canonicalGameMutationFingerprint({
              action: 'create',
              organizationId: actor.organizationId,
              intent,
            }),
          catch: () =>
            new PersistenceError({
              operation: 'game-lifecycle.create.fingerprint',
              message: 'The create request fingerprint could not be computed',
            }),
        }).pipe(Effect.mapError(mapGameError))
        const repository = yield* dependencies.repository(context.env)
        // Idempotency is checked before any dynamic planning facts.  A retry
        // after response loss must adopt the original accepted operation even
        // when capacity or the reviewed catalog has changed since acceptance.
        const replay = yield* repository
          .findIdempotent(actor.organizationId, idempotencyKey, requestFingerprint)
          .pipe(Effect.mapError(mapGameError))
        if (replay !== null) {
          yield* assertAcceptedOperation(actor, replay)
          const planning = yield* dependencies.planning(context.env)
          yield* startOrAdoptGameLifecycleWorkflow(
            planning,
            [],
            dependencies.workflow(context.env, replay.operation.action),
            replay,
          )
          return responseFor(context.req.param('organization') ?? actor.organizationSlug, replay)
        }
        const planning = yield* dependencies.planning(context.env)
        const facts = yield* planning
          .readPlanningFacts(actor.organizationId)
          .pipe(Effect.mapError(mapGameError))
        const plan = yield* planGameServer(
          actor.organizationId,
          intent as GameCreateIntentType,
          facts.nodes,
          facts.catalog,
        ).pipe(Effect.mapError(mapGameError))
        const accepted = yield* repository
          .create({
            organizationId: actor.organizationId,
            actorId: actor.identityId,
            auditRequestContext,
            auditActorType: 'human',
            idempotencyKey,
            correlationId: actor.correlationId,
            intent,
            plan,
          })
          .pipe(Effect.mapError(mapGameError))
        yield* assertAcceptedOperation(actor, accepted)
        yield* startOrAdoptGameLifecycleWorkflow(
          planning,
          facts.catalog,
          dependencies.workflow(context.env, accepted.operation.action),
          accepted,
        )
        return responseFor(context.req.param('organization') ?? actor.organizationSlug, accepted)
      }),
    ),
  )

  app.delete(
    memberPath,
    handler((context) => submitMutation(context, 'delete')),
  )

  // PATCH is the logical server-update alias from the product contract.  It
  // accepts the same strict update DTO as the explicit action endpoint and is
  // persisted through the exact operation/revision/idempotency fence; no
  // provider, node, image, or deployment fields are accepted here.
  app.patch(
    memberPath,
    handler((context) => submitMutation(context, 'update')),
  )

  for (const action of ['start', 'stop', 'restart', 'update', 'move'] as const)
    app.post(
      `${memberPath}/actions/${action}`,
      handler((context) => submitMutation(context, action)),
    )

  // File validation deliberately uses the reviewed update command because
  // SteamCMD's validate operation can repair bytes and advance the installed
  // build. It is therefore audited as a mutation, never as a read-only check.
  app.post(
    `${memberPath}/actions/validate-files`,
    handler((context) => submitMutation(context, 'update')),
  )
  app.post(
    `${memberPath}/actions/force-cleanup`,
    handler((context) => submitMutation(context, 'delete')),
  )

  app.post(
    `${memberPath}/config`,
    handler((context) => submitMutation(context, 'apply-config')),
  )
  app.put(
    `${memberPath}/mods`,
    handler((context) => submitMutation(context, 'sync-mods')),
  )

  return app
}

export { GameWorkflowPayload }
export { actionForPath }

import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import { IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import {
  commercialReviewTokenFromManifestInput,
  GameServerCloneInput,
  GameServerDraftScheduleInput,
  decodeGameServerManifestInput,
  GameServerManifestIdempotencyConflictError,
  GameServerManifestNotFoundError,
  GameServerManifestPersistenceError,
  GameServerManifestRevisionConflictError,
  GameServerManifestValidationError,
  manifestFromDesiredSpec,
  manifestToServerApplyIntent,
  manifestToServerCreateIntent,
  normalizeGameServerManifest,
  planExistingGameServerManifest,
  type GameServerManifest,
  type GameServerManifestApplyResponse as ManifestApplyResponse,
  type GameServerManifestPlanResponse as ManifestPlanResponse,
  type GameServerManifestRepository,
  type GameServerDraftRepository,
  type GameServerManifestStoredState,
} from '@gridora/game-server-manifest-control'
import {
  GameLifecycleValidationError,
  canonicalGameMutationFingerprint,
  GamePlacementError,
  GamePluginUnavailableError,
  type GameLifecycleOperation,
  type GameLifecycleRepository,
} from '@gridora/game-lifecycle-control'
import {
  GameLifecycleD1Error,
  GameLifecycleIdempotencyConflictError,
  GameLifecycleRevisionConflictError,
} from '@gridora/game-lifecycle-d1'
import type { GameLifecyclePlanningD1Repository } from '@gridora/game-lifecycle-d1'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  type ServerPlanControlShape,
  type ServerProvisionPlanControlShape,
} from '@gridora/server-plan-control'
import type { NativeLifecycleWorkflowBinding } from './lifecycle-runtime.js'
import { startOrAdoptGameLifecycleWorkflow } from './game-lifecycle-routes.js'
import { mapServerApplyError, ServerPlanRequestValidationError } from './server-plan-routes.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

export class GameServerManifestRequestValidationError extends Schema.TaggedError<GameServerManifestRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

type ManifestRouteRole = 'viewer' | 'operator'
type AuthorizedContext = OrganizationContext & { readonly membershipRevision?: number }

export interface GameServerManifestRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: ManifestRouteRole,
  ) => Effect.Effect<AuthorizedContext, unknown, R>
  readonly repository: (
    bindings: E['Bindings'],
  ) => Effect.Effect<GameServerManifestRepository, never, R>
  readonly draftRepository?: (
    bindings: E['Bindings'],
  ) => Effect.Effect<GameServerDraftRepository, never, R>
  readonly serverPlan: (bindings: E['Bindings']) => Effect.Effect<ServerPlanControlShape, never, R>
  readonly provisionControl: (
    bindings: E['Bindings'],
    serverPlan: ServerPlanControlShape,
  ) => Effect.Effect<ServerProvisionPlanControlShape, PersistenceError, R>
  readonly lifecycle: (bindings: E['Bindings']) => Effect.Effect<GameLifecycleRepository, never, R>
  readonly lifecyclePlanning: (
    bindings: E['Bindings'],
  ) => Effect.Effect<GameLifecyclePlanningD1Repository, never, R>
  readonly lifecycleWorkflow: (
    bindings: E['Bindings'],
    action: GameLifecycleOperation['action'],
  ) => NativeLifecycleWorkflowBinding | undefined
  readonly auditRequestContext: (context: HonoContext<E>) => AuditRequestContextValue
}

type RequestFailure =
  | GameServerManifestRequestValidationError
  | AuthorizationError
  | ConflictError
  | NotFoundError
  | PersistenceError

const invalid = (message: string) => new GameServerManifestRequestValidationError({ message })

const decodeServerId = (value: string) =>
  Schema.decodeUnknownEffect(Identifier)(value).pipe(
    Effect.mapError(() => invalid('Server id does not match the API contract')),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

const decodeManifest = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap(decodeGameServerManifestInput),
    Effect.flatMap((input) =>
      normalizeGameServerManifest(input).pipe(
        Effect.map((manifest) => ({
          manifest,
          ...(commercialReviewTokenFromManifestInput(input) === undefined
            ? {}
            : { commercialReviewToken: commercialReviewTokenFromManifestInput(input)! }),
        })),
      ),
    ),
    Effect.mapError(() =>
      invalid('The request does not match the GameServer v1alpha1 manifest contract'),
    ),
  )

const decodeScheduleInput = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(GameServerDraftScheduleInput, { onExcessProperty: 'error' })(
        value,
      ),
    ),
    Effect.mapError(() => invalid('The request does not match the one-shot schedule contract')),
  )

const decodeCloneInput = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(GameServerCloneInput, { onExcessProperty: 'error' })(value),
    ),
    Effect.mapError(() => invalid('The request does not match the clone contract')),
  )

const requireOperator = (actor: AuthorizedContext) =>
  actor.role === 'operator' || actor.role === 'administrator' || actor.role === 'owner'
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: 'Operator role is required',
        }),
      )

const requireRouteOrganization = (actor: AuthorizedContext, routeOrganization: string) =>
  routeOrganization === actor.organizationSlug || routeOrganization === actor.organizationId
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'membership_required',
          message: 'The authenticated membership does not belong to this organization',
        }),
      )

const requireManifestOrganization = (actor: AuthorizedContext, manifest: GameServerManifest) =>
  manifest.metadata.organization === actor.organizationSlug ||
  manifest.metadata.organization === actor.organizationId
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'membership_required',
          message: 'Manifest metadata.organization does not match the authenticated organization',
        }),
      )

const mapManifestError = (error: unknown): RequestFailure => {
  if (error instanceof GameServerManifestRequestValidationError) return error
  if (error instanceof AuthorizationError) return error
  if (error instanceof ConflictError) return error
  if (error instanceof NotFoundError) return error
  if (error instanceof PersistenceError) return error
  if (error instanceof GameServerManifestValidationError)
    return invalid('The request does not match the GameServer v1alpha1 manifest contract')
  if (error instanceof GameServerManifestNotFoundError)
    return new NotFoundError({ resource: 'game-server', id: error.server })
  if (error instanceof GameServerManifestIdempotencyConflictError)
    return new ConflictError({
      code: 'idempotency_conflict',
      message: 'Idempotency-Key was already used with a different manifest apply request',
    })
  if (error instanceof GameServerManifestRevisionConflictError)
    return new ConflictError({
      code: 'revision_conflict',
      message: 'The game server desired revision changed; request a fresh manifest plan',
    })
  if (error instanceof GameServerManifestPersistenceError)
    return new PersistenceError({
      operation: error.operation,
      message: 'Authoritative declarative game-server state is unavailable',
    })
  return new PersistenceError({
    operation: 'game-server-manifest',
    message: 'Declarative game-server state is unavailable',
  })
}

const mapLifecycleError = (error: unknown): RequestFailure => {
  if (error instanceof GameLifecycleValidationError)
    return invalid('The manifest cannot be represented by the reviewed game lifecycle contract')
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
      message: 'Idempotency-Key was already used for a different game lifecycle request',
    })
  if (error instanceof GameLifecycleRevisionConflictError)
    return new ConflictError({
      code: 'revision_conflict',
      message: 'The game server desired revision changed; request a fresh manifest plan',
    })
  if (error instanceof GameLifecycleD1Error)
    return new PersistenceError({
      operation: error.operation,
      message: 'Authoritative game lifecycle state is unavailable',
    })
  return mapManifestError(error)
}

const mapProvisionError = (error: unknown): RequestFailure => {
  const mapped = mapServerApplyError(error)
  return mapped instanceof ServerPlanRequestValidationError
    ? invalid('The manifest cannot be represented by the server provisioning contract')
    : mapped
}

type ExistingResolution = {
  readonly kind: 'existing'
  readonly state: GameServerManifestStoredState
}
type NewResolution = { readonly kind: 'new' }

const resolveManifestTarget = (
  repository: GameServerManifestRepository,
  actor: AuthorizedContext,
  manifest: GameServerManifest,
): Effect.Effect<ExistingResolution | NewResolution, unknown> =>
  manifest.metadata.serverId === undefined
    ? repository
        .readByName(actor.organizationId, manifest.metadata.name)
        .pipe(
          Effect.map((state) =>
            state === null ? ({ kind: 'new' } as const) : ({ kind: 'existing', state } as const),
          ),
        )
    : repository
        .readById(actor.organizationId, manifest.metadata.serverId)
        .pipe(Effect.map((state) => ({ kind: 'existing' as const, state })))

const lifecycleAcceptance = (
  actor: AuthorizedContext,
  serverId: string,
  acceptance: { readonly operation: GameLifecycleOperation },
) => {
  if (
    acceptance.operation.organizationId !== actor.organizationId ||
    acceptance.operation.actorId !== actor.identityId ||
    acceptance.operation.serverId !== serverId
  )
    return Effect.fail(
      new PersistenceError({
        operation: 'game-server-manifest.lifecycle.acceptance',
        message:
          'The accepted lifecycle operation is not bound to this manifest, actor, and organization',
      }),
    )
  return Effect.succeed(acceptance)
}

const serverPlanRole = (
  actor: AuthorizedContext,
): 'owner' | 'administrator' | 'operator' | 'viewer' =>
  actor.role === 'automation' ? 'viewer' : actor.role

/**
 * Declarative manifest API. Existing targets are always resolved before any
 * create plan so an export→plan round trip can be a true no-op and never
 * silently creates a duplicate.
 */
export const registerGameServerManifestRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: GameServerManifestRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  const authorize = (context: HonoContext<E>, minimumRole: ManifestRouteRole) =>
    Effect.gen(function* () {
      const actor = yield* dependencies.authorize(context, minimumRole)
      yield* requireRouteOrganization(actor, context.req.param('organization') ?? '')
      if (minimumRole === 'operator') yield* requireOperator(actor)
      return actor
    })

  const planNew = (
    context: HonoContext<E>,
    actor: AuthorizedContext,
    manifest: GameServerManifest,
  ): Effect.Effect<ManifestPlanResponse, RequestFailure, R> =>
    Effect.gen(function* () {
      const serverPlan = yield* dependencies.serverPlan(context.env)
      const provision = yield* dependencies.provisionControl(context.env, serverPlan)
      const plan = yield* provision
        .plan({
          context: {
            organizationId: actor.organizationId,
            actorId: actor.identityId,
            actorRole: serverPlanRole(actor),
            correlationId: actor.correlationId,
            ...(actor.membershipRevision === undefined
              ? {}
              : { actorMembershipRevision: actor.membershipRevision }),
          },
          intent: manifestToServerCreateIntent(manifest),
        })
        .pipe(Effect.mapError(mapProvisionError))
      return { kind: 'create', plan }
    })

  const startLifecycle = (
    context: HonoContext<E>,
    acceptance: { readonly operation: GameLifecycleOperation },
  ) =>
    Effect.gen(function* () {
      const planning = yield* dependencies.lifecyclePlanning(context.env)
      const facts = yield* planning
        .readPlanningFacts(acceptance.operation.organizationId)
        .pipe(Effect.result)
      const catalog = facts._tag === 'Success' ? facts.success.catalog : []
      return yield* startOrAdoptGameLifecycleWorkflow(
        planning,
        catalog,
        dependencies.lifecycleWorkflow(context.env, acceptance.operation.action),
        acceptance,
      )
    })

  const planPath = '/v1/organizations/:organization/game-server-manifests/plan'
  const applyPath = '/v1/organizations/:organization/game-server-manifests/apply'
  const validatePath = '/v1/organizations/:organization/game-server-manifests/validate'
  const draftsPath = '/v1/organizations/:organization/game-server-drafts'
  const exportPath = '/v1/organizations/:organization/game-servers/:serverId/manifest'

  app.post(
    validatePath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* authorize(context, 'operator').pipe(Effect.mapError(mapManifestError))
        const decoded = yield* decodeManifest(context.req.raw)
        yield* requireManifestOrganization(actor, decoded.manifest)
        return jsonResponse({ valid: true as const, manifest: decoded.manifest })
      }),
    ),
  )

  if (dependencies.draftRepository !== undefined) {
    app.post(
      draftsPath,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* authorize(context, 'operator').pipe(
            Effect.mapError(mapManifestError),
          )
          const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
          const decoded = yield* decodeManifest(context.req.raw)
          yield* requireManifestOrganization(actor, decoded.manifest)
          const repository = yield* dependencies.draftRepository!(context.env)
          const draft = yield* repository
            .create({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              correlationId: actor.correlationId,
              auditRequestContext: dependencies.auditRequestContext(context),
              idempotencyKey,
              manifest: decoded.manifest,
            })
            .pipe(Effect.mapError(mapManifestError))
          return jsonResponse({ draft }, 201)
        }),
      ),
    )

    app.get(
      `${draftsPath}/:draftId`,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* authorize(context, 'viewer').pipe(Effect.mapError(mapManifestError))
          const draftId = yield* decodeServerId(context.req.param('draftId') ?? '')
          const repository = yield* dependencies.draftRepository!(context.env)
          const draft = yield* repository
            .read(actor.organizationId, draftId)
            .pipe(Effect.mapError(mapManifestError))
          return jsonResponse({ draft })
        }),
      ),
    )

    app.post(
      `${draftsPath}/:draftId/actions/schedule`,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* authorize(context, 'operator').pipe(
            Effect.mapError(mapManifestError),
          )
          const draftId = yield* decodeServerId(context.req.param('draftId') ?? '')
          const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
          const input = yield* decodeScheduleInput(context.req.raw)
          const scheduledAt = Date.parse(input.scheduledFor)
          const now = Date.now()
          if (
            !Number.isFinite(scheduledAt) ||
            new Date(scheduledAt).toISOString() !== input.scheduledFor ||
            scheduledAt <= now ||
            scheduledAt > now + 366 * 24 * 60 * 60_000
          )
            return yield* invalid(
              'scheduledFor must be an exact future UTC timestamp within one year',
            )
          const repository = yield* dependencies.draftRepository!(context.env)
          const schedule = yield* repository
            .schedule({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              correlationId: actor.correlationId,
              auditRequestContext: dependencies.auditRequestContext(context),
              idempotencyKey,
              draftId,
              expectedRevision: input.expectedRevision,
              scheduledFor: input.scheduledFor,
            })
            .pipe(Effect.mapError(mapManifestError))
          return jsonResponse({ schedule }, 202)
        }),
      ),
    )

    app.post(
      '/v1/organizations/:organization/game-servers/:serverId/actions/clone',
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* authorize(context, 'operator').pipe(
            Effect.mapError(mapManifestError),
          )
          const sourceServerId = yield* decodeServerId(context.req.param('serverId') ?? '')
          const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
          const input = yield* decodeCloneInput(context.req.raw)
          const manifestRepository = yield* dependencies.repository(context.env)
          const source = yield* manifestRepository
            .readById(actor.organizationId, sourceServerId)
            .pipe(Effect.mapError(mapManifestError))
          const exported = manifestFromDesiredSpec({
            organization: actor.organizationSlug,
            serverId: source.serverId,
            name: source.name,
            spec: source.spec,
          })
          const cloneManifest: GameServerManifest = {
            ...exported,
            metadata: { name: input.name, organization: actor.organizationSlug },
            spec: {
              ...exported.spec,
              ...(input.placement === undefined ? {} : { placement: input.placement }),
              endpoint: input.domain === undefined ? {} : { domain: input.domain.toLowerCase() },
            },
          }
          const draftKeyDigest = yield* Effect.tryPromise({
            try: () =>
              canonicalGameMutationFingerprint({
                action: 'clone-draft',
                organizationId: actor.organizationId,
                sourceServerId,
                idempotencyKey,
              }),
            catch: () => invalid('The clone idempotency fingerprint could not be computed'),
          })
          const draftRepository = yield* dependencies.draftRepository!(context.env)
          const draft = yield* draftRepository
            .create({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              correlationId: actor.correlationId,
              auditRequestContext: dependencies.auditRequestContext(context),
              idempotencyKey: `clone-draft:${draftKeyDigest}`,
              manifest: cloneManifest,
              sourceServerId,
            })
            .pipe(Effect.mapError(mapManifestError))
          const serverPlan = yield* dependencies.serverPlan(context.env)
          const provision = yield* dependencies.provisionControl(context.env, serverPlan)
          const acceptance = yield* provision
            .apply({
              context: {
                organizationId: actor.organizationId,
                actorId: actor.identityId,
                actorRole: serverPlanRole(actor),
                correlationId: actor.correlationId,
                ...(actor.membershipRevision === undefined
                  ? {}
                  : { actorMembershipRevision: actor.membershipRevision }),
              },
              idempotencyKey,
              intent: manifestToServerApplyIntent(cloneManifest),
              auditRequestContext: dependencies.auditRequestContext(context),
            })
            .pipe(Effect.mapError(mapProvisionError))
          return jsonResponse({ sourceServerId, cloneDraftId: draft.id, acceptance }, 202)
        }),
      ),
    )
  }

  app.get(
    exportPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* authorize(context, 'viewer').pipe(Effect.mapError(mapManifestError))
        const serverId = yield* decodeServerId(context.req.param('serverId') ?? '')
        const repository = yield* dependencies.repository(context.env)
        const stored = yield* repository
          .readById(actor.organizationId, serverId)
          .pipe(Effect.mapError(mapManifestError))
        return jsonResponse(
          manifestFromDesiredSpec({
            organization: actor.organizationSlug,
            serverId: stored.serverId,
            name: stored.name,
            spec: stored.spec,
          }),
        )
      }),
    ),
  )

  app.post(
    planPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* authorize(context, 'operator').pipe(Effect.mapError(mapManifestError))
        const decoded = yield* decodeManifest(context.req.raw)
        yield* requireManifestOrganization(actor, decoded.manifest)
        const repository = yield* dependencies.repository(context.env)
        const target = yield* resolveManifestTarget(repository, actor, decoded.manifest).pipe(
          Effect.mapError(mapManifestError),
        )
        const response =
          target.kind === 'new'
            ? yield* planNew(context, actor, decoded.manifest)
            : planExistingGameServerManifest(target.state, decoded.manifest)
        return jsonResponse(response satisfies ManifestPlanResponse)
      }),
    ),
  )

  app.post(
    applyPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* authorize(context, 'operator').pipe(Effect.mapError(mapManifestError))
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const decoded = yield* decodeManifest(context.req.raw)
        yield* requireManifestOrganization(actor, decoded.manifest)
        const repository = yield* dependencies.repository(context.env)
        const target = yield* resolveManifestTarget(repository, actor, decoded.manifest).pipe(
          Effect.mapError(mapManifestError),
        )
        if (target.kind === 'new') {
          const serverPlan = yield* dependencies.serverPlan(context.env)
          const provision = yield* dependencies.provisionControl(context.env, serverPlan)
          const accepted = yield* provision
            .apply({
              context: {
                organizationId: actor.organizationId,
                actorId: actor.identityId,
                actorRole: serverPlanRole(actor),
                correlationId: actor.correlationId,
                ...(actor.membershipRevision === undefined
                  ? {}
                  : { actorMembershipRevision: actor.membershipRevision }),
              },
              idempotencyKey,
              intent: manifestToServerApplyIntent(decoded.manifest, decoded.commercialReviewToken),
              auditRequestContext: dependencies.auditRequestContext(context),
            })
            .pipe(Effect.mapError(mapProvisionError))
          return jsonResponse(
            { kind: 'server-provision', acceptance: accepted } satisfies ManifestApplyResponse,
            202,
          )
        }

        const plan = planExistingGameServerManifest(target.state, decoded.manifest)
        if (plan.kind === 'unsupported-plan')
          return yield* new ConflictError({
            code: 'manifest_unsupported',
            message: plan.unsupported.map((delta) => `${delta.path}: ${delta.reason}`).join('; '),
          })
        if (plan.kind === 'no-op')
          return jsonResponse({
            kind: 'no-op',
            serverId: plan.serverId,
            desiredRevision: plan.desiredRevision,
            workflowState: 'not-required',
          } satisfies ManifestApplyResponse)
        if (plan.kind === 'update-policies') {
          const accepted = yield* repository
            .acceptPolicyUpdate({
              organizationId: actor.organizationId,
              actorId: actor.identityId,
              correlationId: actor.correlationId,
              auditRequestContext: dependencies.auditRequestContext(context),
              idempotencyKey,
              serverId: plan.serverId,
              expectedRevision: plan.desiredRevision,
              updatePolicy: decoded.manifest.spec.updatePolicy,
              backupPolicy: decoded.manifest.spec.backupPolicy,
            })
            .pipe(Effect.mapError(mapManifestError))
          return jsonResponse(
            {
              kind: 'policy-update',
              acceptance: accepted,
              workflowState: 'not-required',
            } satisfies ManifestApplyResponse,
            202,
          )
        }

        const lifecycle = yield* dependencies.lifecycle(context.env)
        const intent =
          plan.kind === 'apply-config'
            ? {
                action: 'apply-config' as const,
                expectedConfigRevision: plan.expectedConfigRevision,
                config: decoded.manifest.spec.config,
              }
            : plan.kind === 'sync-mods'
              ? {
                  action: 'sync-mods' as const,
                  expectedConfigRevision: plan.expectedConfigRevision,
                  expectedModRevision: plan.expectedModRevision,
                  mods: decoded.manifest.spec.mods,
                }
              : {
                  action: 'move' as const,
                  targetNodeId: plan.targetNodeId,
                  backupPolicy: 'required' as const,
                }
        const accepted = yield* lifecycle
          .mutate({
            organizationId: actor.organizationId,
            actorId: actor.identityId,
            auditRequestContext: dependencies.auditRequestContext(context),
            auditActorType: 'human',
            idempotencyKey,
            correlationId: actor.correlationId,
            serverId: plan.serverId,
            expectedRevision: plan.desiredRevision,
            intent,
          })
          .pipe(Effect.mapError(mapLifecycleError))
        yield* lifecycleAcceptance(actor, plan.serverId, accepted)
        const workflowState = yield* startLifecycle(context, accepted)
        return jsonResponse(
          {
            kind: 'lifecycle',
            acceptance: {
              operationId: accepted.operation.operationId,
              serverId: accepted.operation.serverId,
              state: accepted.operation.state,
              workflowState,
            },
          } satisfies ManifestApplyResponse,
          202,
        )
      }),
    ),
  )

  return app
}

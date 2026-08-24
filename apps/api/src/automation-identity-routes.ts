import { Effect, Schema } from 'effect'
import { AuditRequestContext, type AuditRequestContextValue } from '@gridora/audit-contracts'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PersistenceError,
} from '@gridora/contracts'
import { AutomationIdentityId, IdempotencyKey, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  AutomationIdentityAuthorizationError,
  AutomationIdentityConflictError,
  AutomationIdentityNotFoundError,
  AutomationIdentityPersistenceError,
  AutomationIdentityValidationError,
  CreateAutomationIdentityInput,
  RotateAutomationIdentityInput,
  type AutomationIdentityControlError,
  type AutomationIdentityControlShape,
  type AutomationIdentitySecretResponse,
} from '@gridora/automation-identity-control'

export class AutomationIdentityRequestValidationError extends Schema.TaggedError<AutomationIdentityRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

/**
 * The HTTP edge reads the current membership revision after Access
 * authorization.  The D1 mutation repeats that exact fence in the acceptance
 * transaction, so a role revocation between authorization and persistence
 * cannot create or rotate a credential.
 */
type AutomationIdentityAuthorizedContext = OrganizationContext & {
  readonly membershipRevision?: number
}

export interface AutomationIdentityRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** The edge supplies unredacted request provenance only to the staged audit envelope. */
  readonly auditRequestContext: (context: HonoContext<E>) => AuditRequestContextValue
  /**
   * This boundary accepts only an already verified human Access membership.
   * Automation credentials use automation-identity-auth and cannot create,
   * rotate, revoke, or change a human organization role.
   */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: 'administrator',
  ) => Effect.Effect<AutomationIdentityAuthorizedContext, unknown, R>
  readonly control: (
    bindings: E['Bindings'],
  ) => Effect.Effect<AutomationIdentityControlShape, never, R>
}

const invalid = (message: string) => new AutomationIdentityRequestValidationError({ message })

const decodeCreate = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CreateAutomationIdentityInput, { onExcessProperty: 'error' })(
        value,
      ).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the automation identity API contract'),
        ),
      ),
    ),
  )

const decodeRotate = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(RotateAutomationIdentityInput, { onExcessProperty: 'error' })(
        value,
      ).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the automation identity API contract'),
        ),
      ),
    ),
  )

const EmptyBody = Schema.Struct({})
const decodeRevoke = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(EmptyBody, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() =>
          invalid('The revoke request does not match the automation identity API contract'),
        ),
      ),
    ),
  )

const decodeIdempotencyKey = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key does not match the API contract')),
      )

/** This endpoint deliberately uses a decimal strong revision, not a wildcard ETag. */
const decodeExpectedRevision = (value: string | undefined) => {
  if (value === undefined || !/^[1-9]\d*$/.test(value))
    return Effect.fail(invalid('If-Match must contain one positive automation identity revision'))
  const revision = Number(value)
  return Number.isSafeInteger(revision)
    ? Effect.succeed(revision)
    : Effect.fail(invalid('If-Match must contain one positive automation identity revision'))
}

const decodeIdentityId = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Automation identity id does not match the API contract'))
    : Schema.decodeUnknownEffect(AutomationIdentityId)(value).pipe(
        Effect.mapError(() => invalid('Automation identity id does not match the API contract')),
      )

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** The signed request input contains no credential text or verifier. */
const fingerprint = (value: unknown) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(value))),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new PersistenceError({
        operation: 'automationIdentity.fingerprint',
        message: 'Automation identity request fingerprinting is unavailable',
      }),
  })

const requireHumanAdministrator = (actor: OrganizationContext) =>
  actor.role === 'owner' || actor.role === 'administrator'
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: 'Owner or Administrator role is required for automation identities',
        }),
      )

const mapControlError = (error: AutomationIdentityControlError) => {
  if (error instanceof AutomationIdentityValidationError)
    return invalid('The request does not match the automation identity API contract')
  if (error instanceof AutomationIdentityAuthorizationError)
    return new AuthorizationError({
      code: 'role_required',
      message: 'Owner or Administrator role is required for automation identities',
    })
  // Do not put a foreign organization id or identity id in a public failure.
  if (error instanceof AutomationIdentityNotFoundError)
    return new NotFoundError({ resource: 'automation-identity', id: 'redacted' })
  if (error instanceof AutomationIdentityConflictError)
    return new ConflictError({
      code: `automation_identity_${error.code}`,
      message:
        error.code === 'idempotency_payload_mismatch'
          ? 'Idempotency-Key was already used with a different request'
          : 'Automation identity state changed; retry with the latest revision',
    })
  if (error instanceof AutomationIdentityPersistenceError)
    return new PersistenceError({
      operation: 'automationIdentity.persistence',
      message: 'Automation identity persistence is unavailable',
    })
  return new PersistenceError({
    operation: 'automationIdentity.control',
    message: 'Automation identity control is unavailable',
  })
}

const secretResponse = (result: AutomationIdentitySecretResponse) =>
  result.replayed || result.credential === undefined
    ? { identity: result.identity, replayed: result.replayed }
    : { identity: result.identity, replayed: false, credential: result.credential }

const noStoreHeaders = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

const collectionPath = '/v1/organizations/:organization/automation-identities'

/**
 * This module is intentionally not imported by the central app index yet.
 * A composition root must select a D1 control layer and explicitly keep these
 * human Access management routes separate from automation credential routes.
 */
export const registerAutomationIdentityRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: AutomationIdentityRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R | AuditRequestContext>,
  ) =>
    effectHandler<E, R, Failure>(
      (context) => dependencies.runtimeFor(context.env),
      (context) =>
        program(context).pipe(
          Effect.provideService(AuditRequestContext, dependencies.auditRequestContext(context)),
        ),
    )

  app.post(
    collectionPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        yield* requireHumanAdministrator(actor)
        const body = yield* decodeCreate(context.req.raw)
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const requestFingerprint = yield* fingerprint({
          action: 'create',
          organizationId: actor.organizationId,
          input: body,
        })
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .create(actor, {
            input: body,
            idempotencyKey,
            requestFingerprint,
            ...(actor.membershipRevision === undefined
              ? {}
              : { actorMembershipRevision: actor.membershipRevision }),
          })
          .pipe(Effect.mapError(mapControlError))
        return jsonResponse(secretResponse(result), result.replayed ? 200 : 201, noStoreHeaders)
      }),
    ),
  )

  app.get(
    collectionPath,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        yield* requireHumanAdministrator(actor)
        const control = yield* dependencies.control(context.env)
        const identities = yield* control.list(actor).pipe(Effect.mapError(mapControlError))
        return jsonResponse({ items: identities }, 200, noStoreHeaders)
      }),
    ),
  )

  app.post(
    `${collectionPath}/:automationIdentityId/actions/rotate`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        yield* requireHumanAdministrator(actor)
        const automationIdentityId = yield* decodeIdentityId(
          context.req.param('automationIdentityId'),
        )
        const body = yield* decodeRotate(context.req.raw)
        const expectedRevision = yield* decodeExpectedRevision(context.req.header('if-match'))
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const requestFingerprint = yield* fingerprint({
          action: 'rotate',
          organizationId: actor.organizationId,
          automationIdentityId,
          expectedRevision,
          input: body,
        })
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .rotate(actor, {
            automationIdentityId,
            expectedRevision,
            input: body,
            idempotencyKey,
            requestFingerprint,
            ...(actor.membershipRevision === undefined
              ? {}
              : { actorMembershipRevision: actor.membershipRevision }),
          })
          .pipe(Effect.mapError(mapControlError))
        return jsonResponse(secretResponse(result), 200, noStoreHeaders)
      }),
    ),
  )

  app.post(
    `${collectionPath}/:automationIdentityId/actions/revoke`,
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, 'administrator')
        yield* requireHumanAdministrator(actor)
        const automationIdentityId = yield* decodeIdentityId(
          context.req.param('automationIdentityId'),
        )
        yield* decodeRevoke(context.req.raw)
        const expectedRevision = yield* decodeExpectedRevision(context.req.header('if-match'))
        const idempotencyKey = yield* decodeIdempotencyKey(context.req.header('idempotency-key'))
        const requestFingerprint = yield* fingerprint({
          action: 'revoke',
          organizationId: actor.organizationId,
          automationIdentityId,
          expectedRevision,
        })
        const control = yield* dependencies.control(context.env)
        const result = yield* control
          .revoke(actor, {
            automationIdentityId,
            expectedRevision,
            idempotencyKey,
            requestFingerprint,
            ...(actor.membershipRevision === undefined
              ? {}
              : { actorMembershipRevision: actor.membershipRevision }),
          })
          .pipe(Effect.mapError(mapControlError))
        return jsonResponse(result, 200, noStoreHeaders)
      }),
    ),
  )

  return app
}

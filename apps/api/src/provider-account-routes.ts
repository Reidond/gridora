import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import { AuthorizationError, PersistenceError } from '@gridora/contracts'
import { OperationId, type OrganizationContext } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  ProviderAccountLifecycleBody,
  type ProviderAccountControlError,
  type ProviderAccountControlShape,
  type ProviderAccountLifecycleAction,
  type ProviderAccountLifecycleCommand,
  type ProviderAccountLifecycleResult,
} from '@gridora/provider-account-control'

const ProviderAccountId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)

export class ProviderAccountRequestValidationError extends Schema.TaggedError<ProviderAccountRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export type ProviderAccountRouteMinimumRole = 'administrator' | 'owner'
type ProviderAccountMutation = Pick<
  ProviderAccountLifecycleCommand,
  'idempotencyKey' | 'operationIdempotencyKey' | 'requestFingerprint' | 'auditRequestContext'
>

export interface ProviderAccountRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Must resolve the route organization and return its active organization membership context. */
  readonly authorize: (
    context: HonoContext<E>,
    minimumRole: ProviderAccountRouteMinimumRole,
  ) => Effect.Effect<OrganizationContext, unknown, R>
  readonly byopEnabled: (bindings: E['Bindings']) => boolean
  readonly control: (
    bindings: E['Bindings'],
  ) => Effect.Effect<ProviderAccountControlShape, never, R>
  /** Provides actor-scoped replay, payload fingerprint, and immutable HTTP audit provenance. */
  readonly mutation: (
    context: HonoContext<E>,
    actor: OrganizationContext,
    action: string,
    resourceType: string,
    resourceId: string,
    input: object,
  ) => Effect.Effect<ProviderAccountMutation, unknown, R>
}

const invalid = (message: string) => new ProviderAccountRequestValidationError({ message })

const decodeBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ProviderAccountLifecycleBody, {
        onExcessProperty: 'error',
      })(value).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the provider-account lifecycle API contract'),
        ),
      ),
    ),
  )

const decodeAccountId = (value: string) =>
  Schema.decodeUnknownEffect(ProviderAccountId)(value).pipe(
    Effect.mapError(() => invalid('Provider account id does not match the API contract')),
  )

const generatedOperationId = () =>
  Schema.decodeUnknownEffect(OperationId)(`provider_account_${crypto.randomUUID()}`).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation: 'providerAccount.operationId',
          message: 'Provider-account operation identifier generation is unavailable',
        }),
    ),
  )

const requireByop = <E extends HonoEnv>(
  context: HonoContext<E>,
  dependencies: ProviderAccountRouteDependencies<E, unknown>,
) =>
  dependencies.byopEnabled(context.env)
    ? Effect.void
    : Effect.fail(
        new AuthorizationError({
          code: 'role_required',
          message: 'Organization provider accounts are not enabled',
        }),
      )

const basePath = '/v1/organizations/:organization/provider-accounts/:accountId'

/** Register after the shared authentication, body-limit, CORS, and CSRF middleware. */
export const registerProviderAccountRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: ProviderAccountRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  const registerAction = (
    action: ProviderAccountLifecycleAction,
    path: string,
    minimumRole: ProviderAccountRouteMinimumRole,
    method: 'post' | 'delete',
  ) => {
    const routeHandler = handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorize(context, minimumRole)
        yield* requireByop(context, dependencies as ProviderAccountRouteDependencies<E, unknown>)
        const accountId = yield* decodeAccountId(context.req.param('accountId') ?? '')
        const body = yield* decodeBody(context.req.raw)
        const mutation = yield* dependencies.mutation(
          context,
          actor,
          `provider-account.${action}`,
          'provider-account',
          accountId,
          body,
        )
        const operationId = yield* generatedOperationId()
        const command = {
          context: actor,
          accountId,
          expectedRevision: body.expectedRevision,
          idempotencyKey: mutation.idempotencyKey,
          operationIdempotencyKey: mutation.operationIdempotencyKey,
          requestFingerprint: mutation.requestFingerprint,
          operationId,
          auditEventId: `audit_provider_account_${crypto.randomUUID()}`,
          auditRequestContext: mutation.auditRequestContext,
          now: new Date().toISOString(),
        }
        const control = yield* dependencies.control(context.env)
        const result: ProviderAccountLifecycleResult = yield* control[action](command).pipe(
          Effect.mapError((error: ProviderAccountControlError) => error),
        )
        return jsonResponse(result)
      }),
    )
    if (method === 'delete') app.delete(path, routeHandler)
    else app.post(path, routeHandler)
  }

  registerAction('test', `${basePath}/test`, 'administrator', 'post')
  registerAction('refresh', `${basePath}/refresh`, 'administrator', 'post')
  registerAction('disable', `${basePath}/actions/disable`, 'owner', 'post')
  registerAction('remove', basePath, 'owner', 'delete')

  return app
}

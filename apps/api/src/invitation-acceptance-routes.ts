import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import type { Identity } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

const InvitationToken = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[0-9a-f]{64}$/),
)

export class InvitationAcceptanceRequestValidationError extends Schema.TaggedError<InvitationAcceptanceRequestValidationError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}

export interface InvitationAcceptanceRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Must resolve an active local identity from the already-verified Access claims. */
  readonly authenticatedIdentity: (context: HonoContext<E>) => Effect.Effect<Identity, unknown, R>
  readonly acceptInvitation: (
    context: HonoContext<E>,
    identity: Identity,
    token: string,
  ) => Effect.Effect<unknown, unknown, R>
}

export const invitationAcceptancePath = '/v1/invitations/:token/actions/accept'

const decodeToken = (value: string) =>
  Schema.decodeUnknownEffect(InvitationToken)(value).pipe(
    Effect.mapError(
      () =>
        new InvitationAcceptanceRequestValidationError({
          message: 'Invitation token does not match the API contract',
        }),
    ),
  )

/** Register after shared Access authentication, request-size, CORS, and CSRF middleware. */
export const registerInvitationAcceptanceRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: InvitationAcceptanceRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <Failure>(
    program: (context: HonoContext<E>) => Effect.Effect<Response, Failure, R>,
  ) => effectHandler<E, R, Failure>((context) => dependencies.runtimeFor(context.env), program)

  app.post(
    invitationAcceptancePath,
    handler((context) =>
      Effect.gen(function* () {
        const identity = yield* dependencies.authenticatedIdentity(context)
        const token = yield* decodeToken(context.req.param('token') ?? '')
        const response = yield* dependencies.acceptInvitation(context, identity, token)
        return jsonResponse(response, 200, {
          'cache-control': 'no-store, private',
          pragma: 'no-cache',
          'referrer-policy': 'no-referrer',
        })
      }),
    ),
  )

  return app
}

import { Effect, Schema } from 'effect'
import { Hono, type Context as HonoContext, type Env as HonoEnv } from 'hono'
import type { PlatformActor } from '@gridora/platform-authority'
import {
  PlatformAllocation,
  type PlatformProviderControlShape,
} from '@gridora/platform-provider-control'
import { IdempotencyKey } from '@gridora/domain'
import { effectHandler, jsonResponse, type WorkerEffectRuntime } from '@gridora/http-hono-effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)
const RevisionBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
const CredentialBody = Schema.Struct({
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  credentialsBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32768)),
})
const RotateBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  credentialsBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32768)),
})
const AllocationBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  allowedRegions: PlatformAllocation.fields.allowedRegions,
  allowedPlans: PlatformAllocation.fields.allowedPlans,
  maxActiveNodes: PlatformAllocation.fields.maxActiveNodes,
  monthlyBudgetMinor: PlatformAllocation.fields.monthlyBudgetMinor,
  status: PlatformAllocation.fields.status,
})
export class PlatformProviderRequestError extends Schema.TaggedError<PlatformProviderRequestError>()(
  'RequestValidationError',
  { message: Schema.String },
) {}
export interface PlatformProviderRouteDependencies<E extends HonoEnv, R> {
  readonly runtimeFor: (bindings: E['Bindings']) => WorkerEffectRuntime<R>
  /** Resolves Cloudflare Access and independently enforces the active global Platform Administrator grant. */
  readonly authorizePlatformAdministrator: (
    context: HonoContext<E>,
  ) => Effect.Effect<PlatformActor, unknown, R>
  readonly control: (
    bindings: E['Bindings'],
    context: HonoContext<E>,
  ) => Effect.Effect<PlatformProviderControlShape, never, R>
}
const invalid = (message: string) => new PlatformProviderRequestError({ message })
const decode = <A, I>(schema: Schema.Codec<A, I, never>, request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => invalid('The request body must be valid JSON'),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() =>
          invalid('The request does not match the platform provider API contract'),
        ),
      ),
    ),
  )
const key = (value: string | undefined) =>
  value === undefined
    ? Effect.fail(invalid('Idempotency-Key is required'))
    : Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
        Effect.mapError(() => invalid('Idempotency-Key is invalid')),
      )
const identifier = (value: string | undefined) =>
  Schema.decodeUnknownEffect(Identifier)(value).pipe(
    Effect.mapError(() => invalid('Resource identifier is invalid')),
  )
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : JSON.stringify(value)
const fingerprint = (value: unknown) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () => invalid('Request fingerprinting is unavailable'),
  })
const credentialDigest = (value: Uint8Array) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ) as ArrayBuffer,
          ),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () => invalid('Credential fingerprinting is unavailable'),
  })
const bytes = (encoded: string) =>
  Effect.try({
    try: () => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error()
      const raw = atob(encoded)
      if (raw.length < 2 || raw.length > 24576) throw new Error()
      return Uint8Array.from(raw, (c) => c.charCodeAt(0))
    },
    catch: () => invalid('Credentials must be bounded canonical base64'),
  })
const withCredentials = <A, E, R>(
  encoded: string,
  use: (credentials: Uint8Array) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(bytes(encoded), use, (credentials) =>
    Effect.sync(() => credentials.fill(0)),
  )

export const registerPlatformProviderRoutes = <E extends HonoEnv, R>(
  app: Hono<E>,
  dependencies: PlatformProviderRouteDependencies<E, R>,
): Hono<E> => {
  const handler = <F>(program: (context: HonoContext<E>) => Effect.Effect<Response, F, R>) =>
    effectHandler<E, R, F>((context) => dependencies.runtimeFor(context.env), program)
  const command = (
    context: HonoContext<E>,
    actor: PlatformActor,
    input: {
      readonly action: string
      readonly resourceType: string
      readonly resourceId: string
      readonly body: unknown
    },
  ) =>
    Effect.gen(function* () {
      const idempotencyKey = yield* key(context.req.header('idempotency-key'))
      const requestFingerprint = yield* fingerprint({
        path: context.req.path,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        body: input.body,
      })
      const operationIdempotencyKey = yield* fingerprint({
        scope: 'platform',
        actorId: actor.identityId,
        action: input.action,
        idempotencyKey,
      })
      const identity = yield* fingerprint({
        operationIdempotencyKey,
        requestFingerprint,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      })
      return {
        actor,
        idempotencyKey,
        requestFingerprint,
        operationIdempotencyKey,
        operationId: `platform-operation-${identity.slice(0, 40)}`,
        auditEventId: `platform-audit-${identity.slice(0, 40)}`,
        now: new Date().toISOString(),
      }
    })
  app.post(
    '/v1/platform/provider-accounts',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorizePlatformAdministrator(context)
        const body = yield* decode(CredentialBody, context.req.raw)
        const accountId = yield* identifier(context.req.query('id') ?? '')
        return yield* withCredentials(body.credentialsBase64, (credentials) =>
          Effect.gen(function* () {
            const digest = yield* credentialDigest(credentials)
            const base = yield* command(context, actor, {
              action: 'platform.provider-account.create',
              resourceType: 'provider-account',
              resourceId: accountId,
              body: { accountId, providerType: body.providerType, credentialDigest: digest },
            })
            const control = yield* dependencies.control(context.env, context)
            return jsonResponse(
              yield* control.add({
                ...base,
                accountId,
                providerType: body.providerType,
                credentials,
              }),
              201,
            )
          }),
        )
      }),
    ),
  )
  for (const action of ['validate', 'disable', 'remove'] as const)
    app.post(
      `/v1/platform/provider-accounts/:accountId/actions/${action}`,
      handler((context) =>
        Effect.gen(function* () {
          const actor = yield* dependencies.authorizePlatformAdministrator(context)
          const accountId = yield* identifier(context.req.param('accountId'))
          const body = yield* decode(RevisionBody, context.req.raw)
          const base = yield* command(context, actor, {
            action: `platform.provider-account.${action}`,
            resourceType: 'provider-account',
            resourceId: accountId,
            body: { accountId, ...body },
          })
          const control = yield* dependencies.control(context.env, context)
          return jsonResponse(
            yield* control[action]({ ...base, accountId, expectedRevision: body.expectedRevision }),
          )
        }),
      ),
    )
  app.post(
    '/v1/platform/provider-accounts/:accountId/actions/rotate',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorizePlatformAdministrator(context)
        const accountId = yield* identifier(context.req.param('accountId'))
        const body = yield* decode(RotateBody, context.req.raw)
        return yield* withCredentials(body.credentialsBase64, (credentials) =>
          Effect.gen(function* () {
            const digest = yield* credentialDigest(credentials)
            const base = yield* command(context, actor, {
              action: 'platform.provider-account.rotate',
              resourceType: 'provider-account',
              resourceId: accountId,
              body: {
                accountId,
                expectedRevision: body.expectedRevision,
                credentialDigest: digest,
              },
            })
            const control = yield* dependencies.control(context.env, context)
            return jsonResponse(
              yield* control.rotate({
                ...base,
                accountId,
                expectedRevision: body.expectedRevision,
                credentials,
              }),
            )
          }),
        )
      }),
    ),
  )
  app.put(
    '/v1/platform/provider-accounts/:accountId/allocations/:organizationId',
    handler((context) =>
      Effect.gen(function* () {
        const actor = yield* dependencies.authorizePlatformAdministrator(context)
        const accountId = yield* identifier(context.req.param('accountId'))
        const organizationId = yield* identifier(context.req.param('organizationId'))
        const body = yield* decode(AllocationBody, context.req.raw)
        const action =
          body.expectedRevision === 0 ? 'create' : body.status === 'disabled' ? 'disable' : 'update'
        const base = yield* command(context, actor, {
          action: `platform.provider-allocation.${action}`,
          resourceType: 'provider-allocation',
          resourceId: `platform-allocation:${organizationId}:${accountId}`,
          body: { accountId, organizationId, ...body },
        })
        const control = yield* dependencies.control(context.env, context)
        return jsonResponse(
          yield* control.putAllocation({
            ...base,
            expectedRevision: body.expectedRevision,
            allocation: {
              organizationId,
              accountId,
              allowedRegions: body.allowedRegions,
              allowedPlans: body.allowedPlans,
              maxActiveNodes: body.maxActiveNodes,
              monthlyBudgetMinor: body.monthlyBudgetMinor,
              status: body.status,
            },
          }),
        )
      }),
    ),
  )
  return app
}

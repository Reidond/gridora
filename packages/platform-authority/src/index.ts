import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
export class PlatformActor extends Schema.Class<PlatformActor>('PlatformActor')({
  identityId: Identifier,
  accessSubject: Identifier,
  correlationId: Identifier,
  administratorRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}) {}
export class PlatformAuthorizationError extends Schema.TaggedError<PlatformAuthorizationError>()(
  'PlatformAuthorizationError',
  {
    code: Schema.Literals([
      'identity_inactive',
      'administrator_required',
      'administrator_inactive',
    ]),
  },
) {}
export class PlatformAuthorityPersistenceError extends Schema.TaggedError<PlatformAuthorityPersistenceError>()(
  'PlatformAuthorityPersistenceError',
  { operation: Schema.String },
) {}
export interface PlatformIdentityPrincipal {
  readonly accessSubject: string
  readonly correlationId: string
}
export interface PlatformAuthorityShape {
  readonly authorize: (
    principal: PlatformIdentityPrincipal,
  ) => Effect.Effect<PlatformActor, PlatformAuthorizationError | PlatformAuthorityPersistenceError>
}
export class PlatformAuthority extends Context.Service<PlatformAuthority, PlatformAuthorityShape>()(
  '@gridora/platform-authority/PlatformAuthority',
) {}
export const PlatformAuthorityLayer = (service: PlatformAuthorityShape) =>
  Layer.succeed(PlatformAuthority, service)

export interface PlatformAuthorityDatabase {
  prepare(sql: string): { bind(...values: ReadonlyArray<unknown>): { first(): Promise<unknown> } }
}
const row = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
export const makePlatformAuthorityD1 = (
  database: PlatformAuthorityDatabase,
): PlatformAuthorityShape => ({
  authorize: (principal) =>
    Effect.gen(function* () {
      const value = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(`SELECT i.id AS identityId, i.access_subject AS accessSubject, i.status AS identityStatus,
        a.status AS administratorStatus, a.revision AS administratorRevision
        FROM identities i LEFT JOIN platform_administrators a ON a.identity_id = i.id
        WHERE i.access_subject = ?`)
            .bind(principal.accessSubject)
            .first(),
        catch: () =>
          new PlatformAuthorityPersistenceError({ operation: 'platform.authority.read' }),
      })
      const found = row(value)
      if (found === undefined || found.identityStatus !== 'active')
        return yield* new PlatformAuthorizationError({ code: 'identity_inactive' })
      if (found.administratorStatus === undefined)
        return yield* new PlatformAuthorizationError({ code: 'administrator_required' })
      if (found.administratorStatus !== 'active')
        return yield* new PlatformAuthorizationError({ code: 'administrator_inactive' })
      return yield* Schema.decodeUnknownEffect(PlatformActor)({
        identityId: found.identityId,
        accessSubject: found.accessSubject,
        correlationId: principal.correlationId,
        administratorRevision: found.administratorRevision,
      }).pipe(
        Effect.mapError(
          () => new PlatformAuthorityPersistenceError({ operation: 'platform.authority.decode' }),
        ),
      )
    }),
})

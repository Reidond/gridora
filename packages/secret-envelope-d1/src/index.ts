import { Context, Effect, Layer, Schema } from 'effect'
import {
  SecretConflictError,
  SecretEnvelopeRecord,
  SecretEnvelopeRepository,
  SecretIntegrityError,
  SecretNotFoundError,
  SecretPersistenceError,
  SecretRevisionConflictError,
  type SecretEnvelopeRepositoryShape,
  type SecretLocator,
} from '@gridora/secret-envelope'
import type { OrganizationContext } from '@gridora/domain'

export interface SecretD1Result {
  readonly success: boolean
  readonly meta?: { readonly changes?: number }
}
export interface SecretD1Statement {
  bind(...values: ReadonlyArray<unknown>): SecretD1Statement
  first(): Promise<unknown>
  run(): Promise<SecretD1Result>
}
export interface SecretD1Database {
  prepare(sql: string): SecretD1Statement
}
export class SecretD1Client extends Context.Service<SecretD1Client, SecretD1Database>()(
  '@gridora/secret-envelope-d1/SecretD1Client',
) {}
export const SecretD1ClientLayer = (database: SecretD1Database) =>
  Layer.succeed(SecretD1Client, database)

const selectRecord = `SELECT organization_id AS organizationId, id, scope_type AS scopeType,
 scope_id AS scopeId, ciphertext, wrapped_data_key AS wrappedDataKey, key_version AS keyVersion,
 revision, created_at AS createdAt, rotated_at AS rotatedAt FROM secret_envelopes`
const failure = (operation: string) =>
  new SecretPersistenceError({ operation, message: 'secret persistence operation failed' })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const requireSuccessfulWrite = (operation: string, result: SecretD1Result) =>
  result.success && result.meta?.changes === 1 ? Effect.void : Effect.fail(failure(operation))
const decode = (operation: string, row: unknown) =>
  Schema.decodeUnknownEffect(SecretEnvelopeRecord)(row).pipe(
    Effect.mapError(() => failure(operation)),
  )

const getScoped = (db: SecretD1Database, context: OrganizationContext, locator: SecretLocator) =>
  Effect.gen(function* () {
    const row = yield* attempt('secretEnvelope.get', () =>
      db
        .prepare(
          `${selectRecord} WHERE organization_id = ? AND id = ? AND scope_type = ? AND scope_id = ?`,
        )
        .bind(context.organizationId, locator.id, locator.scopeType, locator.scopeId)
        .first(),
    )
    if (row === null)
      return yield* new SecretNotFoundError({
        operation: 'secretEnvelope.get',
        message: 'secret envelope not found',
      })
    return yield* decode('secretEnvelope.get', row)
  })

const revisionFailure = (
  db: SecretD1Database,
  context: OrganizationContext,
  locator: SecretLocator,
  expectedRevision: number,
) =>
  Effect.matchEffect(getScoped(db, context, locator), {
    onFailure: (error) => Effect.fail(error),
    onSuccess: () =>
      Effect.fail(
        new SecretRevisionConflictError({
          operation: 'secretEnvelope.revision',
          message: 'secret envelope revision changed',
          expectedRevision,
        }),
      ),
  })

export const makeSecretEnvelopeRepositoryD1 = (
  db: SecretD1Database,
): SecretEnvelopeRepositoryShape => {
  const repository: SecretEnvelopeRepositoryShape = {
    create: (context, record) =>
      Effect.gen(function* () {
        if (record.organizationId !== context.organizationId)
          return yield* new SecretIntegrityError({
            operation: 'secretEnvelope.create',
            message: 'organization binding mismatch',
          })
        const existing = yield* Effect.result(getScoped(db, context, record))
        if (existing._tag === 'Success')
          return yield* new SecretConflictError({
            operation: 'secretEnvelope.create',
            message: 'secret envelope already exists',
          })
        if (existing.failure._tag !== 'SecretNotFoundError') return yield* existing.failure
        const result = yield* attempt('secretEnvelope.create', () =>
          db
            .prepare(
              `INSERT INTO secret_envelopes
                (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
                 key_version, revision, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              context.organizationId,
              record.id,
              record.scopeType,
              record.scopeId,
              record.ciphertext,
              record.wrappedDataKey,
              record.keyVersion,
              record.revision,
              record.createdAt,
              record.rotatedAt,
            )
            .run(),
        )
        yield* requireSuccessfulWrite('secretEnvelope.create', result)
        return record
      }),
    get: (context, locator) => getScoped(db, context, locator),
    replace: (context, record, expectedRevision) =>
      Effect.gen(function* () {
        if (
          record.organizationId !== context.organizationId ||
          record.revision !== expectedRevision + 1
        )
          return yield* new SecretIntegrityError({
            operation: 'secretEnvelope.replace',
            message: 'organization or revision binding mismatch',
          })
        const result = yield* attempt('secretEnvelope.replace', () =>
          db
            .prepare(
              `UPDATE secret_envelopes SET ciphertext = ?, wrapped_data_key = ?, key_version = ?,
                 revision = ?, rotated_at = ? WHERE organization_id = ? AND id = ?
                 AND scope_type = ? AND scope_id = ? AND revision = ?`,
            )
            .bind(
              record.ciphertext,
              record.wrappedDataKey,
              record.keyVersion,
              record.revision,
              record.rotatedAt,
              context.organizationId,
              record.id,
              record.scopeType,
              record.scopeId,
              expectedRevision,
            )
            .run(),
        )
        if (!result.success) return yield* failure('secretEnvelope.replace')
        if ((result.meta?.changes ?? 0) !== 1)
          return yield* revisionFailure(db, context, record, expectedRevision)
        return record
      }),
    delete: (context, locator, expectedRevision) =>
      Effect.gen(function* () {
        const result = yield* attempt('secretEnvelope.delete', () =>
          db
            .prepare(
              `DELETE FROM secret_envelopes WHERE organization_id = ? AND id = ?
                 AND scope_type = ? AND scope_id = ? AND revision = ?`,
            )
            .bind(
              context.organizationId,
              locator.id,
              locator.scopeType,
              locator.scopeId,
              expectedRevision,
            )
            .run(),
        )
        if (!result.success) return yield* failure('secretEnvelope.delete')
        if ((result.meta?.changes ?? 0) !== 1)
          return yield* revisionFailure(db, context, locator, expectedRevision)
      }),
  }
  return repository
}

export const SecretEnvelopeRepositoryD1Live = Layer.effect(
  SecretEnvelopeRepository,
  Effect.gen(function* () {
    const db = yield* SecretD1Client
    return SecretEnvelopeRepository.of(makeSecretEnvelopeRepositoryD1(db))
  }),
)

export const makeSecretEnvelopeRepositoryD1Layer = (database: SecretD1Database) =>
  SecretEnvelopeRepositoryD1Live.pipe(Layer.provide(SecretD1ClientLayer(database)))

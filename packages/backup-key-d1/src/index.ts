import { Context, Effect, Layer, Schema } from 'effect'
import {
  BackupKeyRepositoryPort,
  BackupWrappedKeyRecord,
  type BackupKeyInsertResult,
  type BackupKeyRepositoryPortShape,
} from '@gridora/backup-key'
import { BackupR2Error, type BackupKeyCoordinates } from '@gridora/backup-r2'

export interface BackupKeyD1Result {
  readonly success: boolean
  readonly meta?: { readonly changes?: number }
}
export interface BackupKeyD1Statement {
  bind(...values: ReadonlyArray<unknown>): BackupKeyD1Statement
  first(): Promise<unknown>
  run(): Promise<BackupKeyD1Result>
}
export interface BackupKeyD1Database {
  prepare(sql: string): BackupKeyD1Statement
}

export class BackupKeyD1Client extends Context.Service<BackupKeyD1Client, BackupKeyD1Database>()(
  '@gridora/backup-key-d1/BackupKeyD1Client',
) {}
export const BackupKeyD1ClientLayer = (database: BackupKeyD1Database) =>
  Layer.succeed(BackupKeyD1Client, database)

const selectRecord = `SELECT organization_id AS organizationId, server_id AS serverId,
 backup_id AS backupId, key_version AS keyVersion, wrapped_data_key AS wrappedDataKey,
 revision FROM backup_wrapped_keys`
const failure = (operation: string) =>
  new BackupR2Error({
    code: 'key-failed',
    operation,
    message: 'backup key persistence operation failed',
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const decodeRecord = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(BackupWrappedKeyRecord)(value).pipe(
    Effect.mapError(() => failure(operation)),
  )

const getExact = (database: BackupKeyD1Database, coordinates: BackupKeyCoordinates) =>
  Effect.gen(function* () {
    const row = yield* attempt('backupKeyD1.get', () =>
      database
        .prepare(`${selectRecord} WHERE organization_id = ? AND server_id = ? AND backup_id = ?`)
        .bind(coordinates.organizationId, coordinates.serverId, coordinates.backupId)
        .first(),
    )
    return row === null ? null : yield* decodeRecord('backupKeyD1.get', row)
  })

export const BackupKeyRepositoryD1Live = Layer.effect(
  BackupKeyRepositoryPort,
  Effect.gen(function* () {
    const database = yield* BackupKeyD1Client
    const repository: BackupKeyRepositoryPortShape = {
      get: (coordinates) => getExact(database, coordinates),
      insertOrGet: (candidate) =>
        Effect.gen(function* () {
          const decoded = yield* decodeRecord('backupKeyD1.insertOrGet', candidate)
          const result = yield* attempt('backupKeyD1.insertOrGet', () =>
            database
              .prepare(
                `INSERT OR IGNORE INTO backup_wrapped_keys
                (organization_id, server_id, backup_id, key_version, wrapped_data_key, revision)
                VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                decoded.organizationId,
                decoded.serverId,
                decoded.backupId,
                decoded.keyVersion,
                decoded.wrappedDataKey,
                decoded.revision,
              )
              .run(),
          )
          if (!result.success) return yield* failure('backupKeyD1.insertOrGet')
          if (result.meta?.changes === 1)
            return { kind: 'inserted', record: decoded } satisfies BackupKeyInsertResult
          if (result.meta?.changes !== 0) return yield* failure('backupKeyD1.insertOrGet')
          const existing = yield* getExact(database, decoded)
          if (existing === null) return yield* failure('backupKeyD1.insertOrGet')
          return { kind: 'existing', record: existing } satisfies BackupKeyInsertResult
        }),
    }
    return BackupKeyRepositoryPort.of(repository)
  }),
)

export const makeBackupKeyRepositoryD1Layer = (database: BackupKeyD1Database) =>
  BackupKeyRepositoryD1Live.pipe(Layer.provide(BackupKeyD1ClientLayer(database)))

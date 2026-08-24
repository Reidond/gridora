import { Context, Effect, Layer, Schema } from 'effect'
import { AuditExportEvent } from '@gridora/audit-contracts'

export interface AuditD1Result {
  readonly meta?: { readonly changes?: number }
}
export interface AuditD1AllResult {
  readonly results: ReadonlyArray<unknown>
}
export interface AuditD1Statement {
  bind(...values: ReadonlyArray<unknown>): AuditD1Statement
  all(): Promise<AuditD1AllResult>
  run(): Promise<AuditD1Result>
}
export interface AuditD1Database {
  prepare(sql: string): AuditD1Statement
}

export class AuditD1Client extends Context.Service<AuditD1Client, AuditD1Database>()(
  '@gridora/audit-d1/AuditD1Client',
) {}
export const AuditD1ClientLayer = (database: AuditD1Database) =>
  Layer.succeed(AuditD1Client, database)

export class PlatformAuditOutboxError extends Schema.TaggedError<PlatformAuditOutboxError>()(
  'PlatformAuditOutboxError',
  { operation: Schema.String },
) {}

export const PlatformAuditExportOutboxEvent = Schema.Struct({
  id: Schema.String,
  auditEventId: Schema.String,
  payload: AuditExportEvent,
  publishState: Schema.Literals(['publishing'] as const),
  retryCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  availableAt: Schema.String,
  createdAt: Schema.String,
})
export type PlatformAuditExportOutboxEvent = typeof PlatformAuditExportOutboxEvent.Type

export interface PlatformAuditExportOutboxRepositoryShape {
  readonly claimPending: (
    workerId: string,
    leaseToken: string,
    limit: number,
    now: string,
    leaseUntil: string,
  ) => Effect.Effect<ReadonlyArray<PlatformAuditExportOutboxEvent>, PlatformAuditOutboxError>
  readonly markDelivered: (
    id: string,
    workerId: string,
    leaseToken: string,
    deliveredAt: string,
  ) => Effect.Effect<void, PlatformAuditOutboxError>
  readonly markFailed: (
    id: string,
    workerId: string,
    leaseToken: string,
    availableAt: string,
  ) => Effect.Effect<void, PlatformAuditOutboxError>
  readonly markTerminalFailed: (
    id: string,
    workerId: string,
    leaseToken: string,
  ) => Effect.Effect<void, PlatformAuditOutboxError>
}
export class PlatformAuditExportOutboxRepository extends Context.Service<
  PlatformAuditExportOutboxRepository,
  PlatformAuditExportOutboxRepositoryShape
>()('@gridora/audit-d1/PlatformAuditExportOutboxRepository') {}

const failure = (operation: string) => new PlatformAuditOutboxError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })

const decodeEvent = (operation: string, row: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      id: Schema.String,
      auditEventId: Schema.String,
      payload: Schema.String,
      publishState: Schema.Literals(['publishing'] as const),
      retryCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      availableAt: Schema.String,
      createdAt: Schema.String,
    }),
  )(row).pipe(
    Effect.flatMap((value) =>
      Effect.try({
        try: () => JSON.parse(value.payload) as unknown,
        catch: () => failure(`${operation}.payload`),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AuditExportEvent, { onExcessProperty: 'error' })),
        Effect.map((payload) => ({ ...value, payload })),
      ),
    ),
    Effect.mapError(() => failure(operation)),
  )

export const makePlatformAuditExportOutboxRepositoryD1 = (
  database: AuditD1Database,
): PlatformAuditExportOutboxRepositoryShape => ({
  claimPending: (workerId, leaseToken, limit, now, leaseUntil) =>
    attempt('platform-audit-outbox.claim', () =>
      database
        .prepare(
          `UPDATE platform_audit_export_outbox
           SET publish_state = 'publishing', lease_owner = ?, lease_token = ?, lease_until = ?
           WHERE id IN (
             SELECT id FROM platform_audit_export_outbox
             WHERE ((publish_state IN ('pending', 'failed') AND available_at <= ?)
               OR (publish_state = 'publishing' AND lease_until <= ?))
             ORDER BY created_at, id LIMIT ?
           )
           RETURNING id, audit_event_id AS auditEventId, payload_json AS payload,
             publish_state AS publishState, retry_count AS retryCount,
             available_at AS availableAt, created_at AS createdAt`,
        )
        .bind(workerId, leaseToken, leaseUntil, now, now, limit)
        .all(),
    ).pipe(
      Effect.flatMap((result) =>
        Effect.forEach(result.results, (row) => decodeEvent('platform-audit-outbox.claim', row)),
      ),
    ),
  markDelivered: (id, workerId, leaseToken, deliveredAt) =>
    attempt('platform-audit-outbox.mark-delivered', () =>
      database
        .prepare(`UPDATE platform_audit_export_outbox
          SET publish_state = 'delivered', delivered_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL
          WHERE id = ? AND publish_state = 'publishing' AND lease_owner = ? AND lease_token = ?`)
        .bind(deliveredAt, id, workerId, leaseToken)
        .run(),
    ).pipe(
      Effect.flatMap((result) =>
        (result.meta?.changes ?? 0) === 1
          ? Effect.void
          : Effect.fail(failure('platform-audit-outbox.mark-delivered.lease')),
      ),
    ),
  markFailed: (id, workerId, leaseToken, availableAt) =>
    attempt('platform-audit-outbox.mark-failed', () =>
      database
        .prepare(`UPDATE platform_audit_export_outbox
          SET publish_state = 'failed', retry_count = retry_count + 1, available_at = ?,
            lease_owner = NULL, lease_token = NULL, lease_until = NULL
          WHERE id = ? AND publish_state = 'publishing' AND lease_owner = ? AND lease_token = ?`)
        .bind(availableAt, id, workerId, leaseToken)
        .run(),
    ).pipe(
      Effect.flatMap((result) =>
        (result.meta?.changes ?? 0) === 1
          ? Effect.void
          : Effect.fail(failure('platform-audit-outbox.mark-failed.lease')),
      ),
    ),
  markTerminalFailed: (id, workerId, leaseToken) =>
    attempt('platform-audit-outbox.mark-terminal-failed', () =>
      database
        .prepare(`UPDATE platform_audit_export_outbox
          SET publish_state = 'failed_terminal', lease_owner = NULL, lease_token = NULL, lease_until = NULL
          WHERE id = ? AND publish_state = 'publishing' AND lease_owner = ? AND lease_token = ?`)
        .bind(id, workerId, leaseToken)
        .run(),
    ).pipe(
      Effect.flatMap((result) =>
        (result.meta?.changes ?? 0) === 1
          ? Effect.void
          : Effect.fail(failure('platform-audit-outbox.mark-terminal-failed.lease')),
      ),
    ),
})

export const PlatformAuditExportOutboxRepositoryLive = Layer.effect(
  PlatformAuditExportOutboxRepository,
  Effect.gen(function* () {
    const database = yield* AuditD1Client
    return PlatformAuditExportOutboxRepository.of(
      makePlatformAuditExportOutboxRepositoryD1(database),
    )
  }),
)

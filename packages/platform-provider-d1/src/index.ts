import { Effect, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
  type AuditRequestContextValue,
  type AuditStateSummary,
} from '@gridora/audit-contracts'
import {
  PlatformAllocation,
  PlatformProviderAccount,
  PlatformProviderControlError,
  type PlatformProviderRepositoryShape,
} from '@gridora/platform-provider-control'
import {
  PlatformSecretError,
  PlatformSecretRecord,
  type PlatformSecretRepositoryShape,
} from '@gridora/platform-secret-envelope'

export interface D1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface D1Statement {
  bind(...values: ReadonlyArray<unknown>): D1Statement
  first(): Promise<unknown>
  all(): Promise<D1Result>
}
export interface PlatformProviderD1Database {
  prepare(sql: string): D1Statement
  batch(statements: ReadonlyArray<D1Statement>): Promise<ReadonlyArray<D1Result>>
}
export interface PlatformProviderD1Options {
  /** Immutable HTTP provenance required for each platform control mutation. */
  readonly auditRequestContext?: AuditRequestContextValue
}
const controlFailure = (
  operation: string,
  code: PlatformProviderControlError['code'] = 'persistence',
) => new PlatformProviderControlError({ operation, code })
const secretFailure = (operation: string, code: PlatformSecretError['code'] = 'persistence') =>
  new PlatformSecretError({ operation, code })
const attempt = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (error) =>
      controlFailure(
        operation,
        String(error).includes('active node provision execution')
          ? 'account_busy'
          : String(error).includes('UNIQUE')
            ? 'conflict'
            : 'persistence',
      ),
  })
const secretAttempt = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (error) =>
      secretFailure(
        operation,
        String(error).includes('active execution') ? 'account_busy' : 'persistence',
      ),
  })
const parse = <A, I>(schema: Schema.Codec<A, I, never>, operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => controlFailure(operation)))
const parseSecret = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(PlatformSecretRecord)(value).pipe(
    Effect.mapError(() => secretFailure(operation)),
  )
const accountSelect = `SELECT a.id, a.scope, a.organization_id AS organizationId, a.provider_type AS providerType,
 a.credential_reference AS credentialReference, s.revision AS credentialRevision, a.status, a.revision,
 a.created_at AS createdAt, a.updated_at AS updatedAt FROM provider_accounts a
 JOIN platform_secret_envelopes s ON s.id = a.credential_reference AND s.scope_id = a.id
 WHERE a.id = ? AND a.scope = 'platform' AND a.organization_id IS NULL`
const absent = (reason: string): AuditStateSummary => ({ state: 'absent', reason })
const captured = (summary: Record<string, unknown>): AuditStateSummary => ({
  state: 'captured',
  summary,
})
const accountSummary = (account: PlatformProviderAccount): Record<string, unknown> => ({
  accountId: account.id,
  scope: account.scope,
  providerType: account.providerType,
  status: account.status,
  revision: account.revision,
  credentialRevision: account.credentialRevision,
})
const allocationSummary = (allocation: PlatformAllocation): Record<string, unknown> => ({
  organizationId: allocation.organizationId,
  accountId: allocation.accountId,
  allowedRegions: allocation.allowedRegions,
  allowedPlans: allocation.allowedPlans,
  maxActiveNodes: allocation.maxActiveNodes,
  monthlyBudgetMinor: allocation.monthlyBudgetMinor,
  status: allocation.status,
  revision: allocation.revision,
})
const allocationTargetId = (allocation: PlatformAllocation): string =>
  `platform-allocation:${allocation.organizationId}:${allocation.accountId}`
const audit = (
  db: PlatformProviderD1Database,
  request: AuditRequestContextValue | undefined,
  input: {
    readonly auditEventId: string
    readonly operationId: string
    readonly operationIdempotencyKey: string
    readonly actor: { readonly identityId: string; readonly correlationId: string }
    readonly requestFingerprint: string
    readonly action: string
    readonly targetType: string
    readonly targetId: string
    readonly before: AuditStateSummary
    readonly after: AuditStateSummary
    readonly now: string
  },
): Effect.Effect<ReadonlyArray<D1Statement>, PlatformProviderControlError> =>
  Effect.gen(function* () {
    if (request === undefined || request.correlationId !== input.actor.correlationId)
      return yield* controlFailure('platformProvider.audit.request-context')
    const envelope = yield* completeAuditEnvelope({
      occurredAt: input.now,
      scope: 'platform',
      organizationId: null,
      actor: { type: 'platform', id: input.actor.identityId },
      action: input.action,
      target: { type: input.targetType, id: input.targetId },
      before: input.before,
      after: input.after,
      operationId: input.operationId,
      request,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError(() => controlFailure('platformProvider.audit.envelope')))
    const stage = yield* stageAuditEnvelope(
      'platform',
      input.auditEventId,
      envelope,
      input.now,
    ).pipe(Effect.mapError(() => controlFailure('platformProvider.audit.stage')))
    return [
      db
        .prepare(`INSERT INTO platform_operations
          (id,scope,type,resource_type,resource_id,actor_id,correlation_id,status,progress,
           idempotency_key,payload_fingerprint,revision,created_at,updated_at)
          VALUES (?,'platform',?,?,?,?,?,'succeeded',100,?,?,1,?,?)`)
        .bind(
          input.operationId,
          input.action,
          envelope.target.type,
          envelope.target.id,
          input.actor.identityId,
          envelope.request.correlationId,
          input.operationIdempotencyKey,
          input.requestFingerprint,
          input.now,
          input.now,
        ),
      db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      db
        .prepare(
          `INSERT INTO global_audit_events
            (id,scope,actor_id,action,target_type,target_id,result,correlation_id,summary_json,created_at)
            VALUES (?,'platform',?,?,?,?,?,?,?,?)`,
        )
        .bind(
          input.auditEventId,
          envelope.actor.id,
          envelope.action,
          envelope.target.type,
          envelope.target.id,
          envelope.result,
          envelope.request.correlationId,
          auditEventSummaryJson(envelope),
          envelope.occurredAt,
        ),
    ]
  })
const idempotency = (
  db: PlatformProviderD1Database,
  input: {
    idempotencyKey: string
    action: string
    accountId: string
    actor: { identityId: string }
    requestFingerprint: string
    expectedRevision: number
    resultRevision: number
    response: unknown
    auditEventId: string
    operationId: string
    operationIdempotencyKey: string
    now: string
  },
) =>
  db
    .prepare(
      `INSERT INTO platform_provider_mutations
       (idempotency_key,action,account_id,actor_id,request_fingerprint,expected_revision,result_revision,
        response_json,audit_event_id,operation_id,operation_idempotency_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      input.idempotencyKey,
      input.action,
      input.accountId,
      input.actor.identityId,
      input.requestFingerprint,
      input.expectedRevision,
      input.resultRevision,
      JSON.stringify(input.response),
      input.auditEventId,
      input.operationId,
      input.operationIdempotencyKey,
      input.now,
    )
const replay = <A, I>(
  db: PlatformProviderD1Database,
  table: string,
  key: string,
  fingerprint: string,
  schema: Schema.Codec<A, I, never>,
) =>
  Effect.gen(function* () {
    const value = yield* attempt('platformProvider.replay', () =>
      db
        .prepare(
          `SELECT request_fingerprint AS fingerprint,response_json AS response FROM ${table} WHERE idempotency_key = ?`,
        )
        .bind(key)
        .first(),
    )
    if (value === null) return null
    const row = value as Record<string, unknown>
    if (row.fingerprint !== fingerprint)
      return yield* controlFailure('platformProvider.replay', 'conflict')
    const decoded = yield* Effect.try({
      try: () => JSON.parse(String(row.response)) as unknown,
      catch: () => controlFailure('platformProvider.replay'),
    })
    return yield* parse(schema, 'platformProvider.replay.decode', decoded)
  })

export const makePlatformProviderRepositoryD1 = (
  db: PlatformProviderD1Database,
  options: PlatformProviderD1Options = {},
): PlatformProviderRepositoryShape => ({
  findAccountReplay: (key, fingerprint) =>
    replay(db, 'platform_provider_mutations', key, fingerprint, PlatformProviderAccount),
  getAccount: (id) =>
    Effect.gen(function* () {
      const value = yield* attempt('platformProvider.get', () =>
        db.prepare(accountSelect).bind(id).first(),
      )
      if (value === null) return yield* controlFailure('platformProvider.get', 'not_found')
      return yield* parse(PlatformProviderAccount, 'platformProvider.get.decode', value)
    }),
  createAccount: (input) =>
    Effect.gen(function* () {
      const a = input.account,
        s = input.secret
      const auditStatements = yield* audit(db, options.auditRequestContext, {
        ...input,
        action: 'platform.provider-account.create',
        targetType: 'provider-account',
        targetId: a.id,
        before: absent('provider account did not exist'),
        after: captured(accountSummary(a)),
      })
      yield* attempt('platformProvider.create', () =>
        db.batch([
          db
            .prepare(
              `INSERT INTO provider_accounts (id,scope,organization_id,provider_type,credential_reference,status,revision,created_at,updated_at) VALUES (?,'platform',NULL,?,?,?,1,?,?)`,
            )
            .bind(a.id, a.providerType, a.credentialReference, a.status, a.createdAt, a.updatedAt),
          db
            .prepare(
              `INSERT INTO platform_secret_envelopes (id,scope_type,scope_id,ciphertext,wrapped_data_key,key_version,revision,created_at,rotated_at) VALUES (?,'provider-account',?,?,?,?,?,?,?)`,
            )
            .bind(
              s.id,
              s.accountId,
              s.ciphertext,
              s.wrappedDataKey,
              s.keyVersion,
              s.revision,
              s.createdAt,
              s.rotatedAt,
            ),
          ...auditStatements,
          idempotency(db, {
            ...input,
            action: 'create',
            accountId: a.id,
            expectedRevision: 0,
            resultRevision: 1,
            response: a,
          }),
        ]),
      )
      return a
    }),
  updateAccount: (input) =>
    Effect.gen(function* () {
      const current = yield* makePlatformProviderRepositoryD1(db, options).getAccount(
        input.accountId,
      )
      if (current.revision !== input.expectedRevision)
        return yield* controlFailure('platformProvider.update', 'revision_conflict')
      const next = new PlatformProviderAccount({
        id: current.id,
        scope: current.scope,
        organizationId: current.organizationId,
        providerType: current.providerType,
        credentialReference: current.credentialReference,
        createdAt: current.createdAt,
        status: input.status,
        credentialRevision: input.credentialRevision,
        revision: current.revision + 1,
        updatedAt: input.now,
      })
      const statements: D1Statement[] = []
      if (input.secret !== undefined)
        statements.push(
          db
            .prepare(
              `UPDATE platform_secret_envelopes SET ciphertext=?,wrapped_data_key=?,key_version=?,revision=?,rotated_at=? WHERE scope_id=? AND revision=?`,
            )
            .bind(
              input.secret.ciphertext,
              input.secret.wrappedDataKey,
              input.secret.keyVersion,
              input.secret.revision,
              input.secret.rotatedAt,
              input.accountId,
              current.credentialRevision,
            ),
        )
      statements.push(
        db
          .prepare(
            `UPDATE provider_accounts SET status=?,revision=?,updated_at=? WHERE id=? AND scope='platform' AND revision=?`,
          )
          .bind(next.status, next.revision, next.updatedAt, next.id, current.revision),
        ...(yield* audit(db, options.auditRequestContext, {
          ...input,
          action: `platform.provider-account.${input.action}`,
          targetType: 'provider-account',
          targetId: next.id,
          before: captured(accountSummary(current)),
          after: captured(accountSummary(next)),
        })),
        idempotency(db, {
          ...input,
          accountId: next.id,
          expectedRevision: current.revision,
          resultRevision: next.revision,
          response: next,
        }),
      )
      yield* attempt('platformProvider.update', () => db.batch(statements))
      return next
    }),
  removeAccount: (input) =>
    Effect.gen(function* () {
      const current = yield* makePlatformProviderRepositoryD1(db, options).getAccount(
        input.accountId,
      )
      if (current.revision !== input.expectedRevision)
        return yield* controlFailure('platformProvider.remove', 'revision_conflict')
      if (current.status !== 'disabled')
        return yield* controlFailure('platformProvider.remove', 'conflict')
      const tombstone = new PlatformProviderAccount({
        id: current.id,
        scope: current.scope,
        organizationId: current.organizationId,
        providerType: current.providerType,
        credentialReference: current.credentialReference,
        credentialRevision: current.credentialRevision,
        status: current.status,
        createdAt: current.createdAt,
        revision: current.revision + 1,
        updatedAt: input.now,
      })
      const auditStatements = yield* audit(db, options.auditRequestContext, {
        ...input,
        action: 'platform.provider-account.remove',
        targetType: 'provider-account',
        targetId: current.id,
        before: captured(accountSummary(current)),
        after: absent('provider account was deleted'),
      })
      yield* attempt('platformProvider.remove', () =>
        db.batch([
          db
            .prepare(
              `DELETE FROM provider_allocations WHERE provider_account_id=? AND status='disabled' AND NOT EXISTS (SELECT 1 FROM nodes WHERE provider_account_id=?)`,
            )
            .bind(current.id, current.id),
          db
            .prepare(
              `DELETE FROM platform_secret_envelopes WHERE scope_id=? AND revision=? AND NOT EXISTS (SELECT 1 FROM provider_allocations WHERE provider_account_id=?)`,
            )
            .bind(current.id, input.credentialRevision, current.id),
          db
            .prepare(
              `DELETE FROM provider_accounts WHERE id=? AND scope='platform' AND revision=? AND NOT EXISTS (SELECT 1 FROM provider_allocations WHERE provider_account_id=?)`,
            )
            .bind(current.id, current.revision, current.id),
          ...auditStatements,
          idempotency(db, {
            ...input,
            action: 'remove',
            accountId: current.id,
            expectedRevision: current.revision,
            resultRevision: tombstone.revision,
            response: tombstone,
          }),
        ]),
      )
      return tombstone
    }),
  findAllocationReplay: (key, fingerprint) =>
    replay(db, 'platform_allocation_mutations', key, fingerprint, PlatformAllocation),
  putAllocation: (input) =>
    Effect.gen(function* () {
      const a = input.allocation
      const previous = yield* attempt('platformAllocation.get', () =>
        db
          .prepare(
            `SELECT revision FROM provider_allocations WHERE organization_id=? AND provider_account_id=?`,
          )
          .bind(a.organizationId, a.accountId)
          .first(),
      )
      const actual = previous === null ? 0 : Number((previous as Record<string, unknown>).revision)
      if (actual !== input.expectedRevision)
        return yield* controlFailure('platformAllocation.put', 'revision_conflict')
      const write =
        input.action === 'create'
          ? db
              .prepare(
                `INSERT INTO provider_allocations (organization_id,provider_account_id,allowed_regions_json,allowed_plans_json,max_active_nodes,monthly_budget_minor,status,revision) VALUES (?,?,?,?,?,?,?,1)`,
              )
              .bind(
                a.organizationId,
                a.accountId,
                JSON.stringify(a.allowedRegions),
                JSON.stringify(a.allowedPlans),
                a.maxActiveNodes,
                a.monthlyBudgetMinor,
                a.status,
              )
          : db
              .prepare(
                `UPDATE provider_allocations SET allowed_regions_json=?,allowed_plans_json=?,max_active_nodes=?,monthly_budget_minor=?,status=?,revision=? WHERE organization_id=? AND provider_account_id=? AND revision=?`,
              )
              .bind(
                JSON.stringify(a.allowedRegions),
                JSON.stringify(a.allowedPlans),
                a.maxActiveNodes,
                a.monthlyBudgetMinor,
                a.status,
                a.revision,
                a.organizationId,
                a.accountId,
                input.expectedRevision,
              )
      const auditStatements = yield* audit(db, options.auditRequestContext, {
        ...input,
        action: `platform.provider-allocation.${input.action}`,
        targetType: 'provider-allocation',
        targetId: allocationTargetId(a),
        before:
          previous === null
            ? absent('provider allocation did not exist')
            : captured({
                organizationId: a.organizationId,
                accountId: a.accountId,
                revision: actual,
              }),
        after: captured(allocationSummary(a)),
      })
      const mutation = db
        .prepare(
          `INSERT INTO platform_allocation_mutations
           (idempotency_key,action,organization_id,account_id,actor_id,request_fingerprint,expected_revision,
            result_revision,response_json,audit_event_id,operation_id,operation_idempotency_key,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          input.idempotencyKey,
          input.action,
          a.organizationId,
          a.accountId,
          input.actor.identityId,
          input.requestFingerprint,
          input.expectedRevision,
          a.revision,
          JSON.stringify(a),
          input.auditEventId,
          input.operationId,
          input.operationIdempotencyKey,
          input.now,
        )
      yield* attempt('platformAllocation.put', () =>
        db.batch([write, ...auditStatements, mutation]),
      )
      return a
    }),
})

export const makePlatformSecretRepositoryD1 = (
  db: PlatformProviderD1Database,
): PlatformSecretRepositoryShape => ({
  get: (accountId) =>
    Effect.gen(function* () {
      const value = yield* secretAttempt('platformSecret.get', () =>
        db
          .prepare(
            `SELECT id,scope_id AS accountId,ciphertext,wrapped_data_key AS wrappedDataKey,key_version AS keyVersion,revision,created_at AS createdAt,rotated_at AS rotatedAt FROM platform_secret_envelopes WHERE scope_id=?`,
          )
          .bind(accountId)
          .first(),
      )
      if (value === null) return yield* secretFailure('platformSecret.get', 'not_found')
      return yield* parseSecret('platformSecret.get.decode', value)
    }),
  create: (r) =>
    secretAttempt('platformSecret.create', () =>
      db.batch([
        db
          .prepare(
            `INSERT INTO platform_secret_envelopes (id,scope_type,scope_id,ciphertext,wrapped_data_key,key_version,revision,created_at,rotated_at) VALUES (?,'provider-account',?,?,?,?,?,?,?)`,
          )
          .bind(
            r.id,
            r.accountId,
            r.ciphertext,
            r.wrappedDataKey,
            r.keyVersion,
            r.revision,
            r.createdAt,
            r.rotatedAt,
          ),
      ]),
    ).pipe(Effect.as(r)),
  replace: (r, expected) =>
    secretAttempt('platformSecret.replace', () =>
      db.batch([
        db
          .prepare(
            `UPDATE platform_secret_envelopes SET ciphertext=?,wrapped_data_key=?,key_version=?,revision=?,rotated_at=? WHERE scope_id=? AND revision=?`,
          )
          .bind(
            r.ciphertext,
            r.wrappedDataKey,
            r.keyVersion,
            r.revision,
            r.rotatedAt,
            r.accountId,
            expected,
          ),
      ]),
    ).pipe(Effect.as(r)),
  remove: (accountId, expected) =>
    secretAttempt('platformSecret.remove', () =>
      db.batch([
        db
          .prepare(`DELETE FROM platform_secret_envelopes WHERE scope_id=? AND revision=?`)
          .bind(accountId, expected),
      ]),
    ).pipe(Effect.asVoid),
})

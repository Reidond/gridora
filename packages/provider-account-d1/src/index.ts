import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
} from '@gridora/audit-contracts'
import {
  ProviderAccountActionRepository,
  ProviderAccountLifecycleResult,
  ProviderAccountRecord,
  ProviderAccountStoreConflictError,
  ProviderAccountStoreNotFoundError,
  ProviderAccountStorePersistenceError,
  ProviderAccountStoreRevisionError,
  type ProviderAccountActionRepositoryShape,
  type ProviderAccountCommitInput,
  type ProviderAccountReplayQuery,
  type ProviderAccountStoreError,
} from '@gridora/provider-account-control'

export interface ProviderAccountD1Result {
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface ProviderAccountD1Statement {
  bind(...values: ReadonlyArray<unknown>): ProviderAccountD1Statement
  first(): Promise<unknown>
  all(): Promise<ProviderAccountD1Result>
}
export interface ProviderAccountD1Database {
  prepare(sql: string): ProviderAccountD1Statement
  /** Cloudflare D1 batches are transactional and preserve statement order. */
  batch(
    statements: ReadonlyArray<ProviderAccountD1Statement>,
  ): Promise<ReadonlyArray<ProviderAccountD1Result>>
}
export class ProviderAccountD1Client extends Context.Service<
  ProviderAccountD1Client,
  ProviderAccountD1Database
>()('@gridora/provider-account-d1/ProviderAccountD1Client') {}
export const ProviderAccountD1ClientLayer = (database: ProviderAccountD1Database) =>
  Layer.succeed(ProviderAccountD1Client, database)

/**
 * Additive schema required by this adapter. Central migration application is intentionally left to
 * application composition so this isolated package does not edit the shared migration sequence.
 */
export const providerAccountActionSchemaSql = `
CREATE TABLE IF NOT EXISTS provider_account_action_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('test', 'refresh', 'disable', 'remove')),
  account_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('ovhcloud', 'contabo')),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  result_revision INTEGER NOT NULL CHECK (result_revision = expected_revision + 1),
  operation_id TEXT NOT NULL,
  operation_idempotency_key TEXT NOT NULL CHECK (
    length(operation_idempotency_key) = 64
    AND operation_idempotency_key NOT GLOB '*[^0-9a-f]*'
  ),
  audit_event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (audit_event_id) REFERENCES audit_events(id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX IF NOT EXISTS provider_account_action_account
  ON provider_account_action_idempotency(organization_id, account_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS provider_account_action_precondition_fence
BEFORE INSERT ON provider_account_action_idempotency
WHEN
  json_extract(NEW.response_json, '$.organizationId') IS NOT NEW.organization_id
  OR json_extract(NEW.response_json, '$.accountId') IS NOT NEW.account_id
  OR json_extract(NEW.response_json, '$.providerType') IS NOT NEW.provider_type
  OR json_extract(NEW.response_json, '$.action') IS NOT NEW.action
  OR json_extract(NEW.response_json, '$.revision') IS NOT NEW.result_revision
  OR json_extract(NEW.response_json, '$.operationId') IS NOT NEW.operation_id
  OR NOT EXISTS (
    SELECT 1 FROM operations operation
    WHERE operation.id = NEW.operation_id
      AND operation.organization_id = NEW.organization_id
      AND operation.resource_type = 'provider-account'
      AND operation.resource_id = NEW.account_id
      AND operation.actor_id = NEW.actor_id
      AND operation.idempotency_key = NEW.operation_idempotency_key
  )
  OR NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.id = NEW.audit_event_id
      AND audit.organization_id = NEW.organization_id
      AND audit.target_type = 'provider-account'
      AND audit.target_id = NEW.account_id
      AND audit.actor_id = NEW.actor_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    JOIN secret_envelopes envelope
      ON envelope.organization_id = account.organization_id
     AND envelope.id = account.credential_reference
     AND envelope.scope_type = 'provider-account'
     AND envelope.scope_id = account.id
     AND envelope.revision = NEW.credential_revision
    WHERE account.id = NEW.account_id
      AND account.scope = 'organization'
      AND account.organization_id = NEW.organization_id
      AND account.provider_type = NEW.provider_type
      AND account.revision = NEW.expected_revision
  )
  OR (NEW.action = 'refresh' AND NOT EXISTS (
    SELECT 1 FROM provider_accounts account
    WHERE account.id = NEW.account_id
      AND account.organization_id = NEW.organization_id
      AND account.revision = NEW.expected_revision
      AND account.status = 'active'
  ))
  OR (NEW.action = 'remove' AND (
    NOT EXISTS (
      SELECT 1 FROM provider_accounts account
      WHERE account.id = NEW.account_id
        AND account.organization_id = NEW.organization_id
        AND account.revision = NEW.expected_revision
        AND account.status = 'disabled'
    )
    OR EXISTS (
      SELECT 1 FROM provider_allocations allocation
      WHERE allocation.organization_id = NEW.organization_id
        AND allocation.provider_account_id = NEW.account_id
        AND allocation.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM nodes node
      WHERE node.organization_id = NEW.organization_id
        AND node.provider_account_id = NEW.account_id
    )
  ))
  OR NEW.finalized <> 0
BEGIN
  SELECT RAISE(ABORT, 'provider account lifecycle precondition fence failed');
END;

CREATE TRIGGER IF NOT EXISTS provider_account_action_result_fence
BEFORE UPDATE OF finalized ON provider_account_action_idempotency
WHEN
  OLD.finalized <> 0
  OR NEW.finalized <> 1
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.action IS NOT OLD.action
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.provider_type IS NOT OLD.provider_type
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.expected_revision IS NOT OLD.expected_revision
  OR NEW.credential_revision IS NOT OLD.credential_revision
  OR NEW.result_revision IS NOT OLD.result_revision
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.operation_idempotency_key IS NOT OLD.operation_idempotency_key
  OR NEW.audit_event_id IS NOT OLD.audit_event_id
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.response_json IS NOT OLD.response_json
  OR (
    NEW.action = 'remove' AND (
      json_type(NEW.response_json, '$.accountStatus') <> 'null'
      OR NOT EXISTS (
        SELECT 1 FROM provider_accounts account
        WHERE account.id = NEW.account_id
          AND account.scope = 'organization'
          AND account.organization_id = NEW.organization_id
          AND account.provider_type = NEW.provider_type
          AND account.status = 'disabled'
          AND account.revision = NEW.result_revision
      )
      OR EXISTS (
        SELECT 1 FROM secret_envelopes envelope
        WHERE envelope.organization_id = NEW.organization_id
          AND envelope.scope_type = 'provider-account'
          AND envelope.scope_id = NEW.account_id
      )
    )
  )
  OR (
    NEW.action <> 'remove' AND NOT EXISTS (
      SELECT 1 FROM provider_accounts account
      JOIN secret_envelopes envelope
        ON envelope.organization_id = account.organization_id
       AND envelope.id = account.credential_reference
       AND envelope.scope_type = 'provider-account'
       AND envelope.scope_id = account.id
       AND envelope.revision = NEW.credential_revision
      WHERE account.id = NEW.account_id
        AND account.scope = 'organization'
        AND account.organization_id = NEW.organization_id
        AND account.provider_type = NEW.provider_type
        AND account.revision = NEW.result_revision
        AND account.status = json_extract(NEW.response_json, '$.accountStatus')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'provider account lifecycle transaction fence failed');
END;
`

const selectAccount = `SELECT account.id, account.scope,
 account.organization_id AS organizationId, account.provider_type AS providerType,
 account.credential_reference AS credentialReference, envelope.revision AS credentialRevision,
 account.status, account.revision, account.created_at AS createdAt, account.updated_at AS updatedAt
 FROM provider_accounts account
 JOIN secret_envelopes envelope
   ON envelope.organization_id = account.organization_id
  AND envelope.id = account.credential_reference
  AND envelope.scope_type = 'provider-account'
  AND envelope.scope_id = account.id`

const failure = (operation: string) => new ProviderAccountStorePersistenceError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

const decodeAccount = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(ProviderAccountRecord, { onExcessProperty: 'error' })(value).pipe(
    Effect.mapError(() => failure(operation)),
  )
const decodeResult = (operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(ProviderAccountLifecycleResult, { onExcessProperty: 'error' })(
    value,
  ).pipe(Effect.mapError(() => failure(operation)))

const getScoped = (
  database: ProviderAccountD1Database,
  organizationId: string,
  accountId: string,
) =>
  Effect.gen(function* () {
    const value = yield* attempt('providerAccount.lifecycle.get', () =>
      database
        .prepare(
          `${selectAccount} WHERE account.scope = 'organization'
           AND account.organization_id = ? AND account.id = ?`,
        )
        .bind(organizationId, accountId)
        .first(),
    )
    if (value === null) return yield* new ProviderAccountStoreNotFoundError({ accountId })
    return yield* decodeAccount('providerAccount.lifecycle.get.decode', value)
  })

const findReplay = (database: ProviderAccountD1Database, query: ProviderAccountReplayQuery) =>
  Effect.gen(function* () {
    const value = yield* attempt('providerAccount.lifecycle.replay.get', () =>
      database
        .prepare(
          `SELECT action, account_id AS accountId, provider_type AS providerType,
           request_fingerprint AS requestFingerprint, expected_revision AS expectedRevision,
           result_revision AS resultRevision, operation_id AS operationId, actor_id AS actorId,
           response_json AS responseJson
           FROM provider_account_action_idempotency
           WHERE organization_id = ? AND idempotency_key = ? AND finalized = 1`,
        )
        .bind(query.context.organizationId, query.idempotencyKey)
        .first(),
    )
    if (value === null) return null
    const found = record(value)
    if (
      text(found?.action) !== query.action ||
      text(found?.accountId) !== query.accountId ||
      text(found?.actorId) !== query.context.identityId ||
      text(found?.requestFingerprint) !== query.requestFingerprint
    )
      return yield* new ProviderAccountStoreConflictError({
        accountId: query.accountId,
        code: 'idempotency_payload_mismatch',
      })
    const encoded = text(found?.responseJson)
    if (encoded === undefined) return yield* failure('providerAccount.lifecycle.replay.row')
    const parsed = yield* Effect.try({
      try: () => JSON.parse(encoded) as unknown,
      catch: () => failure('providerAccount.lifecycle.replay.json'),
    })
    const result = yield* decodeResult('providerAccount.lifecycle.replay.decode', parsed)
    if (
      result.organizationId !== query.context.organizationId ||
      result.accountId !== query.accountId ||
      result.action !== query.action ||
      result.providerType !== text(found?.providerType) ||
      result.revision !== integer(found?.resultRevision) ||
      result.operationId !== text(found?.operationId)
    )
      return yield* failure('providerAccount.lifecycle.replay.binding')
    return result
  })

const referenceCounts = (
  database: ProviderAccountD1Database,
  organizationId: string,
  accountId: string,
) =>
  Effect.gen(function* () {
    const value = yield* attempt('providerAccount.lifecycle.references', () =>
      database
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM provider_allocations allocation
             WHERE allocation.organization_id = ? AND allocation.provider_account_id = ?) AS allocations,
           (SELECT COUNT(*) FROM nodes node
             WHERE node.organization_id = ? AND node.provider_account_id = ?) AS nodes,
           (SELECT COUNT(*) FROM provider_allocations allocation
             WHERE allocation.organization_id = ? AND allocation.provider_account_id = ?
               AND allocation.status = 'active') AS activeAllocations,
           (SELECT COUNT(*) FROM nodes node
             WHERE node.organization_id = ? AND node.provider_account_id = ?
               AND (node.desired_state <> 'deleted' OR node.observed_state <> 'deleted')) AS activeNodes`,
        )
        .bind(
          organizationId,
          accountId,
          organizationId,
          accountId,
          organizationId,
          accountId,
          organizationId,
          accountId,
        )
        .first(),
    )
    const found = record(value)
    const allocations = integer(found?.allocations)
    const nodes = integer(found?.nodes)
    const activeAllocations = integer(found?.activeAllocations)
    const activeNodes = integer(found?.activeNodes)
    if (
      allocations === undefined ||
      nodes === undefined ||
      activeAllocations === undefined ||
      activeNodes === undefined
    )
      return yield* failure('providerAccount.lifecycle.references.decode')
    return { allocations, nodes, activeAllocations, activeNodes }
  })

const diagnoseWriteFailure = (
  database: ProviderAccountD1Database,
  input: ProviderAccountCommitInput,
): Effect.Effect<never, ProviderAccountStoreError> =>
  Effect.gen(function* () {
    const replayed = yield* findReplay(database, input)
    if (replayed !== null) return replayed as never
    const account = yield* getScoped(database, input.context.organizationId, input.accountId)
    if (account.providerType !== input.account.providerType)
      return yield* new ProviderAccountStoreConflictError({
        accountId: input.accountId,
        code: 'provider_type_mismatch',
      })
    if (account.revision !== input.expectedRevision)
      return yield* new ProviderAccountStoreRevisionError({
        accountId: input.accountId,
        expectedRevision: input.expectedRevision,
        actualRevision: account.revision,
      })
    if (input.action === 'remove') {
      if (account.status !== 'disabled')
        return yield* new ProviderAccountStoreConflictError({
          accountId: input.accountId,
          code: 'account_not_disabled',
        })
      const references = yield* referenceCounts(
        database,
        input.context.organizationId,
        input.accountId,
      )
      if (references.activeAllocations > 0 || references.nodes > 0)
        return yield* new ProviderAccountStoreConflictError({
          accountId: input.accountId,
          code: 'account_referenced',
        })
    }
    if (input.action === 'refresh' && account.status !== 'active')
      return yield* new ProviderAccountStoreConflictError({
        accountId: input.accountId,
        code: 'account_not_active',
      })
    return yield* failure('providerAccount.lifecycle.commit')
  })

const operationStatus = (input: ProviderAccountCommitInput) =>
  input.result.outcome === 'retryable_failure'
    ? 'failed'
    : input.result.outcome === 'permanent_failure'
      ? 'failed_terminal'
      : 'succeeded'
const auditResult = (input: ProviderAccountCommitInput) =>
  input.result.outcome === 'retryable_failure' || input.result.outcome === 'permanent_failure'
    ? 'failed'
    : 'succeeded'

const lifecycleAuditSummary = (
  account: ProviderAccountCommitInput['account'],
  status: ProviderAccountCommitInput['result']['accountStatus'],
  revision: number,
  credentialState: 'present' | 'revoked' = 'present',
) => ({
  accountId: account.id,
  providerType: account.providerType,
  status,
  revision,
  credentialRevision: credentialState === 'present' ? account.credentialRevision : null,
  credentialState,
})

/**
 * The durable operation statement is deliberately first in the batch. The
 * strict v1 staging trigger then proves the actor, target, result, and
 * correlation before the compact event is accepted.
 */
const stageLifecycleAudit = (
  database: ProviderAccountD1Database,
  input: ProviderAccountCommitInput,
): Effect.Effect<
  { readonly statement: ProviderAccountD1Statement; readonly summaryJson: string },
  ProviderAccountStorePersistenceError
> =>
  Effect.gen(function* () {
    const failed = auditResult(input) === 'failed'
    const envelope = yield* completeAuditEnvelope({
      occurredAt: input.result.completedAt,
      scope: 'tenant',
      organizationId: input.context.organizationId,
      actor: { type: 'human', id: input.context.identityId },
      action: `provider-account.${input.action}`,
      target: { type: 'provider-account', id: input.account.id },
      before: {
        state: 'captured',
        summary: lifecycleAuditSummary(input.account, input.account.status, input.account.revision),
      },
      after: {
        state: 'captured',
        summary: lifecycleAuditSummary(
          input.account,
          input.result.accountStatus,
          input.result.revision,
          input.action === 'remove' ? 'revoked' : 'present',
        ),
      },
      operationId: input.result.operationId,
      request: input.auditRequestContext,
      result: auditResult(input),
      error: failed
        ? { classification: 'provider', code: input.result.failureCategory }
        : { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError(() => failure('providerAccount.lifecycle.audit.envelope')))
    const stage = yield* stageAuditEnvelope(
      'tenant',
      input.auditEventId,
      envelope,
      input.result.completedAt,
    ).pipe(Effect.mapError(() => failure('providerAccount.lifecycle.audit.stage')))
    return {
      statement: database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const validateCommitBinding = (
  input: ProviderAccountCommitInput,
): Effect.Effect<void, ProviderAccountStoreError> => {
  const retryOrPermanent =
    input.result.outcome === 'retryable_failure' || input.result.outcome === 'permanent_failure'
  const validationResultMatches =
    input.action === 'test'
      ? input.result.outcome === 'valid' || retryOrPermanent
      : input.action === 'refresh'
        ? input.result.outcome === 'refreshed' || retryOrPermanent
        : input.action === 'disable'
          ? input.result.outcome === 'disabled' &&
            input.result.accountStatus === 'disabled' &&
            input.result.failureCategory === null
          : input.result.outcome === 'removed' &&
            input.result.accountStatus === null &&
            input.result.failureCategory === null
  const statusMatches =
    input.result.outcome === 'valid' || input.result.outcome === 'refreshed'
      ? input.result.accountStatus === 'active' && input.result.failureCategory === null
      : input.result.outcome === 'retryable_failure'
        ? input.result.accountStatus === input.account.status &&
          input.result.failureCategory !== null
        : input.result.outcome === 'permanent_failure'
          ? input.result.accountStatus === 'error' && input.result.failureCategory !== null
          : true
  const catalogMatches =
    input.action === 'refresh' && input.result.outcome === 'refreshed'
      ? input.result.catalogItemCount === input.catalog.length
      : input.catalog.length === 0
  if (
    input.context.organizationId !== input.account.organizationId ||
    input.context.organizationId !== input.result.organizationId ||
    input.accountId !== input.account.id ||
    input.accountId !== input.result.accountId ||
    input.action !== input.result.action ||
    input.account.providerType !== input.result.providerType ||
    input.result.revision !== input.expectedRevision + 1 ||
    input.auditRequestContext.correlationId !== input.context.correlationId ||
    input.expectedRevision !== input.account.revision ||
    !/^[a-f0-9]{64}$/.test(input.requestFingerprint) ||
    !validationResultMatches ||
    !statusMatches ||
    !catalogMatches
  )
    return Effect.fail(failure('providerAccount.lifecycle.commit.binding'))
  if (input.catalog.length > 512)
    return Effect.fail(failure('providerAccount.lifecycle.commit.catalog-bound'))
  return Effect.void
}

const commit = (database: ProviderAccountD1Database, input: ProviderAccountCommitInput) =>
  Effect.gen(function* () {
    yield* validateCommitBinding(input)
    const before = yield* findReplay(database, input)
    if (before !== null) return before
    const resultJson = JSON.stringify(input.result)
    const audit = yield* stageLifecycleAudit(database, input)
    const mutationStatements: ProviderAccountD1Statement[] = []
    if (input.action === 'remove') {
      mutationStatements.push(
        database
          .prepare(
            `DELETE FROM provider_allocations
             WHERE organization_id = ? AND provider_account_id = ? AND status = 'disabled'
               AND NOT EXISTS (
                 SELECT 1 FROM nodes node
                 WHERE node.organization_id = ? AND node.provider_account_id = ?
               )`,
          )
          .bind(
            input.context.organizationId,
            input.account.id,
            input.context.organizationId,
            input.account.id,
          ),
        database
          .prepare(
            `DELETE FROM secret_envelopes
             WHERE organization_id = ? AND id = ? AND scope_type = 'provider-account'
               AND scope_id = ? AND revision = ?`,
          )
          .bind(
            input.context.organizationId,
            input.account.credentialReference,
            input.account.id,
            input.account.credentialRevision,
          ),
        database
          .prepare(
            `UPDATE provider_accounts SET revision = ?, updated_at = ?
             WHERE organization_id = ? AND id = ? AND scope = 'organization'
               AND provider_type = ? AND status = 'disabled' AND revision = ?
               AND NOT EXISTS (
                 SELECT 1 FROM provider_allocations allocation
                 WHERE allocation.organization_id = ? AND allocation.provider_account_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM nodes node
                 WHERE node.organization_id = ? AND node.provider_account_id = ?
               )`,
          )
          .bind(
            input.result.revision,
            input.result.completedAt,
            input.context.organizationId,
            input.account.id,
            input.account.providerType,
            input.expectedRevision,
            input.context.organizationId,
            input.account.id,
            input.context.organizationId,
            input.account.id,
          ),
      )
    } else {
      mutationStatements.push(
        database
          .prepare(
            `UPDATE provider_accounts SET status = ?, revision = ?, updated_at = ?
             WHERE organization_id = ? AND id = ? AND scope = 'organization'
               AND provider_type = ? AND revision = ?
               AND (? <> 'refresh' OR status = 'active')`,
          )
          .bind(
            input.result.accountStatus,
            input.result.revision,
            input.result.completedAt,
            input.context.organizationId,
            input.account.id,
            input.account.providerType,
            input.expectedRevision,
            input.action,
          ),
      )
      for (const item of input.catalog)
        mutationStatements.push(
          database
            .prepare(
              `INSERT INTO provider_catalog
               (provider_type, region, plan, currency, hourly_price_minor,
                monthly_price_minor, metadata_json, refreshed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(provider_type, region, plan) DO UPDATE SET
                currency = excluded.currency,
                hourly_price_minor = excluded.hourly_price_minor,
                monthly_price_minor = excluded.monthly_price_minor,
                metadata_json = excluded.metadata_json,
                refreshed_at = excluded.refreshed_at`,
            )
            .bind(
              input.account.providerType,
              item.region,
              item.plan,
              item.currency,
              item.hourlyPriceMinor,
              item.monthlyPriceMinor,
              JSON.stringify(item.metadata),
              input.result.completedAt,
            ),
        )
    }
    const statements: ProviderAccountD1Statement[] = [
      database
        .prepare(
          `INSERT INTO operations
           (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
            idempotency_key, correlation_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, 'provider-account', ?, ?, ?, 100, ?, ?, 1, ?, ?)`,
        )
        .bind(
          input.result.operationId,
          input.context.organizationId,
          `provider-account.${input.action}`,
          input.account.id,
          input.context.identityId,
          operationStatus(input),
          input.operationIdempotencyKey,
          input.context.correlationId,
          input.result.completedAt,
          input.result.completedAt,
        ),
      audit.statement,
      database
        .prepare(
          `INSERT INTO audit_events
           (id, organization_id, actor_id, action, target_type, target_id, result,
            correlation_id, summary_json, created_at)
           VALUES (?, ?, ?, ?, 'provider-account', ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.auditEventId,
          input.context.organizationId,
          input.context.identityId,
          `provider-account.${input.action}`,
          input.account.id,
          auditResult(input),
          input.context.correlationId,
          audit.summaryJson,
          input.result.completedAt,
        ),
      database
        .prepare(
          `INSERT INTO provider_account_action_idempotency
           (organization_id, idempotency_key, action, account_id, provider_type,
            request_fingerprint, expected_revision, credential_revision, result_revision,
            operation_id, operation_idempotency_key, audit_event_id, actor_id, response_json, finalized, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(
          input.context.organizationId,
          input.idempotencyKey,
          input.action,
          input.account.id,
          input.account.providerType,
          input.requestFingerprint,
          input.expectedRevision,
          input.account.credentialRevision,
          input.result.revision,
          input.result.operationId,
          input.operationIdempotencyKey,
          input.auditEventId,
          input.context.identityId,
          resultJson,
          input.result.completedAt,
        ),
      ...mutationStatements,
      database
        .prepare(
          `UPDATE provider_account_action_idempotency SET finalized = 1
           WHERE organization_id = ? AND idempotency_key = ? AND finalized = 0`,
        )
        .bind(input.context.organizationId, input.idempotencyKey),
    ]
    const written = yield* Effect.result(
      attempt('providerAccount.lifecycle.commit.batch', () => database.batch(statements)),
    )
    if (written._tag === 'Failure') {
      const recovered = yield* Effect.result(findReplay(database, input))
      if (recovered._tag === 'Success' && recovered.success !== null) return recovered.success
      return yield* diagnoseWriteFailure(database, input)
    }
    const exact = yield* findReplay(database, input)
    if (exact === null) return yield* failure('providerAccount.lifecycle.commit.missing-replay')
    return exact
  })

export const makeProviderAccountActionRepositoryD1 = (
  database: ProviderAccountD1Database,
): ProviderAccountActionRepositoryShape => ({
  getScoped: (context, accountId) => getScoped(database, context.organizationId, accountId),
  findReplay: (query) => findReplay(database, query),
  commit: (input) => commit(database, input),
})

export const ProviderAccountActionRepositoryD1Live = Layer.effect(
  ProviderAccountActionRepository,
  Effect.map(ProviderAccountD1Client, makeProviderAccountActionRepositoryD1),
)

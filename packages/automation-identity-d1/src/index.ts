import { Effect, Result, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelopeFromRequestContext,
  stageAuditEnvelope,
  type AuditRequestContext,
  type AuditStateSummary,
} from '@gridora/audit-contracts'
import {
  AutomationIdentity,
  AutomationIdentityAuthorizationError,
  AutomationIdentityConflictError,
  AutomationIdentityNotFoundError,
  AutomationIdentityPersistenceError,
  AutomationScope,
  automationCapabilitiesForScopes,
  type AutomationIdentityMutationResult,
  type AutomationIdentityReplayQuery,
  type AutomationIdentityRepositoryShape,
  type CreateAutomationIdentityRecord,
} from '@gridora/automation-identity-control'
import {
  AutomationCredentialAuthenticationPersistenceError,
  type AutomationCredentialAuthenticationRepositoryShape,
} from '@gridora/automation-identity-auth'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  IsoDateTime,
  OrganizationId,
  OrganizationSlug,
  type OrganizationContext,
} from '@gridora/domain'

export interface AutomationIdentityD1Result {
  readonly meta?: { readonly changes?: number }
}
export interface AutomationIdentityD1Statement {
  bind(...values: ReadonlyArray<unknown>): AutomationIdentityD1Statement
  first(): Promise<unknown>
  all(): Promise<{ readonly results: ReadonlyArray<unknown> }>
}
export interface AutomationIdentityD1Database {
  prepare(sql: string): AutomationIdentityD1Statement
  /** D1 executes a batch as one SQLite transaction and preserves statement order. */
  batch(
    statements: ReadonlyArray<AutomationIdentityD1Statement>,
  ): Promise<ReadonlyArray<AutomationIdentityD1Result>>
}

const identitySelect = `SELECT identity.organization_id AS organizationId,
  identity.id, identity.name, identity.client_id AS clientId,
  identity.scopes_json AS scopesJson, identity.status, identity.expires_at AS expiresAt,
  identity.credential_version AS credentialVersion, identity.last_used_at AS lastUsedAt,
  identity.created_by AS createdBy, identity.created_at AS createdAt,
  identity.revoked_at AS revokedAt, identity.revision
FROM automation_identities identity`

const authSelect = `SELECT identity.organization_id AS organizationId,
  organization.slug AS organizationSlug, organization.status AS organizationStatus,
  identity.id AS automationIdentityId, identity.client_id AS clientId,
  credential.id AS credentialId, credential.credential_hash AS credentialHash,
  identity.scopes_json AS scopesJson, identity.status AS identityStatus,
  credential.status AS credentialStatus, identity.expires_at AS expiresAt,
  identity.revision AS identityRevision, credential.version AS credentialVersion,
  credential.revision AS credentialRevision,
  creator.status AS creatorIdentityStatus, creatorMembership.status AS creatorMembershipStatus
FROM automation_identities identity
JOIN automation_identity_credentials credential
  ON credential.organization_id = identity.organization_id
 AND credential.automation_identity_id = identity.id
 AND credential.id = identity.credential_reference
JOIN organizations organization ON organization.id = identity.organization_id
JOIN identities creator ON creator.id = identity.created_by
LEFT JOIN organization_memberships creatorMembership
  ON creatorMembership.organization_id = identity.organization_id
 AND creatorMembership.identity_id = identity.created_by`

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const failure = (operation: string) => new AutomationIdentityPersistenceError({ operation })
const authenticationFailure = (operation: string) =>
  new AutomationCredentialAuthenticationPersistenceError({ operation })

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => failure(operation) })
const authenticationAttempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => authenticationFailure(operation) })

const decodeScopes = (operation: string, value: unknown) =>
  Effect.try({
    try: () => {
      if (typeof value !== 'string') throw new Error('missing scopes JSON')
      return JSON.parse(value) as unknown
    },
    catch: () => failure(operation),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AutomationScope))),
    Effect.mapError(() => failure(operation)),
  )

const decodeIdentity = (operation: string, value: unknown) =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* failure(operation)
    const scopes = yield* decodeScopes(operation, row.scopesJson)
    return yield* Schema.decodeUnknownEffect(AutomationIdentity, { onExcessProperty: 'error' })({
      organizationId: row.organizationId,
      id: row.id,
      name: row.name,
      clientId: row.clientId,
      scopes,
      capabilities: automationCapabilitiesForScopes(scopes),
      status: row.status,
      expiresAt: row.expiresAt,
      credentialVersion: row.credentialVersion,
      lastUsedAt: row.lastUsedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      revision: row.revision,
    }).pipe(Effect.mapError(() => failure(operation)))
  })

const getScoped = (
  database: AutomationIdentityD1Database,
  context: OrganizationContext,
  automationIdentityId: string,
) =>
  Effect.gen(function* () {
    const row = yield* attempt('automationIdentity.get', () =>
      database
        .prepare(`${identitySelect} WHERE identity.organization_id = ? AND identity.id = ?`)
        .bind(context.organizationId, automationIdentityId)
        .first(),
    )
    if (row === null) return yield* new AutomationIdentityNotFoundError({ automationIdentityId })
    return yield* decodeIdentity('automationIdentity.get.decode', row)
  })

const decodeReplay = (
  input: AutomationIdentityReplayQuery,
  value: unknown,
): Effect.Effect<
  AutomationIdentityMutationResult,
  AutomationIdentityConflictError | AutomationIdentityPersistenceError
> =>
  Effect.gen(function* () {
    const row = record(value)
    const action = text(row?.action)
    const identityId = text(row?.automationIdentityId)
    const requestFingerprint = text(row?.requestFingerprint)
    const responseJson = text(row?.responseJson)
    if (
      action !== input.action ||
      requestFingerprint !== input.requestFingerprint ||
      identityId === undefined ||
      (input.automationIdentityId !== null && identityId !== input.automationIdentityId)
    )
      return yield* new AutomationIdentityConflictError({ code: 'idempotency_payload_mismatch' })
    if (responseJson === undefined) return yield* failure('automationIdentity.replay.decode')
    const decoded = yield* Effect.try({
      try: () => JSON.parse(responseJson) as unknown,
      catch: () => failure('automationIdentity.replay.json'),
    })
    const identity = yield* Schema.decodeUnknownEffect(AutomationIdentity, {
      onExcessProperty: 'error',
    })(decoded).pipe(Effect.mapError(() => failure('automationIdentity.replay.identity')))
    if (identity.organizationId !== input.context.organizationId || identity.id !== identityId)
      return yield* failure('automationIdentity.replay.binding')
    return { identity, replayed: true }
  })

const findReplay = (database: AutomationIdentityD1Database, input: AutomationIdentityReplayQuery) =>
  Effect.gen(function* () {
    const row = yield* attempt('automationIdentity.replay.get', () =>
      database
        .prepare(`SELECT action, automation_identity_id AS automationIdentityId,
          request_fingerprint AS requestFingerprint, response_json AS responseJson
          FROM automation_identity_mutations
          WHERE organization_id = ? AND idempotency_key = ?`)
        .bind(input.context.organizationId, input.idempotencyKey)
        .first(),
    )
    if (row === null) return null
    return yield* decodeReplay(input, row)
  })

const responseForCreate = (input: CreateAutomationIdentityRecord) => ({
  organizationId: input.context.organizationId,
  id: input.automationIdentityId,
  name: input.name,
  clientId: input.clientId,
  scopes: [...input.scopes],
  capabilities: automationCapabilitiesForScopes(input.scopes),
  status: 'active' as const,
  expiresAt: input.expiresAt,
  credentialVersion: 1,
  lastUsedAt: null,
  createdBy: input.context.identityId,
  createdAt: input.now,
  revokedAt: null,
  revision: 1,
})

const automationOutboxPayload = (
  organizationId: string,
  automationIdentityId: string,
  action: 'create' | 'rotate' | 'revoke',
  revision: number,
) =>
  JSON.stringify({
    schemaVersion: 1,
    organizationId,
    automationIdentityId,
    action,
    revision,
  })

const automationAuditState = (identity: {
  readonly status: string
  readonly scopes: ReadonlyArray<string>
  readonly expiresAt: string | null
  readonly credentialVersion: number
  readonly revision: number
}) => ({
  status: identity.status,
  scopes: [...identity.scopes],
  expiresAt: identity.expiresAt,
  credentialVersion: identity.credentialVersion,
  revision: identity.revision,
})

/**
 * The operation statement is deliberately placed before this staged statement
 * in every batch below.  The migration verifies the exact actor, target,
 * correlation, and successful operation before it permits the compact row.
 */
const stageAutomationAudit = (
  database: AutomationIdentityD1Database,
  input: {
    readonly eventId: string
    readonly operationId: string
    readonly context: OrganizationContext
    readonly action: 'create' | 'rotate' | 'revoke'
    readonly automationIdentityId: string
    readonly before: AuditStateSummary
    readonly after: AuditStateSummary
    readonly now: string
  },
): Effect.Effect<
  { readonly statement: AutomationIdentityD1Statement; readonly summaryJson: string },
  AutomationIdentityPersistenceError,
  AuditRequestContext
> =>
  Effect.gen(function* () {
    const envelope = yield* completeAuditEnvelopeFromRequestContext({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.context.organizationId,
      actor: { type: 'human', id: input.context.identityId },
      action: `automation-identity.${input.action}`,
      target: { type: 'automation-identity', id: input.automationIdentityId },
      before: input.before,
      after: input.after,
      operationId: input.operationId,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError(() => failure('automationIdentity.audit.envelope')))
    const staged = yield* stageAuditEnvelope('tenant', input.eventId, envelope, input.now).pipe(
      Effect.mapError(() => failure('automationIdentity.audit.stage')),
    )
    return {
      statement: database
        .prepare(auditEnvelopeStageSql)
        .bind(...auditEnvelopeStageBindings(staged)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const resultChanged = (results: ReadonlyArray<AutomationIdentityD1Result>): boolean =>
  (results[0]?.meta?.changes ?? 0) === 1

type MutationActorFenceInput = {
  readonly context: OrganizationContext
  readonly actorMembershipRevision?: number
}

/** Repeated in every mutation statement, after the Access middleware may have run. */
const activeMutationActorFence = `EXISTS (
  SELECT 1
  FROM organizations organization
  JOIN identities actor ON actor.id = ?
  JOIN organization_memberships membership
    ON membership.organization_id = organization.id AND membership.identity_id = actor.id
  WHERE organization.id = ?
    AND organization.status = 'active'
    AND actor.status = 'active'
    AND membership.status = 'active'
    AND membership.role IN ('owner', 'administrator')
    AND (? IS NULL OR membership.revision = ?)
)`

const mutationActorFenceBindings = (input: MutationActorFenceInput) => {
  const expectedMembershipRevision = input.actorMembershipRevision ?? null
  return [
    input.context.identityId,
    input.context.organizationId,
    expectedMembershipRevision,
    expectedMembershipRevision,
  ] as const
}

const requireActiveMutationActor = (
  database: AutomationIdentityD1Database,
  input: MutationActorFenceInput,
) =>
  Effect.gen(function* () {
    const row = yield* attempt('automationIdentity.actor.fence', () =>
      database
        .prepare(`SELECT 1 AS allowed WHERE ${activeMutationActorFence}`)
        .bind(...mutationActorFenceBindings(input))
        .first(),
    )
    if (row === null)
      return yield* new AutomationIdentityAuthorizationError({ code: 'administrator_required' })
  })

const runMutation = (
  database: AutomationIdentityD1Database,
  operation: string,
  statements: ReadonlyArray<AutomationIdentityD1Statement>,
) => attempt(operation, () => database.batch(statements))

const diagnoseCreateFailure = (
  database: AutomationIdentityD1Database,
  input: CreateAutomationIdentityRecord,
) =>
  Effect.gen(function* () {
    yield* requireActiveMutationActor(database, input)
    const existing = yield* attempt('automationIdentity.create.name', () =>
      database
        .prepare(`SELECT id FROM automation_identities WHERE organization_id = ? AND name = ?`)
        .bind(input.context.organizationId, input.name)
        .first(),
    )
    if (existing !== null) return yield* new AutomationIdentityConflictError({ code: 'name_taken' })
    return yield* failure('automationIdentity.create')
  })

const diagnoseRevisionFailure = (
  database: AutomationIdentityD1Database,
  input: MutationActorFenceInput,
  automationIdentityId: string,
  expectedRevision: number,
) =>
  Effect.gen(function* () {
    yield* requireActiveMutationActor(database, input)
    const current = yield* getScoped(database, input.context, automationIdentityId)
    if (current.status !== 'active')
      return yield* new AutomationIdentityConflictError({ code: 'identity_revoked' })
    if (current.revision !== expectedRevision)
      return yield* new AutomationIdentityConflictError({ code: 'revision_mismatch' })
    return yield* failure('automationIdentity.mutation')
  })

export const makeAutomationIdentityRepositoryD1 = (
  database: AutomationIdentityD1Database,
): AutomationIdentityRepositoryShape => ({
  get: (context, automationIdentityId) => getScoped(database, context, automationIdentityId),
  findReplay: (input) => findReplay(database, input),
  create: (input) =>
    Effect.gen(function* () {
      const prior = yield* findReplay(database, {
        context: input.context,
        action: 'create',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        automationIdentityId: null,
      })
      if (prior !== null) return prior
      const identity = responseForCreate(input)
      const responseJson = JSON.stringify(identity)
      const audit = yield* stageAutomationAudit(database, {
        eventId: input.auditEventId,
        operationId: input.operationId,
        context: input.context,
        action: 'create',
        automationIdentityId: input.automationIdentityId,
        before: { state: 'absent', reason: 'automation-identity-did-not-exist' },
        after: { state: 'captured', summary: automationAuditState(identity) },
        now: input.now,
      })
      const result = yield* Effect.result(
        runMutation(database, 'automationIdentity.create', [
          database
            .prepare(`INSERT INTO automation_identities
              (organization_id, id, name, client_id, credential_reference, status, last_used_at,
               created_by, created_at, revision, scopes_json, expires_at, credential_version,
               revoked_at, updated_at)
              SELECT ?, ?, ?, ?, ?, 'active', NULL, ?, ?, 1, ?, ?, 1, NULL, ?
              WHERE ${activeMutationActorFence}`)
            .bind(
              input.context.organizationId,
              input.automationIdentityId,
              input.name,
              input.clientId,
              input.credentialId,
              input.context.identityId,
              input.now,
              JSON.stringify(input.scopes),
              input.expiresAt,
              input.now,
              ...mutationActorFenceBindings(input),
            ),
          database
            .prepare(`INSERT INTO automation_identity_credentials
              (organization_id, automation_identity_id, id, credential_hash, version, status,
               issued_at, expires_at, last_used_at, revoked_at, revision)
              VALUES (?, ?, ?, ?, 1, 'active', ?, ?, NULL, NULL, 1)`)
            .bind(
              input.context.organizationId,
              input.automationIdentityId,
              input.credentialId,
              input.credentialHash,
              input.now,
              input.expiresAt,
            ),
          database
            .prepare(`INSERT INTO operations
              (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
               idempotency_key, correlation_id, revision, created_at, updated_at)
              VALUES (?, ?, 'automation-identity.create', 'automation-identity', ?, ?,
               'succeeded', 100, ?, ?, 1, ?, ?)`)
            .bind(
              input.operationId,
              input.context.organizationId,
              input.automationIdentityId,
              input.context.identityId,
              input.idempotencyKey,
              input.context.correlationId,
              input.now,
              input.now,
            ),
          audit.statement,
          database
            .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              VALUES (?, ?, ?, 'automation-identity.create', 'automation-identity', ?,
               'succeeded', ?, ?, ?)`)
            .bind(
              input.auditEventId,
              input.context.organizationId,
              input.context.identityId,
              input.automationIdentityId,
              input.context.correlationId,
              audit.summaryJson,
              input.now,
            ),
          database
            .prepare(`INSERT INTO outbox
              (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
               publish_state, retry_count, available_at, created_at)
              VALUES (?, ?, 'automation-identity.create', 'automation-identity', ?, ?,
               'pending', 0, ?, ?)`)
            .bind(
              input.outboxEventId,
              input.context.organizationId,
              input.automationIdentityId,
              automationOutboxPayload(
                input.context.organizationId,
                input.automationIdentityId,
                'create',
                identity.revision,
              ),
              input.now,
              input.now,
            ),
          database
            .prepare(`INSERT INTO automation_identity_mutations
              (organization_id, idempotency_key, action, automation_identity_id, request_fingerprint,
               expected_revision, result_revision, operation_id, audit_event_id, outbox_event_id,
               secret_delivery, response_json, created_at)
              VALUES (?, ?, 'create', ?, ?, 0, 1, ?, ?, ?, 'sealed', ?, ?)`)
            .bind(
              input.context.organizationId,
              input.idempotencyKey,
              input.automationIdentityId,
              input.requestFingerprint,
              input.operationId,
              input.auditEventId,
              input.outboxEventId,
              responseJson,
              input.now,
            ),
        ]),
      )
      if (Result.isSuccess(result) && resultChanged(result.success))
        return { identity, replayed: false }
      const concurrent = yield* findReplay(database, {
        context: input.context,
        action: 'create',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        automationIdentityId: null,
      })
      if (concurrent !== null) return concurrent
      return yield* diagnoseCreateFailure(database, input)
    }),
  rotate: (input) =>
    Effect.gen(function* () {
      const replayQuery: AutomationIdentityReplayQuery = {
        context: input.context,
        action: 'rotate',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        automationIdentityId: input.automationIdentityId,
      }
      const prior = yield* findReplay(database, replayQuery)
      if (prior !== null) return prior
      const current = yield* getScoped(database, input.context, input.automationIdentityId)
      if (current.status !== 'active')
        return yield* new AutomationIdentityConflictError({ code: 'identity_revoked' })
      if (current.revision !== input.expectedRevision)
        return yield* new AutomationIdentityConflictError({ code: 'revision_mismatch' })
      const identity = {
        ...current,
        expiresAt: input.expiresAt,
        credentialVersion: current.credentialVersion + 1,
        revision: current.revision + 1,
      }
      const responseJson = JSON.stringify(identity)
      const audit = yield* stageAutomationAudit(database, {
        eventId: input.auditEventId,
        operationId: input.operationId,
        context: input.context,
        action: 'rotate',
        automationIdentityId: input.automationIdentityId,
        before: { state: 'captured', summary: automationAuditState(current) },
        after: { state: 'captured', summary: automationAuditState(identity) },
        now: input.now,
      })
      const result = yield* Effect.result(
        runMutation(database, 'automationIdentity.rotate', [
          database
            .prepare(`UPDATE automation_identities
              SET credential_reference = ?, credential_version = credential_version + 1,
                  expires_at = ?, revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND ${activeMutationActorFence}`)
            .bind(
              input.credentialId,
              input.expiresAt,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision,
              ...mutationActorFenceBindings(input),
            ),
          database
            .prepare(`UPDATE automation_identity_credentials
              SET status = 'revoked', revoked_at = ?, revision = revision + 1
              WHERE organization_id = ? AND automation_identity_id = ? AND status = 'active'
                AND EXISTS (
                  SELECT 1 FROM automation_identities identity
                  WHERE identity.organization_id = ? AND identity.id = ?
                    AND identity.credential_reference = ?
                    AND identity.revision = ? AND identity.status = 'active'
                )`)
            .bind(
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.context.organizationId,
              input.automationIdentityId,
              input.credentialId,
              input.expectedRevision + 1,
            ),
          database
            .prepare(`INSERT INTO automation_identity_credentials
              (organization_id, automation_identity_id, id, credential_hash, version, status,
               issued_at, expires_at, last_used_at, revoked_at, revision)
              SELECT organization_id, id, ?, ?, credential_version, 'active', ?, expires_at,
                NULL, NULL, 1
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND credential_reference = ?
                AND revision = ? AND status = 'active'`)
            .bind(
              input.credentialId,
              input.credentialHash,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.credentialId,
              input.expectedRevision + 1,
            ),
          database
            .prepare(`INSERT INTO operations
              (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
               idempotency_key, correlation_id, revision, created_at, updated_at)
              SELECT ?, organization_id, 'automation-identity.rotate', 'automation-identity', id, ?,
                'succeeded', 100, ?, ?, 1, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND credential_reference = ?`)
            .bind(
              input.operationId,
              input.context.identityId,
              input.idempotencyKey,
              input.context.correlationId,
              input.now,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
              input.credentialId,
            ),
          audit.statement,
          database
            .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              SELECT ?, organization_id, ?, 'automation-identity.rotate', 'automation-identity', id,
                'succeeded', ?, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND credential_reference = ?`)
            .bind(
              input.auditEventId,
              input.context.identityId,
              input.context.correlationId,
              audit.summaryJson,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
              input.credentialId,
            ),
          database
            .prepare(`INSERT INTO outbox
              (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
               publish_state, retry_count, available_at, created_at)
              SELECT ?, organization_id, 'automation-identity.rotate', 'automation-identity', id, ?,
                'pending', 0, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND credential_reference = ?`)
            .bind(
              input.outboxEventId,
              automationOutboxPayload(
                input.context.organizationId,
                input.automationIdentityId,
                'rotate',
                identity.revision,
              ),
              input.now,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
              input.credentialId,
            ),
          database
            .prepare(`INSERT INTO automation_identity_mutations
              (organization_id, idempotency_key, action, automation_identity_id, request_fingerprint,
               expected_revision, result_revision, operation_id, audit_event_id, outbox_event_id,
               secret_delivery, response_json, created_at)
              SELECT ?, ?, 'rotate', id, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND credential_reference = ?`)
            .bind(
              input.context.organizationId,
              input.idempotencyKey,
              input.requestFingerprint,
              input.expectedRevision,
              identity.revision,
              input.operationId,
              input.auditEventId,
              input.outboxEventId,
              responseJson,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
              input.credentialId,
            ),
        ]),
      )
      if (Result.isSuccess(result) && resultChanged(result.success))
        return { identity, replayed: false }
      const concurrent = yield* findReplay(database, replayQuery)
      if (concurrent !== null) return concurrent
      return yield* diagnoseRevisionFailure(
        database,
        input,
        input.automationIdentityId,
        input.expectedRevision,
      )
    }),
  revoke: (input) =>
    Effect.gen(function* () {
      const replayQuery: AutomationIdentityReplayQuery = {
        context: input.context,
        action: 'revoke',
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        automationIdentityId: input.automationIdentityId,
      }
      const prior = yield* findReplay(database, replayQuery)
      if (prior !== null) return prior
      const current = yield* getScoped(database, input.context, input.automationIdentityId)
      if (current.status !== 'active')
        return yield* new AutomationIdentityConflictError({ code: 'identity_revoked' })
      if (current.revision !== input.expectedRevision)
        return yield* new AutomationIdentityConflictError({ code: 'revision_mismatch' })
      const identity = {
        ...current,
        status: 'revoked' as const,
        revokedAt: input.now,
        revision: current.revision + 1,
      }
      const responseJson = JSON.stringify(identity)
      const audit = yield* stageAutomationAudit(database, {
        eventId: input.auditEventId,
        operationId: input.operationId,
        context: input.context,
        action: 'revoke',
        automationIdentityId: input.automationIdentityId,
        before: { state: 'captured', summary: automationAuditState(current) },
        after: { state: 'captured', summary: automationAuditState(identity) },
        now: input.now,
      })
      const result = yield* Effect.result(
        runMutation(database, 'automationIdentity.revoke', [
          database
            .prepare(`UPDATE automation_identities
              SET status = 'revoked', revoked_at = ?, revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND ${activeMutationActorFence}`)
            .bind(
              input.now,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision,
              ...mutationActorFenceBindings(input),
            ),
          database
            .prepare(`INSERT INTO operations
              (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
               idempotency_key, correlation_id, revision, created_at, updated_at)
              SELECT ?, organization_id, 'automation-identity.revoke', 'automation-identity', id, ?,
                'succeeded', 100, ?, ?, 1, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'revoked'`)
            .bind(
              input.operationId,
              input.context.identityId,
              input.idempotencyKey,
              input.context.correlationId,
              input.now,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
            ),
          audit.statement,
          database
            .prepare(`INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id, result,
               correlation_id, summary_json, created_at)
              SELECT ?, organization_id, ?, 'automation-identity.revoke', 'automation-identity', id,
                'succeeded', ?, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'revoked'`)
            .bind(
              input.auditEventId,
              input.context.identityId,
              input.context.correlationId,
              audit.summaryJson,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
            ),
          database
            .prepare(`INSERT INTO outbox
              (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
               publish_state, retry_count, available_at, created_at)
              SELECT ?, organization_id, 'automation-identity.revoke', 'automation-identity', id, ?,
                'pending', 0, ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'revoked'`)
            .bind(
              input.outboxEventId,
              automationOutboxPayload(
                input.context.organizationId,
                input.automationIdentityId,
                'revoke',
                identity.revision,
              ),
              input.now,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
            ),
          database
            .prepare(`INSERT INTO automation_identity_mutations
              (organization_id, idempotency_key, action, automation_identity_id, request_fingerprint,
               expected_revision, result_revision, operation_id, audit_event_id, outbox_event_id,
               secret_delivery, response_json, created_at)
              SELECT ?, ?, 'revoke', id, ?, ?, ?, ?, ?, ?, 'none', ?, ?
              FROM automation_identities
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'revoked'`)
            .bind(
              input.context.organizationId,
              input.idempotencyKey,
              input.requestFingerprint,
              input.expectedRevision,
              identity.revision,
              input.operationId,
              input.auditEventId,
              input.outboxEventId,
              responseJson,
              input.now,
              input.context.organizationId,
              input.automationIdentityId,
              input.expectedRevision + 1,
            ),
        ]),
      )
      if (Result.isSuccess(result) && resultChanged(result.success))
        return { identity, replayed: false }
      const concurrent = yield* findReplay(database, replayQuery)
      if (concurrent !== null) return concurrent
      return yield* diagnoseRevisionFailure(
        database,
        input,
        input.automationIdentityId,
        input.expectedRevision,
      )
    }),
  list: (context) =>
    Effect.gen(function* () {
      const rows = yield* attempt('automationIdentity.list', () =>
        database
          .prepare(
            `${identitySelect} WHERE identity.organization_id = ? ORDER BY identity.created_at DESC LIMIT 100`,
          )
          .bind(context.organizationId)
          .all(),
      )
      return yield* Effect.forEach(rows.results, (row) =>
        decodeIdentity('automationIdentity.list.decode', row),
      )
    }),
})

const decodeAuthenticationRecord = (value: unknown) =>
  Effect.gen(function* () {
    const row = record(value)
    if (row === undefined) return yield* authenticationFailure('automationCredential.lookup.decode')
    const scopesJson = text(row.scopesJson)
    if (scopesJson === undefined)
      return yield* authenticationFailure('automationCredential.lookup.scopes')
    const parsedScopes = yield* Effect.try({
      try: () => JSON.parse(scopesJson) as unknown,
      catch: () => authenticationFailure('automationCredential.lookup.scopes'),
    })
    const scopes = yield* Schema.decodeUnknownEffect(Schema.Array(AutomationScope))(
      parsedScopes,
    ).pipe(Effect.mapError(() => authenticationFailure('automationCredential.lookup.scopes')))
    const candidate = {
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      automationIdentityId: row.automationIdentityId,
      clientId: row.clientId,
      credentialId: row.credentialId,
      credentialVersion: row.credentialVersion,
      credentialHash: row.credentialHash,
      scopes,
      organizationStatus: row.organizationStatus,
      identityStatus: row.identityStatus,
      credentialStatus: row.credentialStatus,
      expiresAt: row.expiresAt,
      identityRevision: row.identityRevision,
      credentialRevision: row.credentialRevision,
      creatorIdentityStatus: row.creatorIdentityStatus,
      creatorMembershipStatus: row.creatorMembershipStatus,
    }
    return yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        organizationId: OrganizationId,
        organizationSlug: OrganizationSlug,
        automationIdentityId: AutomationIdentityId,
        clientId: Schema.String,
        credentialId: AutomationCredentialId,
        credentialVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
        credentialHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
        scopes: Schema.Array(AutomationScope),
        organizationStatus: Schema.Literals(['active', 'suspended', 'deleting', 'deleted']),
        identityStatus: Schema.Literals(['active', 'revoked']),
        credentialStatus: Schema.Literals(['active', 'revoked']),
        expiresAt: Schema.NullOr(IsoDateTime),
        identityRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
        credentialRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
        creatorIdentityStatus: Schema.Literals(['active', 'suspended']),
        creatorMembershipStatus: Schema.NullOr(Schema.Literals(['active', 'suspended'])),
      }),
    )(candidate).pipe(
      Effect.mapError(() => authenticationFailure('automationCredential.lookup.decode')),
    )
  })

export const makeAutomationCredentialAuthenticationRepositoryD1 = (
  database: AutomationIdentityD1Database,
): AutomationCredentialAuthenticationRepositoryShape => ({
  findForAuthentication: (input) =>
    Effect.gen(function* () {
      const row = yield* authenticationAttempt('automationCredential.lookup', () =>
        database
          .prepare(
            `${authSelect} WHERE organization.id = (
                SELECT CASE WHEN COUNT(*) = 1 THEN MIN(candidate.id) ELSE NULL END
                FROM organizations candidate
                WHERE candidate.id = ? OR candidate.slug = ?
              )
              AND identity.client_id = ? AND credential.id = ?`,
          )
          .bind(input.organization, input.organization, input.clientId, input.credentialId)
          .first(),
      )
      if (row === null) return null
      return yield* decodeAuthenticationRecord(row)
    }),
  consumeRateLimit: (input) =>
    Effect.gen(function* () {
      const epoch = Date.parse(input.now)
      if (!Number.isFinite(epoch))
        return yield* authenticationFailure('automationCredential.rateLimit.clock')
      const windowStart = Math.floor(epoch / input.windowMilliseconds) * input.windowMilliseconds
      const cutoff = windowStart - input.windowMilliseconds
      const results = yield* authenticationAttempt('automationCredential.rateLimit', () =>
        database.batch([
          database
            .prepare(
              `DELETE FROM automation_identity_rate_windows WHERE window_started_epoch_ms < ?`,
            )
            .bind(cutoff),
          database
            .prepare(`INSERT OR IGNORE INTO automation_identity_rate_windows
              (subject, window_started_epoch_ms, request_count) VALUES (?, ?, 0)`)
            .bind(input.subject, windowStart),
          database
            .prepare(`UPDATE automation_identity_rate_windows
              SET request_count = request_count + 1
              WHERE subject = ? AND window_started_epoch_ms = ? AND request_count < ?`)
            .bind(input.subject, windowStart, input.limit),
        ]),
      )
      return {
        allowed: (results[2]?.meta?.changes ?? 0) === 1,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart + input.windowMilliseconds - epoch) / 1000),
        ),
      }
    }),
  touchLastUse: (input) =>
    Effect.gen(function* () {
      const results = yield* authenticationAttempt('automationCredential.touch', () =>
        database.batch([
          database
            .prepare(`UPDATE automation_identity_credentials
              SET last_used_at = ?
              WHERE organization_id = ? AND automation_identity_id = ? AND id = ?
                AND revision = ? AND status = 'active'
                AND EXISTS (
                  SELECT 1 FROM automation_identities identity
                  JOIN organizations organization ON organization.id = identity.organization_id
                  JOIN identities creator ON creator.id = identity.created_by
                  JOIN organization_memberships membership
                    ON membership.organization_id = identity.organization_id
                   AND membership.identity_id = identity.created_by
                  WHERE identity.organization_id = ? AND identity.id = ?
                    AND identity.revision = ? AND identity.status = 'active'
                    AND identity.credential_reference = ?
                    AND identity.expires_at > ?
                    AND organization.status = 'active'
                    AND creator.status = 'active'
                    AND membership.status = 'active'
                    AND membership.role IN ('owner', 'administrator')
                )`)
            .bind(
              input.now,
              input.organizationId,
              input.automationIdentityId,
              input.credentialId,
              input.expectedCredentialRevision,
              input.organizationId,
              input.automationIdentityId,
              input.expectedIdentityRevision,
              input.credentialId,
              input.now,
            ),
          database
            .prepare(`UPDATE automation_identities
              SET last_used_at = ?
              WHERE organization_id = ? AND id = ? AND revision = ? AND status = 'active'
                AND EXISTS (
                  SELECT 1 FROM organizations organization
                  JOIN identities creator ON creator.id = automation_identities.created_by
                  JOIN organization_memberships membership
                    ON membership.organization_id = automation_identities.organization_id
                   AND membership.identity_id = automation_identities.created_by
                  JOIN automation_identity_credentials credential
                    ON credential.organization_id = automation_identities.organization_id
                   AND credential.automation_identity_id = automation_identities.id
                  WHERE organization.id = automation_identities.organization_id
                    AND organization.status = 'active'
                    AND creator.status = 'active'
                    AND membership.status = 'active'
                    AND membership.role IN ('owner', 'administrator')
                    AND credential.id = ? AND credential.revision = ?
                    AND credential.status = 'active'
                )`)
            .bind(
              input.now,
              input.organizationId,
              input.automationIdentityId,
              input.expectedIdentityRevision,
              input.credentialId,
              input.expectedCredentialRevision,
            ),
        ]),
      )
      return (results[0]?.meta?.changes ?? 0) === 1 && (results[1]?.meta?.changes ?? 0) === 1
    }),
})

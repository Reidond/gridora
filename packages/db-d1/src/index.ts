import { Context, Effect, Layer, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
  type AuditEnvelopeV1,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  ConflictError,
  CreateOrganizationResult,
  NotFoundError,
  Operation,
  OperationDetail,
  OutboxEvent,
  PersistenceError,
  ProviderAccountMetadata,
  RevisionConflictError,
  type RepositoryError,
} from '@gridora/contracts'
import {
  AgentRegistrationRepository,
  AuditRepository,
  IdentityRepository,
  OperationDetailRepository,
  OperationRepository,
  OrganizationInvitationRepository,
  OrganizationMembershipRepository,
  OrganizationRepository,
  OrganizationUnitOfWork,
  OutboxRepository,
  ProviderAccountRepository,
} from '@gridora/db-contracts'
import { SecretEnvelopeRecord } from '@gridora/secret-envelope'
import {
  RegistrationAuditError,
  RegistrationClock,
  RegistrationDecisionAuditPort,
  RegistrationMode,
  RegistrationPolicyRepository,
  RegistrationPolicyStoreError,
} from '@gridora/registration-policy'
import type {
  AgentCredentialPrincipal,
  CoreMutationFacts,
  CoreMutationResult,
  ExchangeAgentRegistration,
  RotateAgentCredential,
} from '@gridora/db-contracts'
import {
  Identity,
  IdentityId,
  type InvitationId,
  Organization,
  OrganizationContext,
  OrganizationId,
  OrganizationInvitation,
  OrganizationMembership,
  OperationId,
} from '@gridora/domain'

export interface D1ResultLike {
  readonly success: boolean
  readonly meta?: { readonly changes?: number }
}
export interface D1AllResultLike {
  readonly results: ReadonlyArray<unknown>
}
export interface D1PreparedStatementLike {
  bind(...values: ReadonlyArray<unknown>): D1PreparedStatementLike
  first(): Promise<unknown>
  all(): Promise<D1AllResultLike>
  run(): Promise<D1ResultLike>
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
  batch(statements: ReadonlyArray<D1PreparedStatementLike>): Promise<ReadonlyArray<D1ResultLike>>
}
export class D1Client extends Context.Service<D1Client, D1DatabaseLike>()(
  '@gridora/db-d1/D1Client',
) {}
export const D1ClientLayer = (database: D1DatabaseLike) => Layer.succeed(D1Client, database)

const failure = (operation: string, cause: unknown) =>
  new PersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => failure(operation, cause) })
const decode = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
): Effect.Effect<A, PersistenceError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure(operation, cause)),
  )
const required = <A>(
  operation: string,
  resource: string,
  id: string,
  schema: Schema.Codec<A, unknown, never, never>,
  row: unknown,
): Effect.Effect<A, NotFoundError | PersistenceError> =>
  row === null ? Effect.fail(new NotFoundError({ resource, id })) : decode(operation, schema, row)

export const assertIdempotentReplay = (storedFingerprint: string, requestFingerprint: string) =>
  storedFingerprint === requestFingerprint
    ? Effect.void
    : Effect.fail(
        new ConflictError({
          code: 'idempotency_key_reused',
          message: 'The idempotency key was already used with a different request',
        }),
      )

const identitySelect = `SELECT id, access_subject AS accessSubject, email, display_name AS displayName,
 status, signed_up_at AS signedUpAt, last_login_at AS lastLoginAt FROM identities`
const organizationSelect = `SELECT id, name, slug, status, timezone, default_region AS defaultRegion,
 onboarding_step AS onboardingStep, policy_revision AS policyRevision, revision, created_at AS createdAt FROM organizations`
const membershipSelect = `SELECT organization_id AS organizationId, identity_id AS identityId, role, status,
 joined_at AS joinedAt, invited_by AS invitedBy, revision FROM organization_memberships`
const invitationSelect = `SELECT id, organization_id AS organizationId, email, role, token_hash AS tokenHash,
 expires_at AS expiresAt, inviter_id AS inviterId, status, created_at AS createdAt, accepted_by AS acceptedBy, revision
 FROM organization_invitations`
const operationSelect = `SELECT id, organization_id AS organizationId, type, resource_type AS resourceType,
 resource_id AS resourceId, actor_id AS actorId, status, progress, idempotency_key AS idempotencyKey,
 correlation_id AS correlationId, revision, created_at AS createdAt, updated_at AS updatedAt FROM operations`
const outboxSelect = `SELECT id, organization_id AS organizationId, event_type AS eventType,
 aggregate_type AS aggregateType, aggregate_id AS aggregateId, payload_json AS payload,
 publish_state AS publishState, retry_count AS retryCount, available_at AS availableAt, created_at AS createdAt FROM outbox`

const membershipSummary = (membership: OrganizationMembership) => ({
  organizationId: membership.organizationId,
  identityId: membership.identityId,
  role: membership.role,
  status: membership.status,
  joinedAt: membership.joinedAt,
  invitedBy: membership.invitedBy,
  revision: membership.revision,
})

const invitationSummary = (invitation: OrganizationInvitation) => ({
  id: invitation.id,
  organizationId: invitation.organizationId,
  email: invitation.email,
  role: invitation.role,
  tokenHash: '[REDACTED]',
  expiresAt: invitation.expiresAt,
  inviterId: invitation.inviterId,
  status: invitation.status,
  createdAt: invitation.createdAt,
  acceptedBy: invitation.acceptedBy,
  revision: invitation.revision,
})

const identitySummary = (identity: Identity) => ({
  id: identity.id,
  accessSubject: identity.accessSubject,
  email: identity.email,
  displayName: identity.displayName,
  status: identity.status,
  signedUpAt: identity.signedUpAt,
  lastLoginAt: identity.lastLoginAt,
})

const organizationSummary = (organization: Organization) => ({
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
  status: organization.status,
  timezone: organization.timezone,
  defaultRegion: organization.defaultRegion,
  onboardingStep: organization.onboardingStep,
  policyRevision: organization.policyRevision,
  revision: organization.revision,
  createdAt: organization.createdAt,
})

const CoreMutationReceiptRow = Schema.Struct({
  operationId: Schema.String,
  resourceId: Schema.String,
  requestFingerprint: Schema.String,
  resultJson: Schema.String,
})

const readCoreMutationReplay = <A>(
  db: D1DatabaseLike,
  context: OrganizationContext,
  mutation: CoreMutationFacts,
  valueSchema: Schema.Codec<A, unknown, never, never>,
): Effect.Effect<CoreMutationResult<A> | null, RepositoryError> =>
  Effect.gen(function* () {
    const row = yield* attempt('coreMutation.replay', () =>
      db
        .prepare(`SELECT operation_id AS operationId, resource_id AS resourceId,
          payload_fingerprint AS requestFingerprint, result_json AS resultJson
          FROM core_mutation_receipts
          WHERE organization_id = ? AND actor_id = ? AND action = ? AND idempotency_key = ?`)
        .bind(context.organizationId, context.identityId, mutation.action, mutation.idempotencyKey)
        .first(),
    )
    if (row === null) return null
    const receipt = yield* decode('coreMutation.replay', CoreMutationReceiptRow, row)
    if (receipt.requestFingerprint !== mutation.requestFingerprint) {
      return yield* new ConflictError({
        code: 'idempotency_key_payload_mismatch',
        message: 'Idempotency key was already used with a different mutation payload',
      })
    }
    const input = yield* Effect.try({
      try: () => JSON.parse(receipt.resultJson) as unknown,
      catch: (cause) => failure('coreMutation.replay.decode', cause),
    })
    const value = yield* decode('coreMutation.replay.value', valueSchema, input)
    return {
      operationId: receipt.operationId as CoreMutationResult<A>['operationId'],
      resourceId: receipt.resourceId,
      value,
      replayed: true,
    }
  })

const completeTenantMutationAudit = (
  context: OrganizationContext,
  mutation: CoreMutationFacts,
  before: AuditEnvelopeV1['before'],
  after: AuditEnvelopeV1['after'],
) =>
  completeAuditEnvelope({
    occurredAt: mutation.now,
    scope: 'tenant',
    organizationId: context.organizationId,
    actor: { type: 'human', id: context.identityId },
    action: mutation.action,
    target: { type: mutation.resourceType, id: mutation.resourceId },
    before,
    after,
    operationId: mutation.operationId,
    request: mutation.request,
    result: 'succeeded',
    error: { classification: 'none', code: null },
    forced: false,
    breakGlass: false,
  })

const tenantMutationStatements = (
  db: D1DatabaseLike,
  context: OrganizationContext,
  mutation: CoreMutationFacts,
  envelope: AuditEnvelopeV1,
  response: unknown,
  guardWithPreviousChange = true,
): Effect.Effect<ReadonlyArray<D1PreparedStatementLike>, RepositoryError> =>
  Effect.gen(function* () {
    const eventId = `audit-${mutation.operationId}`
    const stage = yield* stageAuditEnvelope('tenant', eventId, envelope, mutation.now).pipe(
      Effect.mapError((cause) => failure('coreMutation.audit.stage', cause)),
    )
    return [
      db
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          ${guardWithPreviousChange ? 'SELECT' : 'VALUES ('} ?, ?, ?, ?, ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?${guardWithPreviousChange ? ' WHERE changes() = 1' : ')'}`)
        .bind(
          mutation.operationId,
          context.organizationId,
          mutation.action,
          mutation.resourceType,
          mutation.resourceId,
          context.identityId,
          mutation.operationIdempotencyKey,
          mutation.request.correlationId,
          mutation.now,
          mutation.now,
        ),
      db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      db
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`)
        .bind(
          eventId,
          context.organizationId,
          context.identityId,
          mutation.action,
          mutation.resourceType,
          mutation.resourceId,
          mutation.request.correlationId,
          auditEventSummaryJson(envelope),
          mutation.now,
        ),
      db
        .prepare(`INSERT INTO core_mutation_receipts
          (organization_id, actor_id, action, idempotency_key, payload_fingerprint,
           operation_id, resource_type, resource_id, result_json, response_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          context.organizationId,
          context.identityId,
          mutation.action,
          mutation.idempotencyKey,
          mutation.requestFingerprint,
          mutation.operationId,
          mutation.resourceType,
          mutation.resourceId,
          JSON.stringify(response),
          JSON.stringify({
            operationId: mutation.operationId,
            resourceId: mutation.resourceId,
            status: 'succeeded',
            links: {
              operation: `/v1/organizations/${context.organizationId}/operations/${mutation.operationId}`,
            },
          }),
          mutation.now,
        ),
    ]
  })
const providerAccountSelect = `SELECT pa.id, pa.scope, pa.organization_id AS organizationId,
 pa.provider_type AS providerType, pa.status, pa.revision,
 (SELECT envelope.revision FROM secret_envelopes envelope
  WHERE envelope.organization_id = pa.organization_id
    AND envelope.id = pa.credential_reference
    AND envelope.scope_type = 'provider-account'
    AND envelope.scope_id = pa.id) AS credentialRevision,
 pa.created_at AS createdAt, pa.updated_at AS updatedAt
 FROM provider_accounts pa`
const secretEnvelopeSelect = `SELECT organization_id AS organizationId, id, scope_type AS scopeType,
 scope_id AS scopeId, ciphertext, wrapped_data_key AS wrappedDataKey, key_version AS keyVersion,
 revision, created_at AS createdAt, rotated_at AS rotatedAt FROM secret_envelopes`
const agentCredentialSelect = `SELECT c.organization_id AS organizationId, c.node_id AS nodeId,
 c.id AS credentialId, c.version, s.session_version AS sessionVersion
 FROM node_credentials c JOIN agent_sessions s
 ON s.organization_id = c.organization_id AND s.node_id = c.node_id AND s.credential_id = c.id`
const AgentCredentialPrincipalRow = Schema.Struct({
  organizationId: OrganizationId,
  nodeId: Schema.String,
  credentialId: Schema.String,
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sessionVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
})

export const MembershipSql = {
  updateRole: `UPDATE organization_memberships SET role = ?, revision = revision + 1
    WHERE organization_id = ? AND identity_id = ? AND revision = ?
    AND (? = 'owner' OR role <> 'owner' OR
      (SELECT COUNT(*) FROM organization_memberships WHERE organization_id = ? AND role = 'owner' AND status = 'active') > 1)`,
  transferOwnership: `UPDATE organization_memberships
    SET role = CASE WHEN identity_id = ? THEN 'administrator' ELSE 'owner' END, revision = revision + 1
    WHERE organization_id = ? AND identity_id IN (?, ?) AND status = 'active'
    AND EXISTS (SELECT 1 FROM organization_memberships owner
      WHERE owner.organization_id = ? AND owner.identity_id = ? AND owner.role = 'owner' AND owner.status = 'active')
  AND ? <> ?`,
  leave: `INSERT INTO organization_membership_leave_receipts
    (organization_id, identity_id, membership_revision, membership_role,
     correlation_id, outbox_event_id, left_at)
    SELECT membership.organization_id, membership.identity_id, membership.revision,
      membership.role, ?, ?, ?
    FROM organization_memberships membership
    JOIN organizations organization ON organization.id = membership.organization_id
    WHERE membership.organization_id = ?
      AND membership.identity_id = ?
      AND membership.revision = ?
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'administrator', 'operator', 'viewer')
      AND organization.status = 'active'
      AND (
        membership.role <> 'owner'
        OR (
          SELECT COUNT(*) FROM organization_memberships owner
          WHERE owner.organization_id = membership.organization_id
            AND owner.role = 'owner'
            AND owner.status = 'active'
        ) > 1
      )
    ON CONFLICT (organization_id, identity_id, membership_revision) DO NOTHING`,
} as const

export const InvitationAcceptanceSql = {
  insertMembership: `INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
    SELECT organization_id, ?, role, 'active', ?, inviter_id, 1 FROM organization_invitations
    WHERE organization_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
    ON CONFLICT(organization_id, identity_id) DO NOTHING`,
  acceptInvitation: `UPDATE organization_invitations
    SET status = 'accepted', accepted_by = ?, revision = revision + 1
    WHERE organization_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
    AND changes() = 1`,
  insertIdentityForInvitation: `INSERT INTO identities
    (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
    SELECT ?, ?, ?, ?, 'active', ?, ? FROM organization_invitations
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND lower(email) = lower(?)
    ON CONFLICT(access_subject) DO NOTHING`,
  insertMembershipForAccessSubject: `INSERT INTO organization_memberships
    (organization_id, identity_id, role, status, joined_at, invited_by, revision)
    SELECT invitation.organization_id, identity.id, invitation.role, 'active', ?, invitation.inviter_id, 1
    FROM organization_invitations invitation JOIN identities identity
      ON identity.access_subject = ? AND identity.status = 'active'
      AND lower(identity.email) = lower(invitation.email)
    WHERE invitation.token_hash = ? AND invitation.status = 'pending' AND invitation.expires_at > ?
    ON CONFLICT(organization_id, identity_id) DO NOTHING`,
  acceptForAccessSubject: `UPDATE organization_invitations
    SET status = 'accepted', accepted_by = (SELECT id FROM identities WHERE access_subject = ?), revision = revision + 1
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND changes() = 1`,
} as const

const IdentityRepositoryLive = Layer.effect(
  IdentityRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    return IdentityRepository.of({
      findById: (id) =>
        attempt('identity.findById', () =>
          db.prepare(`${identitySelect} WHERE id = ?`).bind(id).first(),
        ).pipe(
          Effect.flatMap((row) => required('identity.findById', 'identity', id, Identity, row)),
        ),
      findByAccessSubject: (subject) =>
        attempt('identity.findByAccessSubject', () =>
          db.prepare(`${identitySelect} WHERE access_subject = ?`).bind(subject).first(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decode('identity.findByAccessSubject', Identity, row),
          ),
        ),
      createOrGet: (record) =>
        Effect.gen(function* () {
          const replayRow = yield* attempt('identity.createOrGet.replay', () =>
            db
              .prepare(`SELECT identity_id AS identityId, payload_fingerprint AS requestFingerprint
                FROM platform_identity_mutation_receipts
                WHERE access_subject = ? AND action = 'identity.sign-up' AND idempotency_key = ?`)
              .bind(record.accessSubject, record.mutation.idempotencyKey)
              .first(),
          )
          if (replayRow !== null) {
            const replay = yield* decode(
              'identity.createOrGet.replay',
              Schema.Struct({ identityId: IdentityId, requestFingerprint: Schema.String }),
              replayRow,
            )
            if (replay.requestFingerprint !== record.mutation.requestFingerprint)
              return yield* new ConflictError({
                code: 'idempotency_key_payload_mismatch',
                message: 'Idempotency-Key was already used with a different payload',
              })
            const replayIdentity = yield* attempt('identity.createOrGet.replay.read', () =>
              db.prepare(`${identitySelect} WHERE id = ?`).bind(replay.identityId).first(),
            )
            return yield* required(
              'identity.createOrGet.replay.read',
              'identity',
              replay.identityId,
              Identity,
              replayIdentity,
            )
          }
          const identity = new Identity({
            id: record.id,
            accessSubject: record.accessSubject,
            email: record.email,
            displayName: record.displayName,
            status: 'active',
            signedUpAt: record.now,
            lastLoginAt: record.now,
          })
          const envelope = yield* completeAuditEnvelope({
            occurredAt: record.now,
            scope: 'platform',
            organizationId: null,
            actor: { type: 'human', id: record.id },
            action: 'identity.sign-up',
            target: { type: 'identity', id: record.id },
            before: { state: 'absent', reason: 'identity not registered' },
            after: { state: 'captured', summary: identitySummary(identity) },
            operationId: record.mutation.operationId,
            request: record.mutation.request,
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          }).pipe(Effect.mapError((cause) => failure('identity.createOrGet.audit', cause)))
          const auditId = `audit-${record.mutation.operationId}`
          const stage = yield* stageAuditEnvelope('platform', auditId, envelope, record.now).pipe(
            Effect.mapError((cause) => failure('identity.createOrGet.audit-stage', cause)),
          )
          yield* attempt('identity.createOrGet', () =>
            db.batch([
              db
                .prepare(
                  `INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
                )
                .bind(
                  record.id,
                  record.accessSubject,
                  record.email,
                  record.displayName,
                  record.now,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO platform_operations
                (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
                 progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
                SELECT ?, 'platform', 'identity.sign-up', 'identity', ?, ?, ?, 'succeeded',
                  100, ?, ?, 1, ?, ? WHERE changes() = 1`)
                .bind(
                  record.mutation.operationId,
                  record.id,
                  record.id,
                  record.mutation.request.correlationId,
                  record.mutation.operationIdempotencyKey,
                  record.mutation.requestFingerprint,
                  record.now,
                  record.now,
                ),
              db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
              db
                .prepare(`INSERT INTO global_audit_events
                (id, scope, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                VALUES (?, 'platform', ?, 'identity.sign-up', 'identity', ?,
                  'succeeded', ?, ?, ?)`)
                .bind(
                  auditId,
                  record.id,
                  record.id,
                  record.mutation.request.correlationId,
                  auditEventSummaryJson(envelope),
                  record.now,
                ),
              db
                .prepare(`INSERT INTO platform_identity_mutation_receipts
                  (access_subject, action, idempotency_key, payload_fingerprint, operation_id,
                   identity_id, result_json, response_json, created_at)
                  VALUES (?, 'identity.sign-up', ?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  record.accessSubject,
                  record.mutation.idempotencyKey,
                  record.mutation.requestFingerprint,
                  record.mutation.operationId,
                  record.id,
                  JSON.stringify(identity),
                  JSON.stringify({
                    operationId: record.mutation.operationId,
                    resourceId: record.id,
                    status: 'succeeded',
                    links: { operation: `/v1/platform/operations/${record.mutation.operationId}` },
                  }),
                  record.now,
                ),
            ]),
          )
          const row = yield* attempt('identity.createOrGet.read', () =>
            db
              .prepare(`${identitySelect} WHERE access_subject = ?`)
              .bind(record.accessSubject)
              .first(),
          )
          return yield* required(
            'identity.createOrGet.read',
            'identity',
            record.accessSubject,
            Identity,
            row,
          )
        }),
      touchLastLogin: (id, mutation) =>
        Effect.gen(function* () {
          const replay = yield* attempt('identity.touchLastLogin.replay', () =>
            db
              .prepare(`SELECT payload_fingerprint AS requestFingerprint
                FROM platform_operations WHERE scope = 'platform' AND idempotency_key = ?
                  AND actor_id = ? AND type = 'identity.sign-in' AND resource_id = ?`)
              .bind(mutation.operationIdempotencyKey, id, id)
              .first(),
          )
          if (replay !== null) {
            const stored = yield* decode(
              'identity.touchLastLogin.replay',
              Schema.Struct({ requestFingerprint: Schema.String }),
              replay,
            )
            yield* assertIdempotentReplay(stored.requestFingerprint, mutation.requestFingerprint)
            return yield* required(
              'identity.touchLastLogin.replay.read',
              'identity',
              id,
              Identity,
              yield* attempt('identity.touchLastLogin.replay.read', () =>
                db.prepare(`${identitySelect} WHERE id = ?`).bind(id).first(),
              ),
            )
          }
          const before = yield* required(
            'identity.touchLastLogin.before',
            'identity',
            id,
            Identity,
            yield* attempt('identity.touchLastLogin.before', () =>
              db.prepare(`${identitySelect} WHERE id = ?`).bind(id).first(),
            ),
          )
          const after = new Identity({ ...identitySummary(before), lastLoginAt: mutation.now })
          const envelope = yield* completeAuditEnvelope({
            occurredAt: mutation.now,
            scope: 'platform',
            organizationId: null,
            actor: { type: 'human', id },
            action: 'identity.sign-in',
            target: { type: 'identity', id },
            before: { state: 'captured', summary: identitySummary(before) },
            after: { state: 'captured', summary: identitySummary(after) },
            operationId: mutation.operationId,
            request: mutation.request,
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          }).pipe(Effect.mapError((cause) => failure('identity.touchLastLogin.audit', cause)))
          const auditId = `audit-${mutation.operationId}`
          const stage = yield* stageAuditEnvelope('platform', auditId, envelope, mutation.now).pipe(
            Effect.mapError((cause) => failure('identity.touchLastLogin.audit-stage', cause)),
          )
          yield* attempt('identity.touchLastLogin', () =>
            db.batch([
              db
                .prepare(`UPDATE identities SET last_login_at = ? WHERE id = ?`)
                .bind(mutation.now, id),
              db
                .prepare(`INSERT INTO platform_operations
                (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
                 progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
                SELECT ?, 'platform', 'identity.sign-in', 'identity', ?, ?, ?, 'succeeded',
                  100, ?, ?, 1, ?, ? WHERE changes() = 1`)
                .bind(
                  mutation.operationId,
                  id,
                  id,
                  mutation.request.correlationId,
                  mutation.operationIdempotencyKey,
                  mutation.requestFingerprint,
                  mutation.now,
                  mutation.now,
                ),
              db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
              db
                .prepare(`INSERT INTO global_audit_events
                (id, scope, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                VALUES (?, 'platform', ?, 'identity.sign-in', 'identity', ?,
                  'succeeded', ?, ?, ?)`)
                .bind(
                  auditId,
                  id,
                  id,
                  mutation.request.correlationId,
                  auditEventSummaryJson(envelope),
                  mutation.now,
                ),
            ]),
          )
          const row = yield* attempt('identity.touchLastLogin.read', () =>
            db.prepare(`${identitySelect} WHERE id = ?`).bind(id).first(),
          )
          return yield* required('identity.touchLastLogin.read', 'identity', id, Identity, row)
        }),
    })
  }),
)

const OrganizationRepositoryLive = Layer.effect(
  OrganizationRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const byId = (id: OrganizationId) =>
      attempt('organization.getById', () =>
        db.prepare(`${organizationSelect} WHERE id = ?`).bind(id).first(),
      ).pipe(
        Effect.flatMap((row) =>
          required('organization.getById', 'organization', id, Organization, row),
        ),
      )
    return OrganizationRepository.of({
      getById: byId,
      getBySlug: (slug) =>
        attempt('organization.getBySlug', () =>
          db.prepare(`${organizationSelect} WHERE slug = ?`).bind(slug).first(),
        ).pipe(
          Effect.flatMap((row) =>
            required('organization.getBySlug', 'organization', slug, Organization, row),
          ),
        ),
      getForContext: (context) => byId(context.organizationId),
      updateProfile: (context, input, expectedRevision, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(db, context, mutation, Organization)
          if (replay !== null) return replay
          const before = yield* byId(context.organizationId)
          const after = new Organization({
            ...organizationSummary(before),
            name: input.name,
            timezone: input.timezone,
            defaultRegion: input.defaultRegion,
            revision: before.revision + 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: organizationSummary(before) },
            { state: 'captured', summary: organizationSummary(after) },
          ).pipe(Effect.mapError((cause) => failure('organization.updateProfile.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            after,
          )
          const results = yield* attempt('organization.updateProfile', () =>
            db.batch([
              db
                .prepare(`UPDATE organizations
                  SET name = ?, timezone = ?, default_region = ?, revision = revision + 1
                  WHERE id = ? AND revision = ?`)
                .bind(
                  input.name,
                  input.timezone,
                  input.defaultRegion,
                  context.organizationId,
                  expectedRevision,
                ),
              db
                .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  SELECT ?, ?, 'organization.profile.updated', 'organization', ?, ?,
                    'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  context.organizationId,
                  JSON.stringify({
                    organizationId: context.organizationId,
                    revision: after.revision,
                  }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          if ((results[0]?.meta?.changes ?? 0) !== 1)
            return yield* new RevisionConflictError({
              resource: 'organization',
              expected: expectedRevision,
              actual: before.revision,
            })
          return {
            operationId: mutation.operationId,
            resourceId: context.organizationId,
            value: after,
            replayed: false,
          }
        }),
      recordSwitch: (context, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(db, context, mutation, Organization)
          if (replay !== null) return replay
          const organization = yield* byId(context.organizationId)
          const previous = yield* attempt('organization.switch.preference.read', () =>
            db
              .prepare(`SELECT last_organization_id AS lastOrganizationId, revision
                FROM identity_preferences WHERE identity_id = ?`)
              .bind(context.identityId)
              .first(),
          )
          const before =
            previous === null
              ? { state: 'absent' as const, reason: 'no organization preference recorded' }
              : {
                  state: 'captured' as const,
                  summary: {
                    identityId: context.identityId,
                    lastOrganizationId: String(
                      (previous as { lastOrganizationId: unknown }).lastOrganizationId,
                    ),
                    revision: Number((previous as { revision: unknown }).revision),
                  },
                }
          const afterRevision =
            previous === null ? 1 : Number((previous as { revision: unknown }).revision) + 1
          const envelope = yield* completeTenantMutationAudit(context, mutation, before, {
            state: 'captured',
            summary: {
              identityId: context.identityId,
              lastOrganizationId: context.organizationId,
              revision: afterRevision,
            },
          }).pipe(Effect.mapError((cause) => failure('organization.switch.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            organization,
          )
          yield* attempt('organization.switch', () =>
            db.batch([
              db
                .prepare(`INSERT INTO identity_preferences
                  (identity_id, last_organization_id, revision, updated_at)
                  VALUES (?, ?, 1, ?)
                  ON CONFLICT(identity_id) DO UPDATE SET
                    last_organization_id = excluded.last_organization_id,
                    revision = identity_preferences.revision + 1,
                    updated_at = excluded.updated_at`)
                .bind(context.identityId, context.organizationId, mutation.now),
              db
                .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  SELECT ?, ?, 'identity.organization.switched', 'identity', ?, ?,
                    'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  context.identityId,
                  JSON.stringify({
                    identityId: context.identityId,
                    organizationId: context.organizationId,
                    preferenceRevision: afterRevision,
                  }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          return {
            operationId: mutation.operationId,
            resourceId: context.organizationId,
            value: organization,
            replayed: false,
          }
        }),
    })
  }),
)

const MembershipRepositoryLive = Layer.effect(
  OrganizationMembershipRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const get = (organizationId: OrganizationId, identityId: IdentityId) =>
      attempt('membership.get', () =>
        db
          .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
          .bind(organizationId, identityId)
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          required(
            'membership.get',
            'organization_membership',
            `${organizationId}:${identityId}`,
            OrganizationMembership,
            row,
          ),
        ),
      )
    return OrganizationMembershipRepository.of({
      get,
      listForIdentity: (identityId) =>
        attempt('membership.listForIdentity', () =>
          db
            .prepare(
              `${membershipSelect} WHERE identity_id = ? AND status = 'active' ORDER BY joined_at`,
            )
            .bind(identityId)
            .all(),
        ).pipe(
          Effect.flatMap((result) =>
            Effect.forEach(result.results, (row) =>
              decode('membership.listForIdentity', OrganizationMembership, row),
            ),
          ),
        ),
      listForOrganization: (context) =>
        attempt('membership.listForOrganization', () =>
          db
            .prepare(`${membershipSelect} WHERE organization_id = ? ORDER BY joined_at`)
            .bind(context.organizationId)
            .all(),
        ).pipe(
          Effect.flatMap((result) =>
            Effect.forEach(result.results, (row) =>
              decode('membership.listForOrganization', OrganizationMembership, row),
            ),
          ),
        ),
      countActiveOwners: (organizationId) =>
        attempt('membership.countActiveOwners', () =>
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = ? AND role = 'owner' AND status = 'active'`,
            )
            .bind(organizationId)
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            decode('membership.countActiveOwners', Schema.Struct({ count: Schema.Number }), row),
          ),
          Effect.map(({ count }) => count),
        ),
      updateRole: (context, identityId, role, expectedRevision, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(
            db,
            context,
            mutation,
            OrganizationMembership,
          )
          if (replay !== null) return replay
          const before = yield* get(context.organizationId, identityId)
          const after = new OrganizationMembership({
            ...membershipSummary(before),
            role,
            revision: before.revision + 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: membershipSummary(before) },
            { state: 'captured', summary: membershipSummary(after) },
          ).pipe(Effect.mapError((cause) => failure('membership.updateRole.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            after,
          )
          const results = yield* attempt('membership.updateRole', () =>
            db.batch([
              db
                .prepare(MembershipSql.updateRole)
                .bind(
                  role,
                  context.organizationId,
                  identityId,
                  expectedRevision,
                  role,
                  context.organizationId,
                ),
              db
                .prepare(`INSERT INTO outbox
                (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                 publish_state, retry_count, available_at, created_at)
                SELECT ?, ?, 'organization.membership.role.updated', 'organization_membership', ?, ?,
                  'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  identityId,
                  JSON.stringify({ identityId, beforeRole: before.role, afterRole: role }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          if ((results[0]?.meta?.changes ?? 0) !== 1) {
            const current = yield* get(context.organizationId, identityId)
            if (
              current.role === 'owner' &&
              role !== 'owner' &&
              current.revision === expectedRevision
            ) {
              return yield* new ConflictError({
                code: 'last_owner',
                message: 'The final Owner cannot be demoted',
              })
            }
            return yield* new RevisionConflictError({
              resource: 'organization_membership',
              expected: expectedRevision,
              actual: current.revision,
            })
          }
          return {
            operationId: mutation.operationId,
            resourceId: identityId,
            value: after,
            replayed: false,
          }
        }),
      remove: (context, identityId, expectedRevision, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(db, context, mutation, Schema.Null)
          if (replay !== null) return replay
          const before = yield* get(context.organizationId, identityId)
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: membershipSummary(before) },
            { state: 'absent', reason: 'membership removed' },
          ).pipe(Effect.mapError((cause) => failure('membership.remove.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            null,
          )
          const results = yield* attempt('membership.remove', () =>
            db.batch([
              db
                .prepare(
                  `DELETE FROM organization_memberships WHERE organization_id = ? AND identity_id = ? AND revision = ?
             AND (role <> 'owner' OR (SELECT COUNT(*) FROM organization_memberships WHERE organization_id = ? AND role = 'owner' AND status = 'active') > 1)`,
                )
                .bind(context.organizationId, identityId, expectedRevision, context.organizationId),
              db
                .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  SELECT ?, ?, 'organization.membership.revoked', 'organization_membership', ?, ?,
                    'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  identityId,
                  JSON.stringify({ principalId: identityId }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          if ((results[0]?.meta?.changes ?? 0) !== 1)
            return yield* new ConflictError({
              code: 'membership_remove_rejected',
              message: 'Membership revision changed or final Owner is protected',
            })
          return {
            operationId: mutation.operationId,
            resourceId: identityId,
            value: null,
            replayed: false,
          }
        }),
      leave: (context, expectedRevision, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(db, context, mutation, Schema.Null)
          if (replay !== null) return replay
          const before = yield* get(context.organizationId, context.identityId)
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: membershipSummary(before) },
            { state: 'absent', reason: 'member left organization' },
          ).pipe(Effect.mapError((cause) => failure('membership.leave.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            null,
            false,
          )
          const results = yield* attempt('membership.leave', () =>
            db.batch([
              coreStatements[0]!,
              coreStatements[1]!,
              db
                .prepare(MembershipSql.leave)
                .bind(
                  mutation.request.correlationId,
                  outboxEventId,
                  mutation.now,
                  context.organizationId,
                  context.identityId,
                  expectedRevision,
                ),
              coreStatements[2]!,
              coreStatements[3]!,
            ]),
          )
          if ((results[2]?.meta?.changes ?? 0) === 1)
            return {
              operationId: mutation.operationId,
              resourceId: context.identityId,
              value: null,
              replayed: false,
            }
          return yield* new ConflictError({
            code: 'membership_leave_rejected',
            message:
              'Membership revision changed, the organization is inactive, or the final Owner is protected',
          })
        }),
      hasLeaveReceipt: (organizationReference, identityId, expectedRevision) =>
        attempt('membership.leave.receipt.lookup', () =>
          db
            .prepare(
              `SELECT 1 AS found
               FROM organization_membership_leave_receipts receipt
               JOIN organizations organization ON organization.id = receipt.organization_id
               WHERE (organization.id = ? OR organization.slug = ?)
                 AND receipt.identity_id = ?
                 AND receipt.membership_revision = ?`,
            )
            .bind(organizationReference, organizationReference, identityId, expectedRevision)
            .first(),
        ).pipe(Effect.map((row) => row !== null)),
      findLeaveMutationReplay: (organizationReference, identityId, idempotencyKey) =>
        attempt('membership.leave.core-replay', () =>
          db
            .prepare(`SELECT organization.id AS organizationId,
              receipt.operation_id AS operationId,
              receipt.resource_id AS resourceId,
              receipt.payload_fingerprint AS requestFingerprint
              FROM core_mutation_receipts receipt
              JOIN organizations organization ON organization.id = receipt.organization_id
              WHERE (organization.id = ? OR organization.slug = ?)
                AND receipt.actor_id = ?
                AND receipt.action = 'organization.membership.leave'
                AND receipt.idempotency_key = ?`)
            .bind(organizationReference, organizationReference, identityId, idempotencyKey)
            .first(),
        ).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decode(
                  'membership.leave.core-replay',
                  Schema.Struct({
                    organizationId: OrganizationId,
                    operationId: Schema.String,
                    resourceId: Schema.String,
                    requestFingerprint: Schema.String,
                  }),
                  row,
                ).pipe(
                  Effect.map((value) => ({
                    ...value,
                    operationId: value.operationId as CoreMutationResult<null>['operationId'],
                  })),
                ),
          ),
        ),
    })
  }),
)

const InvitationRepositoryLive = Layer.effect(
  OrganizationInvitationRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const getScoped = (context: OrganizationContext, invitationId: InvitationId) =>
      attempt('invitation.get', () =>
        db
          .prepare(`${invitationSelect} WHERE organization_id = ? AND id = ?`)
          .bind(context.organizationId, invitationId)
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          required(
            'invitation.get',
            'organization_invitation',
            invitationId,
            OrganizationInvitation,
            row,
          ),
        ),
      )
    return OrganizationInvitationRepository.of({
      create: (context, record, mutation) =>
        Effect.gen(function* () {
          const coreReplay = yield* readCoreMutationReplay(
            db,
            context,
            mutation,
            OrganizationInvitation,
          )
          if (coreReplay !== null) return coreReplay
          const fingerprint = JSON.stringify({
            email: record.email.toLowerCase(),
            role: record.role,
            expiresAt: record.expiresAt,
          })
          const prior = yield* attempt('invitation.create.idempotency', () =>
            db
              .prepare(
                `SELECT i.id, i.organization_id AS organizationId, i.email, i.role, i.token_hash AS tokenHash,
           i.expires_at AS expiresAt, i.inviter_id AS inviterId, i.status, i.created_at AS createdAt,
           i.accepted_by AS acceptedBy, i.revision, x.request_fingerprint AS requestFingerprint FROM invitation_creation_idempotency x
           JOIN organization_invitations i ON i.organization_id = x.organization_id AND i.id = x.invitation_id
           WHERE x.organization_id = ? AND x.idempotency_key = ?`,
              )
              .bind(context.organizationId, record.idempotencyKey)
              .first(),
          )
          if (prior !== null) {
            const replay = yield* decode(
              'invitation.create.idempotency',
              Schema.Struct({ requestFingerprint: Schema.String }),
              prior,
            )
            yield* assertIdempotentReplay(replay.requestFingerprint, fingerprint)
            const invitation = yield* decode(
              'invitation.create.idempotency',
              OrganizationInvitation,
              prior,
            )
            return {
              operationId: mutation.operationId,
              resourceId: invitation.id,
              value: invitation,
              replayed: true,
            }
          }
          const invitation = new OrganizationInvitation({
            id: record.id,
            organizationId: context.organizationId,
            email: record.email,
            role: record.role,
            tokenHash: record.tokenHash,
            expiresAt: record.expiresAt,
            inviterId: context.identityId,
            status: 'pending',
            createdAt: record.now,
            acceptedBy: null,
            revision: 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'absent', reason: 'invitation not created' },
            { state: 'captured', summary: invitationSummary(invitation) },
          ).pipe(Effect.mapError((cause) => failure('invitation.create.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            invitation,
          )
          yield* attempt('invitation.create', () =>
            db.batch([
              db
                .prepare(`INSERT INTO organization_invitations
            (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, accepted_by, revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 1)`)
                .bind(
                  record.id,
                  context.organizationId,
                  record.email,
                  record.role,
                  record.tokenHash,
                  record.expiresAt,
                  context.identityId,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO invitation_creation_idempotency
            (organization_id, idempotency_key, invitation_id, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
                .bind(
                  context.organizationId,
                  record.idempotencyKey,
                  record.id,
                  fingerprint,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
            SELECT ?, ?, 'organization.invitation.created', 'organization_invitation', ?,
              json_object(
                'invitationId', ?, 'email', ?, 'role', ?, 'expiresAt', ?,
                'organizationName', (SELECT name FROM organizations WHERE id = ?),
                'tokenDerivation', json_object('version', ?, 'scope', ?)
              ), 'pending', 0, ?, ?`)
                .bind(
                  record.outboxEventId,
                  context.organizationId,
                  record.id,
                  record.id,
                  record.email,
                  record.role,
                  record.expiresAt,
                  context.organizationId,
                  record.tokenKeyVersion,
                  record.tokenScope,
                  record.now,
                  record.now,
                ),
              ...coreStatements,
            ]),
          )
          return {
            operationId: mutation.operationId,
            resourceId: record.id,
            value: invitation,
            replayed: false,
          }
        }),
      list: (context) =>
        attempt('invitation.list', () =>
          db
            .prepare(`${invitationSelect} WHERE organization_id = ? ORDER BY created_at DESC`)
            .bind(context.organizationId)
            .all(),
        ).pipe(
          Effect.flatMap((result) =>
            Effect.forEach(result.results, (row) =>
              decode('invitation.list', OrganizationInvitation, row),
            ),
          ),
        ),
      get: getScoped,
      findByTokenHash: (tokenHash) =>
        attempt('invitation.findByTokenHash', () =>
          db.prepare(`${invitationSelect} WHERE token_hash = ?`).bind(tokenHash).first(),
        ).pipe(
          Effect.flatMap((row) =>
            required(
              'invitation.findByTokenHash',
              'organization_invitation',
              'token',
              OrganizationInvitation,
              row,
            ),
          ),
        ),
      revoke: (context, invitationId, expectedRevision, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(
            db,
            context,
            mutation,
            OrganizationInvitation,
          )
          if (replay !== null) return replay
          const before = yield* getScoped(context, invitationId)
          const after = new OrganizationInvitation({
            id: before.id,
            organizationId: before.organizationId,
            email: before.email,
            role: before.role,
            tokenHash: before.tokenHash,
            expiresAt: before.expiresAt,
            inviterId: before.inviterId,
            createdAt: before.createdAt,
            acceptedBy: before.acceptedBy,
            status: 'revoked',
            revision: before.revision + 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: invitationSummary(before) },
            { state: 'captured', summary: invitationSummary(after) },
          ).pipe(Effect.mapError((cause) => failure('invitation.revoke.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            after,
          )
          const results = yield* attempt('invitation.revoke', () =>
            db.batch([
              db
                .prepare(
                  `UPDATE organization_invitations SET status = 'revoked', revision = revision + 1
           WHERE organization_id = ? AND id = ? AND status = 'pending' AND revision = ?`,
                )
                .bind(context.organizationId, invitationId, expectedRevision),
              db
                .prepare(`INSERT INTO outbox
                (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                 publish_state, retry_count, available_at, created_at)
                SELECT ?, ?, 'organization.invitation.revoked', 'organization_invitation', ?, ?,
                  'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  invitationId,
                  JSON.stringify({ invitationId }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          if ((results[0]?.meta?.changes ?? 0) !== 1)
            return yield* new ConflictError({
              code: 'invitation_revoke_rejected',
              message: 'Invitation is no longer pending',
            })
          return {
            operationId: mutation.operationId,
            resourceId: invitationId,
            value: after,
            replayed: false,
          }
        }),
      resend: (context, invitationId, expectedRevision, record, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(
            db,
            context,
            mutation,
            OrganizationInvitation,
          )
          if (replay !== null) return replay
          const before = yield* getScoped(context, invitationId)
          if (before.status !== 'pending')
            return yield* new ConflictError({
              code: 'invitation_resend_rejected',
              message: 'Only a pending invitation can be resent',
            })
          const after = new OrganizationInvitation({
            id: before.id,
            organizationId: before.organizationId,
            email: before.email,
            role: before.role,
            tokenHash: record.tokenHash,
            expiresAt: record.expiresAt,
            inviterId: before.inviterId,
            status: 'pending',
            createdAt: before.createdAt,
            acceptedBy: null,
            revision: before.revision + 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: invitationSummary(before) },
            { state: 'captured', summary: invitationSummary(after) },
          ).pipe(Effect.mapError((cause) => failure('invitation.resend.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            after,
          )
          const results = yield* attempt('invitation.resend', () =>
            db.batch([
              db
                .prepare(`UPDATE organization_invitations
                  SET token_hash = ?, expires_at = ?, revision = revision + 1
                  WHERE organization_id = ? AND id = ? AND status = 'pending' AND revision = ?`)
                .bind(
                  record.tokenHash,
                  record.expiresAt,
                  context.organizationId,
                  invitationId,
                  expectedRevision,
                ),
              db
                .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  SELECT ?, ?, 'organization.invitation.resent', 'organization_invitation', ?,
                    json_object(
                      'invitationId', ?, 'email', ?, 'role', ?, 'expiresAt', ?,
                      'organizationName', (SELECT name FROM organizations WHERE id = ?),
                      'tokenDerivation', json_object('version', ?, 'scope', ?)
                    ), 'pending', 0, ?, ? WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  invitationId,
                  invitationId,
                  before.email,
                  before.role,
                  record.expiresAt,
                  context.organizationId,
                  record.tokenKeyVersion,
                  record.tokenScope,
                  record.now,
                  record.now,
                ),
              ...coreStatements,
            ]),
          )
          if ((results[0]?.meta?.changes ?? 0) !== 1)
            return yield* new ConflictError({
              code: 'invitation_resend_rejected',
              message: 'Invitation is no longer pending or its revision changed',
            })
          return {
            operationId: mutation.operationId,
            resourceId: invitationId,
            value: after,
            replayed: false,
          }
        }),
      expirePending: (now, limit) =>
        attempt('invitation.expirePending', () =>
          db
            .prepare(
              `UPDATE organization_invitations SET status = 'expired', revision = revision + 1 WHERE id IN
         (SELECT id FROM organization_invitations WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at LIMIT ?)`,
            )
            .bind(now, limit)
            .run(),
        ).pipe(Effect.map((result) => result.meta?.changes ?? 0)),
    })
  }),
)

const UnitOfWorkLive = Layer.effect(
  OrganizationUnitOfWork,
  Effect.gen(function* () {
    const db = yield* D1Client
    const readCreation = (identityId: IdentityId, key: string) =>
      attempt('organization.create.idempotency', () =>
        db
          .prepare(
            `SELECT o.id, o.name, o.slug, o.status, o.timezone, o.default_region AS defaultRegion,
       o.onboarding_step AS onboardingStep, o.policy_revision AS policyRevision, o.revision, o.created_at AS createdAt,
       x.request_fingerprint AS requestFingerprint, bootstrap.operation_id AS operationId
       FROM organization_creation_idempotency x
       JOIN organizations o ON o.id = x.organization_id
       JOIN organization_bootstrap_mutation_receipts bootstrap
         ON bootstrap.organization_id = o.id AND bootstrap.actor_id = x.identity_id
       WHERE x.identity_id = ? AND x.idempotency_key = ?`,
          )
          .bind(identityId, key)
          .first(),
      )
    return OrganizationUnitOfWork.of({
      createOrganizationWithOwner: (record) =>
        Effect.gen(function* () {
          if (
            record.initialPolicy.organizationId !== record.id ||
            record.initialPolicy.revision !== 1
          ) {
            return yield* new ConflictError({
              code: 'invalid_initial_policy',
              message: 'Initial policy must match the new organization at revision 1',
            })
          }
          const prior = yield* readCreation(record.ownerIdentityId, record.idempotencyKey)
          if (prior !== null) {
            const replay = yield* decode(
              'organization.create.idempotency',
              Schema.Struct({ requestFingerprint: Schema.String, operationId: OperationId }),
              prior,
            )
            yield* assertIdempotentReplay(replay.requestFingerprint, record.requestFingerprint)
            const organization = yield* decode(
              'organization.create.idempotency',
              Organization,
              prior,
            )
            const membershipRow = yield* attempt('organization.create.membership', () =>
              db
                .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
                .bind(organization.id, record.ownerIdentityId)
                .first(),
            )
            const membership = yield* required(
              'organization.create.membership',
              'organization_membership',
              `${organization.id}:${record.ownerIdentityId}`,
              OrganizationMembership,
              membershipRow,
            )
            return new CreateOrganizationResult({
              organization,
              membership,
              operationId: replay.operationId,
              replayed: true,
            })
          }
          const organization = new Organization({
            id: record.id,
            name: record.name,
            slug: record.slug,
            status: 'active',
            timezone: record.timezone,
            defaultRegion: record.defaultRegion,
            onboardingStep: 'provider',
            policyRevision: 1,
            revision: 1,
            createdAt: record.now,
          })
          const membership = new OrganizationMembership({
            organizationId: record.id,
            identityId: record.ownerIdentityId,
            role: 'owner',
            status: 'active',
            joinedAt: record.now,
            invitedBy: null,
            revision: 1,
          })
          const auditId = `audit-${record.operationId}`
          const envelope = yield* completeAuditEnvelope({
            occurredAt: record.now,
            scope: 'platform',
            organizationId: null,
            actor: { type: 'human', id: record.ownerIdentityId },
            action: 'organization.create',
            target: { type: 'organization', id: record.id },
            before: { state: 'absent', reason: 'organization not created' },
            after: {
              state: 'captured',
              summary: {
                organization: {
                  id: organization.id,
                  name: organization.name,
                  slug: organization.slug,
                  status: organization.status,
                  timezone: organization.timezone,
                  defaultRegion: organization.defaultRegion,
                  onboardingStep: organization.onboardingStep,
                  policyRevision: organization.policyRevision,
                  revision: organization.revision,
                  createdAt: organization.createdAt,
                },
                ownerMembership: {
                  organizationId: membership.organizationId,
                  identityId: membership.identityId,
                  role: membership.role,
                  status: membership.status,
                  joinedAt: membership.joinedAt,
                  invitedBy: membership.invitedBy,
                  revision: membership.revision,
                },
                policyRevision: record.initialPolicy.revision,
                setupInvitations: record.initialInvitations.map((invitation) => ({
                  id: invitation.id,
                  email: invitation.email,
                  role: invitation.role,
                  expiresAt: invitation.expiresAt,
                })),
              },
            },
            operationId: record.operationId,
            request: record.request,
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          }).pipe(Effect.mapError((cause) => failure('organization.create.audit', cause)))
          const stage = yield* stageAuditEnvelope('platform', auditId, envelope, record.now).pipe(
            Effect.mapError((cause) => failure('organization.create.audit-stage', cause)),
          )
          yield* attempt('organization.create', () =>
            db.batch([
              db
                .prepare(`INSERT INTO platform_operations
                (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
                 progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
                VALUES (?, 'platform', 'organization.create', 'organization', ?, ?, ?, 'succeeded',
                  100, ?, ?, 1, ?, ?)`)
                .bind(
                  record.operationId,
                  record.id,
                  record.ownerIdentityId,
                  record.request.correlationId,
                  record.operationIdempotencyKey,
                  record.requestFingerprint,
                  record.now,
                  record.now,
                ),
              db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
              db
                .prepare(`INSERT INTO organizations
            (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
            VALUES (?, ?, ?, 'active', ?, ?, 'provider', 1, 1, ?)`)
                .bind(
                  record.id,
                  record.name,
                  record.slug,
                  record.timezone,
                  record.defaultRegion,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO organization_memberships
            (organization_id, identity_id, role, status, joined_at, invited_by, revision)
            VALUES (?, ?, 'owner', 'active', ?, NULL, 1)`)
                .bind(record.id, record.ownerIdentityId, record.now),
              db
                .prepare(`INSERT INTO organization_onboarding
            (organization_id, current_step, completed_steps_json, completed_at, revision)
            VALUES (?, 'provider', '["organization"]', NULL, 1)`)
                .bind(record.id),
              db
                .prepare(`INSERT INTO organization_terms_acceptances
            (organization_id, identity_id, terms_version, accepted_at)
            VALUES (?, ?, ?, ?)`)
                .bind(record.id, record.ownerIdentityId, record.termsVersion, record.now),
              db
                .prepare(`INSERT INTO organization_policies
            (organization_id, policy_json, revision, updated_by, updated_at)
            VALUES (?, ?, 1, ?, ?)`)
                .bind(
                  record.id,
                  JSON.stringify(record.initialPolicy),
                  record.ownerIdentityId,
                  record.now,
                ),
              ...record.initialInvitations.flatMap((invitation) => [
                db
                  .prepare(`INSERT INTO organization_invitations
                  (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, accepted_by, revision)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 1)`)
                  .bind(
                    invitation.id,
                    record.id,
                    invitation.email,
                    invitation.role,
                    invitation.tokenHash,
                    invitation.expiresAt,
                    record.ownerIdentityId,
                    record.now,
                  ),
                db
                  .prepare(`INSERT INTO outbox
                  (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
                   publish_state, retry_count, available_at, created_at)
                  VALUES (?, ?, 'organization.invitation.created', 'organization_invitation', ?,
                    json_object(
                      'invitationId', ?, 'email', ?, 'role', ?, 'expiresAt', ?, 'organizationName', ?,
                      'tokenDerivation', json_object('version', ?, 'scope', ?)
                    ), 'pending', 0, ?, ?)`)
                  .bind(
                    invitation.outboxEventId,
                    record.id,
                    invitation.id,
                    invitation.id,
                    invitation.email,
                    invitation.role,
                    invitation.expiresAt,
                    record.name,
                    invitation.tokenKeyVersion,
                    invitation.tokenScope,
                    record.now,
                    record.now,
                  ),
              ]),
              db
                .prepare(`INSERT INTO organization_creation_idempotency
            (identity_id, idempotency_key, organization_id, request_fingerprint, created_at)
            VALUES (?, ?, ?, ?, ?)`)
                .bind(
                  record.ownerIdentityId,
                  record.idempotencyKey,
                  record.id,
                  record.requestFingerprint,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
            VALUES (?, ?, 'organization.created', 'organization', ?, ?, 'pending', 0, ?, ?)`)
                .bind(
                  record.outboxEventId,
                  record.id,
                  record.id,
                  JSON.stringify({
                    organizationId: record.id,
                    ownerIdentityId: record.ownerIdentityId,
                  }),
                  record.now,
                  record.now,
                ),
              db
                .prepare(`INSERT INTO global_audit_events
                (id, scope, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                VALUES (?, 'platform', ?, 'organization.create', 'organization', ?,
                  'succeeded', ?, ?, ?)`)
                .bind(
                  auditId,
                  record.ownerIdentityId,
                  record.id,
                  record.request.correlationId,
                  auditEventSummaryJson(envelope),
                  record.now,
                ),
              db
                .prepare(`INSERT INTO organization_bootstrap_mutation_receipts
                (actor_id, action, idempotency_key, payload_fingerprint, operation_id,
                 organization_id, result_json, response_json, created_at)
                VALUES (?, 'organization.create', ?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  record.ownerIdentityId,
                  record.idempotencyKey,
                  record.requestFingerprint,
                  record.operationId,
                  record.id,
                  JSON.stringify({ organization, membership }),
                  JSON.stringify({
                    operationId: record.operationId,
                    resourceId: record.id,
                    status: 'succeeded',
                    links: { operation: `/v1/platform/operations/${record.operationId}` },
                  }),
                  record.now,
                ),
            ]),
          )
          return new CreateOrganizationResult({
            organization,
            membership,
            operationId: record.operationId,
            replayed: false,
          })
        }),
      acceptInvitation: (actor, invitation, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const organization = yield* required(
            'invitation.accept.organization',
            'organization',
            actor.organizationId,
            Organization,
            yield* attempt('invitation.accept.organization', () =>
              db.prepare(`${organizationSelect} WHERE id = ?`).bind(actor.organizationId).first(),
            ),
          )
          const context = yield* decode('invitation.accept.context', OrganizationContext, {
            organizationId: actor.organizationId,
            organizationSlug: organization.slug,
            identityId: actor.identityId,
            role: actor.role,
            correlationId: mutation.request.correlationId,
          })
          const replay = yield* readCoreMutationReplay(
            db,
            context,
            mutation,
            OrganizationMembership,
          )
          if (replay !== null) return replay
          if (invitation.status !== 'pending') {
            return yield* new ConflictError({
              code: 'invitation_accept_rejected',
              message: 'Invitation is no longer pending',
            })
          }
          const membership = new OrganizationMembership({
            organizationId: invitation.organizationId,
            identityId: context.identityId,
            role: invitation.role,
            status: 'active',
            joinedAt: mutation.now,
            invitedBy: invitation.inviterId,
            revision: 1,
          })
          const acceptedInvitation = new OrganizationInvitation({
            id: invitation.id,
            organizationId: invitation.organizationId,
            email: invitation.email,
            role: invitation.role,
            tokenHash: invitation.tokenHash,
            expiresAt: invitation.expiresAt,
            inviterId: invitation.inviterId,
            status: 'accepted',
            createdAt: invitation.createdAt,
            acceptedBy: context.identityId,
            revision: invitation.revision + 1,
          })
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            { state: 'captured', summary: invitationSummary(invitation) },
            {
              state: 'captured',
              summary: {
                invitation: invitationSummary(acceptedInvitation),
                membership: membershipSummary(membership),
              },
            },
          ).pipe(Effect.mapError((cause) => failure('invitation.accept.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            membership,
          )
          const results = yield* attempt('invitation.accept', () =>
            db.batch([
              db
                .prepare(InvitationAcceptanceSql.insertMembership)
                .bind(
                  context.identityId,
                  mutation.now,
                  invitation.organizationId,
                  invitation.id,
                  mutation.now,
                ),
              db
                .prepare(InvitationAcceptanceSql.acceptInvitation)
                .bind(context.identityId, invitation.organizationId, invitation.id, mutation.now),
              db
                .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
            SELECT ?, ?, 'organization.invitation.accepted', 'organization_invitation', ?, ?, 'pending', 0, ?, ?
            WHERE changes() = 1`)
                .bind(
                  outboxEventId,
                  invitation.organizationId,
                  invitation.id,
                  JSON.stringify({ invitationId: invitation.id, identityId: context.identityId }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          if (
            (results[0]?.meta?.changes ?? 0) !== 1 ||
            (results[1]?.meta?.changes ?? 0) !== 1 ||
            (results[2]?.meta?.changes ?? 0) !== 1
          ) {
            return yield* new ConflictError({
              code: 'invitation_accept_rejected',
              message: 'Invitation is no longer pending or the identity is already a member',
            })
          }
          return {
            operationId: mutation.operationId,
            resourceId: invitation.id,
            value: membership,
            replayed: false,
          }
        }),
      acceptInvitationWithIdentity: (record) =>
        Effect.gen(function* () {
          const invitationBefore = yield* required(
            'invitation.acceptWithIdentity.before',
            'organization_invitation',
            record.tokenHash,
            OrganizationInvitation,
            yield* attempt('invitation.acceptWithIdentity.before', () =>
              db.prepare(`${invitationSelect} WHERE token_hash = ?`).bind(record.tokenHash).first(),
            ),
          )
          if (invitationBefore.status === 'accepted') {
            const existingIdentity = yield* required(
              'invitation.acceptWithIdentity.replay.identity',
              'identity',
              record.accessSubject,
              Identity,
              yield* attempt('invitation.acceptWithIdentity.replay.identity', () =>
                db
                  .prepare(`${identitySelect} WHERE access_subject = ?`)
                  .bind(record.accessSubject)
                  .first(),
              ),
            )
            if (invitationBefore.acceptedBy !== existingIdentity.id)
              return yield* new ConflictError({
                code: 'invitation_accept_rejected',
                message: 'Invitation was accepted by another identity',
              })
            const existingMembership = yield* required(
              'invitation.acceptWithIdentity.replay.membership',
              'organization_membership',
              `${invitationBefore.organizationId}:${existingIdentity.id}`,
              OrganizationMembership,
              yield* attempt('invitation.acceptWithIdentity.replay.membership', () =>
                db
                  .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
                  .bind(invitationBefore.organizationId, existingIdentity.id)
                  .first(),
              ),
            )
            return { identity: existingIdentity, membership: existingMembership, replayed: true }
          }
          const existingIdentityRow = yield* attempt(
            'invitation.acceptWithIdentity.existingIdentity',
            () =>
              db
                .prepare(`${identitySelect} WHERE access_subject = ?`)
                .bind(record.accessSubject)
                .first(),
          )
          const existingIdentity =
            existingIdentityRow === null
              ? null
              : yield* decode(
                  'invitation.acceptWithIdentity.existingIdentity',
                  Identity,
                  existingIdentityRow,
                )
          const identityAfter =
            existingIdentity ??
            (yield* decode('invitation.acceptWithIdentity.identity', Identity, {
              id: record.identityId,
              accessSubject: record.accessSubject,
              email: record.email,
              displayName: record.displayName,
              status: 'active',
              signedUpAt: record.now,
              lastLoginAt: record.now,
            }))
          const createsIdentity = existingIdentity === null
          const membershipAfter = new OrganizationMembership({
            organizationId: invitationBefore.organizationId,
            identityId: identityAfter.id,
            role: invitationBefore.role,
            status: 'active',
            joinedAt: record.now,
            invitedBy: invitationBefore.inviterId,
            revision: 1,
          })
          const invitationAfter = new OrganizationInvitation({
            id: invitationBefore.id,
            organizationId: invitationBefore.organizationId,
            email: invitationBefore.email,
            role: invitationBefore.role,
            tokenHash: invitationBefore.tokenHash,
            expiresAt: invitationBefore.expiresAt,
            inviterId: invitationBefore.inviterId,
            createdAt: invitationBefore.createdAt,
            status: 'accepted',
            acceptedBy: identityAfter.id,
            revision: invitationBefore.revision + 1,
          })
          const tenantEnvelope = yield* completeAuditEnvelope({
            occurredAt: record.now,
            scope: 'tenant',
            organizationId: invitationBefore.organizationId,
            actor: { type: 'human', id: identityAfter.id },
            action: 'organization.invitation.accept',
            target: { type: 'organization_invitation', id: invitationBefore.id },
            before: {
              state: 'captured',
              summary: invitationSummary(invitationBefore),
            },
            after: {
              state: 'captured',
              summary: {
                invitation: invitationSummary(invitationAfter),
                membership: membershipSummary(membershipAfter),
              },
            },
            operationId: record.tenantOperationId,
            request: record.request,
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          }).pipe(
            Effect.mapError((cause) =>
              failure('invitation.acceptWithIdentity.tenant-audit', cause),
            ),
          )
          const platformEnvelope = createsIdentity
            ? yield* completeAuditEnvelope({
                occurredAt: record.now,
                scope: 'platform',
                organizationId: null,
                actor: { type: 'human', id: identityAfter.id },
                action: 'identity.sign-up',
                target: { type: 'identity', id: identityAfter.id },
                before: { state: 'absent', reason: 'identity not registered' },
                after: { state: 'captured', summary: identitySummary(identityAfter) },
                operationId: record.platformOperationId,
                request: record.request,
                result: 'succeeded',
                error: { classification: 'none', code: null },
                forced: false,
                breakGlass: false,
              }).pipe(
                Effect.mapError((cause) =>
                  failure('invitation.acceptWithIdentity.platform-audit', cause),
                ),
              )
            : null
          const tenantAuditId = `audit-${record.tenantOperationId}`
          const platformAuditId = `audit-${record.platformOperationId}`
          const tenantStage = yield* stageAuditEnvelope(
            'tenant',
            tenantAuditId,
            tenantEnvelope,
            record.now,
          ).pipe(
            Effect.mapError((cause) =>
              failure('invitation.acceptWithIdentity.tenant-stage', cause),
            ),
          )
          const platformStage =
            platformEnvelope === null
              ? null
              : yield* stageAuditEnvelope(
                  'platform',
                  platformAuditId,
                  platformEnvelope,
                  record.now,
                ).pipe(
                  Effect.mapError((cause) =>
                    failure('invitation.acceptWithIdentity.platform-stage', cause),
                  ),
                )
          const results = yield* attempt('invitation.acceptWithIdentity', () =>
            db.batch([
              db
                .prepare(InvitationAcceptanceSql.insertIdentityForInvitation)
                .bind(
                  identityAfter.id,
                  record.accessSubject,
                  record.email,
                  record.displayName,
                  record.now,
                  record.now,
                  record.tokenHash,
                  record.now,
                  record.email,
                ),
              db
                .prepare(InvitationAcceptanceSql.insertMembershipForAccessSubject)
                .bind(record.now, record.accessSubject, record.tokenHash, record.now),
              db
                .prepare(InvitationAcceptanceSql.acceptForAccessSubject)
                .bind(record.accessSubject, record.tokenHash, record.now),
              db
                .prepare(`INSERT INTO outbox
                (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
                SELECT ?, invitation.organization_id, 'organization.invitation.accepted', 'organization_invitation', invitation.id,
                  json_object('invitationId', invitation.id, 'identityId', identity.id), 'pending', 0, ?, ?
                FROM organization_invitations invitation JOIN identities identity ON identity.access_subject = ?
                WHERE invitation.token_hash = ? AND invitation.status = 'accepted' AND invitation.accepted_by = identity.id
                  AND changes() = 1`)
                .bind(
                  record.outboxEventId,
                  record.now,
                  record.now,
                  record.accessSubject,
                  record.tokenHash,
                ),
              db
                .prepare(`INSERT INTO operations
                (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
                 idempotency_key, correlation_id, revision, created_at, updated_at)
                SELECT ?, ?, 'organization.invitation.accept', 'organization_invitation', ?, ?,
                  'succeeded', 100, ?, ?, 1, ?, ? WHERE changes() = 1`)
                .bind(
                  record.tenantOperationId,
                  invitationBefore.organizationId,
                  invitationBefore.id,
                  identityAfter.id,
                  record.tenantOperationIdempotencyKey,
                  record.request.correlationId,
                  record.now,
                  record.now,
                ),
              db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(tenantStage)),
              db
                .prepare(`INSERT INTO audit_events
                (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
                SELECT ?, ?, ?, 'organization.invitation.accept', 'organization_invitation', ?,
                  'succeeded', ?, ?, ? WHERE changes() = 1`)
                .bind(
                  tenantAuditId,
                  invitationBefore.organizationId,
                  identityAfter.id,
                  invitationBefore.id,
                  record.request.correlationId,
                  auditEventSummaryJson(tenantEnvelope),
                  record.now,
                ),
              db
                .prepare(`INSERT INTO core_mutation_receipts
                (organization_id, actor_id, action, idempotency_key, payload_fingerprint,
                 operation_id, resource_type, resource_id, result_json, response_json, created_at)
                VALUES (?, ?, 'organization.invitation.accept', ?, ?, ?,
                  'organization_invitation', ?, ?, ?, ?)`)
                .bind(
                  invitationBefore.organizationId,
                  identityAfter.id,
                  record.idempotencyKey,
                  record.requestFingerprint,
                  record.tenantOperationId,
                  invitationBefore.id,
                  JSON.stringify(membershipAfter),
                  JSON.stringify({
                    operationId: record.tenantOperationId,
                    resourceId: invitationBefore.id,
                    status: 'succeeded',
                    links: {
                      operation: `/v1/organizations/${invitationBefore.organizationId}/operations/${record.tenantOperationId}`,
                    },
                  }),
                  record.now,
                ),
              ...(platformEnvelope === null || platformStage === null
                ? []
                : [
                    db
                      .prepare(`INSERT INTO platform_operations
                (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status,
                 progress, idempotency_key, payload_fingerprint, revision, created_at, updated_at)
                VALUES (?, 'platform', 'identity.sign-up', 'identity', ?, ?, ?, 'succeeded',
                  100, ?, ?, 1, ?, ?)`)
                      .bind(
                        record.platformOperationId,
                        identityAfter.id,
                        identityAfter.id,
                        record.request.correlationId,
                        record.platformOperationIdempotencyKey,
                        record.requestFingerprint,
                        record.now,
                        record.now,
                      ),
                    db
                      .prepare(auditEnvelopeStageSql)
                      .bind(...auditEnvelopeStageBindings(platformStage)),
                    db
                      .prepare(`INSERT INTO global_audit_events
                (id, scope, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                VALUES (?, 'platform', ?, 'identity.sign-up', 'identity', ?,
                  'succeeded', ?, ?, ?)`)
                      .bind(
                        platformAuditId,
                        identityAfter.id,
                        identityAfter.id,
                        record.request.correlationId,
                        auditEventSummaryJson(platformEnvelope),
                        record.now,
                      ),
                  ]),
            ]),
          )
          const identityRow = yield* attempt('invitation.acceptWithIdentity.readIdentity', () =>
            db
              .prepare(`${identitySelect} WHERE access_subject = ?`)
              .bind(record.accessSubject)
              .first(),
          )
          const identity = yield* required(
            'invitation.acceptWithIdentity.readIdentity',
            'identity',
            record.accessSubject,
            Identity,
            identityRow,
          )
          const invitationRow = yield* attempt('invitation.acceptWithIdentity.readInvitation', () =>
            db.prepare(`${invitationSelect} WHERE token_hash = ?`).bind(record.tokenHash).first(),
          )
          const invitation = yield* required(
            'invitation.acceptWithIdentity.readInvitation',
            'organization_invitation',
            record.tokenHash,
            OrganizationInvitation,
            invitationRow,
          )
          const accepted = (results[2]?.meta?.changes ?? 0) === 1
          if (
            accepted &&
            ((results[1]?.meta?.changes ?? 0) !== 1 ||
              results.slice(3).some((result) => (result.meta?.changes ?? 0) !== 1))
          ) {
            return yield* failure(
              'invitation.acceptWithIdentity.evidence',
              new Error('invitation acceptance evidence is incomplete'),
            )
          }
          if (
            !accepted &&
            (invitation.status !== 'accepted' || invitation.acceptedBy !== identity.id)
          ) {
            return yield* new ConflictError({
              code: 'invitation_accept_rejected',
              message:
                'Invitation is invalid, expired, no longer pending, or belongs to another identity',
            })
          }
          const membershipRow = yield* attempt('invitation.acceptWithIdentity.readMembership', () =>
            db
              .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
              .bind(invitation.organizationId, identity.id)
              .first(),
          )
          const membership = yield* required(
            'invitation.acceptWithIdentity.readMembership',
            'organization_membership',
            `${invitation.organizationId}:${identity.id}`,
            OrganizationMembership,
            membershipRow,
          )
          return { identity, membership, replayed: !accepted }
        }),
      transferOwnership: (context, targetIdentityId, mutation, outboxEventId) =>
        Effect.gen(function* () {
          const replay = yield* readCoreMutationReplay(db, context, mutation, Schema.Null)
          if (replay !== null) return replay
          const actorBefore = yield* required(
            'ownership.transfer.actor',
            'organization_membership',
            `${context.organizationId}:${context.identityId}`,
            OrganizationMembership,
            yield* attempt('ownership.transfer.actor', () =>
              db
                .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
                .bind(context.organizationId, context.identityId)
                .first(),
            ),
          )
          const target = yield* attempt('ownership.transfer.target', () =>
            db
              .prepare(
                `${membershipSelect} WHERE organization_id = ? AND identity_id = ? AND status = 'active'`,
              )
              .bind(context.organizationId, targetIdentityId)
              .first(),
          )
          const targetBefore = yield* required(
            'ownership.transfer.target',
            'organization_membership',
            `${context.organizationId}:${targetIdentityId}`,
            OrganizationMembership,
            target,
          )
          const envelope = yield* completeTenantMutationAudit(
            context,
            mutation,
            {
              state: 'captured',
              summary: {
                actorMembership: membershipSummary(actorBefore),
                targetMembership: membershipSummary(targetBefore),
              },
            },
            {
              state: 'captured',
              summary: {
                actorMembership: {
                  ...membershipSummary(actorBefore),
                  role: 'administrator',
                  revision: actorBefore.revision + 1,
                },
                targetMembership: {
                  ...membershipSummary(targetBefore),
                  role: 'owner',
                  revision: targetBefore.revision + 1,
                },
              },
            },
          ).pipe(Effect.mapError((cause) => failure('ownership.transfer.audit', cause)))
          const coreStatements = yield* tenantMutationStatements(
            db,
            context,
            mutation,
            envelope,
            null,
          )
          yield* attempt('ownership.transfer', () =>
            db.batch([
              db
                .prepare(MembershipSql.transferOwnership)
                .bind(
                  context.identityId,
                  context.organizationId,
                  context.identityId,
                  targetIdentityId,
                  context.organizationId,
                  context.identityId,
                  context.identityId,
                  targetIdentityId,
                ),
              db
                .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
            SELECT ?, ?, 'organization.ownership.transferred', 'organization', ?, ?, 'pending', 0, ?, ?
            WHERE changes() = 2`)
                .bind(
                  outboxEventId,
                  context.organizationId,
                  context.organizationId,
                  JSON.stringify({ from: context.identityId, to: targetIdentityId }),
                  mutation.now,
                  mutation.now,
                ),
              ...coreStatements,
            ]),
          )
          const actorAfter = yield* attempt('ownership.transfer.verifyActor', () =>
            db
              .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
              .bind(context.organizationId, context.identityId)
              .first(),
          )
          const targetAfter = yield* attempt('ownership.transfer.verifyTarget', () =>
            db
              .prepare(`${membershipSelect} WHERE organization_id = ? AND identity_id = ?`)
              .bind(context.organizationId, targetIdentityId)
              .first(),
          )
          const actorMembership = yield* required(
            'ownership.transfer.verifyActor',
            'organization_membership',
            `${context.organizationId}:${context.identityId}`,
            OrganizationMembership,
            actorAfter,
          )
          const targetMembership = yield* required(
            'ownership.transfer.verifyTarget',
            'organization_membership',
            `${context.organizationId}:${targetIdentityId}`,
            OrganizationMembership,
            targetAfter,
          )
          if (actorMembership.role === 'owner' || targetMembership.role !== 'owner') {
            return yield* new ConflictError({
              code: 'ownership_transfer_raced',
              message: 'Ownership transfer was superseded',
            })
          }
          return {
            operationId: mutation.operationId,
            resourceId: context.organizationId,
            value: null,
            replayed: false,
          }
        }),
    })
  }),
)

const AgentRegistrationRepositoryLive = Layer.effect(
  AgentRegistrationRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const readByCredentialHash = (
      operation: string,
      credentialHash: string,
    ): Effect.Effect<AgentCredentialPrincipal, RepositoryError> =>
      attempt(operation, () =>
        db
          .prepare(
            `${agentCredentialSelect} WHERE c.credential_hash = ? AND c.status = 'active' AND s.session_state <> 'revoked'`,
          )
          .bind(credentialHash)
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          required(operation, 'agent_credential', 'credential', AgentCredentialPrincipalRow, row),
        ),
      )
    const readRegistrationReplay = (registration: ExchangeAgentRegistration) =>
      attempt('agent.registration.exchange.replay', () =>
        db
          .prepare(
            `${agentCredentialSelect}
             JOIN node_installer_keys installer
               ON installer.organization_id = c.organization_id AND installer.node_id = c.node_id
              AND installer.status = 'active'
             JOIN node_registration_tokens t
               ON t.organization_id = c.organization_id AND t.node_id = c.node_id
              AND t.credential_id = c.id
             WHERE t.token_hash = ? AND t.organization_id = ? AND t.node_id = ?
               AND t.provider_instance_id = ? AND t.consumed_at IS NOT NULL
               AND t.revoked_at IS NULL AND t.credential_id = ?
               AND c.credential_hash = ? AND c.status = 'active'
               AND s.session_state <> 'revoked' AND s.agent_version = ?
               AND installer.public_key = ? AND installer.public_key_fingerprint = ?`,
          )
          .bind(
            registration.tokenHash,
            registration.organizationId,
            registration.nodeId,
            registration.providerInstanceId,
            registration.credentialId,
            registration.credentialHash,
            registration.agentVersion,
            registration.installerPublicKey,
            registration.installerPublicKeyFingerprint,
          )
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          row === null
            ? Effect.succeed(null)
            : decode('agent.registration.exchange.replay', AgentCredentialPrincipalRow, row),
        ),
      )

    return AgentRegistrationRepository.of({
      exchange: (registration: ExchangeAgentRegistration) =>
        Effect.gen(function* () {
          const transaction = yield* Effect.result(
            attempt('agent.registration.exchange', () =>
              db.batch([
                db
                  .prepare(`UPDATE node_registration_tokens SET consumed_at = ?
                  WHERE token_hash = ? AND organization_id = ? AND node_id = ?
                  AND provider_instance_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
                  AND expires_at > ?`)
                  .bind(
                    registration.now,
                    registration.tokenHash,
                    registration.organizationId,
                    registration.nodeId,
                    registration.providerInstanceId,
                    registration.now,
                  ),
                db
                  .prepare(`INSERT INTO node_credentials
                  (organization_id, node_id, id, credential_hash, version, status, issued_at)
                  SELECT organization_id, node_id, ?, ?, 1, 'active', ?
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
                  .bind(
                    registration.credentialId,
                    registration.credentialHash,
                    registration.now,
                    registration.tokenHash,
                    registration.now,
                  ),
                db
                  .prepare(`INSERT INTO agent_sessions
                  (organization_id, node_id, credential_id, session_version, agent_version,
                   session_state, last_seen_at, revision)
                  SELECT organization_id, node_id, ?, 1, ?, 'connected', ?, 1
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ? AND changes() = 1`)
                  .bind(
                    registration.credentialId,
                    registration.agentVersion,
                    registration.now,
                    registration.tokenHash,
                    registration.now,
                  ),
                db
                  .prepare(`UPDATE node_registration_tokens SET credential_id = ?
                  WHERE token_hash = ? AND consumed_at = ? AND credential_id IS NULL
                  AND changes() = 1`)
                  .bind(registration.credentialId, registration.tokenHash, registration.now),
                db
                  .prepare(`INSERT INTO node_installer_keys
                  (organization_id, node_id, public_key, public_key_fingerprint, status,
                   revision, registered_at)
                  SELECT organization_id, node_id, ?, ?, 'active', 1, ?
                  FROM node_registration_tokens
                  WHERE token_hash = ? AND consumed_at = ? AND credential_id = ?`)
                  .bind(
                    registration.installerPublicKey,
                    registration.installerPublicKeyFingerprint,
                    registration.now,
                    registration.tokenHash,
                    registration.now,
                    registration.credentialId,
                  ),
              ]),
            ),
          )
          if (transaction._tag === 'Failure') {
            const replay = yield* readRegistrationReplay(registration)
            if (replay !== null) return replay
            return yield* new ConflictError({
              code: 'agent_registration_rejected',
              message: 'The registration token is invalid, expired, consumed, or wrongly scoped',
            })
          }
          const results = transaction.success
          if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) {
            const replay = yield* readRegistrationReplay(registration)
            if (replay !== null) return replay
            return yield* new ConflictError({
              code: 'agent_registration_rejected',
              message: 'The registration token is invalid, expired, consumed, or wrongly scoped',
            })
          }
          return yield* readByCredentialHash(
            'agent.registration.exchange.read',
            registration.credentialHash,
          )
        }),
      authenticate: (credentialHash, now) =>
        Effect.gen(function* () {
          yield* readByCredentialHash('agent.credential.authenticate.initial', credentialHash)
          yield* attempt('agent.credential.authenticate.heartbeat', () =>
            db.batch([
              db
                .prepare(`UPDATE node_credentials SET last_used_at = ?
                  WHERE credential_hash = ? AND status = 'active'
                  AND (last_used_at IS NULL OR unixepoch(last_used_at) <= unixepoch(?) - 60)`)
                .bind(now, credentialHash, now),
              db
                .prepare(`UPDATE agent_sessions SET last_seen_at = ?, revision = revision + 1
                  WHERE (organization_id, node_id, credential_id) IN
                    (SELECT organization_id, node_id, id FROM node_credentials
                     WHERE credential_hash = ? AND status = 'active')
                  AND session_state <> 'revoked'
                  AND unixepoch(last_seen_at) <= unixepoch(?) - 60`)
                .bind(now, credentialHash, now),
            ]),
          )
          return yield* readByCredentialHash('agent.credential.authenticate.read', credentialHash)
        }),
      revokeRegistrationToken: (principal, tokenHash, now) =>
        Effect.gen(function* () {
          const result = yield* attempt('agent.registration.revokeToken', () =>
            db
              .prepare(`UPDATE node_registration_tokens
                SET consumed_at = COALESCE(consumed_at, ?), revoked_at = COALESCE(revoked_at, ?)
                WHERE token_hash = ? AND organization_id = ? AND node_id = ?`)
              .bind(now, now, tokenHash, principal.organizationId, principal.nodeId)
              .run(),
          )
          if ((result.meta?.changes ?? 0) !== 1) {
            return yield* new ConflictError({
              code: 'agent_registration_token_revoke_rejected',
              message: 'The registration token does not belong to this node',
            })
          }
        }),
      rotate: (rotation: RotateAgentCredential) =>
        Effect.gen(function* () {
          const nextVersion = rotation.principal.version + 1
          const nextSessionVersion = rotation.principal.sessionVersion + 1
          const results = yield* attempt('agent.credential.rotate', () =>
            db.batch([
              db
                .prepare(`UPDATE node_credentials SET status = 'revoked', revoked_at = ?
                  WHERE organization_id = ? AND node_id = ? AND id = ?
                  AND version = ? AND status = 'active'`)
                .bind(
                  rotation.now,
                  rotation.principal.organizationId,
                  rotation.principal.nodeId,
                  rotation.principal.credentialId,
                  rotation.principal.version,
                ),
              db
                .prepare(`INSERT INTO node_credentials
                  (organization_id, node_id, id, credential_hash, version, status, issued_at)
                  SELECT organization_id, node_id, ?, ?, ?, 'active', ? FROM node_credentials
                  WHERE organization_id = ? AND node_id = ? AND id = ?
                  AND status = 'revoked' AND changes() = 1`)
                .bind(
                  rotation.newCredentialId,
                  rotation.newCredentialHash,
                  nextVersion,
                  rotation.now,
                  rotation.principal.organizationId,
                  rotation.principal.nodeId,
                  rotation.principal.credentialId,
                ),
              db
                .prepare(`UPDATE agent_sessions
                  SET credential_id = ?, session_version = ?, session_state = 'connected',
                      last_seen_at = ?, revision = revision + 1
                  WHERE organization_id = ? AND node_id = ? AND credential_id = ?
                  AND session_version = ? AND changes() = 1`)
                .bind(
                  rotation.newCredentialId,
                  nextSessionVersion,
                  rotation.now,
                  rotation.principal.organizationId,
                  rotation.principal.nodeId,
                  rotation.principal.credentialId,
                  rotation.principal.sessionVersion,
                ),
            ]),
          )
          if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) {
            return yield* new ConflictError({
              code: 'agent_credential_rotation_rejected',
              message: 'The node credential changed before rotation completed',
            })
          }
          return yield* readByCredentialHash(
            'agent.credential.rotate.read',
            rotation.newCredentialHash,
          )
        }),
      revoke: (principal, now) =>
        Effect.gen(function* () {
          const results = yield* attempt('agent.credential.revoke', () =>
            db.batch([
              db
                .prepare(`UPDATE node_credentials SET status = 'revoked', revoked_at = ?
                  WHERE organization_id = ? AND node_id = ? AND id = ?
                  AND version = ? AND status = 'active'`)
                .bind(
                  now,
                  principal.organizationId,
                  principal.nodeId,
                  principal.credentialId,
                  principal.version,
                ),
              db
                .prepare(`UPDATE agent_sessions
                  SET session_state = 'revoked', session_version = session_version + 1,
                      last_seen_at = ?, revision = revision + 1
                  WHERE organization_id = ? AND node_id = ? AND credential_id = ?
                  AND session_version = ? AND session_state <> 'revoked' AND changes() = 1`)
                .bind(
                  now,
                  principal.organizationId,
                  principal.nodeId,
                  principal.credentialId,
                  principal.sessionVersion,
                ),
            ]),
          )
          if (results.some((result) => (result.meta?.changes ?? 0) !== 1)) {
            return yield* new ConflictError({
              code: 'agent_credential_revocation_rejected',
              message: 'The node credential is already revoked or changed',
            })
          }
        }),
    })
  }),
)

const providerAccountOperationId = (operationIdempotencyKey: string) =>
  `provider-account-operation:${operationIdempotencyKey}`
const providerAccountAuditEventId = (operationIdempotencyKey: string) =>
  `provider-account-audit:${operationIdempotencyKey}`
const providerAccountOperationAction = (action: 'create' | 'update-credentials') =>
  action === 'create' ? 'provider-account.create' : 'provider-account.credentials.update'
const providerAccountAuditAction = (action: 'create' | 'update-credentials') =>
  action === 'create' ? 'provider.account.create' : 'provider.account.credentials.update'
const providerAccountAuditSummary = (
  account: ProviderAccountMetadata,
): Record<string, unknown> => ({
  accountId: account.id,
  providerType: account.providerType,
  status: account.status,
  revision: account.revision,
  credentialRevision: account.credentialRevision,
})

const providerAccountAuditStatements = (
  db: D1DatabaseLike,
  input: {
    readonly context: OrganizationContext
    readonly action: 'create' | 'update-credentials'
    readonly accountId: string
    readonly operationIdempotencyKey: string
    readonly requestFingerprint: string
    readonly auditRequestContext: AuditRequestContextValue
    readonly now: string
    readonly before: AuditEnvelopeV1['before']
    readonly after: AuditEnvelopeV1['after']
  },
): Effect.Effect<ReadonlyArray<D1PreparedStatementLike>, RepositoryError> =>
  Effect.gen(function* () {
    if (input.auditRequestContext.correlationId !== input.context.correlationId)
      return yield* new ConflictError({
        code: 'provider_account_audit_request_mismatch',
        message: 'Provider account audit request does not match the authorized mutation',
      })
    const operationId = providerAccountOperationId(input.operationIdempotencyKey)
    const eventId = providerAccountAuditEventId(input.operationIdempotencyKey)
    const envelope = yield* completeAuditEnvelope({
      occurredAt: input.now,
      scope: 'tenant',
      organizationId: input.context.organizationId,
      actor: { type: 'human', id: input.context.identityId },
      action: providerAccountAuditAction(input.action),
      target: { type: 'provider_account', id: input.accountId },
      before: input.before,
      after: input.after,
      operationId,
      request: input.auditRequestContext,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError((cause) => failure('providerAccount.audit.envelope', cause)))
    const stage = yield* stageAuditEnvelope('tenant', eventId, envelope, input.now).pipe(
      Effect.mapError((cause) => failure('providerAccount.audit.stage', cause)),
    )
    return [
      db
        .prepare(`INSERT INTO operations
          (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
           idempotency_key, correlation_id, revision, created_at, updated_at)
          VALUES (?, ?, ?, 'provider_account', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
        .bind(
          operationId,
          input.context.organizationId,
          providerAccountOperationAction(input.action),
          input.accountId,
          input.context.identityId,
          input.operationIdempotencyKey,
          input.auditRequestContext.correlationId,
          input.now,
          input.now,
        ),
      db.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      db
        .prepare(`INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id, result,
           correlation_id, summary_json, created_at)
          VALUES (?, ?, ?, ?, 'provider_account', ?, 'succeeded', ?, ?, ?)`)
        .bind(
          eventId,
          input.context.organizationId,
          input.context.identityId,
          providerAccountAuditAction(input.action),
          input.accountId,
          input.auditRequestContext.correlationId,
          auditEventSummaryJson(envelope),
          input.now,
        ),
    ]
  })

const ProviderAccountRepositoryLive = Layer.effect(
  ProviderAccountRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const replaySchema = Schema.Struct({
      action: Schema.String,
      accountId: Schema.String,
      actorId: Schema.NullOr(Schema.String),
      requestFingerprint: Schema.String,
      responseJson: Schema.String,
    })
    const readReplay = (context: OrganizationContext, idempotencyKey: string) =>
      attempt('providerAccount.idempotency.get', () =>
        db
          .prepare(
            `SELECT action, account_id AS accountId, actor_id AS actorId, request_fingerprint AS requestFingerprint,
           response_json AS responseJson FROM provider_account_mutation_idempotency
         WHERE organization_id = ? AND idempotency_key = ?`,
          )
          .bind(context.organizationId, idempotencyKey)
          .first(),
      )
    const decodeReplay = (
      context: OrganizationContext,
      row: unknown,
      fingerprint: string,
      action: string,
    ) =>
      Effect.gen(function* () {
        const replay = yield* decode('providerAccount.idempotency.decode', replaySchema, row)
        yield* assertIdempotentReplay(replay.requestFingerprint, fingerprint)
        if (replay.actorId !== context.identityId) {
          return yield* new ConflictError({
            code: 'idempotency_key_reused',
            message: 'The idempotency key belongs to a different provider account actor',
          })
        }
        if (replay.action !== action) {
          return yield* new ConflictError({
            code: 'idempotency_key_reused',
            message: 'The idempotency key was already used for another provider account action',
          })
        }
        const parsed = yield* Effect.try({
          try: () => JSON.parse(replay.responseJson) as unknown,
          catch: (cause) => failure('providerAccount.idempotency.decode', cause),
        })
        return yield* decode('providerAccount.idempotency.decode', ProviderAccountMetadata, parsed)
      })
    const getAccount = (context: OrganizationContext, accountId: string) =>
      attempt('providerAccount.get', () =>
        db
          .prepare(
            `${providerAccountSelect} WHERE pa.organization_id = ? AND pa.id = ? AND pa.scope = 'organization'`,
          )
          .bind(context.organizationId, accountId)
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          required(
            'providerAccount.get',
            'provider_account',
            accountId,
            ProviderAccountMetadata,
            row,
          ),
        ),
      )
    const getEnvelope = (context: OrganizationContext, accountId: string) =>
      attempt('providerAccount.credentialEnvelope.get', () =>
        db
          .prepare(
            `${secretEnvelopeSelect} WHERE organization_id = ? AND scope_type = 'provider-account' AND scope_id = ?`,
          )
          .bind(context.organizationId, accountId)
          .first(),
      ).pipe(
        Effect.flatMap((row) =>
          required(
            'providerAccount.credentialEnvelope.get',
            'provider_account',
            accountId,
            SecretEnvelopeRecord,
            row,
          ),
        ),
      )
    return ProviderAccountRepository.of({
      findMutationReplay: (context, idempotencyKey, fingerprint, action) =>
        Effect.flatMap(readReplay(context, idempotencyKey), (row) =>
          row === null ? Effect.succeed(null) : decodeReplay(context, row, fingerprint, action),
        ),
      create: (context, record) =>
        Effect.gen(function* () {
          const prior = yield* readReplay(context, record.idempotencyKey)
          if (prior !== null)
            return yield* decodeReplay(context, prior, record.requestFingerprint, 'create')
          const account = record.account
          const secret = record.credentialEnvelope
          if (
            account.organizationId !== context.organizationId ||
            secret.organizationId !== context.organizationId ||
            secret.id !== `${account.id}.credentials` ||
            secret.scopeType !== 'provider-account' ||
            secret.scopeId !== account.id ||
            secret.revision !== 1 ||
            account.revision !== 1 ||
            account.credentialRevision !== 1
          ) {
            return yield* new ConflictError({
              code: 'provider_credential_binding_invalid',
              message: 'Provider account credential binding is invalid',
            })
          }
          const responseJson = JSON.stringify(account)
          const auditStatements = yield* providerAccountAuditStatements(db, {
            context,
            action: 'create',
            accountId: account.id,
            operationIdempotencyKey: record.operationIdempotencyKey,
            requestFingerprint: record.requestFingerprint,
            auditRequestContext: record.auditRequestContext,
            now: account.createdAt,
            before: { state: 'absent', reason: 'provider account did not exist' },
            after: { state: 'captured', summary: providerAccountAuditSummary(account) },
          })
          const write = attempt('providerAccount.create', () =>
            db.batch([
              db
                .prepare(`INSERT INTO secret_envelopes
            (organization_id, id, scope_type, scope_id, ciphertext, wrapped_data_key,
             key_version, revision, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`)
                .bind(
                  context.organizationId,
                  secret.id,
                  secret.scopeType,
                  secret.scopeId,
                  secret.ciphertext,
                  secret.wrappedDataKey,
                  secret.keyVersion,
                  secret.createdAt,
                ),
              db
                .prepare(`INSERT INTO provider_accounts
            (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
            VALUES (?, 'organization', ?, ?, ?, ?, 1, ?, ?)`)
                .bind(
                  account.id,
                  context.organizationId,
                  account.providerType,
                  secret.id,
                  account.status,
                  account.createdAt,
                  account.updatedAt,
                ),
              ...auditStatements,
              db
                .prepare(`INSERT INTO provider_account_mutation_idempotency
            (organization_id, idempotency_key, action, account_id, request_fingerprint,
             expected_revision, result_revision, expected_credential_revision,
             result_credential_revision, response_json, created_at, actor_id, operation_id,
             operation_idempotency_key, audit_event_id)
            VALUES (?, ?, 'create', ?, ?, 0, 1, 0, 1, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  context.organizationId,
                  record.idempotencyKey,
                  account.id,
                  record.requestFingerprint,
                  responseJson,
                  account.createdAt,
                  context.identityId,
                  providerAccountOperationId(record.operationIdempotencyKey),
                  record.operationIdempotencyKey,
                  providerAccountAuditEventId(record.operationIdempotencyKey),
                ),
            ]),
          ).pipe(Effect.as(account))
          return yield* write.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const concurrent = yield* readReplay(context, record.idempotencyKey)
                return concurrent === null
                  ? yield* Effect.fail(error)
                  : yield* decodeReplay(context, concurrent, record.requestFingerprint, 'create')
              }),
            ),
          )
        }),
      updateCredentials: (context, record) =>
        Effect.gen(function* () {
          const prior = yield* readReplay(context, record.idempotencyKey)
          if (prior !== null)
            return yield* decodeReplay(
              context,
              prior,
              record.requestFingerprint,
              'update-credentials',
            )
          const current = yield* getAccount(context, record.accountId)
          if (current.providerType !== record.providerType) {
            return yield* new ConflictError({
              code: 'provider_type_immutable',
              message: 'Provider account type cannot be changed',
            })
          }
          if (current.revision !== record.expectedRevision) {
            return yield* new RevisionConflictError({
              resource: 'provider_account',
              expected: record.expectedRevision,
              actual: current.revision,
            })
          }
          if (current.credentialRevision !== record.expectedCredentialRevision) {
            return yield* new RevisionConflictError({
              resource: 'provider_account_credential',
              expected: record.expectedCredentialRevision,
              actual: current.credentialRevision,
            })
          }
          const secret = record.credentialEnvelope
          if (
            secret.organizationId !== context.organizationId ||
            secret.id !== `${record.accountId}.credentials` ||
            secret.scopeType !== 'provider-account' ||
            secret.scopeId !== record.accountId ||
            secret.revision !== record.expectedCredentialRevision + 1
          ) {
            return yield* new ConflictError({
              code: 'provider_credential_binding_invalid',
              message: 'Provider account credential replacement is invalid',
            })
          }
          const updated = new ProviderAccountMetadata({
            id: current.id,
            scope: current.scope,
            organizationId: current.organizationId,
            providerType: current.providerType,
            status: current.status,
            revision: record.expectedRevision + 1,
            credentialRevision: record.expectedCredentialRevision + 1,
            createdAt: current.createdAt,
            updatedAt: record.now,
          })
          const responseJson = JSON.stringify(updated)
          const auditStatements = yield* providerAccountAuditStatements(db, {
            context,
            action: 'update-credentials',
            accountId: record.accountId,
            operationIdempotencyKey: record.operationIdempotencyKey,
            requestFingerprint: record.requestFingerprint,
            auditRequestContext: record.auditRequestContext,
            now: record.now,
            before: { state: 'captured', summary: providerAccountAuditSummary(current) },
            after: { state: 'captured', summary: providerAccountAuditSummary(updated) },
          })
          const write = attempt('providerAccount.updateCredentials', () =>
            db.batch([
              db
                .prepare(`UPDATE secret_envelopes SET ciphertext = ?, wrapped_data_key = ?, key_version = ?,
             revision = ?, rotated_at = ? WHERE organization_id = ? AND id = ?
             AND scope_type = 'provider-account' AND scope_id = ? AND revision = ?`)
                .bind(
                  secret.ciphertext,
                  secret.wrappedDataKey,
                  secret.keyVersion,
                  secret.revision,
                  record.now,
                  context.organizationId,
                  secret.id,
                  record.accountId,
                  record.expectedCredentialRevision,
                ),
              db
                .prepare(`UPDATE provider_accounts SET revision = ?, updated_at = ?
             WHERE organization_id = ? AND id = ? AND scope = 'organization'
               AND provider_type = ? AND revision = ?`)
                .bind(
                  updated.revision,
                  record.now,
                  context.organizationId,
                  record.accountId,
                  record.providerType,
                  record.expectedRevision,
                ),
              ...auditStatements,
              db
                .prepare(`INSERT INTO provider_account_mutation_idempotency
            (organization_id, idempotency_key, action, account_id, request_fingerprint,
             expected_revision, result_revision, expected_credential_revision,
             result_credential_revision, response_json, created_at, actor_id, operation_id,
             operation_idempotency_key, audit_event_id)
            VALUES (?, ?, 'update-credentials', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  context.organizationId,
                  record.idempotencyKey,
                  record.accountId,
                  record.requestFingerprint,
                  record.expectedRevision,
                  updated.revision,
                  record.expectedCredentialRevision,
                  updated.credentialRevision,
                  responseJson,
                  record.now,
                  context.identityId,
                  providerAccountOperationId(record.operationIdempotencyKey),
                  record.operationIdempotencyKey,
                  providerAccountAuditEventId(record.operationIdempotencyKey),
                ),
            ]),
          ).pipe(Effect.as(updated))
          return yield* write.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const concurrent = yield* readReplay(context, record.idempotencyKey)
                if (concurrent !== null)
                  return yield* decodeReplay(
                    context,
                    concurrent,
                    record.requestFingerprint,
                    'update-credentials',
                  )
                const latest = yield* getAccount(context, record.accountId)
                return latest.revision !== record.expectedRevision
                  ? yield* new RevisionConflictError({
                      resource: 'provider_account',
                      expected: record.expectedRevision,
                      actual: latest.revision,
                    })
                  : yield* Effect.fail(error)
              }),
            ),
          )
        }),
      getCredentialEnvelope: (context, accountId) => getEnvelope(context, accountId),
    })
  }),
)

const OperationRepositoryLive = Layer.effect(
  OperationRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    const getScoped = (context: OrganizationContext, id: string) =>
      attempt('operation.get', () =>
        db
          .prepare(`${operationSelect} WHERE organization_id = ? AND id = ?`)
          .bind(context.organizationId, id)
          .first(),
      ).pipe(Effect.flatMap((row) => required('operation.get', 'operation', id, Operation, row)))
    return OperationRepository.of({
      createWithOutboxOrGet: (operation, event) =>
        Effect.gen(function* () {
          const prior = yield* attempt('operation.create.idempotency', () =>
            db
              .prepare(`${operationSelect} WHERE organization_id = ? AND idempotency_key = ?`)
              .bind(operation.organizationId, operation.idempotencyKey)
              .first(),
          )
          if (prior !== null) {
            const existing = yield* decode('operation.create.idempotency', Operation, prior)
            const storedFingerprint = JSON.stringify({
              type: existing.type,
              resourceType: existing.resourceType,
              resourceId: existing.resourceId,
              actorId: existing.actorId,
            })
            const requestFingerprint = JSON.stringify({
              type: operation.type,
              resourceType: operation.resourceType,
              resourceId: operation.resourceId,
              actorId: operation.actorId,
            })
            yield* assertIdempotentReplay(storedFingerprint, requestFingerprint)
            return existing
          }
          yield* attempt('operation.create', () =>
            db.batch([
              db
                .prepare(`INSERT INTO operations
            (id, organization_id, type, resource_type, resource_id, actor_id, status, progress, idempotency_key, correlation_id, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  operation.id,
                  operation.organizationId,
                  operation.type,
                  operation.resourceType,
                  operation.resourceId,
                  operation.actorId,
                  operation.status,
                  operation.progress,
                  operation.idempotencyKey,
                  operation.correlationId,
                  operation.revision,
                  operation.createdAt,
                  operation.updatedAt,
                ),
              db
                .prepare(`INSERT INTO outbox
            (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json, publish_state, retry_count, available_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                  event.id,
                  event.organizationId,
                  event.eventType,
                  event.aggregateType,
                  event.aggregateId,
                  event.payload,
                  event.publishState,
                  event.retryCount,
                  event.availableAt,
                  event.createdAt,
                ),
              db
                .prepare(`INSERT INTO audit_events
                (id, organization_id, actor_id, action, target_type, target_id, result,
                 correlation_id, summary_json, created_at)
                SELECT ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ? WHERE changes() = 1`)
                .bind(
                  `audit-${event.id}`,
                  operation.organizationId,
                  operation.actorId,
                  `operation.${operation.type}.enqueue`,
                  operation.resourceType,
                  operation.resourceId,
                  operation.correlationId,
                  JSON.stringify({ operationId: operation.id, resourceId: operation.resourceId }),
                  operation.createdAt,
                ),
            ]),
          )
          const row = yield* attempt('operation.create.read', () =>
            db
              .prepare(`${operationSelect} WHERE organization_id = ? AND id = ?`)
              .bind(operation.organizationId, operation.id)
              .first(),
          )
          return yield* required('operation.create.read', 'operation', operation.id, Operation, row)
        }),
      get: getScoped,
      updateStatus: (context, id, status, progress, expectedRevision, now) =>
        Effect.gen(function* () {
          const result = yield* attempt('operation.updateStatus', () =>
            db
              .prepare(
                `UPDATE operations SET status = ?, progress = ?, revision = revision + 1, updated_at = ?
           WHERE organization_id = ? AND id = ? AND revision = ?`,
              )
              .bind(status, progress, now, context.organizationId, id, expectedRevision)
              .run(),
          )
          if ((result.meta?.changes ?? 0) !== 1) {
            const current = yield* getScoped(context, id)
            return yield* new RevisionConflictError({
              resource: 'operation',
              expected: expectedRevision,
              actual: current.revision,
            })
          }
          return yield* getScoped(context, id)
        }),
    })
  }),
)

const operationRecoveryMessage = (
  code: 'none' | 'wait-for-external-evidence' | 'inspect-terminal-failure' | 'cancelled',
): string => {
  switch (code) {
    case 'wait-for-external-evidence':
      return 'Wait for authoritative external evidence; the operation will reconcile automatically.'
    case 'inspect-terminal-failure':
      return 'Review the recorded steps and audit events. No generic retry action is available.'
    case 'cancelled':
      return 'The operation was cancelled. Start a new typed action if the resource still needs a change.'
    case 'none':
      return 'No recovery action is required.'
  }
}

const OperationDetailRepositoryLive = Layer.effect(
  OperationDetailRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    return OperationDetailRepository.of({
      get: (context, operationId) =>
        Effect.gen(function* () {
          const operation = yield* attempt('operation-detail.operation', () =>
            db
              .prepare(`${operationSelect} WHERE organization_id = ? AND id = ?`)
              .bind(context.organizationId, operationId)
              .first(),
          ).pipe(
            Effect.flatMap((row) =>
              required('operation-detail.operation', 'operation', operationId, Operation, row),
            ),
          )
          const projection = yield* attempt('operation-detail.projection', () =>
            db
              .prepare(`SELECT detail.retry_count AS retryCount,
                detail.waiting_reason AS waitingReason,
                provider_reference_hint AS providerReferenceHint, recovery_code AS recoveryCode,
                final_resource_type AS finalResourceType, final_resource_id AS finalResourceId,
                EXISTS (
                  SELECT 1 FROM operation_cancellation_facts facts
                  WHERE facts.organization_id = detail.organization_id
                    AND facts.operation_id = detail.operation_id
                    AND facts.phase <> 'terminal'
                    AND ((facts.cancellation_policy = 'before-destructive-step'
                          AND facts.phase = 'before-destructive-step')
                      OR (facts.cancellation_policy = 'between-steps'
                          AND facts.phase IN ('before-destructive-step', 'between-steps')))
                    AND NOT EXISTS (
                      SELECT 1 FROM operation_cancellation_requests request
                      WHERE request.organization_id = facts.organization_id
                        AND request.operation_id = facts.operation_id
                    )
                ) AS cancellable
              FROM operation_detail_projection detail
              WHERE detail.organization_id = ? AND detail.operation_id = ?`)
              .bind(context.organizationId, operationId)
              .first(),
          )
          if (projection === null)
            return yield* failure(
              'operation-detail.projection',
              new Error('operation detail projection is missing'),
            )
          const detail = projection as Record<string, unknown>
          const recoveryCode = detail['recoveryCode'] as
            | 'none'
            | 'wait-for-external-evidence'
            | 'inspect-terminal-failure'
            | 'cancelled'
          const steps = yield* attempt('operation-detail.steps', () =>
            db
              .prepare(`SELECT source_type || ':' || source_key AS key, label, state,
                attempt, started_at AS startedAt, completed_at AS completedAt
              FROM operation_detail_steps
              WHERE organization_id = ? AND operation_id = ?
              ORDER BY sequence, source_type, source_key LIMIT 100`)
              .bind(context.organizationId, operationId)
              .all(),
          )
          const logs = yield* attempt('operation-detail.logs', () =>
            db
              .prepare(`SELECT id, action, result, createdAt FROM (
                SELECT audit_event_id AS id, action, result, created_at AS createdAt
                FROM operation_detail_log_events
                WHERE organization_id = ? AND operation_id = ?
                ORDER BY created_at DESC, audit_event_id DESC LIMIT 100
              ) newest ORDER BY createdAt, id`)
              .bind(context.organizationId, operationId)
              .all(),
          )
          return yield* decode('operation-detail.decode', OperationDetail, {
            id: operation.id,
            organizationId: operation.organizationId,
            type: operation.type,
            resourceType: operation.resourceType,
            resourceId: operation.resourceId,
            actorId: operation.actorId,
            status: operation.status,
            progress: operation.progress,
            idempotencyKey: operation.idempotencyKey,
            correlationId: operation.correlationId,
            revision: operation.revision,
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
            retryCount: detail['retryCount'],
            waitingReason: detail['waitingReason'],
            providerReferenceHint: detail['providerReferenceHint'],
            cancellable: detail['cancellable'] === 1,
            recovery: {
              code: recoveryCode,
              message: operationRecoveryMessage(recoveryCode),
              retryAction: null,
            },
            finalResource:
              detail['finalResourceType'] === null || detail['finalResourceId'] === null
                ? null
                : { type: detail['finalResourceType'], id: detail['finalResourceId'] },
            steps: steps.results,
            logs: logs.results,
          })
        }),
    })
  }),
)

const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    return OutboxRepository.of({
      claimPending: (workerId, leaseToken, limit, now, leaseUntil) =>
        attempt('outbox.claimPending', () =>
          db
            .prepare(
              `UPDATE outbox
               SET publish_state = 'publishing', lease_owner = ?, lease_token = ?, lease_until = ?
               WHERE id IN (
                 SELECT id FROM outbox
                 WHERE ((publish_state IN ('pending', 'failed') AND available_at <= ?)
                   OR (publish_state = 'publishing' AND lease_until <= ?))
                 ORDER BY created_at, id LIMIT ?
               )
               RETURNING id, organization_id AS organizationId, event_type AS eventType,
                 aggregate_type AS aggregateType, aggregate_id AS aggregateId, payload_json AS payload,
                 publish_state AS publishState, retry_count AS retryCount,
                 available_at AS availableAt, created_at AS createdAt`,
            )
            .bind(workerId, leaseToken, leaseUntil, now, now, limit)
            .all(),
        ).pipe(
          Effect.flatMap((result) =>
            Effect.forEach(result.results, (row) =>
              decode('outbox.claimPending', OutboxEvent, row),
            ),
          ),
        ),
      listPending: (limit, now) =>
        attempt('outbox.listPending', () =>
          db
            .prepare(
              `${outboxSelect} WHERE publish_state IN ('pending', 'failed') AND available_at <= ? ORDER BY created_at LIMIT ?`,
            )
            .bind(now, limit)
            .all(),
        ).pipe(
          Effect.flatMap((result) =>
            Effect.forEach(result.results, (row) => decode('outbox.listPending', OutboxEvent, row)),
          ),
        ),
      markDelivered: (id, workerId, leaseToken, deliveredAt) =>
        Effect.gen(function* () {
          const result = yield* attempt('outbox.markDelivered', () =>
            db
              .prepare(
                `UPDATE outbox SET publish_state = 'delivered', delivered_at = ?,
                   lease_owner = NULL, lease_token = NULL, lease_until = NULL
                 WHERE id = ? AND publish_state = 'publishing'
                   AND lease_owner = ? AND lease_token = ?`,
              )
              .bind(deliveredAt, id, workerId, leaseToken)
              .run(),
          )
          if ((result.meta?.changes ?? 0) !== 1) {
            return yield* new ConflictError({
              code: 'outbox_lease_lost',
              message: 'The outbox delivery lease is no longer owned by this worker',
            })
          }
        }),
      markFailed: (id, workerId, leaseToken, availableAt) =>
        Effect.gen(function* () {
          const result = yield* attempt('outbox.markFailed', () =>
            db
              .prepare(
                `UPDATE outbox SET publish_state = 'failed', retry_count = retry_count + 1,
                   available_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL
                 WHERE id = ? AND publish_state = 'publishing'
                   AND lease_owner = ? AND lease_token = ?`,
              )
              .bind(availableAt, id, workerId, leaseToken)
              .run(),
          )
          if ((result.meta?.changes ?? 0) !== 1) {
            return yield* new ConflictError({
              code: 'outbox_lease_lost',
              message: 'The outbox delivery lease is no longer owned by this worker',
            })
          }
        }),
      markTerminalFailed: (id, workerId, leaseToken) =>
        Effect.gen(function* () {
          const result = yield* attempt('outbox.markTerminalFailed', () =>
            db
              .prepare(
                `UPDATE outbox SET publish_state = 'failed_terminal', retry_count = retry_count + 1,
                 lease_owner = NULL, lease_token = NULL, lease_until = NULL
               WHERE id = ? AND publish_state = 'publishing'
                 AND lease_owner = ? AND lease_token = ?`,
              )
              .bind(id, workerId, leaseToken)
              .run(),
          )
          if ((result.meta?.changes ?? 0) !== 1) {
            return yield* new ConflictError({
              code: 'outbox_lease_lost',
              message: 'The outbox delivery lease is no longer owned by this worker',
            })
          }
        }),
    })
  }),
)

const AuditRepositoryLive = Layer.effect(
  AuditRepository,
  Effect.gen(function* () {
    const db = yield* D1Client
    return AuditRepository.of({
      append: (context, record) =>
        attempt('audit.append', () =>
          db
            .prepare(
              `INSERT INTO audit_events
         (id, organization_id, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              record.id,
              context.organizationId,
              record.actorId,
              record.action,
              record.targetType,
              record.targetId,
              record.result,
              record.correlationId,
              record.summary,
              record.createdAt,
            )
            .run(),
        ).pipe(Effect.asVoid),
    })
  }),
)

/** All D1 repository implementations. Provide `D1ClientLayer(binding)` once at the Worker boundary. */
export const D1RepositoriesLive = Layer.mergeAll(
  IdentityRepositoryLive,
  OrganizationRepositoryLive,
  MembershipRepositoryLive,
  InvitationRepositoryLive,
  UnitOfWorkLive,
  AgentRegistrationRepositoryLive,
  ProviderAccountRepositoryLive,
  OperationRepositoryLive,
  OperationDetailRepositoryLive,
  OutboxRepositoryLive,
  AuditRepositoryLive,
)

/** Convenience factory for root composition without exposing SQL to the HTTP adapter. */
export const makeD1RepositoriesLayer = (database: D1DatabaseLike) =>
  D1RepositoriesLive.pipe(Layer.provide(D1ClientLayer(database)))

/** Environment-selected registration policy with a D1-deduplicated platform audit sink. */
export const makeRegistrationPolicyD1Layer = (database: D1DatabaseLike, configuredMode: string) => {
  const policyRepository = Layer.succeed(
    RegistrationPolicyRepository,
    RegistrationPolicyRepository.of({
      get: Schema.decodeUnknownEffect(RegistrationMode)(configuredMode).pipe(
        Effect.map((mode) => ({ mode })),
        Effect.mapError(() => new RegistrationPolicyStoreError()),
      ),
    }),
  )
  const clock = Layer.succeed(
    RegistrationClock,
    RegistrationClock.of({
      nowEpochMilliseconds: Effect.sync(() => Date.now()),
    }),
  )
  const audit = Layer.succeed(
    RegistrationDecisionAuditPort,
    RegistrationDecisionAuditPort.of({
      find: (decisionId) =>
        Effect.tryPromise({
          try: () =>
            database
              .prepare(`SELECT decision_id AS decisionId, intent, mode,
                identity_known AS identityKnown, outcome, reason,
                decided_at_epoch_ms AS decidedAtEpochMilliseconds
                FROM registration_policy_decisions WHERE decision_id = ?`)
              .bind(decisionId)
              .first(),
          catch: () => new RegistrationAuditError(),
        }).pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.succeed(null)
              : decode(
                  'registrationPolicy.decisionReplay',
                  Schema.Struct({
                    decisionId: Schema.String,
                    intent: Schema.Literals(['sign-in', 'public-sign-up', 'invitation-completion']),
                    mode: RegistrationMode,
                    identityKnown: Schema.Literals([0, 1]),
                    outcome: Schema.Literals(['allow-existing', 'allow-create', 'deny']),
                    reason: Schema.Literals([
                      'existing_identity',
                      'open_registration',
                      'unknown_sign_in',
                      'public_registration_disabled',
                      'valid_invitation',
                      'invalid_invitation',
                      'expired_invitation',
                      'invitation_binding_mismatch',
                      'invitation_already_consumed',
                    ]),
                    decidedAtEpochMilliseconds: Schema.Number,
                  }),
                  row,
                ).pipe(
                  Effect.map((decision) => ({
                    ...decision,
                    identityKnown: decision.identityKnown === 1,
                  })),
                  Effect.mapError(() => new RegistrationAuditError()),
                ),
          ),
        ),
      record: (decision) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () =>
              database
                .prepare(
                  `INSERT INTO registration_policy_decisions
          (decision_id, intent, mode, identity_known, outcome, reason, decided_at_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET decision_id = excluded.decision_id
         WHERE intent = excluded.intent AND mode = excluded.mode
           AND identity_known = excluded.identity_known AND outcome = excluded.outcome
           AND reason = excluded.reason`,
                )
                .bind(
                  decision.decisionId,
                  decision.intent,
                  decision.mode,
                  decision.identityKnown ? 1 : 0,
                  decision.outcome,
                  decision.reason,
                  decision.decidedAtEpochMilliseconds,
                )
                .run(),
            catch: () => new RegistrationAuditError(),
          })
          if ((result.meta?.changes ?? 0) !== 1) return yield* new RegistrationAuditError()
        }),
    }),
  )
  return Layer.mergeAll(policyRepository, clock, audit)
}

import { Context, Effect, Layer, Schema } from 'effect'
import type { AuditRequestContext } from '@gridora/audit-contracts'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  IdempotencyKey,
  IsoDateTime,
  type OrganizationContext,
  OrganizationId,
} from '@gridora/domain'

const name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/),
)
const clientId = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
)
const fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

/**
 * These scopes are deliberately small. There is no wildcard, organization
 * administration, identity management, policy management, or destructive
 * deletion scope for an automation credential.
 */
export const AutomationScope = Schema.Literals([
  'inventory.read',
  'servers.read',
  'servers.manage',
  'nodes.read',
  'backups.read',
  'backups.manage',
  'logs.read',
  'operations.read',
])
export type AutomationScope = typeof AutomationScope.Type

export const AutomationCapability = Schema.Literals([
  'inventory.read',
  'servers.read',
  'servers.manage',
  'nodes.read',
  'backups.read',
  'backups.create',
  'backups.restore',
  'logs.read',
  'operations.read',
])
export type AutomationCapability = typeof AutomationCapability.Type

const capabilityMap: Readonly<Record<AutomationScope, ReadonlyArray<AutomationCapability>>> = {
  'inventory.read': ['inventory.read'],
  'servers.read': ['servers.read'],
  'servers.manage': ['servers.manage'],
  'nodes.read': ['nodes.read'],
  'backups.read': ['backups.read'],
  'backups.manage': ['backups.create', 'backups.restore'],
  'logs.read': ['logs.read'],
  'operations.read': ['operations.read'],
}

export const automationCapabilitiesForScopes = (
  scopes: ReadonlyArray<AutomationScope>,
): ReadonlyArray<AutomationCapability> =>
  [...new Set(scopes.flatMap((scope) => capabilityMap[scope]))].sort((left, right) =>
    left.localeCompare(right),
  )

export const AutomationIdentityStatus = Schema.Literals(['active', 'revoked'])
export type AutomationIdentityStatus = typeof AutomationIdentityStatus.Type

/** This is always redacted. It never contains a credential or a verifier. */
export const AutomationIdentity = Schema.Struct({
  organizationId: OrganizationId,
  id: AutomationIdentityId,
  name,
  clientId,
  scopes: Schema.Array(AutomationScope),
  capabilities: Schema.Array(AutomationCapability),
  status: AutomationIdentityStatus,
  expiresAt: Schema.NullOr(IsoDateTime),
  credentialVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  lastUsedAt: Schema.NullOr(IsoDateTime),
  createdBy: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
  revision: positiveInteger,
})
export type AutomationIdentity = typeof AutomationIdentity.Type

export const CreateAutomationIdentityInput = Schema.Struct({
  name,
  scopes: Schema.Array(AutomationScope),
  expiresAt: IsoDateTime,
})
export type CreateAutomationIdentityInput = typeof CreateAutomationIdentityInput.Type

export const RotateAutomationIdentityInput = Schema.Struct({
  expiresAt: IsoDateTime,
})
export type RotateAutomationIdentityInput = typeof RotateAutomationIdentityInput.Type

export class AutomationIdentityValidationError extends Schema.TaggedError<AutomationIdentityValidationError>()(
  'AutomationIdentityValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class AutomationIdentityAuthorizationError extends Schema.TaggedError<AutomationIdentityAuthorizationError>()(
  'AutomationIdentityAuthorizationError',
  { code: Schema.Literals(['administrator_required']) },
) {}
export class AutomationIdentityNotFoundError extends Schema.TaggedError<AutomationIdentityNotFoundError>()(
  'AutomationIdentityNotFoundError',
  { automationIdentityId: Schema.String },
) {}
export class AutomationIdentityConflictError extends Schema.TaggedError<AutomationIdentityConflictError>()(
  'AutomationIdentityConflictError',
  {
    code: Schema.Literals([
      'idempotency_payload_mismatch',
      'revision_mismatch',
      'name_taken',
      'identity_revoked',
    ]),
  },
) {}
export class AutomationIdentityPersistenceError extends Schema.TaggedError<AutomationIdentityPersistenceError>()(
  'AutomationIdentityPersistenceError',
  { operation: Schema.String },
) {}

export type AutomationIdentityControlError =
  | AutomationIdentityValidationError
  | AutomationIdentityAuthorizationError
  | AutomationIdentityNotFoundError
  | AutomationIdentityConflictError
  | AutomationIdentityPersistenceError

export type AutomationIdentityMutationAction = 'create' | 'rotate' | 'revoke'

export interface AutomationIdentityReplayQuery {
  readonly context: OrganizationContext
  readonly action: AutomationIdentityMutationAction
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  /** Create has no existing aggregate. Rotate and revoke bind this exact aggregate. */
  readonly automationIdentityId: AutomationIdentityId | null
}

export interface AutomationIdentityMutationResult {
  readonly identity: AutomationIdentity
  readonly replayed: boolean
}

export interface CreateAutomationIdentityRecord {
  readonly context: OrganizationContext
  /** Optional Access membership revision. D1 fences it again at commit time. */
  readonly actorMembershipRevision?: number
  readonly automationIdentityId: AutomationIdentityId
  readonly credentialId: AutomationCredentialId
  readonly clientId: string
  readonly credentialHash: string
  readonly name: string
  readonly scopes: ReadonlyArray<AutomationScope>
  readonly expiresAt: typeof IsoDateTime.Type
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly operationId: string
  readonly auditEventId: string
  readonly outboxEventId: string
  readonly now: typeof IsoDateTime.Type
}

export interface RotateAutomationIdentityRecord {
  readonly context: OrganizationContext
  /** Optional Access membership revision. D1 fences it again at commit time. */
  readonly actorMembershipRevision?: number
  readonly automationIdentityId: AutomationIdentityId
  readonly credentialId: AutomationCredentialId
  readonly credentialHash: string
  readonly expectedRevision: number
  readonly expiresAt: typeof IsoDateTime.Type
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly operationId: string
  readonly auditEventId: string
  readonly outboxEventId: string
  readonly now: typeof IsoDateTime.Type
}

export interface RevokeAutomationIdentityRecord {
  readonly context: OrganizationContext
  /** Optional Access membership revision. D1 fences it again at commit time. */
  readonly actorMembershipRevision?: number
  readonly automationIdentityId: AutomationIdentityId
  readonly expectedRevision: number
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly operationId: string
  readonly auditEventId: string
  readonly outboxEventId: string
  readonly now: typeof IsoDateTime.Type
}

export interface AutomationIdentityRepositoryShape {
  readonly get: (
    context: OrganizationContext,
    automationIdentityId: AutomationIdentityId,
  ) => Effect.Effect<
    AutomationIdentity,
    AutomationIdentityNotFoundError | AutomationIdentityPersistenceError
  >
  readonly findReplay: (
    input: AutomationIdentityReplayQuery,
  ) => Effect.Effect<AutomationIdentityMutationResult | null, AutomationIdentityControlError>
  readonly create: (
    input: CreateAutomationIdentityRecord,
  ) => Effect.Effect<
    AutomationIdentityMutationResult,
    AutomationIdentityControlError,
    AuditRequestContext
  >
  readonly rotate: (
    input: RotateAutomationIdentityRecord,
  ) => Effect.Effect<
    AutomationIdentityMutationResult,
    AutomationIdentityControlError,
    AuditRequestContext
  >
  readonly revoke: (
    input: RevokeAutomationIdentityRecord,
  ) => Effect.Effect<
    AutomationIdentityMutationResult,
    AutomationIdentityControlError,
    AuditRequestContext
  >
  readonly list: (
    context: OrganizationContext,
  ) => Effect.Effect<ReadonlyArray<AutomationIdentity>, AutomationIdentityPersistenceError>
}
export class AutomationIdentityRepository extends Context.Service<
  AutomationIdentityRepository,
  AutomationIdentityRepositoryShape
>()('@gridora/automation-identity-control/AutomationIdentityRepository') {}
export const AutomationIdentityRepositoryLayer = (repository: AutomationIdentityRepositoryShape) =>
  Layer.succeed(AutomationIdentityRepository, repository)

export interface AutomationIdentityClockShape {
  readonly now: Effect.Effect<typeof IsoDateTime.Type, AutomationIdentityPersistenceError>
}
export class AutomationIdentityClock extends Context.Service<
  AutomationIdentityClock,
  AutomationIdentityClockShape
>()('@gridora/automation-identity-control/AutomationIdentityClock') {}
export const AutomationIdentityClockLayer = (clock: AutomationIdentityClockShape) =>
  Layer.succeed(AutomationIdentityClock, clock)

export interface AutomationIdentityIdGeneratorShape {
  readonly automationIdentityId: Effect.Effect<
    AutomationIdentityId,
    AutomationIdentityPersistenceError
  >
  readonly credentialId: Effect.Effect<AutomationCredentialId, AutomationIdentityPersistenceError>
  readonly clientId: Effect.Effect<string, AutomationIdentityPersistenceError>
  readonly operationId: Effect.Effect<string, AutomationIdentityPersistenceError>
  readonly auditEventId: Effect.Effect<string, AutomationIdentityPersistenceError>
  readonly outboxEventId: Effect.Effect<string, AutomationIdentityPersistenceError>
}
export class AutomationIdentityIdGenerator extends Context.Service<
  AutomationIdentityIdGenerator,
  AutomationIdentityIdGeneratorShape
>()('@gridora/automation-identity-control/AutomationIdentityIdGenerator') {}
export const AutomationIdentityIdGeneratorLayer = (ids: AutomationIdentityIdGeneratorShape) =>
  Layer.succeed(AutomationIdentityIdGenerator, ids)

export interface AutomationCredentialIssue {
  /** Returned only to the successful first create or rotate response. */
  readonly credential: string
  /** A fixed-length verifier suitable for persistence. */
  readonly credentialHash: string
}
export interface AutomationCredentialIssuerShape {
  readonly issue: (input: {
    readonly clientId: string
    readonly credentialId: AutomationCredentialId
  }) => Effect.Effect<AutomationCredentialIssue, AutomationIdentityPersistenceError>
}
export class AutomationCredentialIssuer extends Context.Service<
  AutomationCredentialIssuer,
  AutomationCredentialIssuerShape
>()('@gridora/automation-identity-control/AutomationCredentialIssuer') {}
export const AutomationCredentialIssuerLayer = (issuer: AutomationCredentialIssuerShape) =>
  Layer.succeed(AutomationCredentialIssuer, issuer)

const maxCredentialLifetimeMilliseconds = 366 * 24 * 60 * 60 * 1000

const parseTimestamp = (value: string): number | undefined => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const validateScopes = (scopes: ReadonlyArray<AutomationScope>) => {
  if (scopes.length < 1 || scopes.length > 8 || new Set(scopes).size !== scopes.length)
    return new AutomationIdentityValidationError({
      code: 'invalid_scopes',
      message: 'Automation scopes must be a non-empty unique bounded set',
    })
  return undefined
}

const validateExpiry = (expiresAt: string, now: string) => {
  const expires = parseTimestamp(expiresAt)
  const current = parseTimestamp(now)
  if (
    expires === undefined ||
    current === undefined ||
    expires <= current ||
    expires - current > maxCredentialLifetimeMilliseconds
  )
    return new AutomationIdentityValidationError({
      code: 'invalid_expiry',
      message: 'Automation credential expiry must be in the next 366 days',
    })
  return undefined
}

const requireHumanAdministrator = (context: OrganizationContext) =>
  context.role === 'owner' || context.role === 'administrator'
    ? Effect.void
    : Effect.fail(new AutomationIdentityAuthorizationError({ code: 'administrator_required' }))

const decodeCreate = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateAutomationIdentityInput, { onExcessProperty: 'error' })(
    value,
  ).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_create',
          message: 'The automation identity create request is invalid',
        }),
    ),
  )
const decodeRotate = (value: unknown) =>
  Schema.decodeUnknownEffect(RotateAutomationIdentityInput, { onExcessProperty: 'error' })(
    value,
  ).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_rotate',
          message: 'The automation identity rotate request is invalid',
        }),
    ),
  )
const decodeIdempotencyKey = (value: string) =>
  Schema.decodeUnknownEffect(IdempotencyKey)(value).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key is invalid',
        }),
    ),
  )
const decodeFingerprint = (value: string) =>
  Schema.decodeUnknownEffect(fingerprint)(value).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_request_fingerprint',
          message: 'The request fingerprint is invalid',
        }),
    ),
  )
const decodeRevision = (value: number) =>
  Schema.decodeUnknownEffect(positiveInteger)(value).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_revision',
          message: 'The expected revision is invalid',
        }),
    ),
  )
const decodeOptionalActorMembershipRevision = (value: number | undefined) =>
  value === undefined ? Effect.succeed(undefined) : decodeRevision(value)
const decodeIdentityId = (value: string) =>
  Schema.decodeUnknownEffect(AutomationIdentityId)(value).pipe(
    Effect.mapError(
      () =>
        new AutomationIdentityValidationError({
          code: 'invalid_identity_id',
          message: 'The automation identity id is invalid',
        }),
    ),
  )

export interface CreateAutomationIdentityCommand {
  readonly input: unknown
  readonly idempotencyKey: string
  /** SHA-256 over the canonical, secret-free route request. */
  readonly requestFingerprint: string
  /** Carry the verified membership revision when the Access adapter has it. */
  readonly actorMembershipRevision?: number
}
export interface RotateAutomationIdentityCommand {
  readonly automationIdentityId: string
  readonly expectedRevision: number
  readonly input: unknown
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  /** Carry the verified membership revision when the Access adapter has it. */
  readonly actorMembershipRevision?: number
}
export interface RevokeAutomationIdentityCommand {
  readonly automationIdentityId: string
  readonly expectedRevision: number
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  /** Carry the verified membership revision when the Access adapter has it. */
  readonly actorMembershipRevision?: number
}

export interface AutomationIdentitySecretResponse {
  readonly identity: AutomationIdentity
  readonly replayed: boolean
  /** Omitted on every replay, list, revoke, and later read. */
  readonly credential?: string
}

export interface AutomationIdentityControlShape {
  readonly create: (
    context: OrganizationContext,
    command: CreateAutomationIdentityCommand,
  ) => Effect.Effect<
    AutomationIdentitySecretResponse,
    AutomationIdentityControlError,
    AuditRequestContext
  >
  readonly list: (
    context: OrganizationContext,
  ) => Effect.Effect<ReadonlyArray<AutomationIdentity>, AutomationIdentityControlError>
  readonly rotate: (
    context: OrganizationContext,
    command: RotateAutomationIdentityCommand,
  ) => Effect.Effect<
    AutomationIdentitySecretResponse,
    AutomationIdentityControlError,
    AuditRequestContext
  >
  readonly revoke: (
    context: OrganizationContext,
    command: RevokeAutomationIdentityCommand,
  ) => Effect.Effect<
    AutomationIdentityMutationResult,
    AutomationIdentityControlError,
    AuditRequestContext
  >
}
export class AutomationIdentityControl extends Context.Service<
  AutomationIdentityControl,
  AutomationIdentityControlShape
>()('@gridora/automation-identity-control/AutomationIdentityControl') {}

export const AutomationIdentityControlLive = Layer.effect(
  AutomationIdentityControl,
  Effect.gen(function* () {
    const repository = yield* AutomationIdentityRepository
    const clock = yield* AutomationIdentityClock
    const ids = yield* AutomationIdentityIdGenerator
    const issuer = yield* AutomationCredentialIssuer

    const requestParts = (input: {
      readonly context: OrganizationContext
      readonly action: AutomationIdentityMutationAction
      readonly idempotencyKey: string
      readonly requestFingerprint: string
      readonly automationIdentityId: AutomationIdentityId | null
    }) =>
      Effect.all({
        idempotencyKey: decodeIdempotencyKey(input.idempotencyKey),
        requestFingerprint: decodeFingerprint(input.requestFingerprint),
      }).pipe(Effect.map((parts) => ({ ...input, ...parts })))

    const replay = (input: Parameters<AutomationIdentityRepositoryShape['findReplay']>[0]) =>
      repository.findReplay(input)

    return AutomationIdentityControl.of({
      create: (context, command) =>
        Effect.gen(function* () {
          yield* requireHumanAdministrator(context)
          const input = yield* decodeCreate(command.input)
          const scopesError = validateScopes(input.scopes)
          if (scopesError !== undefined) return yield* scopesError
          const actorMembershipRevision = yield* decodeOptionalActorMembershipRevision(
            command.actorMembershipRevision,
          )
          const request = yield* requestParts({
            context,
            action: 'create',
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            automationIdentityId: null,
          })
          const existing = yield* replay(request)
          if (existing !== null) return { identity: existing.identity, replayed: true }
          const now = yield* clock.now
          const expiryError = validateExpiry(input.expiresAt, now)
          if (expiryError !== undefined) return yield* expiryError
          const identityId = yield* ids.automationIdentityId
          const credentialId = yield* ids.credentialId
          const issuedClientId = yield* ids.clientId
          const issued = yield* issuer.issue({ clientId: issuedClientId, credentialId })
          const result = yield* repository.create({
            context,
            ...(actorMembershipRevision === undefined ? {} : { actorMembershipRevision }),
            automationIdentityId: identityId,
            credentialId,
            clientId: issuedClientId,
            credentialHash: issued.credentialHash,
            name: input.name,
            scopes: [...input.scopes].sort((left, right) => left.localeCompare(right)),
            expiresAt: input.expiresAt,
            idempotencyKey: request.idempotencyKey,
            requestFingerprint: request.requestFingerprint,
            operationId: yield* ids.operationId,
            auditEventId: yield* ids.auditEventId,
            outboxEventId: yield* ids.outboxEventId,
            now,
          })
          return result.replayed
            ? { identity: result.identity, replayed: true }
            : { identity: result.identity, replayed: false, credential: issued.credential }
        }),
      list: (context) =>
        Effect.gen(function* () {
          yield* requireHumanAdministrator(context)
          return yield* repository.list(context)
        }),
      rotate: (context, command) =>
        Effect.gen(function* () {
          yield* requireHumanAdministrator(context)
          const automationIdentityId = yield* decodeIdentityId(command.automationIdentityId)
          const input = yield* decodeRotate(command.input)
          const expectedRevision = yield* decodeRevision(command.expectedRevision)
          const actorMembershipRevision = yield* decodeOptionalActorMembershipRevision(
            command.actorMembershipRevision,
          )
          const request = yield* requestParts({
            context,
            action: 'rotate',
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            automationIdentityId,
          })
          const existing = yield* replay(request)
          if (existing !== null) return { identity: existing.identity, replayed: true }
          const now = yield* clock.now
          const expiryError = validateExpiry(input.expiresAt, now)
          if (expiryError !== undefined) return yield* expiryError
          const credentialId = yield* ids.credentialId
          const current = yield* repository.get(context, automationIdentityId)
          if (current.status !== 'active')
            return yield* new AutomationIdentityConflictError({ code: 'identity_revoked' })
          const issued = yield* issuer.issue({ clientId: current.clientId, credentialId })
          const result = yield* repository.rotate({
            context,
            ...(actorMembershipRevision === undefined ? {} : { actorMembershipRevision }),
            automationIdentityId,
            credentialId,
            credentialHash: issued.credentialHash,
            expectedRevision,
            expiresAt: input.expiresAt,
            idempotencyKey: request.idempotencyKey,
            requestFingerprint: request.requestFingerprint,
            operationId: yield* ids.operationId,
            auditEventId: yield* ids.auditEventId,
            outboxEventId: yield* ids.outboxEventId,
            now,
          })
          if (result.replayed) return { identity: result.identity, replayed: true }
          return { identity: result.identity, replayed: false, credential: issued.credential }
        }),
      revoke: (context, command) =>
        Effect.gen(function* () {
          yield* requireHumanAdministrator(context)
          const automationIdentityId = yield* decodeIdentityId(command.automationIdentityId)
          const expectedRevision = yield* decodeRevision(command.expectedRevision)
          const actorMembershipRevision = yield* decodeOptionalActorMembershipRevision(
            command.actorMembershipRevision,
          )
          const request = yield* requestParts({
            context,
            action: 'revoke',
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            automationIdentityId,
          })
          const existing = yield* replay(request)
          if (existing !== null) return existing
          return yield* repository.revoke({
            context,
            ...(actorMembershipRevision === undefined ? {} : { actorMembershipRevision }),
            automationIdentityId,
            expectedRevision,
            idempotencyKey: request.idempotencyKey,
            requestFingerprint: request.requestFingerprint,
            operationId: yield* ids.operationId,
            auditEventId: yield* ids.auditEventId,
            outboxEventId: yield* ids.outboxEventId,
            now: yield* clock.now,
          })
        }),
    })
  }),
)

const generated = <A>(
  prefix: string,
  schema: Schema.Codec<A, unknown, never, never>,
  operation: string,
): Effect.Effect<A, AutomationIdentityPersistenceError> =>
  Effect.sync(() => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => new AutomationIdentityPersistenceError({ operation })),
  )

/** Worker-native ID source. It contains no credential material. */
export const WebCryptoAutomationIdentityIdGenerator: AutomationIdentityIdGeneratorShape = {
  automationIdentityId: generated(
    'automation_identity_',
    AutomationIdentityId,
    'automationIdentity.id',
  ),
  credentialId: generated(
    'automation_credential_',
    AutomationCredentialId,
    'automationIdentity.credentialId',
  ),
  clientId: generated('automation_client_', clientId, 'automationIdentity.clientId'),
  operationId: generated(
    'automation_identity_operation_',
    Schema.String,
    'automationIdentity.operationId',
  ),
  auditEventId: generated(
    'audit_automation_identity_',
    Schema.String,
    'automationIdentity.auditEventId',
  ),
  outboxEventId: generated(
    'outbox_automation_identity_',
    Schema.String,
    'automationIdentity.outboxEventId',
  ),
}

import { Context, Effect } from 'effect'
import type {
  CreateOrganizationResult,
  Operation,
  OperationDetail,
  OutboxEvent,
  PersistenceError,
  ProviderAccountMetadata,
  RepositoryError,
} from '@gridora/contracts'
import type { SecretEnvelopeRecord } from '@gridora/secret-envelope'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import type { OrganizationPolicyV1 } from '@gridora/policy-control'
import type {
  EmailAddress,
  IdempotencyKey,
  Identity,
  IdentityId,
  InvitationId,
  InvitationRole,
  IsoDateTime,
  OperationId,
  Organization,
  OrganizationContext,
  OrganizationId,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationRole,
  OrganizationSlug,
  OutboxEventId,
} from '@gridora/domain'

export interface NewIdentityRecord {
  readonly id: IdentityId
  readonly accessSubject: string
  readonly email: EmailAddress
  readonly displayName: string
  readonly now: IsoDateTime
  readonly mutation: CoreMutationFacts
}

/** Immutable facts that bind one human core mutation to its durable operation. */
export interface CoreMutationFacts {
  readonly operationId: OperationId
  /** Raw client key. It is unique only inside actor + action scope. */
  readonly idempotencyKey: IdempotencyKey
  /** Secret-free SHA-256 of actor, action, route, target, and canonical payload. */
  readonly requestFingerprint: string
  /** SHA-256 scoped key stored in the historical tenant operations table. */
  readonly operationIdempotencyKey: IdempotencyKey
  readonly action: string
  readonly resourceType: string
  readonly resourceId: string
  readonly request: AuditRequestContextValue
  readonly now: IsoDateTime
}

export interface CoreMutationResult<A> {
  readonly operationId: OperationId
  readonly resourceId: string
  readonly value: A
  readonly replayed: boolean
}

export interface CoreMutationReplayReceipt {
  readonly organizationId: OrganizationId
  readonly operationId: OperationId
  readonly resourceId: string
  readonly requestFingerprint: string
}

export interface NewOrganizationRecord {
  readonly id: OrganizationId
  readonly ownerIdentityId: IdentityId
  readonly name: string
  readonly slug: OrganizationSlug
  readonly timezone: string
  readonly defaultRegion: string
  readonly termsVersion: string
  /** Strict revision-1 policy constructed by the organization service. */
  readonly initialPolicy: OrganizationPolicyV1
  readonly idempotencyKey: IdempotencyKey
  readonly now: IsoDateTime
  readonly outboxEventId: OutboxEventId
  readonly operationId: OperationId
  readonly operationIdempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly request: AuditRequestContextValue
  readonly initialInvitations: ReadonlyArray<{
    readonly id: InvitationId
    readonly email: EmailAddress
    readonly role: InvitationRole
    readonly tokenHash: string
    readonly tokenScope: string
    readonly tokenKeyVersion: string
    readonly expiresAt: IsoDateTime
    readonly outboxEventId: OutboxEventId
  }>
}

export interface NewInvitationRecord {
  readonly id: InvitationId
  readonly organizationId: OrganizationId
  readonly email: EmailAddress
  readonly role: InvitationRole
  readonly tokenHash: string
  readonly tokenScope: string
  readonly tokenKeyVersion: string
  readonly expiresAt: IsoDateTime
  readonly inviterId: IdentityId
  readonly idempotencyKey: IdempotencyKey
  readonly now: IsoDateTime
  readonly outboxEventId: OutboxEventId
}

export interface ResendInvitationRecord {
  readonly tokenHash: string
  readonly tokenScope: string
  readonly tokenKeyVersion: string
  readonly expiresAt: IsoDateTime
  readonly now: IsoDateTime
}

export interface AcceptInvitationWithIdentityRecord {
  readonly tokenHash: string
  readonly identityId: IdentityId
  readonly accessSubject: string
  readonly email: EmailAddress
  readonly displayName: string
  readonly now: IsoDateTime
  readonly outboxEventId: OutboxEventId
  readonly tenantOperationId: OperationId
  readonly platformOperationId: OperationId
  readonly idempotencyKey: IdempotencyKey
  readonly tenantOperationIdempotencyKey: IdempotencyKey
  readonly platformOperationIdempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly request: AuditRequestContextValue
}

export interface AcceptedInvitationWithIdentity {
  readonly identity: Identity
  readonly membership: OrganizationMembership
  readonly replayed: boolean
}

export interface IdentityRepositoryShape {
  readonly findById: (identityId: IdentityId) => Effect.Effect<Identity, RepositoryError>
  readonly findByAccessSubject: (
    accessSubject: string,
  ) => Effect.Effect<Identity | null, PersistenceError>
  readonly createOrGet: (record: NewIdentityRecord) => Effect.Effect<Identity, RepositoryError>
  readonly touchLastLogin: (
    identityId: IdentityId,
    mutation: CoreMutationFacts,
  ) => Effect.Effect<Identity, RepositoryError>
}
export class IdentityRepository extends Context.Service<
  IdentityRepository,
  IdentityRepositoryShape
>()('@gridora/db-contracts/IdentityRepository') {}

export interface OrganizationRepositoryShape {
  readonly getById: (organizationId: OrganizationId) => Effect.Effect<Organization, RepositoryError>
  readonly getBySlug: (slug: OrganizationSlug) => Effect.Effect<Organization, RepositoryError>
  readonly getForContext: (
    context: OrganizationContext,
  ) => Effect.Effect<Organization, RepositoryError>
  readonly updateProfile: (
    context: OrganizationContext,
    input: { readonly name: string; readonly timezone: string; readonly defaultRegion: string },
    expectedRevision: number,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<Organization>, RepositoryError>
  readonly recordSwitch: (
    context: OrganizationContext,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<Organization>, RepositoryError>
}
export class OrganizationRepository extends Context.Service<
  OrganizationRepository,
  OrganizationRepositoryShape
>()('@gridora/db-contracts/OrganizationRepository') {}

export interface OrganizationMembershipRepositoryShape {
  readonly get: (
    organizationId: OrganizationId,
    identityId: IdentityId,
  ) => Effect.Effect<OrganizationMembership, RepositoryError>
  readonly listForIdentity: (
    identityId: IdentityId,
  ) => Effect.Effect<ReadonlyArray<OrganizationMembership>, PersistenceError>
  readonly listForOrganization: (
    context: OrganizationContext,
  ) => Effect.Effect<ReadonlyArray<OrganizationMembership>, PersistenceError>
  readonly countActiveOwners: (
    organizationId: OrganizationId,
  ) => Effect.Effect<number, PersistenceError>
  readonly updateRole: (
    context: OrganizationContext,
    identityId: IdentityId,
    role: OrganizationRole,
    expectedRevision: number,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<OrganizationMembership>, RepositoryError>
  readonly remove: (
    context: OrganizationContext,
    identityId: IdentityId,
    expectedRevision: number,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<null>, RepositoryError>
  readonly leave: (
    context: OrganizationContext,
    expectedRevision: number,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<null>, RepositoryError>
  readonly hasLeaveReceipt: (
    organizationReference: string,
    identityId: IdentityId,
    expectedRevision: number,
  ) => Effect.Effect<boolean, PersistenceError>
  readonly findLeaveMutationReplay?: (
    organizationReference: string,
    identityId: IdentityId,
    idempotencyKey: IdempotencyKey,
  ) => Effect.Effect<CoreMutationReplayReceipt | null, PersistenceError>
}
export class OrganizationMembershipRepository extends Context.Service<
  OrganizationMembershipRepository,
  OrganizationMembershipRepositoryShape
>()('@gridora/db-contracts/OrganizationMembershipRepository') {}

export interface OrganizationInvitationRepositoryShape {
  readonly create: (
    context: OrganizationContext,
    record: NewInvitationRecord,
    mutation: CoreMutationFacts,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, RepositoryError>
  readonly list: (
    context: OrganizationContext,
  ) => Effect.Effect<ReadonlyArray<OrganizationInvitation>, PersistenceError>
  readonly get: (
    context: OrganizationContext,
    invitationId: InvitationId,
  ) => Effect.Effect<OrganizationInvitation, RepositoryError>
  readonly findByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<OrganizationInvitation, RepositoryError>
  readonly revoke: (
    context: OrganizationContext,
    invitationId: InvitationId,
    expectedRevision: number,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, RepositoryError>
  readonly resend: (
    context: OrganizationContext,
    invitationId: InvitationId,
    expectedRevision: number,
    record: ResendInvitationRecord,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, RepositoryError>
  readonly expirePending: (
    now: IsoDateTime,
    limit: number,
  ) => Effect.Effect<number, PersistenceError>
}
export class OrganizationInvitationRepository extends Context.Service<
  OrganizationInvitationRepository,
  OrganizationInvitationRepositoryShape
>()('@gridora/db-contracts/OrganizationInvitationRepository') {}

export interface OrganizationUnitOfWorkShape {
  readonly createOrganizationWithOwner: (
    record: NewOrganizationRecord,
  ) => Effect.Effect<CreateOrganizationResult, RepositoryError>
  readonly acceptInvitation: (
    context: Pick<OrganizationContext, 'organizationId' | 'identityId' | 'role'>,
    invitation: OrganizationInvitation,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<OrganizationMembership>, RepositoryError>
  readonly acceptInvitationWithIdentity: (
    record: AcceptInvitationWithIdentityRecord,
  ) => Effect.Effect<AcceptedInvitationWithIdentity, RepositoryError>
  readonly transferOwnership: (
    context: OrganizationContext,
    targetIdentityId: IdentityId,
    mutation: CoreMutationFacts,
    outboxEventId: OutboxEventId,
  ) => Effect.Effect<CoreMutationResult<null>, RepositoryError>
}
export class OrganizationUnitOfWork extends Context.Service<
  OrganizationUnitOfWork,
  OrganizationUnitOfWorkShape
>()('@gridora/db-contracts/OrganizationUnitOfWork') {}

export interface AgentCredentialPrincipal {
  readonly organizationId: OrganizationId
  readonly nodeId: string
  readonly credentialId: string
  readonly version: number
  readonly sessionVersion: number
}

export interface ExchangeAgentRegistration {
  readonly tokenHash: string
  readonly organizationId: OrganizationId
  readonly nodeId: string
  readonly providerInstanceId: string
  readonly credentialId: string
  readonly credentialHash: string
  readonly agentVersion: string
  /** RSA-OAEP SPKI public key for the node's root-only credential installer. */
  readonly installerPublicKey: string
  readonly installerPublicKeyFingerprint: string
  readonly now: IsoDateTime
}

export interface RotateAgentCredential {
  readonly principal: AgentCredentialPrincipal
  readonly newCredentialId: string
  readonly newCredentialHash: string
  readonly now: IsoDateTime
}

export interface AgentRegistrationRepositoryShape {
  readonly exchange: (
    registration: ExchangeAgentRegistration,
  ) => Effect.Effect<AgentCredentialPrincipal, RepositoryError>
  readonly authenticate: (
    credentialHash: string,
    now: IsoDateTime,
  ) => Effect.Effect<AgentCredentialPrincipal, RepositoryError>
  readonly revokeRegistrationToken: (
    principal: AgentCredentialPrincipal,
    tokenHash: string,
    now: IsoDateTime,
  ) => Effect.Effect<void, RepositoryError>
  readonly rotate: (
    rotation: RotateAgentCredential,
  ) => Effect.Effect<AgentCredentialPrincipal, RepositoryError>
  readonly revoke: (
    principal: AgentCredentialPrincipal,
    now: IsoDateTime,
  ) => Effect.Effect<void, RepositoryError>
}
export class AgentRegistrationRepository extends Context.Service<
  AgentRegistrationRepository,
  AgentRegistrationRepositoryShape
>()('@gridora/db-contracts/AgentRegistrationRepository') {}

export interface CreateProviderAccountRecord {
  readonly account: ProviderAccountMetadata
  readonly credentialEnvelope: SecretEnvelopeRecord
  readonly idempotencyKey: IdempotencyKey
  /** SHA-256 key scoped to the authenticated actor, action, and resource. */
  readonly operationIdempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly auditRequestContext: AuditRequestContextValue
}
export interface UpdateProviderAccountRecord {
  readonly accountId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly expectedRevision: number
  readonly expectedCredentialRevision: number
  readonly credentialEnvelope: SecretEnvelopeRecord
  readonly idempotencyKey: IdempotencyKey
  /** SHA-256 key scoped to the authenticated actor, action, and resource. */
  readonly operationIdempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly auditRequestContext: AuditRequestContextValue
  readonly now: IsoDateTime
}
export interface ProviderAccountRepositoryShape {
  readonly findMutationReplay: (
    context: OrganizationContext,
    idempotencyKey: IdempotencyKey,
    requestFingerprint: string,
    action: 'create' | 'update-credentials',
  ) => Effect.Effect<ProviderAccountMetadata | null, RepositoryError>
  readonly create: (
    context: OrganizationContext,
    record: CreateProviderAccountRecord,
  ) => Effect.Effect<ProviderAccountMetadata, RepositoryError>
  readonly updateCredentials: (
    context: OrganizationContext,
    record: UpdateProviderAccountRecord,
  ) => Effect.Effect<ProviderAccountMetadata, RepositoryError>
  readonly getCredentialEnvelope: (
    context: OrganizationContext,
    accountId: string,
  ) => Effect.Effect<SecretEnvelopeRecord, RepositoryError>
}
export class ProviderAccountRepository extends Context.Service<
  ProviderAccountRepository,
  ProviderAccountRepositoryShape
>()('@gridora/db-contracts/ProviderAccountRepository') {}

export interface OperationRepositoryShape {
  readonly createWithOutboxOrGet: (
    operation: Operation,
    event: OutboxEvent,
  ) => Effect.Effect<Operation, RepositoryError>
  readonly get: (
    context: OrganizationContext,
    operationId: OperationId,
  ) => Effect.Effect<Operation, RepositoryError>
  readonly updateStatus: (
    context: OrganizationContext,
    operationId: OperationId,
    status: Operation['status'],
    progress: number,
    expectedRevision: number,
    now: IsoDateTime,
  ) => Effect.Effect<Operation, RepositoryError>
}
export class OperationRepository extends Context.Service<
  OperationRepository,
  OperationRepositoryShape
>()('@gridora/db-contracts/OperationRepository') {}

export interface OperationDetailRepositoryShape {
  readonly get: (
    context: OrganizationContext,
    operationId: OperationId,
  ) => Effect.Effect<OperationDetail, RepositoryError>
}
export class OperationDetailRepository extends Context.Service<
  OperationDetailRepository,
  OperationDetailRepositoryShape
>()('@gridora/db-contracts/OperationDetailRepository') {}

export interface OutboxRepositoryShape {
  readonly claimPending: (
    workerId: string,
    leaseToken: string,
    limit: number,
    now: IsoDateTime,
    leaseUntil: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<OutboxEvent>, PersistenceError>
  readonly listPending: (
    limit: number,
    now: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<OutboxEvent>, PersistenceError>
  readonly markDelivered: (
    eventId: OutboxEventId,
    workerId: string,
    leaseToken: string,
    deliveredAt: IsoDateTime,
  ) => Effect.Effect<void, RepositoryError>
  readonly markFailed: (
    eventId: OutboxEventId,
    workerId: string,
    leaseToken: string,
    availableAt: IsoDateTime,
  ) => Effect.Effect<void, RepositoryError>
  readonly markTerminalFailed: (
    eventId: OutboxEventId,
    workerId: string,
    leaseToken: string,
  ) => Effect.Effect<void, RepositoryError>
}
export class OutboxRepository extends Context.Service<OutboxRepository, OutboxRepositoryShape>()(
  '@gridora/db-contracts/OutboxRepository',
) {}

export interface AuditRecord {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly actorId: IdentityId
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly result: 'succeeded' | 'denied' | 'failed'
  readonly correlationId: string
  readonly summary: string
  readonly createdAt: IsoDateTime
}
export interface AuditRepositoryShape {
  readonly append: (
    context: OrganizationContext,
    record: AuditRecord,
  ) => Effect.Effect<void, PersistenceError>
}
export class AuditRepository extends Context.Service<AuditRepository, AuditRepositoryShape>()(
  '@gridora/db-contracts/AuditRepository',
) {}

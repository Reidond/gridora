import { Schema } from 'effect'
import {
  CorrelationId,
  EmailAddress,
  IdempotencyKey,
  Identity,
  IdentityId,
  InvitationId,
  InvitationRole,
  IsoDateTime,
  OperationId,
  Organization,
  OrganizationId,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationRole,
  OrganizationSlug,
  OutboxEventId,
} from '@gridora/domain'

export class NotFoundError extends Schema.TaggedError<NotFoundError>()('NotFoundError', {
  resource: Schema.String,
  id: Schema.String,
}) {}
export class ConflictError extends Schema.TaggedError<ConflictError>()('ConflictError', {
  code: Schema.String,
  message: Schema.String,
}) {}
export class AuthorizationError extends Schema.TaggedError<AuthorizationError>()(
  'AuthorizationError',
  {
    code: Schema.Literals([
      'membership_required',
      'role_required',
      'identity_suspended',
      'organization_suspended',
    ]),
    message: Schema.String,
  },
) {}
export class PersistenceError extends Schema.TaggedError<PersistenceError>()('PersistenceError', {
  operation: Schema.String,
  message: Schema.String,
}) {}
export class LastOwnerError extends Schema.TaggedError<LastOwnerError>()('LastOwnerError', {
  organizationId: OrganizationId,
  identityId: IdentityId,
}) {}
export class InvitationError extends Schema.TaggedError<InvitationError>()('InvitationError', {
  code: Schema.Literals(['expired', 'revoked', 'accepted', 'email_mismatch', 'invalid_token']),
  invitationId: Schema.optional(InvitationId),
}) {}
export class RevisionConflictError extends Schema.TaggedError<RevisionConflictError>()(
  'RevisionConflictError',
  {
    resource: Schema.String,
    expected: Schema.Number,
    actual: Schema.Number,
  },
) {}

const providerCredentialText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const providerEndpoint = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/[^\s]+$/),
)
export const OvhPublicCloudCredentials = Schema.Struct({
  authUrl: providerEndpoint,
  region: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  projectId: providerCredentialText,
  applicationCredentialId: providerCredentialText,
  applicationCredentialSecret: providerCredentialText,
})
export const ContaboCredentials = Schema.Struct({
  tokenUrl: providerEndpoint,
  apiBaseUrl: providerEndpoint,
  clientId: providerCredentialText,
  clientSecret: providerCredentialText,
  apiUser: providerCredentialText,
  apiPassword: providerCredentialText,
})
export const CreateProviderAccountInput = Schema.Union([
  Schema.Struct({
    providerType: Schema.Literal('ovhcloud'),
    credentials: OvhPublicCloudCredentials,
  }),
  Schema.Struct({ providerType: Schema.Literal('contabo'), credentials: ContaboCredentials }),
])
export type CreateProviderAccountInput = typeof CreateProviderAccountInput.Type
export const UpdateProviderAccountInput = Schema.Union([
  Schema.Struct({
    providerType: Schema.Literal('ovhcloud'),
    expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    expectedCredentialRevision: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
    ),
    credentials: OvhPublicCloudCredentials,
  }),
  Schema.Struct({
    providerType: Schema.Literal('contabo'),
    expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    expectedCredentialRevision: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
    ),
    credentials: ContaboCredentials,
  }),
])
export type UpdateProviderAccountInput = typeof UpdateProviderAccountInput.Type
export class ProviderAccountMetadata extends Schema.Class<ProviderAccountMetadata>(
  'ProviderAccountMetadata',
)({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  scope: Schema.Literal('organization'),
  organizationId: OrganizationId,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  status: Schema.Literals(['active', 'disabled', 'error']),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  credentialRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export type RepositoryError =
  | NotFoundError
  | ConflictError
  | PersistenceError
  | RevisionConflictError

export class CreateOrganizationInput extends Schema.Class<CreateOrganizationInput>(
  'CreateOrganizationInput',
)({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  slug: OrganizationSlug,
  timezone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  defaultRegion: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  termsAccepted: Schema.Literal(true),
  budgetWarningThresholdMinor: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  budgetWarningCurrency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  initialInvitations: Schema.optional(
    Schema.Array(Schema.Struct({ email: EmailAddress, role: InvitationRole })),
  ),
  idempotencyKey: IdempotencyKey,
}) {}

export class CreateOrganizationResult extends Schema.Class<CreateOrganizationResult>(
  'CreateOrganizationResult',
)({
  organization: Organization,
  membership: OrganizationMembership,
  operationId: OperationId,
  replayed: Schema.Boolean,
}) {}

export class CreateInvitationInput extends Schema.Class<CreateInvitationInput>(
  'CreateInvitationInput',
)({
  email: EmailAddress,
  role: InvitationRole,
  expiresAt: IsoDateTime,
  idempotencyKey: IdempotencyKey,
}) {}

export class UpdateMembershipRoleInput extends Schema.Class<UpdateMembershipRoleInput>(
  'UpdateMembershipRoleInput',
)({
  identityId: IdentityId,
  role: OrganizationRole,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
}) {}

export class UpdateOrganizationProfileInput extends Schema.Class<UpdateOrganizationProfileInput>(
  'UpdateOrganizationProfileInput',
)({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  timezone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  defaultRegion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
}) {}

export class ResendInvitationInput extends Schema.Class<ResendInvitationInput>(
  'ResendInvitationInput',
)({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expiresAt: IsoDateTime,
}) {}

export const PluginManifest = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  game: Schema.String,
  apiVersion: Schema.Literal('gridora.plugin/v1alpha1'),
  version: Schema.String,
  capabilities: Schema.Array(Schema.String),
})
export const PluginList = Schema.Array(PluginManifest)

export const InvitationEmailRemediation = Schema.Struct({
  version: Schema.Literal(1),
  disposition: Schema.Literal('permanent-failure'),
  action: Schema.Literal('reissue-invitation'),
  eventId: Schema.String,
  organizationId: OrganizationId,
  invitationId: InvitationId,
  code: Schema.String,
  eventCreatedAt: IsoDateTime,
})
export type InvitationEmailRemediation = typeof InvitationEmailRemediation.Type
export const InvitationEmailRemediationPage = Schema.Struct({
  items: Schema.Array(InvitationEmailRemediation),
  cursor: Schema.optional(Schema.String),
  truncated: Schema.Boolean,
})

export const OperationStatus = Schema.Literals([
  'requested',
  'queued',
  'running',
  'waiting_external',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'retrying',
  'failed_terminal',
])
export type OperationStatus = typeof OperationStatus.Type

export class Operation extends Schema.Class<Operation>('Operation')({
  id: OperationId,
  organizationId: OrganizationId,
  type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  resourceType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  resourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  actorId: IdentityId,
  status: OperationStatus,
  progress: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  idempotencyKey: IdempotencyKey,
  correlationId: CorrelationId,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}) {}

export const OperationStepState = Schema.Literals([
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
])
export class OperationStepDetail extends Schema.Class<OperationStepDetail>('OperationStepDetail')({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  state: OperationStepState,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
}) {}

export class OperationLogEntry extends Schema.Class<OperationLogEntry>('OperationLogEntry')({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)),
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  result: Schema.Literals(['succeeded', 'failed', 'denied']),
  createdAt: IsoDateTime,
}) {}

export const OperationRecoveryCode = Schema.Literals([
  'none',
  'wait-for-external-evidence',
  'inspect-terminal-failure',
  'cancelled',
])

export class OperationDetail extends Schema.Class<OperationDetail>('OperationDetail')({
  ...Operation.fields,
  retryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  waitingReason: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  providerReferenceHint: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  ),
  cancellable: Schema.Boolean,
  recovery: Schema.Struct({
    code: OperationRecoveryCode,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    // No generic retry mutation exists today. A future typed action can extend
    // this union without pretending that replaying an HTTP request is safe.
    retryAction: Schema.Null,
  }),
  finalResource: Schema.NullOr(
    Schema.Struct({
      type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    }),
  ),
  steps: Schema.Array(OperationStepDetail).check(Schema.isMaxLength(100)),
  logs: Schema.Array(OperationLogEntry).check(Schema.isMaxLength(100)),
}) {}

export const OutboxPublishState = Schema.Literals([
  'pending',
  'publishing',
  'delivered',
  'failed',
  'failed_terminal',
])
export type OutboxPublishState = typeof OutboxPublishState.Type
export class OutboxEvent extends Schema.Class<OutboxEvent>('OutboxEvent')({
  id: OutboxEventId,
  organizationId: OrganizationId,
  eventType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  aggregateType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  aggregateId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  payload: Schema.String,
  publishState: OutboxPublishState,
  retryCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  availableAt: IsoDateTime,
  createdAt: IsoDateTime,
}) {}

export class OrganizationSummary extends Schema.Class<OrganizationSummary>('OrganizationSummary')({
  organization: Organization,
  role: OrganizationRole,
}) {}

export class InvitationWithMembership extends Schema.Class<InvitationWithMembership>(
  'InvitationWithMembership',
)({
  invitation: OrganizationInvitation,
  membership: OrganizationMembership,
}) {}

export class MutationAccepted extends Schema.Class<MutationAccepted>('MutationAccepted')({
  operationId: OperationId,
  resourceId: Schema.optional(Schema.String),
  status: Schema.Literal('queued'),
  links: Schema.Struct({ operation: Schema.String }),
}) {}

/** Canonical response for a synchronous mutation committed with its operation evidence. */
export class MutationCompleted extends Schema.Class<MutationCompleted>('MutationCompleted')({
  operationId: OperationId,
  resourceId: Schema.String,
  status: Schema.Literal('succeeded'),
  links: Schema.Struct({ operation: Schema.String }),
}) {}

export class Problem extends Schema.Class<Problem>('Problem')({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(400),
    Schema.isLessThanOrEqualTo(599),
  ),
  detail: Schema.String,
  instance: Schema.optional(Schema.String),
  code: Schema.String,
  correlationId: CorrelationId,
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  ),
}) {}

export const AuthenticationIntent = Schema.Literals(['sign-in', 'sign-up', 'invitation'])
export class AuthBootstrap extends Schema.Class<AuthBootstrap>('AuthBootstrap')({
  authenticated: Schema.Boolean,
  identityId: Schema.optional(IdentityId),
  intent: AuthenticationIntent,
  next: Schema.Literals(['sign-up', 'accept-invitation', 'setup-organization', 'dashboard']),
  organizations: Schema.Array(OrganizationSummary),
}) {}

export class AccessSessionView extends Schema.Class<AccessSessionView>('AccessSessionView')({
  provider: Schema.Literal('cloudflare-access'),
  identity: Identity,
  subject: Schema.String,
  email: EmailAddress,
  issuer: Schema.String,
  issuedAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  management: Schema.Struct({
    authority: Schema.Literal('cloudflare-access'),
    localSessionStorage: Schema.Literal(false),
    canEnumerateOtherSessions: Schema.Literal(false),
    signOutPath: Schema.Literal('/cdn-cgi/access/logout'),
  }),
}) {}

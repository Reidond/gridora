import { Schema } from 'effect'

const identifier = (name: string) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ).pipe(Schema.brand(name))

export const OrganizationId = identifier('OrganizationId')
export type OrganizationId = typeof OrganizationId.Type
export const IdentityId = identifier('IdentityId')
export type IdentityId = typeof IdentityId.Type
export const InvitationId = identifier('InvitationId')
export type InvitationId = typeof InvitationId.Type
export const OperationId = identifier('OperationId')
export type OperationId = typeof OperationId.Type
export const OutboxEventId = identifier('OutboxEventId')
export type OutboxEventId = typeof OutboxEventId.Type
/** Public identifier for one organization-scoped non-interactive client. */
export const AutomationIdentityId = identifier('AutomationIdentityId')
export type AutomationIdentityId = typeof AutomationIdentityId.Type
/** Public identifier for one replaceable verifier of an automation identity. */
export const AutomationCredentialId = identifier('AutomationCredentialId')
export type AutomationCredentialId = typeof AutomationCredentialId.Type
export const CorrelationId = identifier('CorrelationId')
export type CorrelationId = typeof CorrelationId.Type
export const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(255),
).pipe(Schema.brand('IdempotencyKey'))
export type IdempotencyKey = typeof IdempotencyKey.Type

export const EmailAddress = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
).pipe(Schema.brand('EmailAddress'))
export type EmailAddress = typeof EmailAddress.Type

export const OrganizationSlug = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand('OrganizationSlug'))
export type OrganizationSlug = typeof OrganizationSlug.Type

export const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
).pipe(Schema.brand('IsoDateTime'))
export type IsoDateTime = typeof IsoDateTime.Type

export const IdentityStatus = Schema.Literals(['active', 'suspended'])
export type IdentityStatus = typeof IdentityStatus.Type
export const OrganizationStatus = Schema.Literals(['active', 'suspended', 'deleting', 'deleted'])
export type OrganizationStatus = typeof OrganizationStatus.Type
export const MembershipStatus = Schema.Literals(['active', 'suspended'])
export type MembershipStatus = typeof MembershipStatus.Type
export const OrganizationRole = Schema.Literals([
  'owner',
  'administrator',
  'operator',
  'viewer',
  'automation',
])
export type OrganizationRole = typeof OrganizationRole.Type
export const HumanOrganizationRole = Schema.Literals([
  'owner',
  'administrator',
  'operator',
  'viewer',
])
export type HumanOrganizationRole = typeof HumanOrganizationRole.Type
export const InvitationRole = Schema.Literals(['administrator', 'operator', 'viewer'])
export type InvitationRole = typeof InvitationRole.Type
export const InvitationStatus = Schema.Literals(['pending', 'accepted', 'revoked', 'expired'])
export type InvitationStatus = typeof InvitationStatus.Type
export const OnboardingStep = Schema.Literals([
  'organization',
  'provider',
  'team',
  'deployment',
  'complete',
])
export type OnboardingStep = typeof OnboardingStep.Type

export class Identity extends Schema.Class<Identity>('Identity')({
  id: IdentityId,
  accessSubject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  email: EmailAddress,
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  status: IdentityStatus,
  signedUpAt: IsoDateTime,
  lastLoginAt: IsoDateTime,
}) {}

export class Organization extends Schema.Class<Organization>('Organization')({
  id: OrganizationId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  slug: OrganizationSlug,
  status: OrganizationStatus,
  timezone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  defaultRegion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  onboardingStep: OnboardingStep,
  policyRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  createdAt: IsoDateTime,
}) {}

export class OrganizationMembership extends Schema.Class<OrganizationMembership>(
  'OrganizationMembership',
)({
  organizationId: OrganizationId,
  identityId: IdentityId,
  role: OrganizationRole,
  status: MembershipStatus,
  joinedAt: IsoDateTime,
  invitedBy: Schema.NullOr(IdentityId),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
}) {}

export class OrganizationInvitation extends Schema.Class<OrganizationInvitation>(
  'OrganizationInvitation',
)({
  id: InvitationId,
  organizationId: OrganizationId,
  email: EmailAddress,
  role: InvitationRole,
  tokenHash: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128)),
  expiresAt: IsoDateTime,
  inviterId: IdentityId,
  status: InvitationStatus,
  createdAt: IsoDateTime,
  acceptedBy: Schema.NullOr(IdentityId),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
}) {}

export class OrganizationContext extends Schema.Class<OrganizationContext>('OrganizationContext')({
  organizationId: OrganizationId,
  organizationSlug: OrganizationSlug,
  identityId: IdentityId,
  role: OrganizationRole,
  correlationId: CorrelationId,
}) {}

export const roleRank: Readonly<Record<OrganizationRole, number>> = {
  owner: 4,
  administrator: 3,
  operator: 2,
  viewer: 1,
  automation: 0,
}

export const roleAtLeast = (
  actual: OrganizationRole,
  required: Exclude<OrganizationRole, 'automation'>,
): boolean => actual !== 'automation' && roleRank[actual] >= roleRank[required]

export const organizationArtifactKey = (organizationId: OrganizationId, suffix: string): string =>
  `organizations/${organizationId}/${suffix.replace(/^\/+/, '')}`

export const organizationPartitionKey = (
  organizationId: OrganizationId,
  resource: string,
): string => `${organizationId}:${resource}`

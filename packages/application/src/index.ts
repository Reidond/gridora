import { Context, Effect, Layer } from 'effect'
import { AuthorizationError } from '@gridora/contracts'
import {
  IdentityRepository,
  OrganizationMembershipRepository,
  OrganizationRepository,
} from '@gridora/db-contracts'
import {
  type CorrelationId,
  type IdentityId,
  type InvitationId,
  type OperationId,
  OrganizationContext,
  type OrganizationId,
  type OrganizationRole,
  type OrganizationSlug,
  type OutboxEventId,
  roleAtLeast,
} from '@gridora/domain'

export interface IdentifierGeneratorShape {
  readonly identityId: Effect.Effect<IdentityId>
  readonly organizationId: Effect.Effect<OrganizationId>
  readonly invitationId: Effect.Effect<InvitationId>
  readonly operationId: Effect.Effect<OperationId>
  readonly outboxEventId: Effect.Effect<OutboxEventId>
}
export class IdentifierGenerator extends Context.Service<
  IdentifierGenerator,
  IdentifierGeneratorShape
>()('@gridora/application/IdentifierGenerator') {}

export interface ApplicationClockShape {
  readonly now: Effect.Effect<import('@gridora/domain').IsoDateTime>
}
export class ApplicationClock extends Context.Service<ApplicationClock, ApplicationClockShape>()(
  '@gridora/application/ApplicationClock',
) {}

export interface InvitationTokenServiceShape {
  /** Derive a stable, secret-keyed token for one idempotent invitation scope. */
  readonly issue: (
    scope: string,
  ) => Effect.Effect<{ readonly token: string; readonly hash: string; readonly keyVersion: string }>
  /** Recover the key-version candidate whose hash was persisted on an idempotent replay. */
  readonly recover: (
    scope: string,
    expectedHash: string,
  ) => Effect.Effect<{ readonly token: string; readonly hash: string; readonly keyVersion: string }>
  readonly hash: (token: string) => Effect.Effect<string>
}
export class InvitationTokenService extends Context.Service<
  InvitationTokenService,
  InvitationTokenServiceShape
>()('@gridora/application/InvitationTokenService') {}

export interface AuthorizationServiceShape {
  readonly authorizeById: (
    identityId: IdentityId,
    organizationId: OrganizationId,
    correlationId: CorrelationId,
    minimumRole?: Exclude<OrganizationRole, 'automation'>,
  ) => Effect.Effect<OrganizationContext, AuthorizationError>
  readonly authorizeBySlug: (
    identityId: IdentityId,
    slug: OrganizationSlug,
    correlationId: CorrelationId,
    minimumRole?: Exclude<OrganizationRole, 'automation'>,
  ) => Effect.Effect<OrganizationContext, AuthorizationError>
}
export class AuthorizationService extends Context.Service<
  AuthorizationService,
  AuthorizationServiceShape
>()('@gridora/application/AuthorizationService') {}

export const AuthorizationServiceLive = Layer.effect(
  AuthorizationService,
  Effect.gen(function* () {
    const identities = yield* IdentityRepository
    const organizations = yield* OrganizationRepository
    const memberships = yield* OrganizationMembershipRepository
    const authorizeResolved = (
      identityId: IdentityId,
      organizationEffect: Effect.Effect<
        import('@gridora/domain').Organization,
        import('@gridora/contracts').RepositoryError
      >,
      correlationId: CorrelationId,
      minimumRole: Exclude<OrganizationRole, 'automation'>,
    ) =>
      Effect.gen(function* () {
        const identity = yield* identities.findById(identityId).pipe(
          Effect.mapError(
            () =>
              new AuthorizationError({
                code: 'membership_required',
                message: 'Membership is required',
              }),
          ),
        )
        if (identity.status !== 'active') {
          return yield* new AuthorizationError({
            code: 'identity_suspended',
            message: 'Identity is suspended',
          })
        }
        const organization = yield* organizationEffect.pipe(
          Effect.mapError(
            () =>
              new AuthorizationError({
                code: 'membership_required',
                message: 'Membership is required',
              }),
          ),
        )
        if (organization.status !== 'active') {
          return yield* new AuthorizationError({
            code: 'organization_suspended',
            message: 'Organization is not active',
          })
        }
        const membership = yield* memberships.get(organization.id, identityId).pipe(
          Effect.mapError(
            () =>
              new AuthorizationError({
                code: 'membership_required',
                message: 'Membership is required',
              }),
          ),
        )
        if (membership.status !== 'active') {
          return yield* new AuthorizationError({
            code: 'membership_required',
            message: 'Membership is not active',
          })
        }
        if (!roleAtLeast(membership.role, minimumRole)) {
          return yield* new AuthorizationError({
            code: 'role_required',
            message: `${minimumRole} role is required`,
          })
        }
        return new OrganizationContext({
          organizationId: organization.id,
          organizationSlug: organization.slug,
          identityId,
          role: membership.role,
          correlationId,
        })
      })
    return AuthorizationService.of({
      authorizeById: (identityId, organizationId, correlationId, minimumRole = 'viewer') =>
        authorizeResolved(
          identityId,
          organizations.getById(organizationId),
          correlationId,
          minimumRole,
        ),
      authorizeBySlug: (identityId, slug, correlationId, minimumRole = 'viewer') =>
        authorizeResolved(identityId, organizations.getBySlug(slug), correlationId, minimumRole),
    })
  }),
)

/** Root-composable application layer; provide repository Layers once at the Worker entry point. */
export const ApplicationServicesLive = AuthorizationServiceLive

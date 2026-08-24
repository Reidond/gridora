import { describe, expect, it } from 'vitest'
import { Effect, Layer, Schema } from 'effect'
import { AuthorizationService, AuthorizationServiceLive } from '../src/index.js'
import { NotFoundError } from '@gridora/contracts'
import {
  IdentityRepository,
  OrganizationMembershipRepository,
  OrganizationRepository,
} from '@gridora/db-contracts'
import {
  CorrelationId,
  EmailAddress,
  Identity,
  IdentityId,
  IsoDateTime,
  OperationId,
  Organization,
  OrganizationId,
  OrganizationMembership,
  OrganizationSlug,
} from '@gridora/domain'

const at = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T10:00:00.000Z')
const unusedOperationId = Schema.decodeUnknownSync(OperationId)('operation-unused')
const identityA = new Identity({
  id: Schema.decodeUnknownSync(IdentityId)('identity-a'),
  accessSubject: 'access-a',
  email: Schema.decodeUnknownSync(EmailAddress)('a@example.com'),
  displayName: 'A',
  status: 'active',
  signedUpAt: at,
  lastLoginAt: at,
})
const orgA = new Organization({
  id: Schema.decodeUnknownSync(OrganizationId)('org-a'),
  name: 'Organization A',
  slug: Schema.decodeUnknownSync(OrganizationSlug)('organization-a'),
  status: 'active',
  timezone: 'UTC',
  defaultRegion: 'eu-west',
  onboardingStep: 'organization',
  policyRevision: 1,
  revision: 1,
  createdAt: at,
})
const orgB = new Organization({
  id: Schema.decodeUnknownSync(OrganizationId)('org-b'),
  name: 'Organization B',
  slug: Schema.decodeUnknownSync(OrganizationSlug)('organization-b'),
  status: 'active',
  timezone: 'UTC',
  defaultRegion: 'us-east',
  onboardingStep: 'organization',
  policyRevision: 1,
  revision: 1,
  createdAt: at,
})
const membershipA = new OrganizationMembership({
  organizationId: orgA.id,
  identityId: identityA.id,
  role: 'owner',
  status: 'active',
  joinedAt: at,
  invitedBy: null,
  revision: 1,
})

const repositories = Layer.mergeAll(
  Layer.succeed(
    IdentityRepository,
    IdentityRepository.of({
      findById: (id) =>
        id === identityA.id
          ? Effect.succeed(identityA)
          : Effect.fail(new NotFoundError({ resource: 'identity', id })),
      findByAccessSubject: () => Effect.succeed(identityA),
      createOrGet: () => Effect.succeed(identityA),
      touchLastLogin: () => Effect.succeed(identityA),
    }),
  ),
  Layer.succeed(
    OrganizationRepository,
    OrganizationRepository.of({
      getById: (id) =>
        id === orgA.id
          ? Effect.succeed(orgA)
          : id === orgB.id
            ? Effect.succeed(orgB)
            : Effect.fail(new NotFoundError({ resource: 'organization', id })),
      getBySlug: (slug) =>
        slug === orgA.slug
          ? Effect.succeed(orgA)
          : slug === orgB.slug
            ? Effect.succeed(orgB)
            : Effect.fail(new NotFoundError({ resource: 'organization', id: slug })),
      getForContext: (context) =>
        context.organizationId === orgA.id ? Effect.succeed(orgA) : Effect.succeed(orgB),
      updateProfile: () => Effect.die('unused'),
      recordSwitch: () => Effect.die('unused'),
    }),
  ),
  Layer.succeed(
    OrganizationMembershipRepository,
    OrganizationMembershipRepository.of({
      get: (organizationId, identityId) =>
        organizationId === orgA.id && identityId === identityA.id
          ? Effect.succeed(membershipA)
          : Effect.fail(
              new NotFoundError({
                resource: 'organization_membership',
                id: `${organizationId}:${identityId}`,
              }),
            ),
      listForIdentity: () => Effect.succeed([membershipA]),
      listForOrganization: (context) =>
        Effect.succeed(context.organizationId === orgA.id ? [membershipA] : []),
      countActiveOwners: (organizationId) => Effect.succeed(organizationId === orgA.id ? 1 : 0),
      updateRole: () =>
        Effect.succeed({
          operationId: unusedOperationId,
          resourceId: membershipA.identityId,
          value: membershipA,
          replayed: false,
        }),
      remove: () =>
        Effect.succeed({
          operationId: unusedOperationId,
          resourceId: membershipA.identityId,
          value: null,
          replayed: false,
        }),
      leave: () =>
        Effect.succeed({
          operationId: unusedOperationId,
          resourceId: membershipA.identityId,
          value: null,
          replayed: false,
        }),
      hasLeaveReceipt: () => Effect.succeed(false),
    }),
  ),
)
const live = AuthorizationServiceLive.pipe(Layer.provide(repositories))
const correlationId = Schema.decodeUnknownSync(CorrelationId)('correlation-123')

describe('AuthorizationService tenant isolation', () => {
  it("rejects a valid identity using another organization's id", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService
          return yield* authorization.authorizeById(identityA.id, orgB.id, correlationId)
        }).pipe(Effect.provide(live)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.code).toBe('membership_required')
  })

  it('rejects the same attack through the human-readable slug', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const authorization = yield* AuthorizationService
          return yield* authorization.authorizeBySlug(identityA.id, orgB.slug, correlationId)
        }).pipe(Effect.provide(live)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.code).toBe('membership_required')
  })

  it('constructs context only after resolving an active membership', async () => {
    const context = await Effect.runPromise(
      Effect.gen(function* () {
        const authorization = yield* AuthorizationService
        return yield* authorization.authorizeById(identityA.id, orgA.id, correlationId, 'owner')
      }).pipe(Effect.provide(live)),
    )

    expect(context.organizationId).toBe(orgA.id)
    expect(context.identityId).toBe(identityA.id)
    expect(context.role).toBe('owner')
  })
})

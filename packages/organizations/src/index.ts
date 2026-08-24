import { Context, Effect, Layer, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { ApplicationClock, IdentifierGenerator, InvitationTokenService } from '@gridora/application'
import { makeInitialOrganizationPolicy } from '@gridora/policy-control'
import {
  ConflictError,
  type CreateInvitationInput,
  type CreateOrganizationInput,
  type CreateOrganizationResult,
  InvitationError,
  LastOwnerError,
  type RepositoryError,
} from '@gridora/contracts'
import {
  type AcceptedInvitationWithIdentity,
  type CoreMutationFacts,
  type CoreMutationResult,
  IdentityRepository,
  OrganizationInvitationRepository,
  OrganizationMembershipRepository,
  OrganizationUnitOfWork,
} from '@gridora/db-contracts'
import type {
  EmailAddress,
  Identity,
  IdentityId,
  OrganizationContext,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationRole,
} from '@gridora/domain'
import {
  IdempotencyKey,
  InvitationId,
  IsoDateTime,
  OrganizationId,
  OutboxEventId,
  roleAtLeast,
} from '@gridora/domain'

type OrganizationServiceError = RepositoryError | LastOwnerError | ConflictError | InvitationError

export interface InvitationAccessIdentityInput {
  readonly accessSubject: string
  readonly email: EmailAddress
  readonly displayName: string
}

export interface CoreMutationRequest {
  readonly idempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly operationIdempotencyKey: IdempotencyKey
  readonly request: AuditRequestContextValue
  readonly resourceId: string
}

export interface OrganizationServiceShape {
  readonly create: (
    owner: Identity,
    input: CreateOrganizationInput,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CreateOrganizationResult, RepositoryError>
  readonly invite: (
    context: OrganizationContext,
    input: CreateInvitationInput,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, OrganizationServiceError>
  readonly acceptInvitation: (
    identity: Identity,
    token: string,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<OrganizationMembership>, OrganizationServiceError>
  readonly acceptInvitationForAccessIdentity: (
    input: InvitationAccessIdentityInput,
    token: string,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<AcceptedInvitationWithIdentity, OrganizationServiceError>
  readonly acceptInvitationForAccessIdentityByTokenHash: (
    input: InvitationAccessIdentityInput,
    tokenHash: string,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<AcceptedInvitationWithIdentity, OrganizationServiceError>
  readonly updateMemberRole: (
    context: OrganizationContext,
    identityId: IdentityId,
    role: OrganizationRole,
    expectedRevision: number,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<OrganizationMembership>, OrganizationServiceError>
  readonly removeMember: (
    context: OrganizationContext,
    identityId: IdentityId,
    expectedRevision: number,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<null>, OrganizationServiceError>
  readonly leave: (
    context: OrganizationContext,
    expectedRevision: number,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<null>, OrganizationServiceError>
  readonly transferOwnership: (
    context: OrganizationContext,
    targetIdentityId: IdentityId,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<null>, OrganizationServiceError>
  readonly revokeInvitation: (
    context: OrganizationContext,
    invitationId: InvitationId,
    expectedRevision: number,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, OrganizationServiceError>
  readonly resendInvitation: (
    context: OrganizationContext,
    invitationId: InvitationId,
    expectedRevision: number,
    expiresAt: typeof IsoDateTime.Type,
    mutation: CoreMutationRequest,
  ) => Effect.Effect<CoreMutationResult<OrganizationInvitation>, OrganizationServiceError>
}

export class OrganizationService extends Context.Service<
  OrganizationService,
  OrganizationServiceShape
>()('@gridora/organizations/OrganizationService') {}

const requireAdministrator = (context: OrganizationContext): Effect.Effect<void, ConflictError> =>
  roleAtLeast(context.role, 'administrator')
    ? Effect.void
    : new ConflictError({ code: 'role_required', message: 'Administrator role is required' })

const requireOwner = (context: OrganizationContext): Effect.Effect<void, ConflictError> =>
  context.role === 'owner'
    ? Effect.void
    : new ConflictError({ code: 'role_required', message: 'Owner role is required' })

export const OrganizationServiceLive = Layer.effect(
  OrganizationService,
  Effect.gen(function* () {
    const memberships = yield* OrganizationMembershipRepository
    const invitations = yield* OrganizationInvitationRepository
    const units = yield* OrganizationUnitOfWork
    const identities = yield* IdentityRepository
    const ids = yield* IdentifierGenerator
    const tokens = yield* InvitationTokenService
    const clock = yield* ApplicationClock

    const sha256 = (value: string) =>
      Effect.tryPromise({
        try: async () =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
        catch: () => new Error('SHA-256 unavailable'),
      }).pipe(Effect.orDie)

    const coreMutationFacts = (
      mutation: CoreMutationRequest,
      action: string,
      resourceType: string,
      resourceId: string,
      now: typeof IsoDateTime.Type,
    ): Effect.Effect<CoreMutationFacts> =>
      Effect.gen(function* () {
        return {
          operationId: yield* ids.operationId,
          idempotencyKey: mutation.idempotencyKey,
          requestFingerprint: mutation.requestFingerprint,
          operationIdempotencyKey: mutation.operationIdempotencyKey,
          action,
          resourceType,
          resourceId,
          request: mutation.request,
          now,
        }
      })

    const protectLastOwner = (context: OrganizationContext, identityId: IdentityId) =>
      Effect.gen(function* () {
        const membership = yield* memberships.get(context.organizationId, identityId)
        if (membership.role !== 'owner') return
        const owners = yield* memberships.countActiveOwners(context.organizationId)
        if (owners <= 1)
          return yield* new LastOwnerError({ organizationId: context.organizationId, identityId })
      })

    const findInvitationByHash = (tokenHash: string) =>
      invitations
        .findByTokenHash(tokenHash)
        .pipe(
          Effect.mapError((error) =>
            error._tag === 'NotFoundError' ? new InvitationError({ code: 'invalid_token' }) : error,
          ),
        )

    const requireInvitationBinding = (
      invitation: OrganizationInvitation,
      email: EmailAddress,
      allowAcceptedReplay: boolean,
    ) =>
      Effect.gen(function* () {
        if (invitation.email.toLowerCase() !== email.toLowerCase()) {
          return yield* new InvitationError({ code: 'email_mismatch', invitationId: invitation.id })
        }
        if (invitation.status === 'accepted' && allowAcceptedReplay) return invitation
        if (invitation.status !== 'pending') {
          return yield* new InvitationError({
            code: invitation.status,
            invitationId: invitation.id,
          })
        }
        if (invitation.expiresAt <= (yield* clock.now)) {
          return yield* new InvitationError({ code: 'expired', invitationId: invitation.id })
        }
        return invitation
      })
    const acceptAccessIdentityByHash = (
      input: InvitationAccessIdentityInput,
      tokenHash: string,
      mutation: CoreMutationRequest,
    ) =>
      Effect.gen(function* () {
        const invitation = yield* findInvitationByHash(tokenHash).pipe(
          Effect.flatMap((candidate) => requireInvitationBinding(candidate, input.email, true)),
        )
        const now = yield* clock.now
        const identityId = yield* ids.identityId
        const tenantScope = yield* sha256(
          `${invitation.organizationId}:${identityId}:organization.invitation.accept:${mutation.idempotencyKey}`,
        )
        const platformScope = yield* sha256(
          `platform:${identityId}:identity.sign-up:${mutation.idempotencyKey}`,
        )
        return yield* units.acceptInvitationWithIdentity({
          tokenHash,
          identityId,
          accessSubject: input.accessSubject,
          email: input.email,
          displayName: input.displayName,
          now,
          outboxEventId: yield* ids.outboxEventId,
          tenantOperationId: yield* ids.operationId,
          platformOperationId: yield* ids.operationId,
          idempotencyKey: mutation.idempotencyKey,
          tenantOperationIdempotencyKey: yield* Schema.decodeUnknownEffect(IdempotencyKey)(
            tenantScope,
          ).pipe(Effect.orDie),
          platformOperationIdempotencyKey: yield* Schema.decodeUnknownEffect(IdempotencyKey)(
            platformScope,
          ).pipe(Effect.orDie),
          requestFingerprint: yield* sha256(
            JSON.stringify({
              organizationId: invitation.organizationId,
              invitationId: invitation.id,
              identityId,
              accessSubject: input.accessSubject,
              email: input.email.toLowerCase(),
            }),
          ),
          request: mutation.request,
        })
      })

    return OrganizationService.of({
      create: (owner, input, mutation) =>
        Effect.gen(function* () {
          const now = yield* clock.now
          if (
            (input.budgetWarningThresholdMinor === undefined) !==
            (input.budgetWarningCurrency === undefined)
          ) {
            return yield* new ConflictError({
              code: 'invalid_budget_warning',
              message: 'Budget warning minor units and currency must be supplied together',
            })
          }
          const normalizedEmails = (input.initialInvitations ?? []).map((entry) =>
            entry.email.toLowerCase(),
          )
          if (new Set(normalizedEmails).size !== normalizedEmails.length) {
            return yield* new ConflictError({
              code: 'duplicate_initial_invitation',
              message: 'Initial invitation emails must be unique',
            })
          }
          const initialInvitations = yield* Effect.forEach(
            input.initialInvitations ?? [],
            (entry, index) =>
              Effect.gen(function* () {
                const scope = `setup:${owner.id}:${input.idempotencyKey}:${index}:${entry.email.toLowerCase()}`
                const issued = yield* tokens.issue(scope)
                return {
                  id: yield* Schema.decodeUnknownEffect(InvitationId)(
                    `inv_${issued.hash.slice(0, 24)}`,
                  ),
                  email: entry.email,
                  role: entry.role,
                  tokenHash: issued.hash,
                  tokenScope: scope,
                  tokenKeyVersion: issued.keyVersion,
                  expiresAt: yield* Schema.decodeUnknownEffect(IsoDateTime)(
                    new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1_000).toISOString(),
                  ),
                  outboxEventId: yield* Schema.decodeUnknownEffect(OutboxEventId)(
                    `event_${issued.hash.slice(24, 48)}`,
                  ),
                }
              }).pipe(Effect.orDie),
          )
          const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
            mutation.resourceId,
          ).pipe(Effect.orDie)
          const initialPolicy = yield* Effect.try({
            try: () =>
              makeInitialOrganizationPolicy({
                organizationId,
                defaultRegion: input.defaultRegion,
                ...(input.budgetWarningThresholdMinor === undefined ||
                input.budgetWarningCurrency === undefined
                  ? {}
                  : {
                      setupBudgetWarning: {
                        minor: input.budgetWarningThresholdMinor,
                        currency: input.budgetWarningCurrency,
                      },
                    }),
              }),
            catch: () =>
              new ConflictError({
                code: 'invalid_initial_policy',
                message: 'Organization setup values cannot form a valid initial policy',
              }),
          })
          return yield* units.createOrganizationWithOwner({
            id: organizationId,
            ownerIdentityId: owner.id,
            name: input.name,
            slug: input.slug,
            timezone: input.timezone,
            defaultRegion: input.defaultRegion,
            termsVersion: 'product-0.2',
            initialPolicy,
            idempotencyKey: input.idempotencyKey,
            now,
            outboxEventId: yield* ids.outboxEventId,
            operationId: yield* ids.operationId,
            operationIdempotencyKey: mutation.operationIdempotencyKey,
            requestFingerprint: mutation.requestFingerprint,
            request: mutation.request,
            initialInvitations,
          })
        }),
      invite: (context, input, mutation) =>
        Effect.gen(function* () {
          yield* requireAdministrator(context)
          const issued = yield* tokens.issue(`${context.organizationId}:${input.idempotencyKey}`)
          const tokenScope = `${context.organizationId}:${input.idempotencyKey}`
          const now = yield* clock.now
          if (input.expiresAt <= now) {
            return yield* new ConflictError({
              code: 'invalid_expiry',
              message: 'Invitation expiry must be in the future',
            })
          }
          const invitationId = yield* Schema.decodeUnknownEffect(InvitationId)(
            mutation.resourceId,
          ).pipe(
            Effect.mapError(
              () =>
                new ConflictError({
                  code: 'invalid_invitation_id',
                  message: 'Invitation mutation resource ID is invalid',
                }),
            ),
          )
          const invitationResult = yield* invitations.create(
            context,
            {
              id: invitationId,
              organizationId: context.organizationId,
              email: input.email,
              role: input.role,
              tokenHash: issued.hash,
              tokenScope,
              tokenKeyVersion: issued.keyVersion,
              expiresAt: input.expiresAt,
              inviterId: context.identityId,
              idempotencyKey: input.idempotencyKey,
              now,
              outboxEventId: yield* ids.outboxEventId,
            },
            yield* coreMutationFacts(
              mutation,
              'organization.invitation.create',
              'organization_invitation',
              invitationId,
              now,
            ),
          )
          return invitationResult
        }),
      acceptInvitation: (identity, token, mutation) =>
        Effect.gen(function* () {
          const tokenHash = yield* tokens.hash(token)
          const invitation = yield* findInvitationByHash(tokenHash).pipe(
            Effect.flatMap((candidate) =>
              requireInvitationBinding(candidate, identity.email, true),
            ),
          )
          const now = yield* clock.now
          const context: Pick<OrganizationContext, 'organizationId' | 'identityId' | 'role'> = {
            organizationId: invitation.organizationId,
            identityId: identity.id,
            role: invitation.role,
          }
          const operationIdempotencyKey = yield* Schema.decodeUnknownEffect(IdempotencyKey)(
            yield* sha256(
              `${invitation.organizationId}:${identity.id}:organization.invitation.accept:organization_invitation:${invitation.id}:${mutation.idempotencyKey}`,
            ),
          ).pipe(Effect.orDie)
          return yield* units.acceptInvitation(
            context,
            invitation,
            yield* coreMutationFacts(
              { ...mutation, operationIdempotencyKey },
              'organization.invitation.accept',
              'organization_invitation',
              invitation.id,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      acceptInvitationForAccessIdentity: (input, token, mutation) =>
        tokens
          .hash(token)
          .pipe(
            Effect.flatMap((tokenHash) => acceptAccessIdentityByHash(input, tokenHash, mutation)),
          ),
      acceptInvitationForAccessIdentityByTokenHash: acceptAccessIdentityByHash,
      updateMemberRole: (context, identityId, role, expectedRevision, mutation) =>
        Effect.gen(function* () {
          yield* requireAdministrator(context)
          if (role === 'automation') {
            return yield* new ConflictError({
              code: 'invalid_human_role',
              message: 'Automation role requires a machine identity',
            })
          }
          const target = yield* memberships.get(context.organizationId, identityId)
          if ((role === 'owner' || target.role === 'owner') && context.role !== 'owner') {
            return yield* new ConflictError({
              code: 'owner_role_requires_owner',
              message: 'Only an Owner can change an Owner membership',
            })
          }
          if (role !== 'owner') yield* protectLastOwner(context, identityId)
          const now = yield* clock.now
          return yield* memberships.updateRole(
            context,
            identityId,
            role,
            expectedRevision,
            yield* coreMutationFacts(
              mutation,
              'organization.membership.role.update',
              'organization_membership',
              identityId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      removeMember: (context, identityId, expectedRevision, mutation) =>
        Effect.gen(function* () {
          yield* requireAdministrator(context)
          if (identityId !== context.identityId) yield* identities.findById(identityId)
          yield* protectLastOwner(context, identityId)
          const now = yield* clock.now
          return yield* memberships.remove(
            context,
            identityId,
            expectedRevision,
            yield* coreMutationFacts(
              mutation,
              'organization.membership.remove',
              'organization_membership',
              identityId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      leave: (context, expectedRevision, mutation) =>
        Effect.gen(function* () {
          yield* protectLastOwner(context, context.identityId)
          const now = yield* clock.now
          return yield* memberships.leave(
            context,
            expectedRevision,
            yield* coreMutationFacts(
              mutation,
              'organization.membership.leave',
              'organization_membership',
              context.identityId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      transferOwnership: (context, targetIdentityId, mutation) =>
        Effect.gen(function* () {
          yield* requireOwner(context)
          if (targetIdentityId === context.identityId) {
            return yield* new ConflictError({
              code: 'ownership_target_unchanged',
              message: 'Select a different active member as the new Owner',
            })
          }
          const target = yield* memberships.get(context.organizationId, targetIdentityId)
          if (target.status !== 'active') {
            return yield* new ConflictError({
              code: 'target_inactive',
              message: 'Target membership must be active',
            })
          }
          const now = yield* clock.now
          return yield* units.transferOwnership(
            context,
            targetIdentityId,
            yield* coreMutationFacts(
              mutation,
              'organization.ownership.transfer',
              'organization',
              context.organizationId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      revokeInvitation: (context, invitationId, expectedRevision, mutation) =>
        Effect.gen(function* () {
          yield* requireAdministrator(context)
          const now = yield* clock.now
          return yield* invitations.revoke(
            context,
            invitationId,
            expectedRevision,
            yield* coreMutationFacts(
              mutation,
              'organization.invitation.revoke',
              'organization_invitation',
              invitationId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
      resendInvitation: (context, invitationId, expectedRevision, expiresAt, mutation) =>
        Effect.gen(function* () {
          yield* requireAdministrator(context)
          const now = yield* clock.now
          if (expiresAt <= now)
            return yield* new ConflictError({
              code: 'invalid_expiry',
              message: 'Invitation expiry must be in the future',
            })
          const tokenScope = `resend:${context.organizationId}:${invitationId}:${mutation.idempotencyKey}`
          const issued = yield* tokens.issue(tokenScope)
          return yield* invitations.resend(
            context,
            invitationId,
            expectedRevision,
            {
              tokenHash: issued.hash,
              tokenScope,
              tokenKeyVersion: issued.keyVersion,
              expiresAt,
              now,
            },
            yield* coreMutationFacts(
              mutation,
              'organization.invitation.resend',
              'organization_invitation',
              invitationId,
              now,
            ),
            yield* ids.outboxEventId,
          )
        }),
    })
  }),
)

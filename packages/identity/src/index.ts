import { Context, Effect, Layer, Schema } from 'effect'
import { ApplicationClock, IdentifierGenerator } from '@gridora/application'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import type { RepositoryError } from '@gridora/contracts'
import { IdentityRepository } from '@gridora/db-contracts'
import { EmailAddress, Identity, type IdempotencyKey } from '@gridora/domain'

export interface IdentityMutationRequest {
  readonly idempotencyKey: IdempotencyKey
  readonly operationIdempotencyKey: IdempotencyKey
  readonly requestFingerprint: string
  readonly request: AuditRequestContextValue
}

export class CompleteSignUpInput extends Schema.Class<CompleteSignUpInput>('CompleteSignUpInput')({
  accessSubject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  email: EmailAddress,
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
}) {}

export interface IdentityServiceShape {
  readonly completeSignUp: (
    input: CompleteSignUpInput,
    mutation: IdentityMutationRequest,
  ) => Effect.Effect<Identity, RepositoryError>
  readonly recordLogin: (
    accessSubject: string,
    mutation: IdentityMutationRequest,
  ) => Effect.Effect<Identity | null, RepositoryError>
}

export class IdentityService extends Context.Service<IdentityService, IdentityServiceShape>()(
  '@gridora/identity/IdentityService',
) {}

export const IdentityServiceLive = Layer.effect(
  IdentityService,
  Effect.gen(function* () {
    const repository = yield* IdentityRepository
    const ids = yield* IdentifierGenerator
    const clock = yield* ApplicationClock
    return IdentityService.of({
      completeSignUp: (input, mutation) =>
        Effect.gen(function* () {
          const id = yield* ids.identityId
          const now = yield* clock.now
          return yield* repository.createOrGet({
            id,
            accessSubject: input.accessSubject,
            email: input.email,
            displayName: input.displayName,
            now,
            mutation: {
              operationId: yield* ids.operationId,
              ...mutation,
              action: 'identity.sign-up',
              resourceType: 'identity',
              resourceId: id,
              now,
            },
          })
        }),
      recordLogin: (accessSubject, mutation) =>
        Effect.gen(function* () {
          const identity = yield* repository.findByAccessSubject(accessSubject)
          if (identity === null) return null
          const now = yield* clock.now
          return yield* repository.touchLastLogin(identity.id, {
            operationId: yield* ids.operationId,
            ...mutation,
            action: 'identity.sign-in',
            resourceType: 'identity',
            resourceId: identity.id,
            now,
          })
        }),
    })
  }),
)

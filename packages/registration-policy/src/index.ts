import { Context, Effect, Layer, Schema } from 'effect'

export const RegistrationMode = Schema.Literals(['open', 'invitation-only', 'closed'])
export type RegistrationMode = typeof RegistrationMode.Type

export interface RegistrationPolicy {
  readonly mode: RegistrationMode
}

export class RegistrationPolicyStoreError extends Schema.TaggedError<RegistrationPolicyStoreError>()(
  'RegistrationPolicyStoreError',
  {},
) {}

export class RegistrationAuditError extends Schema.TaggedError<RegistrationAuditError>()(
  'RegistrationAuditError',
  {},
) {}

/** This error deliberately does not disclose policy or invitation state. */
export class RegistrationDeniedError extends Schema.TaggedError<RegistrationDeniedError>()(
  'RegistrationDeniedError',
  { code: Schema.Literal('registration_not_available') },
) {}

/** This error deliberately does not disclose which server-side dependency failed. */
export class RegistrationPolicyUnavailableError extends Schema.TaggedError<RegistrationPolicyUnavailableError>()(
  'RegistrationPolicyUnavailableError',
  { code: Schema.Literal('registration_policy_unavailable') },
) {}

export type RegistrationPolicyError = RegistrationDeniedError | RegistrationPolicyUnavailableError

export interface RegistrationPolicyRepositoryShape {
  readonly get: Effect.Effect<RegistrationPolicy, RegistrationPolicyStoreError>
}

export class RegistrationPolicyRepository extends Context.Service<
  RegistrationPolicyRepository,
  RegistrationPolicyRepositoryShape
>()('@gridora/registration-policy/RegistrationPolicyRepository') {}

export interface RegistrationClockShape {
  readonly nowEpochMilliseconds: Effect.Effect<number>
}

export class RegistrationClock extends Context.Service<RegistrationClock, RegistrationClockShape>()(
  '@gridora/registration-policy/RegistrationClock',
) {}

export type RegistrationDecisionReason =
  | 'existing_identity'
  | 'open_registration'
  | 'unknown_sign_in'
  | 'public_registration_disabled'
  | 'valid_invitation'
  | 'invalid_invitation'
  | 'expired_invitation'
  | 'invitation_binding_mismatch'
  | 'invitation_already_consumed'

export interface RegistrationDecisionAudit {
  readonly decisionId: string
  readonly intent: RegistrationIntent
  readonly mode: RegistrationMode
  readonly identityKnown: boolean
  readonly outcome: 'allow-existing' | 'allow-create' | 'deny'
  readonly reason: RegistrationDecisionReason
  readonly decidedAtEpochMilliseconds: number
}

export interface RegistrationDecisionAuditPortShape {
  /** Implementations must deduplicate by decisionId. */
  readonly record: (
    decision: RegistrationDecisionAudit,
  ) => Effect.Effect<void, RegistrationAuditError>
  /** Reads the immutable result for response-loss adoption of a protected authentication state. */
  readonly find: (
    decisionId: string,
  ) => Effect.Effect<RegistrationDecisionAudit | null, RegistrationAuditError>
}

export class RegistrationDecisionAuditPort extends Context.Service<
  RegistrationDecisionAuditPort,
  RegistrationDecisionAuditPortShape
>()('@gridora/registration-policy/RegistrationDecisionAuditPort') {}

export type RegistrationIntent = 'sign-in' | 'public-sign-up' | 'invitation-completion'

export interface VerifiedInvitationBinding {
  /** Opaque server-side invitation identifier. Never use a raw invitation token here. */
  readonly invitationId: string
  readonly boundExternalIdentity: string
  readonly expiresAtEpochMilliseconds: number
  readonly consumedAtEpochMilliseconds: number | null
}

/**
 * The HTTP edge constructs this value only after it verifies the protected intent.
 * This service does not accept a redirect query parameter, requested mode, or raw token.
 */
export interface VerifiedRegistrationAttempt {
  readonly decisionId: string
  readonly intent: RegistrationIntent
  readonly externalIdentity: string
  readonly identityKnown: boolean
  readonly invitation: VerifiedInvitationBinding | null
}

export interface RegistrationAllowed {
  readonly outcome: 'allow-existing' | 'allow-create'
  readonly reason: 'existing_identity' | 'open_registration' | 'valid_invitation'
}

export interface RegistrationPolicyServiceShape {
  readonly decide: (
    attempt: VerifiedRegistrationAttempt,
  ) => Effect.Effect<RegistrationAllowed, RegistrationPolicyError>
}

export class RegistrationPolicyService extends Context.Service<
  RegistrationPolicyService,
  RegistrationPolicyServiceShape
>()('@gridora/registration-policy/RegistrationPolicyService') {}

interface InternalDecision {
  readonly outcome: 'allow-existing' | 'allow-create' | 'deny'
  readonly reason: RegistrationDecisionReason
}

const invitationDecision = (
  attempt: VerifiedRegistrationAttempt,
  now: number,
): InternalDecision => {
  const invitation = attempt.invitation
  if (invitation === null) return { outcome: 'deny', reason: 'invalid_invitation' }
  if (invitation.consumedAtEpochMilliseconds !== null)
    return { outcome: 'deny', reason: 'invitation_already_consumed' }
  if (invitation.expiresAtEpochMilliseconds <= now)
    return { outcome: 'deny', reason: 'expired_invitation' }
  if (invitation.boundExternalIdentity !== attempt.externalIdentity)
    return { outcome: 'deny', reason: 'invitation_binding_mismatch' }
  return {
    outcome: attempt.identityKnown ? 'allow-existing' : 'allow-create',
    reason: 'valid_invitation',
  }
}

const evaluate = (
  policy: RegistrationPolicy,
  attempt: VerifiedRegistrationAttempt,
  now: number,
): InternalDecision => {
  if (attempt.intent === 'sign-in')
    return attempt.identityKnown
      ? { outcome: 'allow-existing', reason: 'existing_identity' }
      : { outcome: 'deny', reason: 'unknown_sign_in' }

  if (attempt.intent === 'invitation-completion') return invitationDecision(attempt, now)

  if (attempt.identityKnown) return { outcome: 'allow-existing', reason: 'existing_identity' }
  if (policy.mode === 'open') return { outcome: 'allow-create', reason: 'open_registration' }
  return { outcome: 'deny', reason: 'public_registration_disabled' }
}

const unavailable = () =>
  new RegistrationPolicyUnavailableError({ code: 'registration_policy_unavailable' })

export const RegistrationPolicyServiceLive = Layer.effect(
  RegistrationPolicyService,
  Effect.gen(function* () {
    const policies = yield* RegistrationPolicyRepository
    const clock = yield* RegistrationClock
    const audit = yield* RegistrationDecisionAuditPort

    return RegistrationPolicyService.of({
      decide: (attempt) =>
        Effect.gen(function* () {
          const prior = yield* audit.find(attempt.decisionId).pipe(Effect.mapError(unavailable))
          if (prior !== null) {
            if (prior.intent !== attempt.intent) return yield* unavailable()
            if (prior.outcome === 'deny')
              return yield* new RegistrationDeniedError({ code: 'registration_not_available' })
            return { outcome: prior.outcome, reason: prior.reason } as RegistrationAllowed
          }
          const policy = yield* policies.get.pipe(Effect.mapError(unavailable))
          const now = yield* clock.nowEpochMilliseconds
          const decision = evaluate(policy, attempt, now)
          yield* audit
            .record({
              decisionId: attempt.decisionId,
              intent: attempt.intent,
              mode: policy.mode,
              identityKnown: attempt.identityKnown,
              outcome: decision.outcome,
              reason: decision.reason,
              decidedAtEpochMilliseconds: now,
            })
            .pipe(Effect.mapError(unavailable))

          if (decision.outcome === 'deny')
            return yield* new RegistrationDeniedError({ code: 'registration_not_available' })

          return {
            outcome: decision.outcome,
            reason: decision.reason,
          } as RegistrationAllowed
        }),
    })
  }),
)

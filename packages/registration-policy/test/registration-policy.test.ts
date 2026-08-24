import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  RegistrationClock,
  RegistrationAuditError,
  RegistrationDecisionAuditPort,
  type RegistrationDecisionAudit,
  RegistrationDeniedError,
  type RegistrationIntent,
  type RegistrationMode,
  RegistrationPolicyRepository,
  RegistrationPolicyStoreError,
  RegistrationPolicyService,
  RegistrationPolicyServiceLive,
  RegistrationPolicyUnavailableError,
  type VerifiedInvitationBinding,
  type VerifiedRegistrationAttempt,
} from '../src/index.js'

const now = 2_000_000
const externalIdentity = 'access|subject-1'

const validInvitation = (): VerifiedInvitationBinding => ({
  invitationId: 'invitation-1',
  boundExternalIdentity: externalIdentity,
  expiresAtEpochMilliseconds: now + 10_000,
  consumedAtEpochMilliseconds: null,
})

const attempt = (
  intent: RegistrationIntent,
  identityKnown: boolean,
  invitation: VerifiedInvitationBinding | null = null,
): VerifiedRegistrationAttempt => ({
  decisionId: `decision:${intent}:${identityKnown}:${invitation?.invitationId ?? 'none'}`,
  intent,
  externalIdentity,
  identityKnown,
  invitation,
})

const harness = (mode: RegistrationMode) => {
  const audits = new Map<string, RegistrationDecisionAudit>()
  const dependencies = Layer.mergeAll(
    Layer.succeed(RegistrationPolicyRepository, { get: Effect.succeed({ mode }) }),
    Layer.succeed(RegistrationClock, { nowEpochMilliseconds: Effect.succeed(now) }),
    Layer.succeed(RegistrationDecisionAuditPort, {
      find: (decisionId) => Effect.succeed(audits.get(decisionId) ?? null),
      record: (decision) =>
        Effect.sync(() => {
          audits.set(decision.decisionId, decision)
        }),
    }),
  )
  const layer = RegistrationPolicyServiceLive.pipe(Layer.provide(dependencies))
  return {
    audits,
    decide: (input: VerifiedRegistrationAttempt) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* RegistrationPolicyService).decide(input)
        }).pipe(Effect.provide(layer)),
      ),
  }
}

describe.each(['open', 'invitation-only', 'closed'] as const)('%s registration', (mode) => {
  it('allows a known identity to sign in without creating it', async () => {
    await expect(harness(mode).decide(attempt('sign-in', true))).resolves.toEqual({
      outcome: 'allow-existing',
      reason: 'existing_identity',
    })
  })

  it('denies unknown sign-in without creating an identity', async () => {
    await expect(harness(mode).decide(attempt('sign-in', false))).rejects.toMatchObject({
      _tag: 'RegistrationDeniedError',
      code: 'registration_not_available',
    })
  })

  it('keeps public sign-up idempotent for a known identity', async () => {
    await expect(harness(mode).decide(attempt('public-sign-up', true))).resolves.toEqual({
      outcome: 'allow-existing',
      reason: 'existing_identity',
    })
  })

  it('permits a valid invitation for a new identity', async () => {
    await expect(
      harness(mode).decide(attempt('invitation-completion', false, validInvitation())),
    ).resolves.toEqual({ outcome: 'allow-create', reason: 'valid_invitation' })
  })

  it('permits a valid invitation for a known identity without creating it', async () => {
    await expect(
      harness(mode).decide(attempt('invitation-completion', true, validInvitation())),
    ).resolves.toEqual({ outcome: 'allow-existing', reason: 'valid_invitation' })
  })

  it('does not let a known identity bypass invitation validation', async () => {
    await expect(
      harness(mode).decide(attempt('invitation-completion', true, null)),
    ).rejects.toEqual(new RegistrationDeniedError({ code: 'registration_not_available' }))
  })

  it.each([
    ['missing', null],
    ['expired', { ...validInvitation(), invitationId: 'expired', expiresAtEpochMilliseconds: now }],
    [
      'identity mismatch',
      { ...validInvitation(), invitationId: 'mismatch', boundExternalIdentity: 'access|other' },
    ],
    [
      'consumed replay',
      { ...validInvitation(), invitationId: 'consumed', consumedAtEpochMilliseconds: now - 1 },
    ],
  ])('denies a %s invitation without disclosing why', async (_label, invitation) => {
    const result = harness(mode).decide(
      attempt('invitation-completion', false, invitation as VerifiedInvitationBinding | null),
    )
    await expect(result).rejects.toEqual(
      new RegistrationDeniedError({ code: 'registration_not_available' }),
    )
  })
})

describe('mode-specific public creation', () => {
  it('allows public identity creation only in open mode', async () => {
    await expect(harness('open').decide(attempt('public-sign-up', false))).resolves.toEqual({
      outcome: 'allow-create',
      reason: 'open_registration',
    })
  })

  it.each(['invitation-only', 'closed'] as const)(
    'denies public creation in %s mode',
    async (mode) => {
      await expect(harness(mode).decide(attempt('public-sign-up', false))).rejects.toMatchObject({
        _tag: 'RegistrationDeniedError',
        code: 'registration_not_available',
      })
    },
  )
})

describe('authority and audit behavior', () => {
  it('ignores client query parameters because they are not policy inputs', async () => {
    const clientDecoratedAttempt = {
      ...attempt('public-sign-up', false),
      query: { registrationMode: 'open', invitationValid: 'true' },
    }
    await expect(harness('closed').decide(clientDecoratedAttempt)).rejects.toMatchObject({
      _tag: 'RegistrationDeniedError',
    })
  })

  it('records an allow decision with the injected clock', async () => {
    const test = harness('open')
    const input = attempt('public-sign-up', false)
    await test.decide(input)
    expect(test.audits.get(input.decisionId)).toEqual({
      decisionId: input.decisionId,
      intent: 'public-sign-up',
      mode: 'open',
      identityKnown: false,
      outcome: 'allow-create',
      reason: 'open_registration',
      decidedAtEpochMilliseconds: now,
    })
  })

  it('records a denial before returning its non-disclosing error', async () => {
    const test = harness('invitation-only')
    const input = attempt('public-sign-up', false)
    await expect(test.decide(input)).rejects.toMatchObject({ _tag: 'RegistrationDeniedError' })
    expect(test.audits.get(input.decisionId)?.reason).toBe('public_registration_disabled')
  })

  it('makes a repeated decision stable and delegates audit deduplication by decision ID', async () => {
    const test = harness('open')
    const input = attempt('public-sign-up', false)
    const first = await test.decide(input)
    const second = await test.decide(input)
    expect(second).toEqual(first)
    expect(test.audits.size).toBe(1)
  })

  it('adopts the original protected-state decision after mutable registration facts change', async () => {
    const test = harness('open')
    const initial = attempt('public-sign-up', false)
    const first = await test.decide(initial)
    const replay = await test.decide({ ...initial, identityKnown: true })
    expect(replay).toEqual(first)
    expect(test.audits.size).toBe(1)
  })

  it('fails closed without exposing a policy repository failure', async () => {
    const dependencies = Layer.mergeAll(
      Layer.succeed(RegistrationPolicyRepository, {
        get: Effect.fail(new RegistrationPolicyStoreError()),
      }),
      Layer.succeed(RegistrationClock, { nowEpochMilliseconds: Effect.succeed(now) }),
      Layer.succeed(RegistrationDecisionAuditPort, {
        find: () => Effect.succeed(null),
        record: () => Effect.void,
      }),
    )
    const layer = RegistrationPolicyServiceLive.pipe(Layer.provide(dependencies))
    const result = Effect.gen(function* () {
      return yield* (yield* RegistrationPolicyService).decide(attempt('public-sign-up', false))
    }).pipe(Effect.provide(layer), Effect.runPromise)
    await expect(result).rejects.toEqual(
      new RegistrationPolicyUnavailableError({ code: 'registration_policy_unavailable' }),
    )
  })

  it('fails closed without exposing an audit sink failure', async () => {
    const dependencies = Layer.mergeAll(
      Layer.succeed(RegistrationPolicyRepository, {
        get: Effect.succeed({ mode: 'open' as const }),
      }),
      Layer.succeed(RegistrationClock, { nowEpochMilliseconds: Effect.succeed(now) }),
      Layer.succeed(RegistrationDecisionAuditPort, {
        find: () => Effect.succeed(null),
        record: () => Effect.fail(new RegistrationAuditError()),
      }),
    )
    const layer = RegistrationPolicyServiceLive.pipe(Layer.provide(dependencies))
    const result = Effect.gen(function* () {
      return yield* (yield* RegistrationPolicyService).decide(attempt('public-sign-up', false))
    }).pipe(Effect.provide(layer), Effect.runPromise)
    await expect(result).rejects.toEqual(
      new RegistrationPolicyUnavailableError({ code: 'registration_policy_unavailable' }),
    )
  })
})

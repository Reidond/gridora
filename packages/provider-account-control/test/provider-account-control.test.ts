import { Deferred, Effect, Fiber, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { IdempotencyKey, OperationId, OrganizationContext } from '@gridora/domain'
import { ProviderAuthenticationError, ProviderTemporaryError } from '@gridora/provider-sdk'
import type { SecretEnvelopeServiceShape } from '@gridora/secret-envelope'
import {
  ProviderAccountControl,
  ProviderAccountControlLayer,
  ProviderDiscoverySnapshot,
  ProviderAccountRecord,
  ProviderAccountStoreConflictError,
  ProviderAccountStoreNotFoundError,
  type ProviderAccountActionRepositoryShape,
  type ProviderAccountLifecycleCommand,
  type ProviderAccountReplayQuery,
  type ProviderAccountValidatorShape,
} from '../src/index.js'

const now = '2026-08-23T15:00:00.000Z'
const encoder = new TextEncoder()
const fingerprint = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const organizationContext = (
  role: 'owner' | 'administrator' | 'operator',
  organizationId = 'org-a',
) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'org-a-slug' : 'org-b-slug',
    identityId: `${role}-a`,
    role,
    correlationId: `correlation-${role}`,
  })

const idempotencyKey = (action: string) =>
  Schema.decodeUnknownSync(IdempotencyKey)(`idempotency-${action}`)

const account = (
  status: 'active' | 'disabled' | 'error' = 'active',
  providerType: 'ovhcloud' | 'contabo' = 'ovhcloud',
) =>
  Schema.decodeUnknownSync(ProviderAccountRecord)({
    id: 'account-a',
    scope: 'organization',
    organizationId: 'org-a',
    providerType,
    credentialReference: 'account-a.credentials',
    credentialRevision: 1,
    status,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })

const command = (
  action: string,
  role: 'owner' | 'administrator' | 'operator' = 'owner',
): ProviderAccountLifecycleCommand => {
  const context = organizationContext(role)
  return {
    context,
    accountId: 'account-a',
    expectedRevision: 1,
    idempotencyKey: idempotencyKey(action),
    operationIdempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)('a'.repeat(64)),
    requestFingerprint: fingerprint,
    operationId: Schema.decodeUnknownSync(OperationId)(`operation-${action}`),
    auditEventId: `audit-${action}`,
    auditRequestContext: {
      origin: 'http',
      requestId: `request-${action}`,
      correlationId: context.correlationId,
      source: {
        ip: { state: 'captured', value: '203.0.113.10' },
        access: {
          state: 'captured',
          value: {
            subject: `access-${context.identityId}`,
            identityId: context.identityId,
            issuer: 'https://access.example.test',
            email: `${context.identityId}@example.test`,
          },
        },
      },
    },
    now,
  }
}

const snapshot = Schema.decodeUnknownSync(ProviderDiscoverySnapshot)({
  regions: ['eu-west'],
  projects: ['project-a'],
  catalog: [
    {
      region: 'eu-west',
      plan: 'b2-15',
      currency: 'EUR',
      hourlyPriceMinor: 5,
      monthlyPriceMinor: 2500,
      metadata: {
        cpu: 4,
        memoryMiB: 16_384,
        diskGiB: 160,
        billingKind: 'hourly',
        contractMonths: null,
      },
    },
  ],
})

describe('provider account lifecycle control', () => {
  let current: ProviderAccountRecord | undefined
  let replayed: { query: ProviderAccountReplayQuery; result: unknown } | undefined
  let opened = 0
  let credentialBuffer: Uint8Array | undefined
  let ovhCalls = 0
  let contaboCalls = 0
  let ovhValidator: ProviderAccountValidatorShape
  let contaboValidator: ProviderAccountValidatorShape

  const repository: ProviderAccountActionRepositoryShape = {
    getScoped: (context, accountId) =>
      current !== undefined &&
      current.organizationId === context.organizationId &&
      current.id === accountId
        ? Effect.succeed(current)
        : Effect.fail(new ProviderAccountStoreNotFoundError({ accountId })),
    findReplay: (query) =>
      replayed !== undefined &&
      replayed.query.context.organizationId === query.context.organizationId &&
      replayed.query.idempotencyKey === query.idempotencyKey
        ? replayed.query.action === query.action &&
          replayed.query.accountId === query.accountId &&
          replayed.query.requestFingerprint === query.requestFingerprint
          ? Effect.succeed(replayed.result as never)
          : Effect.fail(
              new ProviderAccountStoreConflictError({
                accountId: query.accountId,
                code: 'idempotency_payload_mismatch',
              }),
            )
        : Effect.succeed(null),
    commit: (input) =>
      Effect.sync(() => {
        replayed = { query: input, result: input.result }
        current =
          input.action === 'remove'
            ? undefined
            : Schema.decodeUnknownSync(ProviderAccountRecord)({
                id: input.account.id,
                scope: input.account.scope,
                organizationId: input.account.organizationId,
                providerType: input.account.providerType,
                credentialReference: input.account.credentialReference,
                credentialRevision: input.result.revision,
                status: input.result.accountStatus,
                revision: input.result.revision,
                createdAt: input.account.createdAt,
                updatedAt: input.result.completedAt,
              })
        return input.result
      }),
  }

  const secrets: SecretEnvelopeServiceShape = {
    seal: () => Effect.die('not used'),
    rotate: () => Effect.die('not used'),
    delete: () => Effect.die('not used'),
    open: () =>
      Effect.sync(() => {
        opened += 1
        credentialBuffer = encoder.encode(
          JSON.stringify({ applicationCredentialSecret: 'credential-canary' }),
        )
        return credentialBuffer
      }),
  }

  const run = <A, E>(effect: Effect.Effect<A, E, ProviderAccountControl>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          ProviderAccountControlLayer({
            repository,
            secrets,
            ovh: ovhValidator,
            contabo: contaboValidator,
          }),
        ),
      ),
    )

  beforeEach(() => {
    current = account()
    replayed = undefined
    opened = 0
    credentialBuffer = undefined
    ovhCalls = 0
    contaboCalls = 0
    ovhValidator = {
      validate: () => {
        ovhCalls += 1
        return Effect.succeed(snapshot)
      },
    }
    contaboValidator = {
      validate: () => {
        contaboCalls += 1
        return Effect.succeed(snapshot)
      },
    }
  })

  it('opens credentials only for the persisted provider validator, zeroes them, and re-enables a disabled account', async () => {
    current = account('disabled', 'ovhcloud')
    const result = await run(
      Effect.flatMap(ProviderAccountControl, (service) =>
        service.test(command('test', 'administrator')),
      ),
    )

    expect(result).toMatchObject({
      providerType: 'ovhcloud',
      outcome: 'valid',
      accountStatus: 'active',
      revision: 2,
      regionCount: 1,
      projectCount: 1,
    })
    expect(opened).toBe(1)
    expect(ovhCalls).toBe(1)
    expect(contaboCalls).toBe(0)
    expect(credentialBuffer).toBeDefined()
    expect([...credentialBuffer!].every((byte) => byte === 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('credential-canary')
    expect(current).toMatchObject({ status: 'active', revision: 2, providerType: 'ovhcloud' })
  })

  it('zeroes opened credential bytes when validation is interrupted', async () => {
    const started = Deferred.makeUnsafe<void>()
    ovhValidator = {
      validate: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
    }
    await run(
      Effect.gen(function* () {
        const service = yield* ProviderAccountControl
        const fiber = yield* Effect.forkChild(service.test(command('interrupted', 'administrator')))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(credentialBuffer).toBeDefined()
    expect([...credentialBuffer!].every((byte) => byte === 0)).toBe(true)
    expect(replayed).toBeUndefined()
  })

  it('normalizes retryable provider failures without retaining raw provider messages', async () => {
    ovhValidator = {
      validate: () =>
        Effect.fail(
          new ProviderTemporaryError({
            provider: 'ovhcloud',
            operation: 'account.test',
            message: 'raw-provider-body credential-canary',
          }),
        ),
    }
    const result = await run(
      Effect.flatMap(ProviderAccountControl, (service) =>
        service.test(command('retryable', 'administrator')),
      ),
    )
    expect(result).toMatchObject({
      outcome: 'retryable_failure',
      failureCategory: 'temporarily_unavailable',
      accountStatus: 'active',
    })
    expect(JSON.stringify({ result, replayed })).not.toContain('raw-provider-body')
    expect(JSON.stringify({ result, replayed })).not.toContain('credential-canary')
    expect([...credentialBuffer!].every((byte) => byte === 0)).toBe(true)
  })

  it('normalizes permanent authentication failure and marks the account unavailable', async () => {
    current = account('disabled')
    ovhValidator = {
      validate: () =>
        Effect.fail(
          new ProviderAuthenticationError({
            provider: 'ovhcloud',
            operation: 'account.test',
            message: 'secret vendor response',
          }),
        ),
    }
    const result = await run(
      Effect.flatMap(ProviderAccountControl, (service) => service.test(command('permanent'))),
    )
    expect(result).toMatchObject({
      outcome: 'permanent_failure',
      failureCategory: 'authentication_failed',
      accountStatus: 'error',
    })
    expect(JSON.stringify(result)).not.toContain('secret vendor response')
    expect(current).toMatchObject({ status: 'error', providerType: 'ovhcloud' })
  })

  it('prevents refresh and provider use while disabled without opening credentials', async () => {
    current = account('disabled')
    await expect(
      run(
        Effect.flatMap(ProviderAccountControl, (service) =>
          service.refresh(command('refresh', 'administrator')),
        ),
      ),
    ).rejects.toMatchObject({ code: 'provider_account_account_not_active' })
    await expect(
      run(
        Effect.flatMap(ProviderAccountControl, (service) =>
          service.assertUsable(organizationContext('owner'), 'account-a', 'ovhcloud'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'provider_account_account_not_active' })
    expect(opened).toBe(0)
    expect(ovhCalls).toBe(0)
  })

  it('requires Administrator for validation and Owner for destructive lifecycle actions', async () => {
    await expect(
      run(
        Effect.flatMap(ProviderAccountControl, (service) =>
          service.test(command('operator-test', 'operator')),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'AuthorizationError', code: 'role_required' })
    await expect(
      run(
        Effect.flatMap(ProviderAccountControl, (service) =>
          service.disable(command('admin-disable', 'administrator')),
        ),
      ),
    ).rejects.toMatchObject({ _tag: 'AuthorizationError', code: 'role_required' })
    expect(opened).toBe(0)
  })

  it('uses the immutable stored provider type and rejects a mismatched provider boundary', async () => {
    current = account('active', 'contabo')
    const result = await run(
      Effect.flatMap(ProviderAccountControl, (service) => service.test(command('contabo'))),
    )
    expect(result.providerType).toBe('contabo')
    expect(ovhCalls).toBe(0)
    expect(contaboCalls).toBe(1)
    expect(current?.providerType).toBe('contabo')

    await expect(
      run(
        Effect.flatMap(ProviderAccountControl, (service) =>
          service.assertUsable(organizationContext('owner'), 'account-a', 'ovhcloud'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'provider_account_provider_type_mismatch' })
  })

  it('returns the exact stored replay without reopening credentials or calling the provider', async () => {
    const lifecycleCommand = command('replay', 'administrator')
    const first = await run(
      Effect.flatMap(ProviderAccountControl, (service) => service.test(lifecycleCommand)),
    )
    const second = await run(
      Effect.flatMap(ProviderAccountControl, (service) => service.test(lifecycleCommand)),
    )
    expect(second).toEqual(first)
    expect(opened).toBe(1)
    expect(ovhCalls).toBe(1)
  })
})

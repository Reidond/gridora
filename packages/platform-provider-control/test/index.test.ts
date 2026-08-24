import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { PlatformActor } from '@gridora/platform-authority'
import {
  PlatformSecretError,
  PlatformSecretRecord,
  type PlatformSecretEnvelopeShape,
} from '@gridora/platform-secret-envelope'
import {
  PlatformProviderAccount,
  PlatformProviderControlError,
  type PlatformProviderRepositoryShape,
  makePlatformProviderControl,
} from '../src/index.js'
import type { ProviderAccountValidatorShape } from '@gridora/provider-account-control'

const now = '2026-08-24T00:00:00.000Z'
const actor = new PlatformActor({
  identityId: 'platform-admin',
  accessSubject: 'access-platform-admin',
  correlationId: 'platform-provider-response-loss',
  administratorRevision: 1,
})
const controlFailure = (operation: string) =>
  new PlatformProviderControlError({ operation, code: 'persistence' })
const secretFailure = (operation: string) =>
  new PlatformSecretError({ operation, code: 'persistence' })

describe('platform provider control', () => {
  it('adopts a committed account after a lost response before validation or a second provider write', async () => {
    let durable: PlatformProviderAccount | undefined
    let accepted:
      | {
          readonly operationId: string
          readonly operationIdempotencyKey: string
          readonly auditEventId: string
          readonly requestFingerprint: string
        }
      | undefined
    let createCalls = 0
    let validationCalls = 0
    const repository: PlatformProviderRepositoryShape = {
      findAccountReplay: () => Effect.succeed(durable ?? null),
      getAccount: () =>
        durable === undefined
          ? Effect.fail(controlFailure('test.getAccount'))
          : Effect.succeed(durable),
      createAccount: (input) =>
        Effect.sync(() => {
          createCalls += 1
          durable = input.account
          accepted = {
            operationId: input.operationId,
            operationIdempotencyKey: input.operationIdempotencyKey,
            auditEventId: input.auditEventId,
            requestFingerprint: input.requestFingerprint,
          }
        }).pipe(Effect.andThen(Effect.fail(controlFailure('test.responseLostAfterCommit')))),
      updateAccount: () => Effect.fail(controlFailure('test.updateAccount')),
      removeAccount: () => Effect.fail(controlFailure('test.removeAccount')),
      findAllocationReplay: () => Effect.succeed(null),
      putAllocation: () => Effect.fail(controlFailure('test.putAllocation')),
    }
    const secrets: PlatformSecretEnvelopeShape = {
      getRecord: () => Effect.fail(secretFailure('test.getRecord')),
      prepareSeal: (input) =>
        Effect.succeed(
          new PlatformSecretRecord({
            id: input.id,
            accountId: input.accountId,
            ciphertext: 'ciphertext',
            wrappedDataKey: 'wrapped-key',
            keyVersion: 1,
            revision: 1,
            createdAt: input.now,
            rotatedAt: null,
          }),
        ),
      prepareRotation: () => Effect.fail(secretFailure('test.prepareRotation')),
      seal: () => Effect.fail(secretFailure('test.seal')),
      open: () => Effect.fail(secretFailure('test.open')),
      rotate: () => Effect.fail(secretFailure('test.rotate')),
      remove: () => Effect.fail(secretFailure('test.remove')),
    }
    const validator: ProviderAccountValidatorShape = {
      validate: () =>
        Effect.sync(() => {
          validationCalls += 1
        }).pipe(Effect.as({ regions: [], projects: [], catalog: [] })),
    }
    const control = makePlatformProviderControl(repository, secrets, () => validator)
    const command = () => ({
      actor,
      idempotencyKey: 'platform-provider-replay-key',
      requestFingerprint: 'a'.repeat(64),
      operationId: 'platform-operation-response-loss',
      operationIdempotencyKey: 'b'.repeat(64),
      auditEventId: 'platform-audit-response-loss',
      now,
      accountId: 'platform-ovh',
      providerType: 'ovhcloud' as const,
      credentials: Uint8Array.from([1, 2, 3]),
    })

    await expect(Effect.runPromise(control.add(command()))).rejects.toMatchObject({
      code: 'persistence',
    })
    const replay = await Effect.runPromise(control.add(command()))

    expect(replay).toEqual(durable)
    expect(createCalls).toBe(1)
    expect(validationCalls).toBe(1)
    expect(accepted).toEqual({
      operationId: 'platform-operation-response-loss',
      operationIdempotencyKey: 'b'.repeat(64),
      auditEventId: 'platform-audit-response-loss',
      requestFingerprint: 'a'.repeat(64),
    })
  })
})

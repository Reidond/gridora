import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type { KekPortShape } from '@gridora/secret-envelope'
import {
  makePlatformSecretEnvelope,
  PlatformSecretError,
  PlatformSecretRecord,
  type PlatformSecretRepositoryShape,
} from '../src/index.js'

const kek: KekPortShape = {
  activeKeyVersion: Effect.succeed(1),
  wrap: (_version, key) => Effect.succeed(key.slice()),
  unwrap: (_version, key) => Effect.succeed(key.slice()),
}
const repository = (): {
  readonly repo: PlatformSecretRepositoryShape
  readonly record: () => PlatformSecretRecord | undefined
} => {
  let stored: PlatformSecretRecord | undefined
  return {
    record: () => stored,
    repo: {
      create: (record) => {
        stored = record
        return Effect.succeed(record)
      },
      get: () =>
        stored === undefined
          ? Effect.fail(new PlatformSecretError({ operation: 'get', code: 'not_found' }))
          : Effect.succeed(stored),
      replace: (record) => {
        stored = record
        return Effect.succeed(record)
      },
      remove: () => {
        stored = undefined
        return Effect.void
      },
    },
  }
}

describe('platform secret envelope', () => {
  it('encrypts without persisting a plaintext canary and clears caller bytes', async () => {
    const storage = repository()
    const service = makePlatformSecretEnvelope(storage.repo, kek)
    const plaintext = new TextEncoder().encode('platform-secret-canary')
    await Effect.runPromise(
      service.seal({ id: 'envelope-a', accountId: 'account-a', plaintext, now: 'now' }),
    )
    expect(plaintext.every((byte) => byte === 0)).toBe(true)
    expect(JSON.stringify(storage.record())).not.toContain('platform-secret-canary')
    const opened = await Effect.runPromise(service.open('account-a'))
    expect(new TextDecoder().decode(opened)).toBe('platform-secret-canary')
    opened.fill(0)
  })

  it('authenticates account scope and refuses cross-account opening', async () => {
    const storage = repository()
    const service = makePlatformSecretEnvelope(storage.repo, kek)
    await Effect.runPromise(
      service.seal({
        id: 'envelope-a',
        accountId: 'account-a',
        plaintext: new TextEncoder().encode('secret'),
        now: 'now',
      }),
    )
    await expect(Effect.runPromise(service.open('account-b'))).rejects.toMatchObject({
      code: 'integrity',
    })
  })

  it('maps a malformed wrapped key to a typed integrity error', async () => {
    const storage = repository()
    const service = makePlatformSecretEnvelope(storage.repo, kek)
    await Effect.runPromise(
      storage.repo.create(
        new PlatformSecretRecord({
          id: 'envelope-a',
          accountId: 'account-a',
          ciphertext: 'v1.bad.bad',
          wrappedDataKey: '*not-base64*',
          keyVersion: 1,
          revision: 1,
          createdAt: 'now',
          rotatedAt: null,
        }),
      ),
    )
    await expect(Effect.runPromise(service.open('account-a'))).rejects.toMatchObject({
      _tag: 'PlatformSecretError',
      code: 'integrity',
    })
  })
})

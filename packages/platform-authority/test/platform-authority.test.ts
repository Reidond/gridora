import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { makePlatformAuthorityD1, PlatformAuthorizationError } from '../src/index.js'

const database = (value: unknown) => ({
  prepare: () => ({ bind: () => ({ first: async () => value }) }),
})
describe('platform authority', () => {
  it('requires a separate active platform grant and active global identity', async () => {
    const missing = makePlatformAuthorityD1(
      database({ identityId: 'i', accessSubject: 's', identityStatus: 'active' }),
    )
    await expect(
      Effect.runPromise(missing.authorize({ accessSubject: 's', correlationId: 'c' })),
    ).rejects.toBeInstanceOf(PlatformAuthorizationError)
    const suspended = makePlatformAuthorityD1(
      database({
        identityId: 'i',
        accessSubject: 's',
        identityStatus: 'suspended',
        administratorStatus: 'active',
        administratorRevision: 1,
      }),
    )
    await expect(
      Effect.runPromise(suspended.authorize({ accessSubject: 's', correlationId: 'c' })),
    ).rejects.toMatchObject({ code: 'identity_inactive' })
  })
  it('does not consult organization membership', async () => {
    const authority = makePlatformAuthorityD1(
      database({
        identityId: 'i',
        accessSubject: 's',
        identityStatus: 'active',
        administratorStatus: 'active',
        administratorRevision: 2,
      }),
    )
    await expect(
      Effect.runPromise(authority.authorize({ accessSubject: 's', correlationId: 'c' })),
    ).resolves.toMatchObject({ identityId: 'i', administratorRevision: 2 })
  })
})

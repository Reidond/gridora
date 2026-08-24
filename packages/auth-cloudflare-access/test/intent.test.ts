import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { signAuthenticationIntent, verifyAuthenticationIntent } from '../src/index.js'

describe('authentication intents', () => {
  const secret = 'test-secret-with-at-least-thirty-two-bytes'
  it('signs an expiring same-origin return target bound to CSRF', async () => {
    const intent = {
      intent: 'sign-up' as const,
      returnTo: '/setup/organization',
      csrf: 'csrf_1',
      nonce: 'nonce_1',
      expiresAt: Date.now() + 60_000,
    }
    const token = await Effect.runPromise(signAuthenticationIntent(intent, secret))
    await expect(
      Effect.runPromise(verifyAuthenticationIntent(token, secret, 'csrf_1')),
    ).resolves.toEqual(intent)
    await expect(
      Effect.runPromise(verifyAuthenticationIntent(token, secret, 'csrf_2')),
    ).rejects.toBeDefined()
  })

  it('rejects protocol-relative return targets', async () => {
    await expect(
      Effect.runPromise(
        signAuthenticationIntent(
          {
            intent: 'sign-in',
            returnTo: '//evil.example',
            csrf: 'csrf',
            nonce: 'nonce',
            expiresAt: Date.now() + 60_000,
          },
          secret,
        ),
      ),
    ).rejects.toBeDefined()
  })

  it.each([
    '/%2f%2fevil.example',
    '/%5cevil',
    '/cdn-cgi/access/callback',
    '/v1/auth/sign-up/complete',
    '/unknown',
  ])('rejects a non-allowlisted return target %s', async (returnTo) => {
    await expect(
      Effect.runPromise(
        signAuthenticationIntent(
          {
            intent: 'sign-in',
            returnTo,
            csrf: 'csrf',
            nonce: 'nonce',
            expiresAt: Date.now() + 60_000,
          },
          secret,
        ),
      ),
    ).rejects.toBeDefined()
  })
})

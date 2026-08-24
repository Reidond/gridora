import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  AutomationCredentialAuthenticationPersistenceError,
  WebCryptoAutomationCredentialIssuer,
  isAutomationCredentialHash,
  makeAutomationCredentialAuthenticator,
  type AutomationCredentialCryptography,
} from '../src/index.js'
import { AutomationCredentialId, IsoDateTime } from '@gridora/domain'
import { AutomationIdentityPersistenceError } from '@gridora/automation-identity-control'

const credentialId = Schema.decodeUnknownSync(AutomationCredentialId)(
  'automation_credential_aaaaaaaaaaaaaaaa',
)
const now = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:00:00.000Z')

describe('automation credential cryptography boundary', () => {
  it('issues 256-bit random bearer secret text and only a fixed-size verifier for persistence', async () => {
    const first = await Effect.runPromise(
      WebCryptoAutomationCredentialIssuer.issue({
        clientId: 'automation_client_aaaaaaaaaaaaaaaa',
        credentialId,
      }),
    )
    const second = await Effect.runPromise(
      WebCryptoAutomationCredentialIssuer.issue({
        clientId: 'automation_client_aaaaaaaaaaaaaaaa',
        credentialId,
      }),
    )
    expect(first.credential).toMatch(
      /^grda\.v1\.automation_client_aaaaaaaaaaaaaaaa\.automation_credential_aaaaaaaaaaaaaaaa\.[A-Za-z0-9_-]{43}$/,
    )
    expect(first.credential).not.toBe(second.credential)
    expect(isAutomationCredentialHash(first.credentialHash)).toBe(true)
    expect(first.credentialHash).not.toBe(first.credential)
  })

  it('maps cryptography failures to the narrow public authentication persistence error', async () => {
    const cryptography: AutomationCredentialCryptography = {
      hash: () =>
        Effect.fail(new AutomationIdentityPersistenceError({ operation: 'unsafe-crypto-detail' })),
      timingSafeEqual: () => Effect.die('not reached'),
    }
    const authenticator = makeAutomationCredentialAuthenticator({
      cryptography,
      clock: { now: Effect.succeed(now) },
      repository: {
        findForAuthentication: () => Effect.die('not reached'),
        consumeRateLimit: () => Effect.die('not reached'),
        touchLastUse: () => Effect.die('not reached'),
      },
    })
    await expect(
      Effect.runPromise(
        authenticator.authenticate({
          authorization: 'Bearer malformed',
          organization: 'organization-a',
          requiredScope: 'servers.read',
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'AutomationCredentialAuthenticationPersistenceError',
      operation: 'automationCredential.authentication.hash',
    } satisfies Partial<AutomationCredentialAuthenticationPersistenceError>)
  })
})

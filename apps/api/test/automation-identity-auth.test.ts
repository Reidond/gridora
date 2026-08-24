import { Effect, Schema } from 'effect'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  AutomationCredentialAuthenticationError,
  type AutomationCredentialAuthenticatorShape,
  type AutomationCredentialPrincipal,
} from '@gridora/automation-identity-auth'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  OrganizationId,
  OrganizationSlug,
} from '@gridora/domain'
import {
  authenticateAutomationCredentialRequest,
  automationCredentialAuthenticationResponse,
} from '../src/automation-identity-auth.js'

type TestEnv = { Bindings: Record<string, never> }

const principal: AutomationCredentialPrincipal = {
  authenticationType: 'automation-credential',
  organizationId: Schema.decodeUnknownSync(OrganizationId)('org-a'),
  organizationSlug: Schema.decodeUnknownSync(OrganizationSlug)('organization-a'),
  automationIdentityId: Schema.decodeUnknownSync(AutomationIdentityId)(
    'automation_identity_aaaaaaaaaaaaaaaa',
  ),
  clientId: 'automation_client_aaaaaaaaaaaaaaaa',
  credentialId: Schema.decodeUnknownSync(AutomationCredentialId)(
    'automation_credential_aaaaaaaaaaaaaaaa',
  ),
  credentialVersion: 1,
  identityRevision: 1,
  scopes: ['servers.read'],
  capabilities: ['servers.read'],
}

describe('automation credential request adapter', () => {
  it('uses only the Authorization credential and returns a machine principal, not a human role', async () => {
    let captured:
      | {
          readonly authorization: string | undefined
          readonly organization: string
          readonly requiredScope: string
        }
      | undefined
    const authenticator: AutomationCredentialAuthenticatorShape = {
      authenticate: (input) => {
        captured = input
        return Effect.succeed(principal)
      },
    }
    const app = new Hono<TestEnv>()
    app.get('/v1/organizations/:organization/servers', async (context) => {
      const result = await Effect.runPromise(
        authenticateAutomationCredentialRequest(
          context,
          { authenticator: () => Effect.succeed(authenticator) },
          'servers.read',
        ),
      )
      return context.json(result)
    })

    const response = await app.request(
      'https://api.gridora.test/v1/organizations/organization-a/servers',
      {
        headers: {
          authorization: 'Bearer grda.v1.example',
          'cf-access-jwt-assertion': 'a-human-access-assertion-must-not-be-used-here',
        },
      },
      {},
    )
    expect(response.status).toBe(200)
    expect(captured).toEqual({
      authorization: 'Bearer grda.v1.example',
      organization: 'organization-a',
      requiredScope: 'servers.read',
    })
    const body = await response.json()
    expect(body).toMatchObject({
      authenticationType: 'automation-credential',
      organizationId: 'org-a',
    })
    expect(body).not.toHaveProperty('role')
    expect(body).not.toHaveProperty('identityId')
  })

  it('uses the same generic public response for absent and forged cross-tenant credentials', async () => {
    const invalid = new AutomationCredentialAuthenticationError({ reason: 'invalid_credential' })
    const absent = await automationCredentialAuthenticationResponse(invalid, 'request-1').text()
    const forged = await automationCredentialAuthenticationResponse(invalid, 'request-1').text()
    expect(forged).toBe(absent)
    expect(forged).not.toContain('organization-a')
    expect(forged).not.toContain('automation_client_')

    const response = automationCredentialAuthenticationResponse(invalid, 'request-2')
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(response.headers.get('content-type')).toContain('application/problem+json')
  })

  it('does not use a Cloudflare Access assertion as a credential', async () => {
    let authorization: string | undefined = 'not-set'
    const app = new Hono<TestEnv>()
    app.get('/v1/organizations/:organization/servers', async (context) => {
      await Effect.runPromise(
        authenticateAutomationCredentialRequest(
          context,
          {
            authenticator: () =>
              Effect.succeed({
                authenticate: (input) => {
                  authorization = input.authorization
                  return Effect.fail(
                    new AutomationCredentialAuthenticationError({ reason: 'missing_credential' }),
                  )
                },
              }),
          },
          'servers.read',
        ).pipe(Effect.catch(() => Effect.void)),
      )
      return context.text('ok')
    })
    const response = await app.request(
      'https://api.gridora.test/v1/organizations/organization-a/servers',
      { headers: { 'cf-access-jwt-assertion': 'access-only' } },
      {},
    )
    expect(response.status).toBe(200)
    expect(authorization).toBeUndefined()
  })
})

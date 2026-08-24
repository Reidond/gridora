import { Effect, Layer, Schema } from 'effect'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, InvitationError } from '@gridora/contracts'
import { Identity, OrganizationMembership } from '@gridora/domain'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { registerInvitationAcceptanceRoutes } from '../src/invitation-acceptance-routes.js'

type TestEnv = { Bindings: Record<string, never> }

const runtime = makeWorkerEffectRuntime(Layer.empty)
const token = 'a'.repeat(64)
const identity = Schema.decodeUnknownSync(Identity)({
  id: 'identity-a',
  accessSubject: 'access-subject-a',
  email: 'member@example.com',
  displayName: 'Member',
  status: 'active',
  signedUpAt: '2026-08-23T12:00:00.000Z',
  lastLoginAt: '2026-08-23T12:00:00.000Z',
})
const membership = Schema.decodeUnknownSync(OrganizationMembership)({
  organizationId: 'org-a',
  identityId: identity.id,
  role: 'viewer',
  status: 'active',
  joinedAt: '2026-08-23T12:00:00.000Z',
  invitedBy: 'owner-a',
  revision: 1,
})

let app: Hono<TestEnv>
let authenticated = true
let acceptanceError: InvitationError | undefined
let accepted: Array<{ readonly identity: Identity; readonly token: string }>

describe('existing-identity invitation acceptance route', () => {
  beforeEach(() => {
    authenticated = true
    acceptanceError = undefined
    accepted = []
    app = new Hono<TestEnv>()
    registerInvitationAcceptanceRoutes(app, {
      runtimeFor: () => runtime,
      authenticatedIdentity: () =>
        authenticated
          ? Effect.succeed(identity)
          : Effect.fail(
              new ConflictError({
                code: 'account_not_found',
                message: 'Complete sign-up before using Gridora',
              }),
            ),
      acceptInvitation: (_context, authenticatedIdentity, pathToken) => {
        accepted.push({ identity: authenticatedIdentity, token: pathToken })
        return acceptanceError === undefined
          ? Effect.succeed({
              operationId: 'operation-accept',
              resourceId: 'invite-a',
              status: 'succeeded',
              links: { operation: '/v1/organizations/org-a/operations/operation-accept' },
            })
          : Effect.fail(acceptanceError)
      },
    })
  })

  afterAll(() => runtime.dispose())

  it('accepts with the authenticated existing identity and only the path token', async () => {
    const response = await app.request(
      `https://api.gridora.test/v1/invitations/${token}/actions/accept`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'body-token-must-not-be-used' }),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    await expect(response.json()).resolves.toEqual({
      operationId: 'operation-accept',
      resourceId: 'invite-a',
      status: 'succeeded',
      links: { operation: '/v1/organizations/org-a/operations/operation-accept' },
    })
    expect(accepted).toEqual([{ identity, token }])
    expect(JSON.stringify(membership)).not.toContain(token)
  })

  it('rejects malformed path tokens before invitation lookup', async () => {
    for (const malformed of ['short', 'A'.repeat(64), `${'a'.repeat(63)}!`]) {
      const response = await app.request(
        `https://api.gridora.test/v1/invitations/${malformed}/actions/accept`,
        { method: 'POST' },
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' })
    }
    expect(accepted).toEqual([])
  })

  it('does not mutate membership for an Access identity without a local account', async () => {
    authenticated = false
    const response = await app.request(
      `https://api.gridora.test/v1/invitations/${token}/actions/accept`,
      { method: 'POST' },
    )
    expect(response.status).toBe(409)
    expect(accepted).toEqual([])
  })

  it.each(['expired', 'revoked', 'accepted', 'email_mismatch', 'invalid_token'] as const)(
    'preserves the domain %s rejection',
    async (code) => {
      acceptanceError = new InvitationError({ code })
      const response = await app.request(
        `https://api.gridora.test/v1/invitations/${token}/actions/accept`,
        { method: 'POST' },
      )
      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toMatchObject({ code: 'INVITATION_INVALID' })
      expect(accepted).toHaveLength(1)
    },
  )
})

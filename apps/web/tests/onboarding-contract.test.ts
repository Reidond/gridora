import { describe, expect, it, vi } from 'vitest'
import { createAuthenticationApi } from '../services/gridora-api'

const identity = {
  id: 'identity_01',
  accessSubject: 'access-subject-01',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  status: 'active',
}

const jsonBody = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body')
  return JSON.parse(init.body) as unknown
}

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input

describe('opaque authentication state contract', () => {
  it('keeps profile data in the API request and sends only state to completion', async () => {
    const responses = [
      { state: 'state_opaque-01', expiresAt: Date.now() + 300_000 },
      { intent: 'sign-up', next: 'setup-organization', returnTo: '/setup/organization', identity },
    ]
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const auth = createAuthenticationApi('https://api.gridora.test', fetchMock)

    const issued = await auth.create({
      intent: 'sign-up',
      returnTo: '/setup/organization',
      displayName: 'Alex Morgan',
    })
    const completed = await auth.complete(issued.state)

    expect(completed.next).toBe('setup-organization')
    const begin = fetchMock.mock.calls[0]!
    expect(jsonBody(begin[1])).toEqual({
      intent: 'sign-up',
      returnTo: '/setup/organization',
      displayName: 'Alex Morgan',
    })
    expect(begin[1]?.credentials).toBe('include')
    const completion = fetchMock.mock.calls[1]!
    expect(completion[0]).toBe('https://api.gridora.test/v1/auth/complete')
    expect(jsonBody(completion[1])).toEqual({})
    const headers = new Headers(completion[1]?.headers)
    expect(headers.get('x-gridora-auth-state')).toBe('state_opaque-01')
    expect(JSON.stringify(completion[1])).not.toContain('Alex Morgan')
    expect(JSON.stringify(completion[1])).not.toContain('invitation')
  })

  it('forwards the invitation only while issuing server-side state', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ state: 'state_invite-01', expiresAt: Date.now() + 300_000 }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    )
    const auth = createAuthenticationApi('https://api.gridora.test', fetchMock)
    await auth.create({
      intent: 'accept-invitation',
      returnTo: '/',
      invitationToken: 'raw-secret-token',
    })
    const request = fetchMock.mock.calls[0]!
    expect(jsonBody(request[1])).toMatchObject({
      invitationToken: 'raw-secret-token',
    })
    expect(requestUrl(request[0])).not.toContain('raw-secret-token')
  })
})

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { signRealtimeTicket, verifyRealtimeTicket } from '../src/ticket.js'

describe('realtime tickets', () => {
  it('binds a short-lived ticket to one organization and resource', async () => {
    const claims = {
      organizationId: 'org_1',
      principalId: 'identity_1',
      audience: 'console' as const,
      resourceType: 'organization' as const,
      resourceId: 'org_1',
      machineId: null,
      sessionVersion: 1,
      expiresAt: Date.now() + 60_000,
      nonce: crypto.randomUUID(),
    }
    const ticket = await Effect.runPromise(
      signRealtimeTicket(claims, 'a-test-secret-with-enough-entropy'),
    )
    await expect(
      Effect.runPromise(
        verifyRealtimeTicket(ticket, 'a-test-secret-with-enough-entropy', {
          organizationId: 'org_1',
          resourceType: 'organization',
          resourceId: 'org_1',
        }),
      ),
    ).resolves.toMatchObject({ organizationId: 'org_1' })
    await expect(
      Effect.runPromise(
        verifyRealtimeTicket(ticket, 'a-test-secret-with-enough-entropy', {
          organizationId: 'org_2',
          resourceType: 'organization',
          resourceId: 'org_2',
        }),
      ),
    ).rejects.toBeDefined()
  })
})

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  makeLogMonitoringRealtime,
  type LiveLogStreamStub,
} from '../src/log-monitoring-realtime.js'
import type { LiveLogTicketClaim } from '@gridora/realtime'

const secret = 'realtime-live-log-secret-with-at-least-32-bytes'
const now = Date.now()

class FakeStream implements LiveLogStreamStub {
  readonly initialized: Array<readonly [string, string, string, string, number, number, number]> =
    []
  readonly claims: string[] = []
  readonly requests: Request[] = []
  #used = new Set<string>()

  initialize(
    organizationId: string,
    serverId: string,
    streamEpoch: string,
    principalId: string,
    revision: number,
    membershipAuthorizationGeneration: number,
    organizationAuthorizationGeneration: number,
  ): Promise<boolean> {
    this.initialized.push([
      organizationId,
      serverId,
      streamEpoch,
      principalId,
      revision,
      membershipAuthorizationGeneration,
      organizationAuthorizationGeneration,
    ])
    return Promise.resolve(true)
  }

  claimTicket(input: LiveLogTicketClaim): Promise<boolean> {
    if (this.#used.has(input.nonce)) return Promise.resolve(false)
    this.#used.add(input.nonce)
    this.claims.push(input.nonce)
    return Promise.resolve(true)
  }

  fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    return Promise.resolve(new Response('upgrade forwarded'))
  }
}

describe('log monitoring realtime composition', () => {
  it('binds issue, claim, and upgrade to one tenant/server DO', async () => {
    const stream = new FakeStream()
    const composition = makeLogMonitoringRealtime({
      secret,
      liveLogStream: {
        getByName: (name) => {
          expect(name).toBe('org-a:logs:server-a:deployment-a')
          return stream
        },
      },
      now: () => now,
      nonce: () => '00000000-0000-4000-8000-000000000001',
    })
    const issued = await Effect.runPromise(
      composition.ticketIssuer.issue({
        organizationId: 'org-a',
        serverId: 'server-a',
        streamEpoch: 'deployment-a',
        principalId: 'identity-a',
        membershipRevision: 4,
        membershipAuthorizationGeneration: 7,
        organizationAuthorizationGeneration: 3,
        now,
      }),
    )
    expect(stream.initialized).toEqual([
      ['org-a', 'server-a', 'deployment-a', 'identity-a', 4, 7, 3],
    ])
    const claims = await Effect.runPromise(
      composition.ticketVerifier.verify({
        ticket: issued.ticket,
        organizationId: 'org-a',
        serverId: 'server-a',
        streamEpoch: 'deployment-a',
        now,
      }),
    )
    await Effect.runPromise(
      composition.ticketVerifier.consume({
        claims,
        organizationId: 'org-a',
        serverId: 'server-a',
        streamEpoch: 'deployment-a',
        now,
      }),
    )
    await expect(
      Effect.runPromise(
        composition.ticketVerifier.consume({
          claims,
          organizationId: 'org-a',
          serverId: 'server-a',
          streamEpoch: 'deployment-a',
          now,
        }),
      ),
    ).rejects.toMatchObject({ operation: 'liveLogs.consumeTicket' })
    await expect(composition.stream.open(claims, issued.ticket)).resolves.toMatchObject({
      status: 200,
    })
    expect(new URL(stream.requests[0]!.url).searchParams.get('ticket')).toBe(issued.ticket)
    expect(stream.requests[0]!.headers.get('authorization')).toBeNull()
  })

  it('rejects a forged organization/server scope before touching the DO', async () => {
    const stream = new FakeStream()
    const composition = makeLogMonitoringRealtime({
      secret,
      liveLogStream: { getByName: () => stream },
      now: () => now,
      nonce: () => '00000000-0000-4000-8000-000000000002',
    })
    const issued = await Effect.runPromise(
      composition.ticketIssuer.issue({
        organizationId: 'org-a',
        serverId: 'server-a',
        streamEpoch: 'deployment-a',
        principalId: 'identity-a',
        membershipRevision: 1,
        membershipAuthorizationGeneration: 1,
        organizationAuthorizationGeneration: 1,
        now,
      }),
    )
    await expect(
      Effect.runPromise(
        composition.ticketVerifier.verify({
          ticket: issued.ticket,
          organizationId: 'org-b',
          serverId: 'server-a',
          streamEpoch: 'deployment-a',
          now,
        }),
      ),
    ).rejects.toMatchObject({ operation: 'liveLogs.verifyTicket' })
    expect(stream.claims).toHaveLength(0)
  })
})

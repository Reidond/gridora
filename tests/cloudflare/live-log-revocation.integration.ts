/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers'
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  signRealtimeTicket,
  LIVE_LOG_LIMITS,
  type LiveLogPublication,
  type LiveLogStreamDO,
  type LiveLogTicketClaim,
} from '../../workers/realtime/src/index.js'

const organizationId = 'organization-a'
const serverId = 'server-a'
const streamEpoch = 'deployment-a'
const principalId = 'identity-a'

const claim = (
  membershipRevision: number,
  membershipAuthorizationGeneration: number,
  organizationAuthorizationGeneration: number,
  options: { readonly principalId?: string; readonly nonce?: string } = {},
): LiveLogTicketClaim => ({
  organizationId,
  serverId,
  streamEpoch,
  principalId: options.principalId ?? principalId,
  membershipRevision,
  membershipAuthorizationGeneration,
  organizationAuthorizationGeneration,
  nonce:
    options.nonce ??
    `nonce-${membershipRevision}-${membershipAuthorizationGeneration}-${organizationAuthorizationGeneration}-abcdef`,
  expiresAt: Date.now() + 60_000,
})

const publication = (
  organization: string,
  server: string,
  epoch: string,
  archiveId: string,
  sequence: number,
): LiveLogPublication => ({
  organizationId: organization,
  serverId: server,
  streamEpoch: epoch,
  nodeId: 'node-a',
  archiveId,
  archiveSha256: `sha256:${'a'.repeat(64)}`,
  entries: [
    {
      organizationId: organization,
      nodeId: 'node-a',
      serverId: server,
      component: 'game',
      level: 'info',
      timestamp: '2026-08-24T12:00:00.000Z',
      sequence,
      message: 'started',
    },
  ],
})

const signedClaim = async (input: LiveLogTicketClaim): Promise<string> =>
  Effect.runPromise(
    signRealtimeTicket(
      {
        organizationId: input.organizationId,
        principalId: input.principalId,
        audience: 'console',
        resourceType: 'resource',
        resourceId: JSON.stringify([input.serverId, input.streamEpoch]),
        machineId: null,
        sessionVersion: input.membershipRevision,
        membershipAuthorizationGeneration: input.membershipAuthorizationGeneration,
        organizationAuthorizationGeneration: input.organizationAuthorizationGeneration,
        expiresAt: input.expiresAt,
        nonce: input.nonce,
      },
      'integration-test-only-secret',
    ),
  )

const closeClients = (clients: ReadonlyArray<WebSocket>): void => {
  for (const client of clients) client.close(1000, 'test complete')
}

describe('live-log authorization Durable Object races', () => {
  it('uses a native Durable Object transaction and adopts a response-lost archive replay exactly once', async () => {
    const publishOrganizationId = 'organization-publish'
    const publishServerId = 'server-publish'
    const publishEpoch = 'deployment-publish'
    const namespace = env.LIVE_LOG_STREAM as DurableObjectNamespace<LiveLogStreamDO>
    const stream = namespace.getByName(
      `${publishOrganizationId}:logs:${publishServerId}:${publishEpoch}`,
    )
    expect(
      await stream.initialize(
        publishOrganizationId,
        publishServerId,
        publishEpoch,
        'identity-publish',
        1,
        1,
        1,
      ),
    ).toBe(true)
    const input = publication(
      publishOrganizationId,
      publishServerId,
      publishEpoch,
      'archive_publish',
      1,
    )

    // The first caller loses its response after the Durable Object persists;
    // eviction proves the later Queue retry reads only durable dedupe evidence.
    await expect(stream.publish(input)).resolves.toEqual({
      accepted: true,
      replayed: false,
      firstSequence: 1,
      lastSequence: 1,
    })
    await evictDurableObject(stream)
    await expect(stream.publish(input)).resolves.toEqual({
      accepted: false,
      replayed: true,
      firstSequence: 1,
      lastSequence: 1,
    })
    const persisted = await runInDurableObject(stream, async (_instance, durableState) => ({
      events: durableState.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_events')
        .toArray()[0]?.count,
      archives: durableState.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_archives')
        .toArray()[0]?.count,
    }))
    expect(persisted).toEqual({ events: 1, archives: 1 })
  })

  it('replays committed revocation cleanup after a loss and never broadcasts to the fenced socket', async () => {
    const faultOrganizationId = 'organization-fault'
    const faultServerId = 'server-fault'
    const faultEpoch = 'deployment-fault'
    const faultPrincipalId = 'identity-fault'
    const namespace = env.LIVE_LOG_STREAM as DurableObjectNamespace<LiveLogStreamDO>
    const stream = namespace.getByName(`${faultOrganizationId}:logs:${faultServerId}:${faultEpoch}`)
    expect(
      await stream.initialize(
        faultOrganizationId,
        faultServerId,
        faultEpoch,
        faultPrincipalId,
        1,
        1,
        1,
      ),
    ).toBe(true)
    const ticketClaim: LiveLogTicketClaim = {
      organizationId: faultOrganizationId,
      serverId: faultServerId,
      streamEpoch: faultEpoch,
      principalId: faultPrincipalId,
      membershipRevision: 1,
      membershipAuthorizationGeneration: 1,
      organizationAuthorizationGeneration: 1,
      nonce: 'fault-cleanup-nonce-abcdef',
      expiresAt: Date.now() + 60_000,
    }
    expect(await stream.claimTicket(ticketClaim)).toBe(true)
    const ticket = await signedClaim(ticketClaim)
    const upgrade = await stream.fetch(
      `https://live-log.test/?ticket=${encodeURIComponent(ticket)}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(upgrade.status).toBe(101)
    await expect(
      runInDurableObject(
        stream,
        async (_instance, durableState) => durableState.getWebSockets('console').length,
      ),
    ).resolves.toBe(1)
    const client = upgrade.webSocket
    if (client === null) throw new Error('Workers runtime did not return a WebSocket')
    client.accept()
    const delivered: string[] = []
    client.addEventListener('message', (event) => delivered.push(String(event.data)))
    const socketClosed = new Promise<void>((resolve) => {
      client.addEventListener('close', () => resolve(), { once: true })
    })

    await stream.armAuthorizationCleanupFailureForTest()
    // The harness returns normally to model a caller that lost the outcome;
    // its injected process loss happens after the durable state commit and
    // before non-durable ticket/socket cleanup.
    await expect(
      stream.synchronizePrincipalAuthorization(
        faultOrganizationId,
        faultServerId,
        faultEpoch,
        faultPrincipalId,
        2,
        2,
        'revoked',
      ),
    ).resolves.toBeUndefined()
    const afterLoss = await runInDurableObject(stream, async (_instance, durableState) => ({
      authorization: await durableState.storage.get<{
        readonly generation: number
        readonly revision: number
        readonly state: string
      }>(`membership_authorization:${faultPrincipalId}`),
      tickets: durableState.storage.sql
        .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_tickets')
        .toArray()[0]?.count,
      sockets: durableState.getWebSockets('console').length,
    }))
    expect(afterLoss).toEqual({
      authorization: { generation: 2, revision: 2, state: 'revoked' },
      tickets: 1,
      sockets: 1,
    })

    // Socket cleanup is deliberately not the authorization boundary. The
    // publication path rereads durable state and closes the stale connection
    // instead of sending a frame while the failed cleanup is retried.
    await expect(
      stream.publish(
        publication(faultOrganizationId, faultServerId, faultEpoch, 'archive_fault', 1),
      ),
    ).resolves.toMatchObject({ accepted: true, replayed: false })
    await expect(socketClosed).resolves.toBeUndefined()
    expect(delivered).toEqual([])

    await expect(
      stream.synchronizePrincipalAuthorization(
        faultOrganizationId,
        faultServerId,
        faultEpoch,
        faultPrincipalId,
        2,
        2,
        'revoked',
      ),
    ).resolves.toBeUndefined()
    await expect(
      runInDurableObject(
        stream,
        async (_instance, durableState) =>
          durableState.storage.sql
            .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_tickets')
            .toArray()[0]?.count,
      ),
    ).resolves.toBe(0)
  })

  it('never lets a delayed pre-revocation initialize resurrect a membership or terminal organization', async () => {
    const namespace = env.LIVE_LOG_STREAM as DurableObjectNamespace<LiveLogStreamDO>
    const stream = namespace.getByName(`${organizationId}:logs:${serverId}:${streamEpoch}`)

    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 1, 1, 1),
    ).toBe(true)
    expect(await stream.claimTicket(claim(1, 1, 1))).toBe(true)

    // This is the committed outbox authority. The following initialize models
    // a ticket request that passed its HTTP authorization before the revoke,
    // then arrived at the DO after that committed authority.
    await stream.synchronizePrincipalAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      principalId,
      2,
      2,
      'revoked',
    )
    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 1, 1, 1),
    ).toBe(false)
    expect(await stream.claimTicket(claim(1, 1, 1))).toBe(false)

    // A legitimate regrant has a strictly newer D1 generation. It can reopen
    // only that principal and leaves every earlier ticket generation invalid.
    await stream.synchronizePrincipalAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      principalId,
      3,
      3,
      'active',
    )
    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 3, 3, 1),
    ).toBe(true)
    expect(await stream.claimTicket(claim(1, 1, 1))).toBe(false)
    expect(await stream.claimTicket(claim(3, 3, 1))).toBe(true)

    await stream.synchronizeOrganizationAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      2,
      'suspended',
    )
    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 3, 3, 1),
    ).toBe(false)

    // Reactivation is allowed only at a strictly greater authoritative
    // generation. Organization deletion is terminal even if a stale or bad
    // later status message claims active again.
    await stream.synchronizeOrganizationAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      3,
      'active',
    )
    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 3, 3, 3),
    ).toBe(true)
    await stream.synchronizeOrganizationAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      4,
      'deleted',
    )
    await stream.synchronizeOrganizationAuthorization(
      organizationId,
      serverId,
      streamEpoch,
      5,
      'active',
    )
    expect(
      await stream.initialize(organizationId, serverId, streamEpoch, principalId, 3, 3, 5),
    ).toBe(false)

    const state = await runInDurableObject(stream, async (_instance, durableState) => ({
      organization: await durableState.storage.get<{
        readonly generation: number
        readonly state: string
      }>('organization_authorization'),
      membership: await durableState.storage.get<{
        readonly generation: number
        readonly revision: number
        readonly state: string
      }>(`membership_authorization:${principalId}`),
    }))
    expect(state.organization).toEqual({ generation: 4, state: 'deleted' })
    expect(state.membership).toEqual({ generation: 3, revision: 3, state: 'active' })
  })

  it('enforces durable per-principal and per-stream ticket caps before a signed nonce can accumulate', async () => {
    const capOrganizationId = 'organization-ticket-cap'
    const capServerId = 'server-ticket-cap'
    const capEpoch = 'deployment-ticket-cap'
    const namespace = env.LIVE_LOG_STREAM as DurableObjectNamespace<LiveLogStreamDO>
    const stream = namespace.getByName(`${capOrganizationId}:logs:${capServerId}:${capEpoch}`)

    for (let index = 0; index < LIVE_LOG_LIMITS.maximumTicketsPerStream; index += 1) {
      const capPrincipal = `identity-ticket-cap-${Math.floor(index / LIVE_LOG_LIMITS.maximumTicketsPerPrincipal)}`
      if (index % LIVE_LOG_LIMITS.maximumTicketsPerPrincipal === 0) {
        expect(
          await stream.initialize(capOrganizationId, capServerId, capEpoch, capPrincipal, 1, 1, 1),
        ).toBe(true)
      }
      expect(
        await stream.claimTicket({
          organizationId: capOrganizationId,
          serverId: capServerId,
          streamEpoch: capEpoch,
          principalId: capPrincipal,
          membershipRevision: 1,
          membershipAuthorizationGeneration: 1,
          organizationAuthorizationGeneration: 1,
          nonce: `ticket-cap-${index}-abcdef`,
          expiresAt: Date.now() + 60_000,
        }),
      ).toBe(true)
      if (index === LIVE_LOG_LIMITS.maximumTicketsPerPrincipal - 1) {
        expect(
          await stream.claimTicket({
            organizationId: capOrganizationId,
            serverId: capServerId,
            streamEpoch: capEpoch,
            principalId: capPrincipal,
            membershipRevision: 1,
            membershipAuthorizationGeneration: 1,
            organizationAuthorizationGeneration: 1,
            nonce: 'ticket-principal-cap-overflow-abcdef',
            expiresAt: Date.now() + 60_000,
          }),
        ).toBe(false)
      }
    }

    const overflowPrincipal = 'identity-ticket-cap-overflow'
    expect(
      await stream.initialize(capOrganizationId, capServerId, capEpoch, overflowPrincipal, 1, 1, 1),
    ).toBe(true)
    expect(
      await stream.claimTicket({
        organizationId: capOrganizationId,
        serverId: capServerId,
        streamEpoch: capEpoch,
        principalId: overflowPrincipal,
        membershipRevision: 1,
        membershipAuthorizationGeneration: 1,
        organizationAuthorizationGeneration: 1,
        nonce: 'ticket-cap-overflow-abcdef',
        expiresAt: Date.now() + 60_000,
      }),
    ).toBe(false)
    await expect(
      runInDurableObject(
        stream,
        async (_instance, durableState) =>
          durableState.storage.sql
            .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_tickets')
            .toArray()[0]?.count,
      ),
    ).resolves.toBe(LIVE_LOG_LIMITS.maximumTicketsPerStream)
  })

  it('rejects an over-cap socket and closes an idle hibernatable socket through its durable alarm', async () => {
    const capOrganizationId = 'organization-socket-cap'
    const capServerId = 'server-socket-cap'
    const capEpoch = 'deployment-socket-cap'
    const capPrincipal = 'identity-socket-cap'
    const namespace = env.LIVE_LOG_STREAM as DurableObjectNamespace<LiveLogStreamDO>
    const stream = namespace.getByName(`${capOrganizationId}:logs:${capServerId}:${capEpoch}`)
    expect(
      await stream.initialize(capOrganizationId, capServerId, capEpoch, capPrincipal, 1, 1, 1),
    ).toBe(true)

    const clients: WebSocket[] = []
    for (let index = 0; index < LIVE_LOG_LIMITS.maximumSocketsPerPrincipal; index += 1) {
      const ticketClaim: LiveLogTicketClaim = {
        organizationId: capOrganizationId,
        serverId: capServerId,
        streamEpoch: capEpoch,
        principalId: capPrincipal,
        membershipRevision: 1,
        membershipAuthorizationGeneration: 1,
        organizationAuthorizationGeneration: 1,
        nonce: `socket-cap-${index}-abcdef`,
        expiresAt: Date.now() + 60_000,
      }
      expect(await stream.claimTicket(ticketClaim)).toBe(true)
      const upgrade = await stream.fetch(
        `https://live-log.test/?ticket=${encodeURIComponent(await signedClaim(ticketClaim))}`,
        { headers: { Upgrade: 'websocket' } },
      )
      expect(upgrade.status).toBe(101)
      const client = upgrade.webSocket
      if (client === null) throw new Error('Workers runtime did not return a WebSocket')
      client.accept()
      clients.push(client)
    }

    const overflowClaim: LiveLogTicketClaim = {
      organizationId: capOrganizationId,
      serverId: capServerId,
      streamEpoch: capEpoch,
      principalId: capPrincipal,
      membershipRevision: 1,
      membershipAuthorizationGeneration: 1,
      organizationAuthorizationGeneration: 1,
      nonce: 'socket-cap-overflow-abcdef',
      expiresAt: Date.now() + 60_000,
    }
    expect(await stream.claimTicket(overflowClaim)).toBe(true)
    await expect(
      stream.fetch(
        `https://live-log.test/?ticket=${encodeURIComponent(await signedClaim(overflowClaim))}`,
        { headers: { Upgrade: 'websocket' } },
      ),
    ).resolves.toMatchObject({ status: 403 })

    const idleClient = clients[0]
    if (idleClient === undefined) throw new Error('Expected one accepted WebSocket')
    const idleClosed = new Promise<void>((resolve) => {
      idleClient.addEventListener('close', () => resolve(), { once: true })
    })
    await runInDurableObject(stream, async (_instance, durableState) => {
      const socket = durableState.getWebSockets(`principal:${capPrincipal}`)[0]
      if (socket === undefined) throw new Error('Expected a hibernatable live-log socket')
      const attachment = socket.deserializeAttachment()
      if (typeof attachment !== 'object' || attachment === null)
        throw new Error('Expected a durable live-log attachment')
      socket.serializeAttachment({ ...attachment, lastActivityAt: 0 })
    })
    expect(await runDurableObjectAlarm(stream)).toBe(true)
    await expect(idleClosed).resolves.toBeUndefined()
    await expect(
      runInDurableObject(stream, async (_instance, durableState) => ({
        tickets: durableState.storage.sql
          .exec<{ readonly count: number }>('SELECT COUNT(*) AS count FROM log_stream_tickets')
          .toArray()[0]?.count,
        sockets: durableState.getWebSockets(`principal:${capPrincipal}`).length,
      })),
    ).resolves.toEqual({
      tickets: LIVE_LOG_LIMITS.maximumSocketsPerPrincipal,
      sockets: LIVE_LOG_LIMITS.maximumSocketsPerPrincipal - 1,
    })

    closeClients(clients.slice(1))
  })
})

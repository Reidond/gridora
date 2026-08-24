import { DurableObject } from 'cloudflare:workers'
import { Effect } from 'effect'
import { makeLogBatch, type LogEntry } from '@gridora/log-control'
import { verifyRealtimeTicket, type RealtimeTicketClaims } from './ticket.js'
import {
  boundedLiveLogBacklog,
  decodeEpochLiveLogCursor,
  encodeEpochLiveLogCursor,
  liveLogBackpressureDecision,
  LIVE_LOG_LIMITS,
} from './live-log-invariants.js'

export interface LiveLogStreamBindings {
  readonly REALTIME_TICKET_SECRET: string
  /** Present only in the Workers integration harness; never configured in Wrangler. */
  readonly LIVE_LOG_TEST_FAULT_INJECTION?: 'enabled'
}

export interface LiveLogTicketClaim {
  readonly organizationId: string
  readonly serverId: string
  readonly streamEpoch: string
  readonly principalId: string
  readonly membershipRevision: number
  readonly membershipAuthorizationGeneration: number
  readonly organizationAuthorizationGeneration: number
  readonly nonce: string
  readonly expiresAt: number
}

export interface LiveLogPublication {
  readonly organizationId: string
  readonly serverId: string
  readonly streamEpoch: string
  readonly nodeId: string
  /** Immutable D1/R2 archive identity; Queue retries must not rebroadcast it. */
  readonly archiveId: string
  readonly archiveSha256: string
  readonly entries: ReadonlyArray<LogEntry>
}

export interface LiveLogPublicationResult {
  readonly accepted: boolean
  readonly replayed: boolean
  readonly firstSequence: number
  readonly lastSequence: number
}

interface StreamIdentity {
  readonly organizationId: string
  readonly resourceId: string
  readonly streamEpoch: string
}

type OrganizationAuthorizationState = 'active' | 'suspended' | 'deleted'
type MembershipAuthorizationState = 'active' | 'revoked'

interface OrganizationAuthorization {
  readonly generation: number
  readonly state: OrganizationAuthorizationState
}

interface MembershipAuthorization {
  readonly generation: number
  readonly revision: number
  readonly state: MembershipAuthorizationState
}

interface OrganizationAuthorizationTransition {
  readonly allowed: boolean
  readonly changed: boolean
  /** The incoming authoritative fact exactly matches durable authorization. */
  readonly matchesIncoming: boolean
}

interface MembershipAuthorizationTransition {
  readonly allowed: boolean
  readonly changed: boolean
  /** The incoming authoritative fact exactly matches durable authorization. */
  readonly matchesIncoming: boolean
}

interface AuthorizationStorage {
  readonly get: <T = unknown>(key: string) => Promise<T | undefined>
  readonly put: <T>(key: string, value: T) => Promise<void>
  readonly delete: (key: string) => Promise<boolean>
}

interface TicketRow {
  readonly [key: string]: string | number
  readonly principal_id: string
  readonly session_version: number
  readonly expires_at: number
  readonly state: 'claimed' | 'connected'
}

interface CountRow {
  readonly [key: string]: number
  readonly count: number
}

/**
 * Hibernatable WebSocket attachments are durable state.  Keeping the last
 * activity alongside the signed claims lets an alarm reclaim a disconnected
 * or quiet client even when no later publication wakes this object.
 */
interface LiveLogSocketAttachment extends RealtimeTicketClaims {
  readonly lastActivityAt: number
}

interface EventRow {
  readonly [key: string]: string | number
  readonly log_sequence: number
  readonly body: string
  readonly created_at: number
  readonly bytes: number
}

interface ArchiveDeliveryRow {
  readonly [key: string]: string | number
  readonly archive_id: string
  readonly archive_sha256: string
  readonly first_sequence: number
  readonly last_sequence: number
}

const websocketRequired = (): Response =>
  new Response('WebSocket upgrade required', { status: 426 })
const denied = (): Response => new Response('Live log authorization denied', { status: 403 })
const textEncoder = new TextEncoder()
const principalIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const archiveIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const sha256Digest = /^sha256:[a-f0-9]{64}$/
const membershipAuthorizationKey = (principalId: string): string => {
  if (!principalIdentifier.test(principalId))
    throw new Error('Live log principal identity is invalid')
  return `membership_authorization:${principalId}`
}

const legacyMembershipRevisionKey = (principalId: string): string => {
  if (!principalIdentifier.test(principalId))
    throw new Error('Live log principal identity is invalid')
  return `membership_revision:${principalId}`
}

const organizationAuthorizationKey = 'organization_authorization'
const legacyOrganizationSuspendedKey = 'organization_suspended'
const authorizationCleanupFaultKey = 'test_authorization_cleanup_fault_once'

const validGeneration = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const isOrganizationAuthorization = (value: unknown): value is OrganizationAuthorization =>
  typeof value === 'object' &&
  value !== null &&
  validGeneration((value as Partial<OrganizationAuthorization>).generation ?? Number.NaN) &&
  ((value as Partial<OrganizationAuthorization>).state === 'active' ||
    (value as Partial<OrganizationAuthorization>).state === 'suspended' ||
    (value as Partial<OrganizationAuthorization>).state === 'deleted')

const isMembershipAuthorization = (value: unknown): value is MembershipAuthorization =>
  typeof value === 'object' &&
  value !== null &&
  validGeneration((value as Partial<MembershipAuthorization>).generation ?? Number.NaN) &&
  validGeneration((value as Partial<MembershipAuthorization>).revision ?? Number.NaN) &&
  ((value as Partial<MembershipAuthorization>).state === 'active' ||
    (value as Partial<MembershipAuthorization>).state === 'revoked')

const ticketResourceId = (serverId: string, streamEpoch: string): string =>
  JSON.stringify([serverId, streamEpoch])

const streamFrame = (entry: LogEntry, identity: StreamIdentity): string =>
  JSON.stringify({
    type: 'log',
    organizationId: identity.organizationId,
    serverId: identity.resourceId,
    streamEpoch: identity.streamEpoch,
    sequence: entry.sequence,
    cursor: encodeEpochLiveLogCursor(identity.streamEpoch, entry.sequence),
    entry,
  })

const streamFrameBytes = (frame: string): number => textEncoder.encode(frame).byteLength

/**
 * One Durable Object owns one organization/server stream.  The object is the
 * final nonce authority: API verification and the RPC claim are advisory, but
 * only this object can atomically move a ticket from claimed to connected.
 */
export class LiveLogStreamDO extends DurableObject<LiveLogStreamBindings> {
  #identity: StreamIdentity | undefined

  constructor(ctx: DurableObjectState, env: LiveLogStreamBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS log_stream_tickets (
          nonce TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          session_version INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('claimed', 'connected'))
        );
        CREATE INDEX IF NOT EXISTS log_stream_tickets_principal_expiry
          ON log_stream_tickets(principal_id, expires_at, nonce);
        CREATE TABLE IF NOT EXISTS log_stream_events (
          log_sequence INTEGER PRIMARY KEY,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          bytes INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS log_stream_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          last_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS log_stream_archives (
          archive_id TEXT PRIMARY KEY,
          archive_sha256 TEXT NOT NULL,
          first_sequence INTEGER NOT NULL,
          last_sequence INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      this.#identity = await this.ctx.storage.get<StreamIdentity>('identity')
    })
  }

  async initialize(
    organizationId: string,
    serverId: string,
    streamEpoch: string,
    principalId: string,
    membershipRevision: number,
    membershipAuthorizationGeneration: number,
    organizationAuthorizationGeneration: number,
  ): Promise<boolean> {
    await this.ensureIdentity(organizationId, serverId, streamEpoch)
    if (!validGeneration(membershipRevision) || !validGeneration(membershipAuthorizationGeneration))
      throw new Error('Live log membership authorization is invalid')
    if (!validGeneration(organizationAuthorizationGeneration))
      throw new Error('Live log organization authorization is invalid')
    const transition = await this.ctx.storage.transaction(async (storage) => {
      const organization = await this.applyOrganizationAuthorization(storage, {
        generation: organizationAuthorizationGeneration,
        state: 'active',
      })
      if (!organization.allowed)
        return {
          organizationChanged: organization.changed,
          membershipChanged: false,
          allowed: false,
        }
      const membership = await this.applyMembershipAuthorization(storage, principalId, {
        generation: membershipAuthorizationGeneration,
        revision: membershipRevision,
        state: 'active',
      })
      return {
        organizationChanged: organization.changed,
        membershipChanged: membership.changed,
        allowed: membership.allowed,
      }
    })
    // Persist both fences before closing connections. A later RPC can never
    // observe a stale state even if the close callback races a client retry.
    if (transition.organizationChanged)
      this.closeOrganizationSockets('organization authorization changed')
    if (transition.membershipChanged)
      this.closeOlderAuthorizationSockets(
        principalId,
        membershipRevision,
        membershipAuthorizationGeneration,
      )
    return transition.allowed
  }

  /** Called only from a committed outbox consumer after an authoritative D1 read. */
  async synchronizePrincipalAuthorization(
    organizationId: string,
    serverId: string,
    streamEpoch: string,
    principalId: string,
    membershipRevision: number,
    membershipAuthorizationGeneration: number,
    state: MembershipAuthorizationState,
  ): Promise<void> {
    await this.ensureIdentity(organizationId, serverId, streamEpoch)
    if (
      !validGeneration(membershipRevision) ||
      !validGeneration(membershipAuthorizationGeneration) ||
      (state !== 'active' && state !== 'revoked')
    )
      throw new Error('Live log membership authorization is invalid')
    const transition = await this.ctx.storage.transaction((storage) =>
      this.applyMembershipAuthorization(storage, principalId, {
        generation: membershipAuthorizationGeneration,
        revision: membershipRevision,
        state,
      }),
    )
    // A duplicate outbox delivery may be the recovery path after the first
    // invocation durably fenced access but crashed before socket cleanup. Only
    // an exact repeat is allowed to replay that cleanup; a stale fact must not
    // evict connections for a newer authorization generation.
    if (!transition.matchesIncoming) return
    if (await this.skipAuthorizationCleanupForTest()) return
    this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets WHERE principal_id = ?', principalId)
    if (state === 'revoked') this.closePrincipalSockets(principalId, 'membership revoked')
    else
      this.closeOlderAuthorizationSockets(
        principalId,
        membershipRevision,
        membershipAuthorizationGeneration,
      )
  }

  /** Called from a committed outbox consumer after an authoritative D1 read. */
  async synchronizeOrganizationAuthorization(
    organizationId: string,
    serverId: string,
    streamEpoch: string,
    organizationAuthorizationGeneration: number,
    state: OrganizationAuthorizationState,
  ): Promise<void> {
    await this.ensureIdentity(organizationId, serverId, streamEpoch)
    if (
      !validGeneration(organizationAuthorizationGeneration) ||
      (state !== 'active' && state !== 'suspended' && state !== 'deleted')
    )
      throw new Error('Live log organization authorization is invalid')
    const transition = await this.ctx.storage.transaction((storage) =>
      this.applyOrganizationAuthorization(storage, {
        generation: organizationAuthorizationGeneration,
        state,
      }),
    )
    // Exact non-active replays must still finish ticket/socket cleanup after a
    // crash. An unchanged active status is intentionally a no-op so duplicate
    // status events do not disconnect newly authorized viewers.
    if (!transition.matchesIncoming || (state === 'active' && !transition.changed)) return
    if (await this.skipAuthorizationCleanupForTest()) return
    this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets')
    this.closeOrganizationSockets(
      state === 'deleted' ? 'organization deleted' : 'organization authorization changed',
    )
  }

  /** Claims a ticket before the HTTP edge proxies the WebSocket upgrade. */
  async claimTicket(input: LiveLogTicketClaim): Promise<boolean> {
    await this.ensureIdentity(input.organizationId, input.serverId, input.streamEpoch)
    const organization = await this.readOrganizationAuthorization(this.ctx.storage)
    const membership = await this.readMembershipAuthorization(this.ctx.storage, input.principalId)
    const now = Date.now()
    if (
      organization === undefined ||
      organization.state !== 'active' ||
      input.organizationAuthorizationGeneration !== organization.generation ||
      membership === undefined ||
      membership.state !== 'active' ||
      input.membershipRevision !== membership.revision ||
      input.membershipAuthorizationGeneration !== membership.generation ||
      !validGeneration(input.membershipAuthorizationGeneration) ||
      !validGeneration(input.organizationAuthorizationGeneration) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + 5 * 60 * 1000 ||
      input.nonce.length < 8 ||
      input.nonce.length > 256 ||
      !principalIdentifier.test(input.principalId)
    )
      return false
    this.deleteExpiredTickets(now)
    if (!this.hasTicketCapacity(input.principalId)) return false
    let inserted = false
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO log_stream_tickets
          (nonce, principal_id, session_version, expires_at, state)
         VALUES (?, ?, ?, ?, 'claimed')`,
        input.nonce,
        input.principalId,
        input.membershipRevision,
        input.expiresAt,
      )
      inserted = true
      // A nonce is not allowed to depend on a future request to be reclaimed.
      // The durable alarm is set before the claim response can be observed.
      await this.scheduleExpiryAlarm()
      return true
    } catch {
      if (inserted)
        this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets WHERE nonce = ?', input.nonce)
      return false
    }
  }

  async publish(input: LiveLogPublication): Promise<LiveLogPublicationResult> {
    await this.ensureIdentity(input.organizationId, input.serverId, input.streamEpoch)
    const identity = this.#identity
    if (
      identity === undefined ||
      input.nodeId.length < 1 ||
      input.entries.length === 0 ||
      !archiveIdentifier.test(input.archiveId) ||
      !sha256Digest.test(input.archiveSha256)
    )
      throw new Error('Live log publication scope is invalid')
    const decoded = await Effect.runPromise(
      makeLogBatch(input.organizationId, input.nodeId, input.entries).pipe(
        Effect.mapError((error) => new Error(error.message)),
      ),
    )
    if (
      decoded.entries.some(
        (entry) =>
          entry.organizationId !== identity.organizationId ||
          entry.serverId !== identity.resourceId,
      )
    )
      throw new Error('Live log publication scope is invalid')

    const createdAt = Date.now()
    // `sql.exec()` explicitly rejects BEGIN/COMMIT/ROLLBACK in SQLite-backed
    // Durable Objects. Keep the read fences, immutable archive receipt, event
    // rows, and watermarks in one synchronous storage transaction instead.
    const result = this.ctx.storage.transactionSync((): LiveLogPublicationResult => {
      const recordedArchive = this.ctx.storage.sql
        .exec<ArchiveDeliveryRow>(
          `SELECT archive_id, archive_sha256, first_sequence, last_sequence
           FROM log_stream_archives WHERE archive_id = ?`,
          input.archiveId,
        )
        .toArray()[0]
      if (recordedArchive !== undefined) {
        if (
          recordedArchive.archive_sha256 === input.archiveSha256 &&
          recordedArchive.first_sequence === decoded.firstSequence &&
          recordedArchive.last_sequence === decoded.lastSequence
        )
          return {
            accepted: false,
            replayed: true,
            firstSequence: decoded.firstSequence,
            lastSequence: decoded.lastSequence,
          }
        throw new Error('Live log archive identity was reused with different content')
      }

      const state = this.ctx.storage.sql
        .exec<{ last_sequence: number }>(
          'SELECT last_sequence FROM log_stream_state WHERE singleton = 1',
        )
        .toArray()[0]
      const lastSequence = state?.last_sequence
      if (lastSequence !== undefined) {
        if (decoded.firstSequence <= lastSequence) {
          const replayed = decoded.entries.every((entry) => {
            const stored = this.ctx.storage.sql
              .exec<{ body: string }>(
                'SELECT body FROM log_stream_events WHERE log_sequence = ?',
                entry.sequence,
              )
              .toArray()[0]
            return stored !== undefined && stored.body === JSON.stringify(entry)
          })
          if (replayed && decoded.lastSequence <= lastSequence)
            return {
              accepted: false,
              replayed: true,
              firstSequence: decoded.firstSequence,
              lastSequence: decoded.lastSequence,
            }
          throw new Error('Live log publication is a replay, overlap, or conflict')
        }
        if (decoded.firstSequence !== lastSequence + 1)
          throw new Error('Live log publication has a sequence gap')
      }

      for (const entry of decoded.entries) {
        const body = JSON.stringify(entry)
        this.ctx.storage.sql.exec(
          'INSERT INTO log_stream_events (log_sequence, body, created_at, bytes) VALUES (?, ?, ?, ?)',
          entry.sequence,
          body,
          createdAt,
          streamFrameBytes(streamFrame(entry, identity)),
        )
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO log_stream_state (singleton, last_sequence) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET last_sequence = excluded.last_sequence`,
        decoded.lastSequence,
      )
      this.ctx.storage.sql.exec(
        `INSERT INTO log_stream_archives
          (archive_id, archive_sha256, first_sequence, last_sequence, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.archiveId,
        input.archiveSha256,
        decoded.firstSequence,
        decoded.lastSequence,
        createdAt,
      )
      this.trimEvents(createdAt)
      this.trimArchives(createdAt)
      return {
        accepted: true,
        replayed: false,
        firstSequence: decoded.firstSequence,
        lastSequence: decoded.lastSequence,
      }
    })

    // Never emit a frame solely because persistence succeeded. A revoked or
    // suspended authorization may have committed before cleanup completed;
    // broadcast rechecks durable state for every attached viewer.
    if (result.accepted) {
      await this.ctx.storage.sync()
      for (const entry of decoded.entries) await this.broadcast(entry)
    }
    return result
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return websocketRequired()
    const url = new URL(request.url)
    const tickets = url.searchParams.getAll('ticket')
    if (
      tickets.length !== 1 ||
      Array.from(url.searchParams.keys()).some((key) => key !== 'ticket' && key !== 'after') ||
      url.searchParams.getAll('after').length > 1
    )
      return denied()
    const claims = await this.authorizeTicket(tickets[0]!)
    if (claims === null) return denied()
    const identity = this.#identity
    if (identity === undefined) return denied()
    const afterValue = url.searchParams.get('after')
    const after =
      afterValue === null ? undefined : decodeEpochLiveLogCursor(afterValue, identity.streamEpoch)
    if (afterValue !== null && after === undefined) return denied()
    if (!this.connectTicket(claims)) return denied()
    const openedAt = Date.now()
    try {
      await this.scheduleExpiryAlarm(openedAt + LIVE_LOG_LIMITS.maximumSocketIdleMilliseconds)
    } catch {
      this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets WHERE nonce = ?', claims.nonce)
      return denied()
    }
    const rows = this.loadBacklog(after)
    const bounded = boundedLiveLogBacklog(rows, LIVE_LOG_LIMITS.maximumBacklogEvents)
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['console', `principal:${claims.principalId}`])
    pair[1].serializeAttachment({
      ...claims,
      lastActivityAt: openedAt,
    } satisfies LiveLogSocketAttachment)
    const gap = after === undefined ? undefined : this.replayGap(after, rows)
    if (gap !== undefined) {
      this.sendFrame(
        pair[1],
        JSON.stringify({
          type: 'backlog-gap',
          organizationId: identity.organizationId,
          serverId: identity.resourceId,
          streamEpoch: identity.streamEpoch,
          after: afterValue,
          nextSequence: gap,
        }),
      )
    }
    if (bounded.truncated) {
      this.sendFrame(
        pair[1],
        JSON.stringify({
          type: 'backlog-truncated',
          organizationId: identity.organizationId,
          serverId: identity.resourceId,
          streamEpoch: identity.streamEpoch,
          after: afterValue,
          maximum: LIVE_LOG_LIMITS.maximumBacklogEvents,
        }),
      )
    }
    for (const row of bounded.items) {
      const entry = this.decodeStoredEntry(row)
      if (entry === null || !this.sendFrame(pair[1], streamFrame(entry, identity))) {
        try {
          pair[1].close(1011, 'live log replay failed')
        } catch {
          // The runtime may already have closed the socket.
        }
        break
      }
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (
      typeof message !== 'string' ||
      textEncoder.encode(message).byteLength > LIVE_LOG_LIMITS.maximumInboundMessageBytes
    ) {
      try {
        socket.close(1009, 'message too large')
      } catch {
        // Ignore an already closed client.
      }
      return
    }
    if (!(await this.socketIsAuthorized(socket))) {
      this.closeSocket(socket, 'live log authorization revoked')
      return
    }
    this.touchSocket(socket)
    await this.scheduleExpiryAlarm()
    if (message === 'ping') {
      if (!this.sendFrame(socket, 'pong')) {
        try {
          socket.close(1013, 'live log backpressure')
        } catch {
          // Ignore an already closed client.
        }
      }
      return
    }
    try {
      socket.close(1008, 'read-only live log stream')
    } catch {
      // Ignore an already closed client.
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.releaseSocketTicket(socket)
  }

  override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    await this.releaseSocketTicket(socket)
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    this.deleteExpiredTickets(now)
    for (const socket of this.ctx.getWebSockets('console')) {
      if (!(await this.socketIsAuthorized(socket, now))) {
        this.deleteSocketTicket(socket)
        try {
          socket.close(1008, 'live log idle or authorization expired')
        } catch {
          // The runtime may have already closed an idle hibernatable socket.
        }
      }
    }
    await this.scheduleExpiryAlarm()
  }

  private async ensureIdentity(
    organizationId: string,
    serverId: string,
    streamEpoch: string,
  ): Promise<void> {
    if (organizationId.length < 1 || serverId.length < 1 || streamEpoch.length < 1)
      throw new Error('Live log identity is invalid')
    const requested = { organizationId, resourceId: serverId, streamEpoch }
    const stored = this.#identity ?? (await this.ctx.storage.get<StreamIdentity>('identity'))
    if (stored === undefined) {
      await this.ctx.storage.put('identity', requested)
      this.#identity = requested
      return
    }
    if (
      stored.organizationId !== organizationId ||
      stored.resourceId !== serverId ||
      stored.streamEpoch !== streamEpoch
    )
      throw new Error('Live log organization scope mismatch')
    this.#identity = stored
  }

  private async readOrganizationAuthorization(
    storage: Pick<AuthorizationStorage, 'get'>,
  ): Promise<OrganizationAuthorization | undefined> {
    const stored = await storage.get<unknown>(organizationAuthorizationKey)
    if (isOrganizationAuthorization(stored)) return stored
    // Objects created before the generation fence had only this boolean. It is
    // deliberately treated as generation zero, so only a later authoritative
    // active generation can reopen it; a delayed old initialize cannot.
    const suspended = await storage.get<boolean>(legacyOrganizationSuspendedKey)
    return suspended === true ? { generation: 0, state: 'suspended' } : undefined
  }

  private async readMembershipAuthorization(
    storage: Pick<AuthorizationStorage, 'get'>,
    principalId: string,
  ): Promise<MembershipAuthorization | undefined> {
    const stored = await storage.get<unknown>(membershipAuthorizationKey(principalId))
    if (isMembershipAuthorization(stored)) return stored
    const legacy = await storage.get<number>(legacyMembershipRevisionKey(principalId))
    return legacy !== undefined && validGeneration(legacy)
      ? { generation: 1, revision: legacy, state: 'active' }
      : undefined
  }

  private async applyOrganizationAuthorization(
    storage: AuthorizationStorage,
    incoming: OrganizationAuthorization,
  ): Promise<OrganizationAuthorizationTransition> {
    const current = await this.readOrganizationAuthorization(storage)
    if (current === undefined) {
      await storage.put(organizationAuthorizationKey, incoming)
      if (incoming.state === 'active') await storage.delete(legacyOrganizationSuspendedKey)
      return {
        allowed: incoming.state === 'active',
        changed: incoming.state !== 'active',
        matchesIncoming: true,
      }
    }
    if (current.state === 'deleted')
      return {
        allowed: false,
        changed: false,
        matchesIncoming: incoming.generation === current.generation && incoming.state === 'deleted',
      }
    if (incoming.generation < current.generation)
      return { allowed: false, changed: false, matchesIncoming: false }
    if (incoming.generation === current.generation) {
      if (incoming.state === current.state)
        return {
          allowed: current.state === 'active',
          changed: false,
          matchesIncoming: true,
        }
      // Equal generations are never allowed to revive a suspended state. A
      // non-active fact wins instead, because it is safe under delayed outbox
      // delivery while the route path can re-open only with a greater one.
      if (incoming.state === 'active')
        return { allowed: false, changed: false, matchesIncoming: false }
      await storage.put(organizationAuthorizationKey, incoming)
      return { allowed: false, changed: true, matchesIncoming: true }
    }
    if (incoming.state === 'deleted') {
      await storage.put(organizationAuthorizationKey, incoming)
      return { allowed: false, changed: true, matchesIncoming: true }
    }
    await storage.put(organizationAuthorizationKey, incoming)
    if (incoming.state === 'active') await storage.delete(legacyOrganizationSuspendedKey)
    return { allowed: incoming.state === 'active', changed: true, matchesIncoming: true }
  }

  private async applyMembershipAuthorization(
    storage: AuthorizationStorage,
    principalId: string,
    incoming: MembershipAuthorization,
  ): Promise<MembershipAuthorizationTransition> {
    const current = await this.readMembershipAuthorization(storage, principalId)
    const key = membershipAuthorizationKey(principalId)
    if (current === undefined) {
      await storage.put(key, incoming)
      return {
        allowed: incoming.state === 'active',
        changed: incoming.state !== 'active',
        matchesIncoming: true,
      }
    }
    if (incoming.generation < current.generation)
      return { allowed: false, changed: false, matchesIncoming: false }
    if (incoming.generation === current.generation) {
      if (incoming.state === current.state && incoming.revision === current.revision)
        return {
          allowed: current.state === 'active',
          changed: false,
          matchesIncoming: true,
        }
      // A same-generation active update cannot overwrite a revocation or a
      // revision mismatch. Only the D1-generated next generation may do so.
      if (incoming.state === 'active')
        return { allowed: false, changed: false, matchesIncoming: false }
      if (current.state === 'revoked')
        return { allowed: false, changed: false, matchesIncoming: false }
      await storage.put(key, incoming)
      return { allowed: false, changed: true, matchesIncoming: true }
    }
    await storage.put(key, incoming)
    return { allowed: incoming.state === 'active', changed: true, matchesIncoming: true }
  }

  private async authorizeTicket(ticket: string): Promise<RealtimeTicketClaims | null> {
    const identity = this.#identity ?? (await this.ctx.storage.get<StreamIdentity>('identity'))
    if (identity === undefined) return null
    const organization = await this.readOrganizationAuthorization(this.ctx.storage)
    if (organization?.state !== 'active') return null
    const verified = await Effect.runPromise(
      Effect.result(
        verifyRealtimeTicket(ticket, this.env.REALTIME_TICKET_SECRET, {
          organizationId: identity.organizationId,
          resourceType: 'resource',
          resourceId: ticketResourceId(identity.resourceId, identity.streamEpoch),
        }),
      ),
    )
    if (verified._tag === 'Failure') return null
    const claims = verified.success
    const membership = await this.readMembershipAuthorization(this.ctx.storage, claims.principalId)
    if (
      claims.audience !== 'console' ||
      claims.machineId !== null ||
      membership?.state !== 'active' ||
      claims.sessionVersion !== membership.revision ||
      claims.membershipAuthorizationGeneration !== membership.generation ||
      claims.organizationAuthorizationGeneration !== organization.generation ||
      !validGeneration(claims.membershipAuthorizationGeneration ?? Number.NaN) ||
      !validGeneration(claims.organizationAuthorizationGeneration ?? Number.NaN) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= Date.now()
    )
      return null
    this.deleteExpiredTickets(Date.now())
    const row = this.ctx.storage.sql
      .exec<TicketRow>(
        `SELECT principal_id, session_version, expires_at, state
         FROM log_stream_tickets WHERE nonce = ?`,
        claims.nonce,
      )
      .toArray()[0]
    if (row !== undefined) {
      if (
        row.state !== 'claimed' ||
        row.principal_id !== claims.principalId ||
        row.session_version !== claims.sessionVersion ||
        row.expires_at !== claims.expiresAt
      )
        return null
      return claims
    }
    // The HTTP issue path must first claim the signed nonce through this
    // object. Direct upgrades cannot bypass the durable claim/cardinality
    // ledger merely by possessing a valid signature.
    return null
  }

  private deleteExpiredTickets(now: number): void {
    this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets WHERE expires_at <= ?', now)
  }

  private hasTicketCapacity(principalId: string): boolean {
    const stream = this.ctx.storage.sql
      .exec<CountRow>('SELECT COUNT(*) AS count FROM log_stream_tickets')
      .toArray()[0]?.count
    const principal = this.ctx.storage.sql
      .exec<CountRow>(
        'SELECT COUNT(*) AS count FROM log_stream_tickets WHERE principal_id = ?',
        principalId,
      )
      .toArray()[0]?.count
    return (
      stream !== undefined &&
      principal !== undefined &&
      stream < LIVE_LOG_LIMITS.maximumTicketsPerStream &&
      principal < LIVE_LOG_LIMITS.maximumTicketsPerPrincipal
    )
  }

  private hasSocketCapacity(principalId: string): boolean {
    return (
      this.ctx.getWebSockets('console').length < LIVE_LOG_LIMITS.maximumSocketsPerStream &&
      this.ctx.getWebSockets(`principal:${principalId}`).length <
        LIVE_LOG_LIMITS.maximumSocketsPerPrincipal
    )
  }

  /** Atomically consumes a claimed nonce only after the socket caps are checked. */
  private connectTicket(claims: RealtimeTicketClaims): boolean {
    const now = Date.now()
    if (!principalIdentifier.test(claims.principalId) || claims.expiresAt <= now) return false
    this.deleteExpiredTickets(now)
    if (!this.hasSocketCapacity(claims.principalId)) return false
    const changed = this.ctx.storage.sql.exec(
      `UPDATE log_stream_tickets SET state = 'connected'
       WHERE nonce = ? AND principal_id = ? AND session_version = ?
         AND expires_at = ? AND state = 'claimed'`,
      claims.nonce,
      claims.principalId,
      claims.sessionVersion,
      claims.expiresAt,
    )
    return changed.rowsWritten === 1
  }

  private loadBacklog(after: number | undefined): ReadonlyArray<EventRow> {
    this.trimEvents(Date.now())
    if (after === undefined) {
      return this.ctx.storage.sql
        .exec<EventRow>(
          `SELECT log_sequence, body, created_at, bytes
           FROM log_stream_events ORDER BY log_sequence DESC LIMIT ?`,
          LIVE_LOG_LIMITS.maximumBacklogEvents + 1,
        )
        .toArray()
        .reverse()
    }
    return this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT log_sequence, body, created_at, bytes
         FROM log_stream_events WHERE log_sequence > ?
         ORDER BY log_sequence ASC LIMIT ?`,
        after,
        LIVE_LOG_LIMITS.maximumBacklogEvents + 1,
      )
      .toArray()
  }

  private replayGap(after: number, rows: ReadonlyArray<EventRow>): number | null | undefined {
    const first = rows[0]?.log_sequence
    if (first !== undefined) return first > after + 1 ? first : undefined
    const state = this.ctx.storage.sql
      .exec<{ last_sequence: number }>(
        'SELECT last_sequence FROM log_stream_state WHERE singleton = 1',
      )
      .toArray()[0]
    return state !== undefined && state.last_sequence > after ? null : undefined
  }

  private decodeStoredEntry(row: EventRow): LogEntry | null {
    try {
      const parsed = JSON.parse(row.body) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as LogEntry) : null
    } catch {
      return null
    }
  }

  private trimEvents(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM log_stream_events WHERE created_at < ?',
      now - LIVE_LOG_LIMITS.maximumRetentionMilliseconds,
    )
    for (;;) {
      const stats = this.ctx.storage.sql
        .exec<{ count: number; bytes: number }>(
          'SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM log_stream_events',
        )
        .toArray()[0] ?? { count: 0, bytes: 0 }
      if (
        stats.count <= LIVE_LOG_LIMITS.maximumRetainedEvents &&
        stats.bytes <= LIVE_LOG_LIMITS.maximumRetainedBytes
      )
        return
      this.ctx.storage.sql.exec(
        `DELETE FROM log_stream_events WHERE log_sequence = (
          SELECT log_sequence FROM log_stream_events ORDER BY log_sequence ASC LIMIT 1
        )`,
      )
    }
  }

  /** Keep dedupe evidence bounded with the same short replay retention as events. */
  private trimArchives(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM log_stream_archives WHERE created_at < ?',
      now - LIVE_LOG_LIMITS.maximumRetentionMilliseconds,
    )
    this.ctx.storage.sql.exec(
      `DELETE FROM log_stream_archives WHERE archive_id IN (
        SELECT archive_id FROM log_stream_archives
        ORDER BY created_at DESC, archive_id DESC
        LIMIT -1 OFFSET ?
      )`,
      LIVE_LOG_LIMITS.maximumRetainedEvents,
    )
  }

  private async broadcast(entry: LogEntry): Promise<void> {
    const identity = this.#identity
    if (identity === undefined) return
    const frame = streamFrame(entry, identity)
    for (const socket of this.ctx.getWebSockets('console')) {
      if (await this.socketIsAuthorized(socket)) this.sendFrame(socket, frame)
      else this.closeSocket(socket, 'live log authorization revoked')
    }
    await this.scheduleExpiryAlarm()
  }

  private readSocketAttachment(socket: WebSocket): Partial<LiveLogSocketAttachment> | undefined {
    const attachment = socket.deserializeAttachment()
    return typeof attachment === 'object' && attachment !== null
      ? (attachment as Partial<LiveLogSocketAttachment>)
      : undefined
  }

  private async socketIsAuthorized(socket: WebSocket, now = Date.now()): Promise<boolean> {
    const identity = this.#identity
    if (identity === undefined) return false
    const claim = this.readSocketAttachment(socket)
    const expiresAt = claim?.expiresAt
    const lastActivityAt = claim?.lastActivityAt
    if (
      claim === undefined ||
      claim.audience !== 'console' ||
      claim.machineId !== null ||
      claim.organizationId !== identity.organizationId ||
      claim.resourceType !== 'resource' ||
      claim.resourceId !== ticketResourceId(identity.resourceId, identity.streamEpoch) ||
      typeof claim.principalId !== 'string' ||
      claim.principalId.length < 1 ||
      !Number.isSafeInteger(claim.sessionVersion) ||
      !validGeneration(claim.membershipAuthorizationGeneration ?? Number.NaN) ||
      !validGeneration(claim.organizationAuthorizationGeneration ?? Number.NaN) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt === undefined ||
      expiresAt <= now ||
      !Number.isSafeInteger(lastActivityAt) ||
      lastActivityAt === undefined ||
      lastActivityAt > now ||
      lastActivityAt + LIVE_LOG_LIMITS.maximumSocketIdleMilliseconds <= now
    )
      return false
    const organization = await this.readOrganizationAuthorization(this.ctx.storage)
    if (
      organization?.state !== 'active' ||
      organization.generation !== claim.organizationAuthorizationGeneration
    )
      return false
    const membership = await this.readMembershipAuthorization(this.ctx.storage, claim.principalId)
    return (
      membership?.state === 'active' &&
      membership.revision === claim.sessionVersion &&
      membership.generation === claim.membershipAuthorizationGeneration
    )
  }

  private socketDeadline(socket: WebSocket): number | undefined {
    const attachment = this.readSocketAttachment(socket)
    const expiresAt = attachment?.expiresAt
    const lastActivityAt = attachment?.lastActivityAt
    if (
      attachment === undefined ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      typeof lastActivityAt !== 'number' ||
      !Number.isSafeInteger(lastActivityAt)
    )
      return undefined
    return Math.min(expiresAt, lastActivityAt + LIVE_LOG_LIMITS.maximumSocketIdleMilliseconds)
  }

  /**
   * Hibernatable socket state survives eviction, so the next alarm must be
   * derived from durable nonce expiry and every attachment's idle deadline.
   */
  private async scheduleExpiryAlarm(extraDeadline?: number): Promise<void> {
    const ticketDeadline = this.ctx.storage.sql
      .exec<{ readonly expires_at: number }>(
        'SELECT MIN(expires_at) AS expires_at FROM log_stream_tickets',
      )
      .toArray()[0]?.expires_at
    const socketDeadlines = this.ctx
      .getWebSockets('console')
      .map((socket) => this.socketDeadline(socket))
      .filter((deadline): deadline is number => deadline !== undefined)
    const candidates = [ticketDeadline, extraDeadline, ...socketDeadlines].filter(
      (deadline): deadline is number =>
        typeof deadline === 'number' && Number.isSafeInteger(deadline) && deadline > 0,
    )
    const next = candidates.length === 0 ? undefined : Math.min(...candidates)
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null || existing > next) await this.ctx.storage.setAlarm(next)
  }

  private touchSocket(socket: WebSocket): void {
    const attachment = this.readSocketAttachment(socket)
    if (attachment === undefined) return
    socket.serializeAttachment({ ...attachment, lastActivityAt: Date.now() })
  }

  private deleteSocketTicket(socket: WebSocket): void {
    const attachment = this.readSocketAttachment(socket)
    if (attachment?.nonce === undefined) return
    this.ctx.storage.sql.exec('DELETE FROM log_stream_tickets WHERE nonce = ?', attachment.nonce)
  }

  private async releaseSocketTicket(socket: WebSocket): Promise<void> {
    this.deleteSocketTicket(socket)
    await this.scheduleExpiryAlarm()
  }

  /**
   * Workers integration tests arm this explicit one-shot fault to model a
   * process loss after the authorization transaction commits and before the
   * non-durable socket cleanup starts. Wrangler never supplies the capability.
   */
  async armAuthorizationCleanupFailureForTest(): Promise<void> {
    if (this.env.LIVE_LOG_TEST_FAULT_INJECTION !== 'enabled')
      throw new Error('Live log authorization cleanup fault injection is disabled')
    await this.ctx.storage.put(authorizationCleanupFaultKey, true)
  }

  private async skipAuthorizationCleanupForTest(): Promise<boolean> {
    if (this.env.LIVE_LOG_TEST_FAULT_INJECTION !== 'enabled') return false
    const armed = await this.ctx.storage.get<boolean>(authorizationCleanupFaultKey)
    if (armed !== true) return false
    await this.ctx.storage.delete(authorizationCleanupFaultKey)
    return true
  }

  private closeOlderAuthorizationSockets(
    principalId: string,
    revision: number,
    membershipAuthorizationGeneration: number,
  ): void {
    for (const socket of this.ctx.getWebSockets(`principal:${principalId}`)) {
      const claim = this.readSocketAttachment(socket)
      if (
        claim === undefined ||
        typeof claim.sessionVersion !== 'number' ||
        !Number.isSafeInteger(claim.sessionVersion) ||
        claim.sessionVersion !== revision ||
        claim.membershipAuthorizationGeneration !== membershipAuthorizationGeneration
      )
        this.closeSocket(socket, 'membership authorization changed')
    }
  }

  private closePrincipalSockets(principalId: string, reason: string): void {
    for (const socket of this.ctx.getWebSockets(`principal:${principalId}`))
      this.closeSocket(socket, reason)
  }

  private closeOrganizationSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets('console')) this.closeSocket(socket, reason)
  }

  private closeSocket(socket: WebSocket, reason: string): void {
    this.ctx.waitUntil(this.releaseSocketTicket(socket).catch(() => undefined))
    try {
      socket.close(1008, reason)
    } catch {
      // A hibernating socket may already be closed by the runtime.
    }
  }

  private sendFrame(socket: WebSocket, frame: string): boolean {
    const bytes = streamFrameBytes(frame)
    const buffered = Number(
      (socket as unknown as { readonly bufferedAmount?: unknown }).bufferedAmount ?? 0,
    )
    if (liveLogBackpressureDecision(buffered, bytes) === 'close') {
      try {
        socket.close(1013, 'live log backpressure')
      } catch {
        // Ignore an already closed client.
      }
      return false
    }
    try {
      socket.send(frame)
      const afterSend = Number(
        (socket as unknown as { readonly bufferedAmount?: unknown }).bufferedAmount ?? 0,
      )
      if (!Number.isFinite(afterSend) || afterSend > LIVE_LOG_LIMITS.maximumBufferedBytes) {
        socket.close(1013, 'live log backpressure')
        return false
      }
      this.touchSocket(socket)
      return true
    } catch {
      try {
        socket.close(1011, 'live log delivery failed')
      } catch {
        // Ignore an already closed client.
      }
      return false
    }
  }
}

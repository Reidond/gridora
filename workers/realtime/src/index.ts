import { DurableObject } from 'cloudflare:workers'
import { Effect, Schema } from 'effect'
import {
  CommandResult,
  type AgentCommand,
  type CommandResult as CommandResultType,
} from '@gridora/agent-protocol'
import { verifyRealtimeTicket, type RealtimeTicketClaims } from './ticket.js'
import {
  closeSocketsForMembershipRevocation,
  contiguousResultWatermark,
  sameCommandResult,
  sameCommandPayload,
  validCommandResult,
  validNodeAgentClaims,
} from './coordinator-invariants.js'

export * from './ticket.js'
export * from './coordinator-invariants.js'
export * from './live-log-invariants.js'
export { LiveLogStreamDO } from './live-log-stream.js'
export type {
  LiveLogStreamBindings,
  LiveLogTicketClaim,
  LiveLogPublication,
  LiveLogPublicationResult,
} from './live-log-stream.js'

type RealtimeBindings = { readonly REALTIME_TICKET_SECRET: string }

const CoordinatorIdentity = Schema.Struct({
  organizationId: Schema.String,
  resourceId: Schema.String,
})
type CoordinatorIdentity = typeof CoordinatorIdentity.Type

const EventEnvelope = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  type: Schema.String,
  resourceId: Schema.optional(Schema.String),
  occurredAt: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export type EventEnvelope = typeof EventEnvelope.Type

const responseProblem = (status: number, code: string): Response =>
  new Response(
    JSON.stringify({
      type: `https://errors.gridora.example/${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Realtime connection rejected',
      status,
      code,
      detail: 'The realtime authorization ticket is invalid or has expired',
      requestId: crypto.randomUUID(),
      retryable: false,
      fields: [],
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

abstract class ScopedCoordinator extends DurableObject<RealtimeBindings> {
  protected identity: CoordinatorIdentity | undefined

  protected async ensureIdentity(organizationId: string, resourceId: string): Promise<void> {
    const requested = { organizationId, resourceId }
    const stored = this.identity ?? (await this.ctx.storage.get<CoordinatorIdentity>('identity'))
    if (stored === undefined) {
      await this.ctx.storage.put('identity', requested)
      this.identity = requested
      return
    }
    if (stored.organizationId !== organizationId || stored.resourceId !== resourceId) {
      throw new Error('Durable Object organization scope mismatch')
    }
    this.identity = stored
  }

  protected initializeRealtimeTickets(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS realtime_ticket_nonces (
      nonce TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`)
  }

  protected async authorizeUpgrade(
    request: Request,
    resourceType: 'node' | 'organization' | 'resource',
    audience: 'console' | 'node-agent',
  ): Promise<RealtimeTicketClaims | null> {
    const identity = this.identity ?? (await this.ctx.storage.get<CoordinatorIdentity>('identity'))
    if (identity === undefined) return null
    const ticket = new URL(request.url).searchParams.get('ticket')
    if (ticket === null) return null
    const result = await Effect.runPromise(
      Effect.result(
        verifyRealtimeTicket(ticket, this.env.REALTIME_TICKET_SECRET, {
          organizationId: identity.organizationId,
          resourceType,
          resourceId: identity.resourceId,
        }),
      ),
    )
    if (result._tag === 'Failure') return null
    if (result.success.audience !== audience) return null
    this.ctx.storage.sql.exec('DELETE FROM realtime_ticket_nonces WHERE expires_at < ?', Date.now())
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO realtime_ticket_nonces (nonce, principal_id, expires_at) VALUES (?, ?, ?)',
        result.success.nonce,
        result.success.principalId,
        result.success.expiresAt,
      )
      return result.success
    } catch {
      return null
    }
  }

  protected acceptWebSocket(
    tags: string[],
    attachment: RealtimeTicketClaims,
  ): { readonly response: Response; readonly socket: WebSocket } {
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], tags)
    pair[1].serializeAttachment(attachment)
    return { response: new Response(null, { status: 101, webSocket: pair[0] }), socket: pair[1] }
  }
}

export class InternalReplayGuardDO extends DurableObject<RealtimeBindings> {
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS internal_nonces (
        scope TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(scope, nonce)
      )`)
    })
  }

  async claim(scope: string, nonce: string, expiresAt: number): Promise<boolean> {
    if (
      scope.length === 0 ||
      scope.length > 256 ||
      nonce.length < 8 ||
      nonce.length > 256 ||
      expiresAt <= Date.now()
    )
      return false
    this.ctx.storage.sql.exec('DELETE FROM internal_nonces WHERE expires_at < ?', Date.now())
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO internal_nonces (scope, nonce, expires_at) VALUES (?, ?, ?)',
        scope,
        nonce,
        expiresAt,
      )
      return true
    } catch {
      return false
    }
  }
}

export class AuthIntentRateLimitDO extends DurableObject<RealtimeBindings> {
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate_window (
        window_start INTEGER PRIMARY KEY,
        request_count INTEGER NOT NULL
      )`)
    })
  }

  async allow(now: number, windowMilliseconds = 60_000, maximum = 10): Promise<boolean> {
    const windowStart = Math.floor(now / windowMilliseconds) * windowMilliseconds
    this.ctx.storage.sql.exec('DELETE FROM rate_window WHERE window_start < ?', windowStart)
    const current =
      this.ctx.storage.sql
        .exec<{ request_count: number }>(
          'SELECT request_count FROM rate_window WHERE window_start = ?',
          windowStart,
        )
        .toArray()[0]?.request_count ?? 0
    if (current >= maximum) return false
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_window (window_start, request_count) VALUES (?, 1)
       ON CONFLICT(window_start) DO UPDATE SET request_count = request_count + 1`,
      windowStart,
    )
    return true
  }
}

export class AuthIntentStateDO extends DurableObject<RealtimeBindings> {
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS auth_intent (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        verifier_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_by TEXT,
        consumed_at INTEGER
      )`)
    })
  }

  async issue(
    verifierHash: string,
    expiresAt: number,
    state: {
      readonly intent: 'sign-in' | 'sign-up' | 'accept-invitation'
      readonly returnTo: string
      readonly invitationTokenHash?: string | undefined
      readonly displayName?: string | undefined
    },
  ): Promise<boolean> {
    if (verifierHash.length !== 64 || expiresAt <= Date.now()) return false
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO auth_intent (singleton, verifier_hash, state_json, expires_at) VALUES (1, ?, ?, ?)',
        verifierHash,
        JSON.stringify(state),
        expiresAt,
      )
      await this.ctx.storage.setAlarm(expiresAt)
      return true
    } catch {
      return false
    }
  }

  async consume(
    verifierHash: string,
    accessSubject: string,
  ): Promise<{
    readonly intent: 'sign-in' | 'sign-up' | 'accept-invitation'
    readonly returnTo: string
    readonly invitationTokenHash?: string | undefined
    readonly displayName?: string | undefined
  } | null> {
    const current = this.ctx.storage.sql
      .exec<{ state_json: string; consumed_by: string | null }>(
        `SELECT state_json, consumed_by FROM auth_intent
       WHERE singleton = 1 AND verifier_hash = ? AND expires_at >= ?`,
        verifierHash,
        Date.now(),
      )
      .toArray()[0]
    if (current === undefined) return null
    if (current.consumed_by !== null)
      return current.consumed_by === accessSubject ? JSON.parse(current.state_json) : null
    const changed = this.ctx.storage.sql.exec(
      `UPDATE auth_intent SET consumed_by = ?, consumed_at = ?
       WHERE singleton = 1 AND verifier_hash = ? AND expires_at >= ? AND consumed_at IS NULL`,
      accessSubject,
      Date.now(),
      verifierHash,
      Date.now(),
    )
    if (changed.rowsWritten !== 1) return null
    return JSON.parse(current.state_json)
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

export type NodeCommand = AgentCommand

export class NodeCoordinatorDO extends ScopedCoordinator {
  readonly #commandWaiters = new Set<(command: NodeCommand | null) => void>()
  readonly #resultWaiters = new Map<string, Set<(result: CommandResultType | null) => void>>()
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS commands (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          result_body TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          last_result_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS port_reservations (
          reservation_id TEXT PRIMARY KEY,
          protocol TEXT NOT NULL,
          port INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          UNIQUE(protocol, port)
        );
      `)
      this.initializeRealtimeTickets()
      const existingSession = await this.ctx.storage.get<number>('node_session_version')
      if (existingSession === undefined) await this.ctx.storage.put('node_session_version', 1)
      this.identity = await this.ctx.storage.get<CoordinatorIdentity>('identity')
    })
  }

  async initialize(organizationId: string, nodeId: string, sessionVersion = 1): Promise<void> {
    await this.ensureIdentity(organizationId, nodeId)
    const current = await this.ctx.storage.get<number>('node_session_version')
    if (sessionVersion < (current ?? 1))
      throw new Error('Node session version cannot move backwards')
    if (sessionVersion !== current)
      await this.ctx.storage.put('node_session_version', sessionVersion)
  }

  async enqueue(
    command: NodeCommand,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }> {
    await this.ensureIdentity(command.organizationId, command.nodeId)
    const existing = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        'SELECT sequence, body FROM commands WHERE idempotency_key = ?',
        command.idempotencyKey,
      )
      .toArray()[0] as { sequence: number; body: string } | undefined
    if (existing !== undefined) {
      const stored = JSON.parse(existing.body) as AgentCommand
      if (!sameCommandPayload(stored, command)) {
        throw new Error('Node command idempotency payload mismatch')
      }
      return { sequence: existing.sequence, replayed: true }
    }
    const row = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        "INSERT INTO commands (id, idempotency_key, body, status, created_at) VALUES (?, ?, ?, 'queued', ?) RETURNING sequence",
        command.commandId,
        command.idempotencyKey,
        JSON.stringify(command),
        Date.now(),
      )
      .one()
    for (const socket of this.ctx.getWebSockets('agent'))
      socket.send(JSON.stringify({ type: 'command', command }))
    for (const waiter of this.#commandWaiters) waiter(command)
    this.#commandWaiters.clear()
    return { sequence: row.sequence, replayed: false }
  }

  async acknowledge(organizationId: string, nodeId: string, commandId: string): Promise<void> {
    await this.ensureIdentity(organizationId, nodeId)
    this.ctx.storage.sql.exec("UPDATE commands SET status = 'acknowledged' WHERE id = ?", commandId)
  }

  async drainQueuedCommands(
    organizationId: string,
    nodeId: string,
  ): Promise<
    ReadonlyArray<{
      readonly sequence: number
      readonly command: NodeCommand
    }>
  > {
    await this.ensureIdentity(organizationId, nodeId)
    const now = Date.now()
    const rows = this.ctx.storage.sql
      .exec<{ sequence: number; id: string; body: string }>(
        "SELECT sequence, id, body FROM commands WHERE status = 'queued' ORDER BY sequence",
      )
      .toArray()
    const pending: Array<{ readonly sequence: number; readonly command: NodeCommand }> = []
    for (const row of rows) {
      const command = JSON.parse(row.body) as NodeCommand
      if (Date.parse(command.expiresAt) <= now) {
        this.ctx.storage.sql.exec(
          "UPDATE commands SET status = 'expired' WHERE id = ? AND status = 'queued'",
          row.id,
        )
      } else {
        pending.push({ sequence: row.sequence, command })
      }
    }
    return pending
  }

  async waitForCommand(
    organizationId: string,
    nodeId: string,
    waitSeconds: number,
  ): Promise<NodeCommand | null> {
    const pending = await this.drainQueuedCommands(organizationId, nodeId)
    if (pending[0] !== undefined) return pending[0].command
    const boundedWait = Math.max(1, Math.min(30, Math.trunc(waitSeconds)))
    return new Promise<NodeCommand | null>((resolve) => {
      let settled = false
      const waiter = (command: NodeCommand | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.#commandWaiters.delete(waiter)
        resolve(command)
      }
      const timeout = setTimeout(() => waiter(null), boundedWait * 1_000)
      this.#commandWaiters.add(waiter)
    })
  }

  async acceptCommandResult(
    organizationId: string,
    nodeId: string,
    result: CommandResultType,
  ): Promise<{
    readonly accepted: boolean
    readonly replayed: boolean
    readonly lastSequence: number
  }> {
    await this.ensureIdentity(organizationId, nodeId)
    const last =
      this.ctx.storage.sql
        .exec<{ last_result_sequence: number }>(
          'SELECT last_result_sequence FROM agent_state WHERE singleton = 1',
        )
        .toArray()[0]?.last_result_sequence ?? 0
    const command = this.ctx.storage.sql
      .exec<{ sequence: number; status: string; body: string; result_body: string | null }>(
        'SELECT sequence, status, body, result_body FROM commands WHERE id = ?',
        result.commandId,
      )
      .toArray()[0]
    if (command === undefined) {
      return { accepted: false, replayed: false, lastSequence: last }
    }
    const storedCommand = JSON.parse(command.body) as AgentCommand
    if (!validCommandResult(storedCommand, result)) {
      return { accepted: false, replayed: false, lastSequence: last }
    }
    if (command.status === 'succeeded' || command.status === 'failed') {
      const storedResult =
        command.result_body === null ? null : (JSON.parse(command.result_body) as CommandResultType)
      return {
        accepted: false,
        replayed: storedResult !== null && sameCommandResult(storedResult, result),
        lastSequence: last,
      }
    }
    this.ctx.storage.sql.exec(
      'UPDATE commands SET status = ?, result_body = ? WHERE id = ? AND sequence = ?',
      result.status === 'succeeded' ? 'succeeded' : 'failed',
      JSON.stringify(result),
      result.commandId,
      command.sequence,
    )
    const completedSequences = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        "SELECT sequence FROM commands WHERE status IN ('succeeded', 'failed') ORDER BY sequence",
      )
      .toArray()
      .map((row) => row.sequence)
    const watermark = contiguousResultWatermark(last, completedSequences)
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (singleton, last_result_sequence) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET last_result_sequence = excluded.last_result_sequence`,
      watermark,
    )
    const waiters = this.#resultWaiters.get(result.commandId)
    if (waiters !== undefined) {
      this.#resultWaiters.delete(result.commandId)
      for (const waiter of waiters) waiter(result)
    }
    return { accepted: true, replayed: false, lastSequence: watermark }
  }

  /**
   * Read or await the terminal result for one exact command.  The command
   * queue is durable; this in-memory waiter is only a latency optimization.
   * A Workflow retry can call the method again and adopt the durable result
   * after a response loss or an isolate restart.
   */
  async waitForCommandResult(
    organizationId: string,
    nodeId: string,
    commandId: string,
    waitSeconds: number,
  ): Promise<CommandResultType | null> {
    await this.ensureIdentity(organizationId, nodeId)
    const read = (): CommandResultType | null => {
      const row = this.ctx.storage.sql
        .exec<{ status: string; result_body: string | null }>(
          'SELECT status, result_body FROM commands WHERE id = ?',
          commandId,
        )
        .toArray()[0]
      if (
        row === undefined ||
        (row.status !== 'succeeded' && row.status !== 'failed') ||
        row.result_body === null
      )
        return null
      return JSON.parse(row.result_body) as CommandResultType
    }
    const existing = read()
    if (existing !== null) return existing
    const boundedWait = Math.max(1, Math.min(30, Math.trunc(waitSeconds)))
    return new Promise<CommandResultType | null>((resolve) => {
      let settled = false
      const waiters =
        this.#resultWaiters.get(commandId) ?? new Set<(result: CommandResultType | null) => void>()
      const waiter = (result: CommandResultType | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        waiters.delete(waiter)
        if (waiters.size === 0) this.#resultWaiters.delete(commandId)
        resolve(result)
      }
      const timeout = setTimeout(() => waiter(read()), boundedWait * 1_000)
      waiters.add(waiter)
      this.#resultWaiters.set(commandId, waiters)
    })
  }

  async reservePort(
    organizationId: string,
    nodeId: string,
    reservationId: string,
    protocol: 'tcp' | 'udp',
    port: number,
    expiresAt: number,
  ): Promise<boolean> {
    await this.ensureIdentity(organizationId, nodeId)
    this.ctx.storage.sql.exec('DELETE FROM port_reservations WHERE expires_at < ?', Date.now())
    try {
      this.ctx.storage.sql.exec(
        'INSERT INTO port_reservations (reservation_id, protocol, port, expires_at) VALUES (?, ?, ?, ?)',
        reservationId,
        protocol,
        port,
        expiresAt,
      )
      return true
    } catch {
      return false
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return responseProblem(426, 'WEBSOCKET_REQUIRED')
    const claims = await this.authorizeUpgrade(request, 'node', 'node-agent')
    if (claims === null) return responseProblem(403, 'REALTIME_ACCESS_DENIED')
    const identity = this.identity
    const sessionVersion = await this.ctx.storage.get<number>('node_session_version')
    if (
      identity === undefined ||
      !validNodeAgentClaims(claims, identity.resourceId, sessionVersion ?? 1)
    ) {
      return responseProblem(403, 'REALTIME_ACCESS_DENIED')
    }
    const accepted = this.acceptWebSocket(['agent', `principal:${claims.principalId}`], claims)
    for (const pending of await this.drainQueuedCommands(
      identity.organizationId,
      identity.resourceId,
    )) {
      accepted.socket.send(
        JSON.stringify({ type: 'command', sequence: pending.sequence, command: pending.command }),
      )
    }
    return accepted.response
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 65_536) {
      socket.close(1009, 'message too large')
      return
    }
    const decoded = await Effect.runPromise(
      Effect.result(
        Effect.try({ try: () => JSON.parse(message), catch: () => new Error('invalid json') }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CommandResult)),
        ),
      ),
    )
    if (decoded._tag === 'Failure') {
      socket.close(1007, 'invalid command result')
      return
    }
    const identity = this.identity ?? (await this.ctx.storage.get<CoordinatorIdentity>('identity'))
    if (identity === undefined) {
      socket.close(1011, 'coordinator not initialized')
      return
    }
    const outcome = await this.acceptCommandResult(
      identity.organizationId,
      identity.resourceId,
      decoded.success,
    )
    socket.send(
      JSON.stringify({
        type: 'command-result-ack',
        commandId: decoded.success.commandId,
        ...outcome,
      }),
    )
  }
}

export class ResourceOperationDO extends ScopedCoordinator {
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operation_lock (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        operation_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_reservations (
        scope TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)
      this.initializeRealtimeTickets()
      this.identity = await this.ctx.storage.get<CoordinatorIdentity>('identity')
    })
  }

  async initialize(organizationId: string, resourceId: string): Promise<void> {
    await this.ensureIdentity(organizationId, resourceId)
  }

  async acquire(
    organizationId: string,
    resourceId: string,
    operationId: string,
    ownerToken: string,
    expectedRevision: number,
    leaseMilliseconds = 120_000,
  ): Promise<{
    readonly acquired: boolean
    readonly operationId: string
    readonly leaseUntil: number
  }> {
    await this.ensureIdentity(organizationId, resourceId)
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'DELETE FROM operation_lock WHERE singleton = 1 AND lease_until <= ?',
      now,
    )
    const current = this.ctx.storage.sql
      .exec<{ operation_id: string; owner_token: string; lease_until: number }>(
        'SELECT operation_id, owner_token, lease_until FROM operation_lock WHERE singleton = 1',
      )
      .toArray()[0]
    if (current !== undefined)
      return {
        acquired: current.operation_id === operationId && current.owner_token === ownerToken,
        operationId: current.operation_id,
        leaseUntil: current.lease_until,
      }
    const leaseUntil = now + leaseMilliseconds
    this.ctx.storage.sql.exec(
      'INSERT INTO operation_lock (singleton, operation_id, owner_token, lease_until, revision, acquired_at) VALUES (1, ?, ?, ?, ?, ?)',
      operationId,
      ownerToken,
      leaseUntil,
      expectedRevision,
      now,
    )
    return { acquired: true, operationId, leaseUntil }
  }

  async renew(
    organizationId: string,
    resourceId: string,
    operationId: string,
    ownerToken: string,
    leaseMilliseconds = 120_000,
  ): Promise<number | null> {
    await this.ensureIdentity(organizationId, resourceId)
    const now = Date.now()
    const leaseUntil = now + leaseMilliseconds
    const changed = this.ctx.storage.sql.exec(
      `UPDATE operation_lock SET lease_until = ? WHERE singleton = 1 AND operation_id = ?
       AND owner_token = ? AND lease_until > ?`,
      leaseUntil,
      operationId,
      ownerToken,
      now,
    )
    return changed.rowsWritten === 1 ? leaseUntil : null
  }

  async reserveIdempotency(
    organizationId: string,
    scope: string,
    operationId: string,
    resourceId: string,
    payloadFingerprint: string,
  ): Promise<{
    readonly status: 'reserved' | 'replayed' | 'conflict'
    readonly operationId: string
    readonly resourceId: string
  }> {
    await this.ensureIdentity(organizationId, scope)
    const current = this.ctx.storage.sql
      .exec<{ operation_id: string; resource_id: string; payload_fingerprint: string }>(
        'SELECT operation_id, resource_id, payload_fingerprint FROM idempotency_reservations WHERE scope = ?',
        scope,
      )
      .toArray()[0]
    if (current !== undefined)
      return {
        status: current.payload_fingerprint === payloadFingerprint ? 'replayed' : 'conflict',
        operationId: current.operation_id,
        resourceId: current.resource_id,
      }
    this.ctx.storage.sql.exec(
      'INSERT INTO idempotency_reservations (scope, operation_id, resource_id, payload_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)',
      scope,
      operationId,
      resourceId,
      payloadFingerprint,
      Date.now(),
    )
    return { status: 'reserved', operationId, resourceId }
  }

  async releaseIdempotency(
    organizationId: string,
    scope: string,
    operationId: string,
    resourceId: string,
  ): Promise<boolean> {
    await this.ensureIdentity(organizationId, scope)
    const changed = this.ctx.storage.sql.exec(
      'DELETE FROM idempotency_reservations WHERE scope = ? AND operation_id = ? AND resource_id = ?',
      scope,
      operationId,
      resourceId,
    )
    return changed.rowsWritten > 0
  }

  async requestCancellation(
    organizationId: string,
    resourceId: string,
    operationId: string,
  ): Promise<boolean> {
    await this.ensureIdentity(organizationId, resourceId)
    const changed = this.ctx.storage.sql.exec(
      'UPDATE operation_lock SET cancellation_requested = 1 WHERE singleton = 1 AND operation_id = ?',
      operationId,
    )
    return changed.rowsWritten > 0
  }

  async release(
    organizationId: string,
    resourceId: string,
    operationId: string,
    ownerToken: string,
  ): Promise<boolean> {
    await this.ensureIdentity(organizationId, resourceId)
    const changed = this.ctx.storage.sql.exec(
      'DELETE FROM operation_lock WHERE singleton = 1 AND operation_id = ? AND owner_token = ?',
      operationId,
      ownerToken,
    )
    return changed.rowsWritten > 0
  }
}

export class OrganizationEventsDO extends ScopedCoordinator {
  constructor(ctx: DurableObjectState, env: RealtimeBindings) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS recent_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      )`)
      this.initializeRealtimeTickets()
      this.identity = await this.ctx.storage.get<CoordinatorIdentity>('identity')
    })
  }

  async initialize(organizationId: string): Promise<void> {
    await this.ensureIdentity(organizationId, organizationId)
  }

  async publish(event: EventEnvelope): Promise<boolean> {
    await this.ensureIdentity(event.organizationId, event.organizationId)
    const exists = this.ctx.storage.sql
      .exec('SELECT event_id FROM recent_events WHERE event_id = ?', event.id)
      .toArray()[0]
    if (exists !== undefined) return false
    this.ctx.storage.sql.exec(
      'INSERT INTO recent_events (event_id, body, occurred_at) VALUES (?, ?, ?)',
      event.id,
      JSON.stringify(event),
      Date.parse(event.occurredAt),
    )
    this.ctx.storage.sql.exec(`DELETE FROM recent_events WHERE sequence NOT IN (
      SELECT sequence FROM recent_events ORDER BY sequence DESC LIMIT 100
    )`)
    for (const socket of this.ctx.getWebSockets('dashboard')) socket.send(JSON.stringify(event))
    closeSocketsForMembershipRevocation(event, (tag) => this.ctx.getWebSockets(tag))
    return true
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return responseProblem(426, 'WEBSOCKET_REQUIRED')
    const claims = await this.authorizeUpgrade(request, 'organization', 'console')
    if (claims === null) return responseProblem(403, 'REALTIME_ACCESS_DENIED')
    return this.acceptWebSocket(['dashboard', `principal:${claims.principalId}`], claims).response
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') socket.send('pong')
  }
}

export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<RealtimeBindings>

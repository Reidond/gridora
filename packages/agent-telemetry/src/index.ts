import { Effect, Schema, Semaphore } from 'effect'
import { LOG_LIMITS, LogValidationError, makeLogBatch } from '@gridora/log-control'
import type { LogBatch, LogEntry } from '@gridora/log-control'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

export const AGENT_TELEMETRY_LIMITS = {
  maximumHealthBytes: 16 * 1024,
  maximumLogSpoolBytes: 4 * 1024 * 1024,
  maximumSpoolEntries: 4096,
  maximumResponseBytes: 16 * 1024,
  maximumFutureSkewMilliseconds: 30_000,
} as const

/** Machine-observed facts only. Provider, policy, backup, and operation truth is control-plane-owned. */
export interface AgentHealthSample {
  readonly apiVersion: 'agent.telemetry.gridora.dev/v1alpha1'
  readonly organizationId: string
  readonly nodeId: string
  readonly sampledAt: string
  readonly agentVersion: string
  readonly tunnel: 'connected' | 'degraded' | 'offline' | 'unknown'
  readonly docker: 'healthy' | 'degraded' | 'offline' | 'unknown'
  readonly firewall: 'ready' | 'degraded' | 'offline' | 'unknown'
  readonly cpuUsedMillis: number
  readonly cpuTotalMillis: number
  readonly ramUsedBytes: number
  readonly ramTotalBytes: number
  readonly diskUsedBytes: number
  readonly diskTotalBytes: number
  readonly loadPermille: number
  readonly networkReceiveBytes: number
  readonly networkTransmitBytes: number
  readonly containers: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly state: 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'unknown'
    readonly health: 'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown'
    readonly restartCount: number
    readonly cpuUsedMillis: number
    readonly memoryUsedBytes: number
  }>
}

export interface AgentTelemetryReceipt {
  readonly organizationId: string
  readonly nodeId: string
  readonly acceptedAt: string
  readonly logFirstSequence?: number
  readonly logLastSequence?: number
  readonly replayed: boolean
}

/**
 * The agent may report container and plugin/game facts, but never decides the
 * placement.  The API resolves this tuple against the authenticated node's
 * current deployment before it writes server health.
 */
export interface AgentServerHealthSample {
  readonly serverId: string
  readonly deploymentId: string
  readonly containerId: string
  readonly game: {
    readonly process: 'running' | 'stopped' | 'unknown'
    readonly query: 'healthy' | 'unhealthy' | 'unsupported' | 'unknown'
    readonly mods: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
    readonly map?: string
    readonly scenario?: string
    readonly playerCount?: number
    readonly version?: string
  }
}

export class AgentTelemetryError extends Schema.TaggedError<AgentTelemetryError>()(
  'AgentTelemetryError',
  {
    code: Schema.Literals([
      'invalid-input',
      'transport-failed',
      'response-too-large',
      'rejected',
      'offline',
    ]),
    message: Schema.String,
  },
) {}

const safeIso = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
const validState = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
  'unknown',
])
const validContainerHealth = new Set(['healthy', 'unhealthy', 'starting', 'none', 'unknown'])
const validTunnel = new Set(['connected', 'degraded', 'offline', 'unknown'])
const validDocker = new Set(['healthy', 'degraded', 'offline', 'unknown'])
const validFirewall = new Set(['ready', 'degraded', 'offline', 'unknown'])
const healthKeys = new Set([
  'apiVersion',
  'organizationId',
  'nodeId',
  'sampledAt',
  'agentVersion',
  'tunnel',
  'docker',
  'firewall',
  'cpuUsedMillis',
  'cpuTotalMillis',
  'ramUsedBytes',
  'ramTotalBytes',
  'diskUsedBytes',
  'diskTotalBytes',
  'loadPermille',
  'networkReceiveBytes',
  'networkTransmitBytes',
  'containers',
])
const containerKeys = new Set([
  'id',
  'name',
  'state',
  'health',
  'restartCount',
  'cpuUsedMillis',
  'memoryUsedBytes',
])

export const validateAgentHealthSample = (
  sample: AgentHealthSample,
  now = Date.now(),
): Effect.Effect<void, AgentTelemetryError> => {
  if (
    typeof sample !== 'object' ||
    sample === null ||
    Array.isArray(sample) ||
    Object.keys(sample).some((key) => !healthKeys.has(key)) ||
    sample.apiVersion !== 'agent.telemetry.gridora.dev/v1alpha1' ||
    !Schema.is(Identifier)(sample.organizationId) ||
    !Schema.is(Identifier)(sample.nodeId) ||
    !safeIso(sample.sampledAt) ||
    Date.parse(sample.sampledAt) > now + AGENT_TELEMETRY_LIMITS.maximumFutureSkewMilliseconds ||
    !Schema.is(Identifier)(sample.agentVersion) ||
    !validTunnel.has(sample.tunnel) ||
    !validDocker.has(sample.docker) ||
    !validFirewall.has(sample.firewall)
  )
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Agent health scope, timestamp, or version is invalid',
      }),
    )
  const numbers = [
    sample.cpuUsedMillis,
    sample.cpuTotalMillis,
    sample.ramUsedBytes,
    sample.ramTotalBytes,
    sample.diskUsedBytes,
    sample.diskTotalBytes,
    sample.loadPermille,
    sample.networkReceiveBytes,
    sample.networkTransmitBytes,
  ]
  if (
    numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    sample.cpuUsedMillis > sample.cpuTotalMillis ||
    sample.ramUsedBytes > sample.ramTotalBytes ||
    sample.diskUsedBytes > sample.diskTotalBytes
  )
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Agent health capacity is invalid',
      }),
    )
  if (
    !Array.isArray(sample.containers) ||
    sample.containers.length > 128 ||
    sample.containers.some(
      (container) =>
        typeof container !== 'object' ||
        container === null ||
        Array.isArray(container) ||
        Object.keys(container).some((key) => !containerKeys.has(key)) ||
        !Schema.is(Identifier)(container.id) ||
        typeof container.name !== 'string' ||
        container.name.length < 1 ||
        container.name.length > 128 ||
        !validState.has(container.state) ||
        !validContainerHealth.has(container.health) ||
        ![container.restartCount, container.cpuUsedMillis, container.memoryUsedBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ),
    )
  )
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Agent container health is invalid',
      }),
    )
  const encoded = JSON.stringify(sample)
  if (new TextEncoder().encode(encoded).byteLength > AGENT_TELEMETRY_LIMITS.maximumHealthBytes)
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Agent health sample is too large',
      }),
    )
  return Effect.void
}

export const prepareAgentHealthSample = (
  input: Omit<AgentHealthSample, 'apiVersion'>,
): Effect.Effect<AgentHealthSample, AgentTelemetryError> => {
  const sample: AgentHealthSample = { apiVersion: 'agent.telemetry.gridora.dev/v1alpha1', ...input }
  return validateAgentHealthSample(sample).pipe(Effect.as(sample))
}

export interface AgentTelemetryTransportShape {
  readonly publish: (
    credential: string,
    input: AgentTelemetryPayload,
  ) => Effect.Effect<AgentTelemetryReceipt, AgentTelemetryError>
}

export interface AgentTelemetryPayload {
  readonly health: AgentHealthSample
  readonly logs?: LogBatch
  readonly serverHealth?: ReadonlyArray<AgentServerHealthSample>
}

const readResponse = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response body is missing')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > AGENT_TELEMETRY_LIMITS.maximumResponseBytes) {
        await reader.cancel()
        throw new Error('response too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

const decodeReceipt = (value: unknown): AgentTelemetryReceipt | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (
    typeof row.organizationId !== 'string' ||
    typeof row.nodeId !== 'string' ||
    typeof row.acceptedAt !== 'string' ||
    typeof row.replayed !== 'boolean'
  )
    return undefined
  if (
    row.logFirstSequence !== undefined &&
    (!Number.isSafeInteger(row.logFirstSequence) || (row.logFirstSequence as number) < 1)
  )
    return undefined
  if (
    row.logLastSequence !== undefined &&
    (!Number.isSafeInteger(row.logLastSequence) || (row.logLastSequence as number) < 1)
  )
    return undefined
  return {
    organizationId: row.organizationId,
    nodeId: row.nodeId,
    acceptedAt: row.acceptedAt,
    replayed: row.replayed,
    ...(row.logFirstSequence === undefined
      ? {}
      : { logFirstSequence: row.logFirstSequence as number }),
    ...(row.logLastSequence === undefined
      ? {}
      : { logLastSequence: row.logLastSequence as number }),
  }
}

const prepareTelemetryLogs = (
  value: unknown,
  health: AgentHealthSample,
  now: number,
): Effect.Effect<LogBatch | undefined, AgentTelemetryError> => {
  if (value === undefined) return Effect.succeed(undefined)
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  const organizationId = typeof raw.organizationId === 'string' ? raw.organizationId : ''
  const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId : ''
  return makeLogBatch(organizationId, nodeId, entries).pipe(
    Effect.mapError(
      (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
    ),
    Effect.flatMap((batch) => {
      if (
        batch.organizationId !== health.organizationId ||
        batch.nodeId !== health.nodeId ||
        batch.entries.some(
          (entry) =>
            Date.parse(entry.timestamp) >
            now + AGENT_TELEMETRY_LIMITS.maximumFutureSkewMilliseconds,
        )
      )
        return Effect.fail(
          new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Telemetry log scope or timestamp is invalid',
          }),
        )
      return Effect.succeed(batch)
    }),
  )
}

const isGameProcess = (value: unknown): value is AgentServerHealthSample['game']['process'] =>
  value === 'running' || value === 'stopped' || value === 'unknown'

const isGameQuery = (value: unknown): value is AgentServerHealthSample['game']['query'] =>
  value === 'healthy' || value === 'unhealthy' || value === 'unsupported' || value === 'unknown'

const isGameMods = (value: unknown): value is AgentServerHealthSample['game']['mods'] =>
  value === 'healthy' || value === 'degraded' || value === 'unhealthy' || value === 'unknown'
const validateServerHealth = (
  value: unknown,
  health: AgentHealthSample,
): Effect.Effect<ReadonlyArray<AgentServerHealthSample> | undefined, AgentTelemetryError> => {
  if (value === undefined) return Effect.succeed(undefined)
  if (!Array.isArray(value) || value.length > 128)
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Telemetry server health is invalid',
      }),
    )
  const knownContainers = new Set(health.containers.map((container) => container.id))
  const seenServers = new Set<string>()
  const output: AgentServerHealthSample[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
      return Effect.fail(
        new AgentTelemetryError({
          code: 'invalid-input',
          message: 'Telemetry server health is invalid',
        }),
      )
    const row = candidate as Record<string, unknown>
    const game =
      typeof row.game === 'object' && row.game !== null && !Array.isArray(row.game)
        ? (row.game as Record<string, unknown>)
        : undefined
    const playerCount = game?.playerCount
    if (
      Object.keys(row).some(
        (key) =>
          key !== 'serverId' && key !== 'deploymentId' && key !== 'containerId' && key !== 'game',
      ) ||
      game === undefined ||
      Object.keys(game).some(
        (key) =>
          !['process', 'query', 'mods', 'map', 'scenario', 'playerCount', 'version'].includes(key),
      ) ||
      typeof row.serverId !== 'string' ||
      !Schema.is(Identifier)(row.serverId) ||
      typeof row.deploymentId !== 'string' ||
      !Schema.is(Identifier)(row.deploymentId) ||
      typeof row.containerId !== 'string' ||
      !Schema.is(Identifier)(row.containerId) ||
      !knownContainers.has(row.containerId) ||
      seenServers.has(row.serverId) ||
      !isGameProcess(game.process) ||
      !isGameQuery(game.query) ||
      !isGameMods(game.mods) ||
      (game.map !== undefined && (typeof game.map !== 'string' || game.map.length > 160)) ||
      (game.scenario !== undefined &&
        (typeof game.scenario !== 'string' || game.scenario.length > 160)) ||
      (playerCount !== undefined &&
        (typeof playerCount !== 'number' ||
          !Number.isSafeInteger(playerCount) ||
          playerCount < 0 ||
          playerCount > 10_000)) ||
      (game.version !== undefined &&
        (typeof game.version !== 'string' || game.version.length > 128))
    )
      return Effect.fail(
        new AgentTelemetryError({
          code: 'invalid-input',
          message: 'Telemetry server health is invalid',
        }),
      )
    seenServers.add(row.serverId)
    output.push({
      serverId: row.serverId,
      deploymentId: row.deploymentId,
      containerId: row.containerId,
      game: {
        process: game.process,
        query: game.query,
        mods: game.mods,
        ...(game.map === undefined ? {} : { map: game.map as string }),
        ...(game.scenario === undefined ? {} : { scenario: game.scenario as string }),
        ...(playerCount === undefined ? {} : { playerCount }),
        ...(game.version === undefined ? {} : { version: game.version as string }),
      },
    })
  }
  return Effect.succeed(output)
}

/** Strictly decodes the machine publication envelope before it reaches D1/R2. */
export const prepareAgentTelemetryPayload = (
  value: unknown,
  now = Date.now(),
): Effect.Effect<AgentTelemetryPayload, AgentTelemetryError> =>
  Effect.gen(function* () {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return yield* new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Telemetry payload must be an object',
      })
    const raw = value as Record<string, unknown>
    if (
      Object.keys(raw).some(
        (key) => key !== 'health' && key !== 'logs' && key !== 'serverHealth',
      ) ||
      typeof raw.health !== 'object' ||
      raw.health === null ||
      Array.isArray(raw.health)
    )
      return yield* new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Telemetry payload shape is invalid',
      })
    const health = raw.health as AgentHealthSample
    yield* validateAgentHealthSample(health, now)
    const logs = yield* prepareTelemetryLogs(raw.logs, health, now)
    const serverHealth = yield* validateServerHealth(raw.serverHealth, health)
    return {
      health,
      ...(logs === undefined ? {} : { logs }),
      ...(serverHealth === undefined ? {} : { serverHealth }),
    }
  })

export const FetchAgentTelemetryTransport = (
  controlPlaneUrl: string,
  expectedHost: string,
  allowLoopbackHttp = false,
) => {
  const origin = new URL(controlPlaneUrl)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(origin.hostname)
  if (
    origin.hostname !== expectedHost ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('telemetry endpoint host is invalid')
  if (
    origin.protocol !== 'https:' &&
    !(allowLoopbackHttp && loopback && origin.protocol === 'http:')
  )
    throw new Error('telemetry endpoint must use HTTPS')
  return {
    publish: (credential: string, input: AgentTelemetryPayload) =>
      Effect.gen(function* () {
        const now = Date.now()
        const payload = yield* prepareAgentTelemetryPayload(input, now)
        const body = JSON.stringify(payload)
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(
              new Request(new URL('/v1/agent/telemetry', origin), {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${credential}`,
                  'content-type': 'application/json',
                },
                body,
                redirect: 'error',
                signal: AbortSignal.timeout(10_000),
              }),
            ),
          catch: () =>
            new AgentTelemetryError({
              code: 'offline',
              message: 'Telemetry delivery failed while the control plane was unavailable',
            }),
        })
        const decoded = yield* Effect.tryPromise({
          try: () => readResponse(response),
          catch: (cause) =>
            new AgentTelemetryError({
              code:
                cause instanceof Error && cause.message === 'response too large'
                  ? 'response-too-large'
                  : 'rejected',
              message: 'Telemetry response is invalid',
            }),
        })
        if (!response.ok)
          return yield* new AgentTelemetryError({
            code: 'rejected',
            message: 'Telemetry event was rejected by the control plane',
          })
        const receipt = decodeReceipt(decoded)
        if (
          receipt === undefined ||
          receipt.organizationId !== input.health.organizationId ||
          receipt.nodeId !== input.health.nodeId
        )
          return yield* new AgentTelemetryError({
            code: 'rejected',
            message: 'Telemetry receipt scope is invalid',
          })
        return receipt
      }),
  } satisfies AgentTelemetryTransportShape
}

export interface LogSpoolShape {
  readonly append: (entry: LogEntry) => Effect.Effect<void, AgentTelemetryError>
  readonly drain: (
    maximumEntries: number,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, AgentTelemetryError>
  readonly size: Effect.Effect<number, AgentTelemetryError>
}

/** A bounded in-process adapter; the agent can wrap it in its existing fsync file state. */
export const makeBoundedLogSpool = (): LogSpoolShape => {
  const entries: LogEntry[] = []
  let bytes = 0
  return {
    append: (entry) =>
      Effect.gen(function* () {
        const sanitized = yield* (
          makeLogBatch(entry.organizationId, entry.nodeId, [entry]) as Effect.Effect<
            LogBatch,
            LogValidationError
          >
        ).pipe(
          Effect.mapError(
            (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
          ),
        )
        const nextBytes = bytes + sanitized.uncompressedBytes
        if (
          entries.length >= AGENT_TELEMETRY_LIMITS.maximumSpoolEntries ||
          nextBytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes
        )
          return yield* new AgentTelemetryError({
            code: 'offline',
            message: 'Log spool capacity is exhausted',
          })
        entries.push(sanitized.entries[0]!)
        bytes = nextBytes
      }),
    drain: (maximumEntries) =>
      Effect.try({
        try: () => {
          if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1)
            throw new Error('invalid drain limit')
          const output = entries.splice(0, Math.min(maximumEntries, entries.length))
          bytes = entries.reduce(
            (total, entry) =>
              total + new TextEncoder().encode(`${JSON.stringify(entry)}\n`).byteLength,
            0,
          )
          return output
        },
        catch: () =>
          new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Log spool drain limit is invalid',
          }),
      }),
    size: Effect.sync(() => entries.length),
  }
}

export interface DurableLogSpoolStorage {
  /**
   * Atomically reads, transforms, and commits one spool state. Implementations
   * backed by a file must hold their OS/file lock across the callback and the
   * replace/fsync operation; a separate read followed by write is not safe.
   * A failed callback must leave the stored state unchanged.
   */
  readonly transact: <A>(
    operation: (entries: ReadonlyArray<unknown>) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<unknown>
        readonly result: A
      },
      AgentTelemetryError
    >,
  ) => Effect.Effect<A, AgentTelemetryError>
}

/**
 * The agent must preserve the exact publication envelope across a timeout or a
 * credential/session renewal.  A separate health file plus a log spool would
 * leave an acknowledgement crash window, so implementations expose one
 * full-state transaction for entries and the pending canonical payload.
 */
export interface DurableTelemetrySpoolState {
  readonly entries: ReadonlyArray<unknown>
  /** JSON persistence accepts only an object envelope or an explicit empty slot. */
  readonly pendingPayload: object | null
}

export interface DurableTelemetrySpoolStorage {
  readonly transactTelemetry: <A>(
    operation: (state: DurableTelemetrySpoolState) => Effect.Effect<
      {
        readonly state: DurableTelemetrySpoolState
        readonly result: A
      },
      AgentTelemetryError
    >,
  ) => Effect.Effect<A, AgentTelemetryError>
}

/**
 * Ack-based durable spool contract for the real agent file adapter.  `peek` never
 * removes data; only an acknowledged contiguous sequence may be deleted after the
 * control plane receipt has been durably observed.
 */
export const makeDurableLogSpool = (
  storage: DurableLogSpoolStorage,
): {
  readonly append: (entry: LogEntry) => Effect.Effect<void, AgentTelemetryError>
  readonly peek: (
    maximumEntries: number,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, AgentTelemetryError>
  readonly acknowledgeThrough: (sequence: number) => Effect.Effect<void, AgentTelemetryError>
  readonly size: Effect.Effect<number, AgentTelemetryError>
} => {
  const decodeEntries = (values: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      if (values.length > AGENT_TELEMETRY_LIMITS.maximumSpoolEntries)
        return yield* new AgentTelemetryError({
          code: 'offline',
          message: 'Durable log spool exceeds the configured entry bound',
        })
      const entries: LogEntry[] = []
      let previous = 0
      let organizationId: string | undefined
      let nodeId: string | undefined
      let bytes = 0
      for (const value of values) {
        const envelope =
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
        const valueOrganizationId =
          typeof envelope.organizationId === 'string' ? envelope.organizationId : ''
        const valueNodeId = typeof envelope.nodeId === 'string' ? envelope.nodeId : ''
        const entry = yield* makeLogBatch(valueOrganizationId, valueNodeId, [value]).pipe(
          Effect.mapError(
            (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
          ),
        )
        const next = entry.entries[0]!
        if (organizationId === undefined) organizationId = next.organizationId
        if (nodeId === undefined) nodeId = next.nodeId
        if (next.organizationId !== organizationId || next.nodeId !== nodeId)
          return yield* new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable log spool scope changed',
          })
        if (previous !== 0 && next.sequence <= previous)
          return yield* new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable log spool sequence is not strictly increasing',
          })
        previous = next.sequence
        bytes += entry.uncompressedBytes
        entries.push(next)
      }
      if (bytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes)
        return yield* new AgentTelemetryError({
          code: 'offline',
          message: 'Durable log spool exceeds the configured byte bound',
        })
      return entries
    })
  // The storage transaction is the cross-process durability boundary. This
  // semaphore also prevents two fibers using this spool instance from entering
  // the boundary concurrently and makes append+ack ordering deterministic.
  const semaphore = Semaphore.makeUnsafe(1)
  const transaction = <A>(
    operation: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<LogEntry>
        readonly result: A
      },
      AgentTelemetryError
    >,
  ): Effect.Effect<A, AgentTelemetryError> =>
    semaphore.withPermit(
      storage.transact((raw) => decodeEntries(raw).pipe(Effect.flatMap(operation))),
    )
  const sanitizeEntry = (value: unknown) => {
    const envelope =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    const organizationId =
      typeof envelope.organizationId === 'string' ? envelope.organizationId : ''
    const nodeId = typeof envelope.nodeId === 'string' ? envelope.nodeId : ''
    return makeLogBatch(organizationId, nodeId, [value]).pipe(
      Effect.map((batch) => batch.entries[0]!),
      Effect.mapError(
        (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
      ),
    )
  }
  return {
    append: (entry) =>
      sanitizeEntry(entry).pipe(
        Effect.flatMap((sanitized) =>
          transaction((current) => {
            if (current.length >= AGENT_TELEMETRY_LIMITS.maximumSpoolEntries)
              return Effect.fail(
                new AgentTelemetryError({
                  code: 'offline',
                  message: 'Durable log spool capacity is exhausted',
                }),
              )
            if (
              current.at(-1)?.sequence !== undefined &&
              sanitized.sequence !== current.at(-1)!.sequence + 1
            )
              return Effect.fail(
                new AgentTelemetryError({
                  code: 'invalid-input',
                  message: 'Durable log spool append is not contiguous',
                }),
              )
            const next = [...current, sanitized]
            const bytes = next.reduce(
              (total, item) =>
                total + new TextEncoder().encode(`${JSON.stringify(item)}\n`).byteLength,
              0,
            )
            if (bytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes)
              return Effect.fail(
                new AgentTelemetryError({
                  code: 'offline',
                  message: 'Durable log spool capacity is exhausted',
                }),
              )
            return Effect.succeed({ entries: next, result: undefined })
          }),
        ),
      ),
    peek: (maximumEntries) => {
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1)
        return Effect.fail(
          new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable log spool peek limit is invalid',
          }),
        )
      return transaction((entries) =>
        Effect.succeed({ entries, result: entries.slice(0, maximumEntries) }),
      )
    },
    acknowledgeThrough: (sequence) => {
      if (!Number.isSafeInteger(sequence) || sequence < 0)
        return Effect.fail(
          new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable log spool acknowledgement is invalid',
          }),
        )
      return transaction((current) =>
        Effect.succeed({
          entries: current.filter((entry) => entry.sequence > sequence),
          result: undefined,
        }),
      )
    },
    size: transaction((entries) => Effect.succeed({ entries, result: entries.length })),
  }
}

interface PendingTelemetryPayload {
  readonly payload: AgentTelemetryPayload
  readonly logFirstSequence: number | null
  readonly logLastSequence: number | null
}

const decodeDurableEntries = (
  values: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<LogEntry>, AgentTelemetryError> =>
  Effect.gen(function* () {
    if (values.length > AGENT_TELEMETRY_LIMITS.maximumSpoolEntries)
      return yield* new AgentTelemetryError({
        code: 'offline',
        message: 'Durable telemetry spool exceeds the configured entry bound',
      })
    const entries: LogEntry[] = []
    let organizationId: string | undefined
    let nodeId: string | undefined
    let prior = 0
    let bytes = 0
    for (const value of values) {
      const envelope =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
      const batch = yield* makeLogBatch(
        typeof envelope.organizationId === 'string' ? envelope.organizationId : '',
        typeof envelope.nodeId === 'string' ? envelope.nodeId : '',
        [value],
      ).pipe(
        Effect.mapError(
          (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
        ),
      )
      const entry = batch.entries[0]!
      if (organizationId === undefined) organizationId = entry.organizationId
      if (nodeId === undefined) nodeId = entry.nodeId
      if (
        entry.organizationId !== organizationId ||
        entry.nodeId !== nodeId ||
        (prior !== 0 && entry.sequence !== prior + 1)
      )
        return yield* new AgentTelemetryError({
          code: 'invalid-input',
          message: 'Durable telemetry spool scope or sequence is invalid',
        })
      prior = entry.sequence
      bytes += new TextEncoder().encode(`${JSON.stringify(entry)}\n`).byteLength
      entries.push(entry)
    }
    if (bytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes)
      return yield* new AgentTelemetryError({
        code: 'offline',
        message: 'Durable telemetry spool exceeds the configured byte bound',
      })
    return entries
  })

const decodePendingTelemetry = (
  value: unknown,
): Effect.Effect<PendingTelemetryPayload | null, AgentTelemetryError> => {
  if (value === null) return Effect.succeed(null)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Durable telemetry pending payload is invalid',
      }),
    )
  const raw = value as Record<string, unknown>
  const first = raw.logFirstSequence
  const last = raw.logLastSequence
  if (
    !('payload' in raw) ||
    !(first === null || (Number.isSafeInteger(first) && (first as number) >= 1)) ||
    !(last === null || (Number.isSafeInteger(last) && (last as number) >= 1)) ||
    (first === null) !== (last === null) ||
    (typeof first === 'number' && typeof last === 'number' && last < first)
  )
    return Effect.fail(
      new AgentTelemetryError({
        code: 'invalid-input',
        message: 'Durable telemetry pending range is invalid',
      }),
    )
  return prepareAgentTelemetryPayload(raw.payload).pipe(
    Effect.flatMap((payload) => {
      const hasLogs = payload.logs !== undefined
      if (
        hasLogs !== (first !== null) ||
        (hasLogs && (payload.logs!.firstSequence !== first || payload.logs!.lastSequence !== last))
      )
        return Effect.fail(
          new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable telemetry pending payload range is invalid',
          }),
        )
      return Effect.succeed({
        payload,
        logFirstSequence: first as number | null,
        logLastSequence: last as number | null,
      })
    }),
  )
}

export interface DurableTelemetryPublisherShape {
  readonly append: (entry: LogEntry) => Effect.Effect<void, AgentTelemetryError>
  readonly publishOnce: (
    credential: string,
    health: AgentHealthSample,
    serverHealth?: ReadonlyArray<AgentServerHealthSample>,
  ) => Effect.Effect<AgentTelemetryReceipt, AgentTelemetryError>
  readonly pending: Effect.Effect<AgentTelemetryPayload | null, AgentTelemetryError>
}

/**
 * Creates a file-safe publication loop boundary.  It stores a fully prepared
 * (and already-redacted) body before send, retries the byte-identical body,
 * and removes log entries only in the same durable state transition after an
 * exact control-plane acknowledgement range.
 */
export const makeDurableTelemetryPublisher = (
  storage: DurableTelemetrySpoolStorage,
  transport: AgentTelemetryTransportShape,
): DurableTelemetryPublisherShape => {
  const semaphore = Semaphore.makeUnsafe(1)
  const transaction = <A>(
    operation: (state: DurableTelemetrySpoolState) => Effect.Effect<
      {
        readonly state: DurableTelemetrySpoolState
        readonly result: A
      },
      AgentTelemetryError
    >,
  ): Effect.Effect<A, AgentTelemetryError> =>
    semaphore.withPermit(storage.transactTelemetry(operation))

  const pending = (): Effect.Effect<PendingTelemetryPayload | null, AgentTelemetryError> =>
    transaction((state) =>
      decodePendingTelemetry(state.pendingPayload).pipe(
        Effect.map((decoded) => ({ state, result: decoded })),
      ),
    )

  const prepare = (
    health: AgentHealthSample,
    serverHealth: ReadonlyArray<AgentServerHealthSample> | undefined,
  ): Effect.Effect<PendingTelemetryPayload, AgentTelemetryError> =>
    transaction((state) =>
      Effect.gen(function* () {
        const existing = yield* decodePendingTelemetry(state.pendingPayload)
        if (existing !== null) return { state, result: existing }
        yield* validateAgentHealthSample(health)
        const entries = yield* decodeDurableEntries(state.entries)
        if (
          entries.some(
            (entry) =>
              entry.organizationId !== health.organizationId || entry.nodeId !== health.nodeId,
          )
        )
          return yield* new AgentTelemetryError({
            code: 'invalid-input',
            message: 'Durable telemetry spool does not match health scope',
          })
        const selected = entries.slice(0, LOG_LIMITS.maximumBatchEntries)
        const logs =
          selected.length === 0
            ? undefined
            : yield* makeLogBatch(health.organizationId, health.nodeId, selected).pipe(
                Effect.mapError(
                  (error) =>
                    new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
                ),
              )
        const payload = yield* prepareAgentTelemetryPayload({
          health,
          ...(logs === undefined ? {} : { logs }),
          ...(serverHealth === undefined ? {} : { serverHealth }),
        })
        const prepared: PendingTelemetryPayload = {
          payload,
          logFirstSequence: logs?.firstSequence ?? null,
          logLastSequence: logs?.lastSequence ?? null,
        }
        return { state: { ...state, pendingPayload: prepared }, result: prepared }
      }),
    )

  const acknowledge = (
    prepared: PendingTelemetryPayload,
    receipt: AgentTelemetryReceipt,
  ): Effect.Effect<void, AgentTelemetryError> =>
    transaction((state) =>
      Effect.gen(function* () {
        const current = yield* decodePendingTelemetry(state.pendingPayload)
        if (
          current === null ||
          JSON.stringify(current) !== JSON.stringify(prepared) ||
          receipt.organizationId !== prepared.payload.health.organizationId ||
          receipt.nodeId !== prepared.payload.health.nodeId ||
          (prepared.logFirstSequence === null
            ? receipt.logFirstSequence !== undefined || receipt.logLastSequence !== undefined
            : receipt.logFirstSequence !== prepared.logFirstSequence ||
              receipt.logLastSequence !== prepared.logLastSequence)
        )
          return yield* new AgentTelemetryError({
            code: 'rejected',
            message: 'Telemetry receipt does not acknowledge the exact pending range',
          })
        const entries = yield* decodeDurableEntries(state.entries)
        if (prepared.logLastSequence !== null) {
          const acknowledgedAt = entries.findIndex(
            (entry) => entry.sequence === prepared.logLastSequence,
          )
          if (
            acknowledgedAt < 0 ||
            entries[0]?.sequence !== prepared.logFirstSequence ||
            acknowledgedAt !== prepared.logLastSequence - prepared.logFirstSequence
          )
            return yield* new AgentTelemetryError({
              code: 'invalid-input',
              message: 'Durable telemetry spool acknowledgement is non-contiguous',
            })
        }
        const remaining =
          prepared.logLastSequence === null
            ? entries
            : entries.filter((entry) => entry.sequence > prepared.logLastSequence!)
        return { state: { entries: remaining, pendingPayload: null }, result: undefined }
      }),
    )

  return {
    append: (entry) =>
      transaction((state) =>
        Effect.gen(function* () {
          const sanitized = yield* makeLogBatch(entry.organizationId, entry.nodeId, [entry]).pipe(
            Effect.mapError(
              (error) => new AgentTelemetryError({ code: 'invalid-input', message: error.message }),
            ),
          )
          const entries = yield* decodeDurableEntries(state.entries)
          const previous = entries.at(-1)
          if (previous !== undefined && sanitized.firstSequence !== previous.sequence + 1)
            return yield* new AgentTelemetryError({
              code: 'invalid-input',
              message: 'Durable telemetry spool append is not contiguous',
            })
          const next = [...entries, sanitized.entries[0]!]
          if (next.length > AGENT_TELEMETRY_LIMITS.maximumSpoolEntries)
            return yield* new AgentTelemetryError({
              code: 'offline',
              message: 'Durable telemetry spool capacity is exhausted',
            })
          const bytes = next.reduce(
            (total, candidate) =>
              total + new TextEncoder().encode(`${JSON.stringify(candidate)}\n`).byteLength,
            0,
          )
          if (bytes > AGENT_TELEMETRY_LIMITS.maximumLogSpoolBytes)
            return yield* new AgentTelemetryError({
              code: 'offline',
              message: 'Durable telemetry spool capacity is exhausted',
            })
          return { state: { ...state, entries: next }, result: undefined }
        }),
      ),
    publishOnce: (credential, health, serverHealth) =>
      Effect.gen(function* () {
        const prepared = yield* prepare(health, serverHealth)
        const receipt = yield* transport.publish(credential, prepared.payload)
        yield* acknowledge(prepared, receipt)
        return receipt
      }),
    pending: pending().pipe(Effect.map((value) => value?.payload ?? null)),
  }
}

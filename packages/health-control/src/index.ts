import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)

export const HEALTH_LIMITS = {
  staleHeartbeatMilliseconds: 60_000,
  lowDiskRatio: 0.1,
  crashLoopRestartCount: 5,
  maximumContainers: 128,
  maximumSummaryBytes: 8 * 1024,
  maximumHistoryPageSize: 100,
  maximumHistoryRangeMilliseconds: 31 * 24 * 60 * 60 * 1000,
  maximumAlertsPerSnapshot: 32,
  maximumAlertMessageBytes: 512,
  maximumFutureSkewMilliseconds: 30_000,
} as const

export const HealthStatus = Schema.Literals(['healthy', 'degraded', 'unhealthy', 'unknown'])
export type HealthStatus = typeof HealthStatus.Type
export const HealthSeverity = Schema.Literals(['info', 'warning', 'critical'])
export type HealthSeverity = typeof HealthSeverity.Type
export const HealthResourceType = Schema.Literals(['node', 'server', 'container'])
export type HealthResourceType = typeof HealthResourceType.Type

export interface ProviderHealthInput {
  readonly state: 'active' | 'stopped' | 'error' | 'cancelling' | 'orphaned' | 'unknown'
  readonly cancellationPending?: boolean
}
export interface ContainerHealthInput {
  readonly id: string
  readonly name: string
  readonly state: 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'unknown'
  readonly health: 'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown'
  readonly restartCount: number
  readonly cpuUsedMillis: number
  readonly memoryUsedBytes: number
}
export interface GameHealthInput {
  readonly process: 'running' | 'stopped' | 'unknown'
  readonly query: 'healthy' | 'unhealthy' | 'unsupported' | 'unknown'
  readonly map?: string
  readonly scenario?: string
  readonly playerCount?: number
  readonly version?: string
  readonly mods: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
}
export interface NodeHealthInput {
  readonly organizationId: string
  readonly nodeId: string
  readonly sampledAt: string
  readonly provider: ProviderHealthInput
  readonly agentLastSeenAt: string | null
  readonly agentVersion: string | null
  readonly supportedAgent: boolean
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
  readonly containers: ReadonlyArray<ContainerHealthInput>
}
export interface ServerHealthInput {
  readonly organizationId: string
  readonly nodeId: string
  readonly serverId: string
  readonly deploymentId: string | null
  readonly sampledAt: string
  readonly container: ContainerHealthInput | null
  readonly game: GameHealthInput | null
  readonly lastSuccessfulBackupAt: string | null
  readonly backupStale: boolean
  readonly currentOperation: string | null
  readonly operationFailed: boolean
}

export interface HealthSummary {
  readonly provider: ProviderHealthInput['state']
  readonly agentLastSeenAt: string | null
  readonly agentVersion: string | null
  readonly supportedAgent: boolean
  readonly tunnel: NodeHealthInput['tunnel']
  readonly docker: NodeHealthInput['docker']
  readonly firewall: NodeHealthInput['firewall']
  readonly cpu: { readonly usedMillis: number; readonly totalMillis: number }
  readonly ram: { readonly usedBytes: number; readonly totalBytes: number }
  readonly disk: {
    readonly usedBytes: number
    readonly totalBytes: number
    readonly availableRatio: number
  }
  readonly loadPermille: number
  readonly network: { readonly receiveBytes: number; readonly transmitBytes: number }
  readonly containers: ReadonlyArray<ContainerHealthInput>
  readonly game?: GameHealthInput
  readonly backup?: { readonly lastSuccessfulAt: string | null; readonly stale: boolean }
  readonly currentOperation?: string | null
  readonly degradationReasons: ReadonlyArray<string>
}

export interface HealthSnapshot {
  readonly organizationId: string
  readonly resourceType: HealthResourceType
  readonly resourceId: string
  readonly nodeId: string
  readonly serverId: string | null
  readonly sampledAt: string
  readonly status: HealthStatus
  readonly summary: HealthSummary
}

export const HealthAlert = Schema.Struct({
  organizationId: Identifier,
  id: Identifier,
  resourceType: HealthResourceType,
  resourceId: Identifier,
  nodeId: Identifier,
  serverId: Schema.NullOr(Identifier),
  type: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
  ),
  severity: HealthSeverity,
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HEALTH_LIMITS.maximumAlertMessageBytes),
  ),
  fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  state: Schema.Literals(['open', 'acknowledged', 'resolved']),
  firstSeenAt: Timestamp,
  lastSeenAt: Timestamp,
  resolvedAt: Schema.NullOr(Timestamp),
})
export type HealthAlert = typeof HealthAlert.Type

export class HealthValidationError extends Schema.TaggedError<HealthValidationError>()(
  'HealthValidationError',
  {
    code: Schema.Literals([
      'invalid-input',
      'capacity-invalid',
      'too-many-containers',
      'summary-too-large',
    ]),
    message: Schema.String,
  },
) {}
export class HealthPersistenceError extends Schema.TaggedError<HealthPersistenceError>()(
  'HealthPersistenceError',
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface HealthEvaluation {
  readonly node: HealthSnapshot
  readonly server?: HealthSnapshot
  readonly alerts: ReadonlyArray<HealthAlert>
}

const isIso = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
const ratio = (used: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(1, (total - used) / total)) : 0
const providerStates = new Set(['active', 'stopped', 'error', 'cancelling', 'orphaned', 'unknown'])
const tunnelStates = new Set(['connected', 'degraded', 'offline', 'unknown'])
const dockerStates = new Set(['healthy', 'degraded', 'offline', 'unknown'])
const firewallStates = new Set(['ready', 'degraded', 'offline', 'unknown'])
const containerStates = new Set([
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
  'unknown',
])
const containerHealthStates = new Set(['healthy', 'unhealthy', 'starting', 'none', 'unknown'])

const validateContainer = (container: ContainerHealthInput): boolean =>
  typeof container === 'object' &&
  container !== null &&
  !Array.isArray(container) &&
  typeof container.id === 'string' &&
  typeof container.name === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container.id) &&
  container.name.length > 0 &&
  container.name.length <= 128 &&
  containerStates.has(container.state) &&
  containerHealthStates.has(container.health) &&
  Number.isSafeInteger(container.restartCount) &&
  container.restartCount >= 0 &&
  Number.isSafeInteger(container.cpuUsedMillis) &&
  container.cpuUsedMillis >= 0 &&
  Number.isSafeInteger(container.memoryUsedBytes) &&
  container.memoryUsedBytes >= 0

const validateNode = (
  input: NodeHealthInput,
  now: number,
): Effect.Effect<void, HealthValidationError> => {
  if (
    !Schema.is(Identifier)(input.organizationId) ||
    !Schema.is(Identifier)(input.nodeId) ||
    !isIso(input.sampledAt) ||
    Date.parse(input.sampledAt) > now + HEALTH_LIMITS.maximumFutureSkewMilliseconds ||
    typeof input.provider !== 'object' ||
    input.provider === null ||
    !providerStates.has(input.provider.state) ||
    !tunnelStates.has(input.tunnel) ||
    !dockerStates.has(input.docker) ||
    !firewallStates.has(input.firewall) ||
    !Array.isArray(input.containers) ||
    (input.agentLastSeenAt !== null &&
      (typeof input.agentLastSeenAt !== 'string' ||
        !isIso(input.agentLastSeenAt) ||
        Date.parse(input.agentLastSeenAt) > now + HEALTH_LIMITS.maximumFutureSkewMilliseconds))
  )
    return Effect.fail(
      new HealthValidationError({
        code: 'invalid-input',
        message: 'Node health scope or timestamp is invalid',
      }),
    )
  if (
    ![
      input.cpuUsedMillis,
      input.cpuTotalMillis,
      input.ramUsedBytes,
      input.ramTotalBytes,
      input.diskUsedBytes,
      input.diskTotalBytes,
      input.loadPermille,
      input.networkReceiveBytes,
      input.networkTransmitBytes,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    input.cpuUsedMillis > input.cpuTotalMillis ||
    input.ramUsedBytes > input.ramTotalBytes ||
    input.diskUsedBytes > input.diskTotalBytes
  )
    return Effect.fail(
      new HealthValidationError({
        code: 'capacity-invalid',
        message: 'Node health capacity is invalid',
      }),
    )
  if (
    input.containers.length > HEALTH_LIMITS.maximumContainers ||
    input.containers.some((container) => !validateContainer(container))
  )
    return Effect.fail(
      new HealthValidationError({
        code: 'too-many-containers',
        message: 'Node container health is outside the bound',
      }),
    )
  return Effect.void
}

const nodeReasons = (input: NodeHealthInput, stale: boolean): string[] => {
  const reasons: string[] = []
  if (input.provider.state === 'error') reasons.push('provider_error')
  if (input.provider.state === 'orphaned') reasons.push('provider_orphaned')
  if (input.provider.state === 'cancelling' || input.provider.cancellationPending)
    reasons.push('provider_cancellation_pending')
  if (stale) reasons.push('agent_offline')
  if (input.tunnel === 'offline') reasons.push('tunnel_offline')
  else if (input.tunnel === 'degraded') reasons.push('tunnel_degraded')
  if (input.docker === 'offline') reasons.push('docker_offline')
  else if (input.docker === 'degraded') reasons.push('docker_degraded')
  if (input.firewall !== 'ready') reasons.push('firewall_not_ready')
  if (ratio(input.diskUsedBytes, input.diskTotalBytes) < HEALTH_LIMITS.lowDiskRatio)
    reasons.push('disk_low')
  if (!input.supportedAgent) reasons.push('agent_unsupported')
  if (
    input.containers.some(
      (container) => container.restartCount >= HEALTH_LIMITS.crashLoopRestartCount,
    )
  )
    reasons.push('container_crash_loop')
  return reasons
}

export const evaluateNodeHealth = (
  input: NodeHealthInput,
  now = Date.now(),
): Effect.Effect<HealthSnapshot, HealthValidationError> =>
  validateNode(input, now).pipe(
    Effect.map(() => {
      const stale =
        input.agentLastSeenAt === null ||
        !isIso(input.agentLastSeenAt) ||
        now - Date.parse(input.agentLastSeenAt) > HEALTH_LIMITS.staleHeartbeatMilliseconds
      const reasons = nodeReasons(input, stale)
      const severe = reasons.some((reason) =>
        [
          'provider_error',
          'provider_orphaned',
          'agent_offline',
          'tunnel_offline',
          'docker_offline',
        ].includes(reason),
      )
      const status: HealthStatus = severe
        ? 'unhealthy'
        : reasons.length > 0
          ? 'degraded'
          : 'healthy'
      const summary: HealthSummary = {
        provider: input.provider.state,
        agentLastSeenAt: input.agentLastSeenAt,
        agentVersion: input.agentVersion,
        supportedAgent: input.supportedAgent,
        tunnel: input.tunnel,
        docker: input.docker,
        firewall: input.firewall,
        cpu: { usedMillis: input.cpuUsedMillis, totalMillis: input.cpuTotalMillis },
        ram: { usedBytes: input.ramUsedBytes, totalBytes: input.ramTotalBytes },
        disk: {
          usedBytes: input.diskUsedBytes,
          totalBytes: input.diskTotalBytes,
          availableRatio: ratio(input.diskUsedBytes, input.diskTotalBytes),
        },
        loadPermille: input.loadPermille,
        network: {
          receiveBytes: input.networkReceiveBytes,
          transmitBytes: input.networkTransmitBytes,
        },
        containers: input.containers.map((container) => ({ ...container })),
        degradationReasons: reasons,
      }
      return {
        organizationId: input.organizationId,
        resourceType: 'node',
        resourceId: input.nodeId,
        nodeId: input.nodeId,
        serverId: null,
        sampledAt: input.sampledAt,
        status,
        summary,
      }
    }),
  )

export const evaluateServerHealth = (
  input: ServerHealthInput,
  node: HealthSnapshot,
  now = Date.now(),
): Effect.Effect<HealthSnapshot, HealthValidationError> =>
  Effect.gen(function* () {
    if (
      !Schema.is(Identifier)(input.organizationId) ||
      !Schema.is(Identifier)(input.nodeId) ||
      !Schema.is(Identifier)(input.serverId) ||
      input.organizationId !== node.organizationId ||
      input.nodeId !== node.nodeId ||
      !isIso(input.sampledAt) ||
      Date.parse(input.sampledAt) > now + HEALTH_LIMITS.maximumFutureSkewMilliseconds
    )
      return yield* new HealthValidationError({
        code: 'invalid-input',
        message: 'Server health scope or timestamp is invalid',
      })
    const reasons = [...node.summary.degradationReasons]
    if (input.container === null) reasons.push('container_missing')
    else {
      if (input.container.state !== 'running') reasons.push('container_not_running')
      if (input.container.health === 'unhealthy') reasons.push('container_unhealthy')
      if (input.container.restartCount >= HEALTH_LIMITS.crashLoopRestartCount)
        reasons.push('container_crash_loop')
    }
    if (input.game === null) reasons.push('game_health_unknown')
    else {
      if (input.game.process !== 'running') reasons.push('game_process_not_running')
      if (input.game.query === 'unhealthy') reasons.push('game_query_unhealthy')
      if (input.game.query === 'unknown') reasons.push('game_query_unknown')
      if (input.game.mods === 'unhealthy') reasons.push('mods_unhealthy')
    }
    if (input.backupStale) reasons.push('backup_stale')
    if (input.operationFailed) reasons.push('operation_failed')
    const severe = reasons.some((reason) =>
      [
        'provider_error',
        'provider_orphaned',
        'agent_offline',
        'tunnel_offline',
        'docker_offline',
        'container_not_running',
        'container_unhealthy',
        'game_process_not_running',
        'game_query_unhealthy',
        'operation_failed',
      ].includes(reason),
    )
    const status: HealthStatus = severe ? 'unhealthy' : reasons.length > 0 ? 'degraded' : 'healthy'
    const summary: HealthSummary = {
      ...node.summary,
      ...(input.game === null ? {} : { game: input.game }),
      backup: { lastSuccessfulAt: input.lastSuccessfulBackupAt, stale: input.backupStale },
      currentOperation: input.currentOperation,
      degradationReasons: reasons,
      containers: input.container === null ? [] : [input.container],
    }
    return {
      organizationId: input.organizationId,
      resourceType: 'server',
      resourceId: input.serverId,
      nodeId: input.nodeId,
      serverId: input.serverId,
      sampledAt: input.sampledAt,
      status,
      summary,
    }
  })

const alertId = (input: {
  readonly resourceType: HealthResourceType
  readonly resourceId: string
  readonly type: string
}): string => `alert_${input.resourceType}_${input.resourceId}_${input.type}`.slice(0, 128)
const makeAlert = (
  snapshot: HealthSnapshot,
  type: string,
  severity: HealthSeverity,
  message: string,
): HealthAlert => ({
  organizationId: snapshot.organizationId,
  id: alertId({ resourceType: snapshot.resourceType, resourceId: snapshot.resourceId, type }),
  resourceType: snapshot.resourceType,
  resourceId: snapshot.resourceId,
  nodeId: snapshot.nodeId,
  serverId: snapshot.serverId,
  type,
  severity,
  message,
  fingerprint: `${snapshot.resourceType}:${snapshot.resourceId}:${type}`,
  state: 'open',
  firstSeenAt: snapshot.sampledAt,
  lastSeenAt: snapshot.sampledAt,
  resolvedAt: null,
})

export const deriveHealthAlerts = (snapshot: HealthSnapshot): ReadonlyArray<HealthAlert> => {
  const reasons = new Set(snapshot.summary.degradationReasons)
  const alerts: HealthAlert[] = []
  const add = (type: string, severity: HealthSeverity, message: string) => {
    if (alerts.length < HEALTH_LIMITS.maximumAlertsPerSnapshot)
      alerts.push(makeAlert(snapshot, type, severity, message))
  }
  if (reasons.has('agent_offline'))
    add('node-offline', 'critical', 'The node agent heartbeat is stale.')
  if (reasons.has('tunnel_offline'))
    add('tunnel-offline', 'critical', 'The management Tunnel is offline.')
  if (reasons.has('disk_low')) add('disk-low', 'warning', 'Node disk headroom is below policy.')
  if (reasons.has('container_crash_loop'))
    add('crash-loop', 'critical', 'A managed container is repeatedly restarting.')
  if (reasons.has('provider_cancellation_pending'))
    add(
      'provider-cancellation-pending',
      'warning',
      'Provider cancellation is pending and billing semantics require review.',
    )
  if (reasons.has('provider_orphaned'))
    add('provider-orphan', 'critical', 'Provider inventory contains an unmanaged resource.')
  if (reasons.has('agent_unsupported'))
    add('agent-unsupported', 'warning', 'The node agent is below the supported version.')
  if (
    reasons.has('game_process_not_running') ||
    reasons.has('game_query_unhealthy') ||
    reasons.has('container_unhealthy')
  )
    add('game-unhealthy', 'critical', 'The game deployment is not healthy at every required layer.')
  if (reasons.has('backup_stale'))
    add('backup-stale', 'warning', 'The latest successful backup is outside policy.')
  if (reasons.has('operation_failed'))
    add('update-failed', 'warning', 'The current lifecycle operation failed.')
  return alerts
}

export interface HealthRepositoryShape {
  readonly getCurrent: (input: {
    readonly organizationId: string
    readonly resourceType: HealthResourceType
    readonly resourceId: string
  }) => Effect.Effect<HealthSnapshot | null, HealthPersistenceError>
  readonly upsertCurrent: (snapshot: HealthSnapshot) => Effect.Effect<void, HealthPersistenceError>
  readonly appendHourly: (snapshot: HealthSnapshot) => Effect.Effect<void, HealthPersistenceError>
  readonly listHistory: (input: {
    readonly organizationId: string
    readonly resourceType: HealthResourceType
    readonly resourceId: string
    readonly from?: string
    readonly to?: string
    readonly limit: number
    readonly before?: string
  }) => Effect.Effect<ReadonlyArray<HealthSnapshot>, HealthPersistenceError>
  readonly upsertAlert: (alert: HealthAlert) => Effect.Effect<HealthAlert, HealthPersistenceError>
  readonly resolveMissingAlerts: (
    organizationId: string,
    resourceType: HealthResourceType,
    resourceId: string,
    seenFingerprints: ReadonlyArray<string>,
    resolvedAt: string,
  ) => Effect.Effect<number, HealthPersistenceError>
  readonly listAlerts: (input: {
    readonly organizationId: string
    readonly resourceType?: HealthResourceType
    readonly resourceId?: string
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<HealthAlert>, HealthPersistenceError>
}
export class HealthRepository extends Context.Service<HealthRepository, HealthRepositoryShape>()(
  '@gridora/health-control/HealthRepository',
) {}
export const HealthRepositoryLayer = (repository: HealthRepositoryShape) =>
  Layer.succeed(HealthRepository, repository)

export const evaluateHealth = (
  node: NodeHealthInput,
  server?: ServerHealthInput,
  now = Date.now(),
): Effect.Effect<HealthEvaluation, HealthValidationError> =>
  Effect.gen(function* () {
    const nodeSnapshot = yield* evaluateNodeHealth(node, now)
    const serverSnapshot =
      server === undefined ? undefined : yield* evaluateServerHealth(server, nodeSnapshot, now)
    return {
      node: nodeSnapshot,
      ...(serverSnapshot === undefined ? {} : { server: serverSnapshot }),
      alerts: [
        ...deriveHealthAlerts(nodeSnapshot),
        ...(serverSnapshot === undefined ? [] : deriveHealthAlerts(serverSnapshot)),
      ],
    }
  })

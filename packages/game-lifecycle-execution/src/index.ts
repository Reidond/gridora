import { Effect, Schema } from 'effect'
import { makeCloudflareControl, type CloudflareApiShape } from '@gridora/cloudflare-control'
import {
  ConfigApplyPayload,
  DeploymentSpec,
  DeploymentRemovePayload,
  ModSyncPayload,
  ServerActionPayload,
  ServerUpdatePayload,
  AgentCommand,
  canonicalCommandPayload,
  type AgentCommand as AgentCommandType,
} from '@gridora/agent-protocol'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)

export const GameWorkflowPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Identifier,
  actorId: Identifier,
  operationId: Identifier,
  serverId: Identifier,
  nodeId: Identifier,
  targetNodeId: Schema.optional(Identifier),
  deploymentId: Identifier,
  plugin: Schema.Struct({ id: Identifier, version: Identifier }),
  image: Schema.Struct({ installer: Digest, runtime: Digest }),
  ports: Schema.Array(
    Schema.Struct({
      protocol: Schema.Literals(['tcp', 'udp']),
      containerPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      publicPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      purpose: Identifier,
    }),
  ),
  resources: Schema.Struct({
    cpu: Schema.Number.check(Schema.isGreaterThan(0)),
    memoryMiB: Schema.Int.check(Schema.isGreaterThanOrEqualTo(128)),
    diskGiB: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  config: Schema.Record(Schema.String, Schema.Unknown),
  mods: Schema.Array(
    Schema.Struct({
      source: Identifier,
      id: Identifier,
      requestedVersion: Schema.optional(Identifier),
      loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    }),
  ),
  configRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  modRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expectedPriorRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  action: Schema.Literals([
    'create',
    'delete',
    'start',
    'stop',
    'restart',
    'update',
    'apply-config',
    'sync-mods',
    'move',
  ]),
  expiresAt: Timestamp,
  steamCredentialRef: Schema.optional(Identifier),
  domain: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253))),
  backupBeforeUpdate: Schema.optional(Schema.Boolean),
  backupPolicy: Schema.optional(Schema.Literals(['required', 'skip-authorized'])),
  forcedCleanup: Schema.optional(Schema.Literal(true)),
  movePhase: Schema.optional(
    Schema.Literals([
      'reserved',
      'backup',
      'stopped',
      'restoring',
      'validated',
      'cutover',
      'released',
      'rolled_back',
      'failed',
    ]),
  ),
  moveSourcePreserved: Schema.optional(Schema.Boolean),
  moveBackupId: Schema.optional(Identifier),
})
export type GameWorkflowPayload = typeof GameWorkflowPayload.Type

export const GameObservation = Schema.Struct({
  organizationId: Identifier,
  serverId: Identifier,
  operationId: Schema.NullOr(Identifier),
  observedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: Schema.Literals([
    'unknown',
    'planning',
    'installing',
    'starting',
    'running',
    'stopping',
    'stopped',
    'updating',
    'backing_up',
    'restoring',
    'moving',
    'repairing',
    'deleting',
    'deleted',
    'failed',
  ]),
  error: Schema.optional(Schema.String),
  observedAt: Timestamp,
})
export type GameObservation = typeof GameObservation.Type

export const GameWorkflowStepNames = {
  create: [
    'reserve',
    'install',
    'apply-config',
    'sync-mods',
    'start',
    'verify-observation',
    'publish-endpoint',
  ],
  delete: [
    'backup-if-required',
    'authorize-force-cleanup',
    'stop',
    'remove',
    'release-ports',
    'delete-dns',
    'verify-observation',
  ],
  start: ['start', 'verify-observation'],
  stop: ['stop', 'verify-observation'],
  restart: ['stop', 'start', 'verify-observation'],
  update: [
    'backup-if-required',
    'update',
    'apply-config',
    'sync-mods',
    'restart',
    'verify-observation',
  ],
  'apply-config': ['apply-config', 'restart', 'verify-observation'],
  'sync-mods': ['sync-mods', 'restart', 'verify-observation'],
  move: [
    'reserve-target',
    'backup-source',
    'stop-source',
    'restore-target',
    'verify-target',
    'cutover-endpoint',
    'release-source',
    'rollback-if-required',
    'verify-observation',
  ],
} as const

export type GameWorkflowStepName =
  (typeof GameWorkflowStepNames)[keyof typeof GameWorkflowStepNames][number]

export interface GameEndpointIntent {
  readonly organizationId: string
  readonly serverId: string
  readonly hostname: string
  readonly target: string
  readonly proxyMode: 'dns_only'
  readonly ports: readonly { protocol: 'tcp' | 'udp'; publicPort: number; purpose: string }[]
}

export interface GameAgentCommandSpec {
  readonly type: AgentCommandType['type']
  readonly payload: unknown
}

export interface GameAgentCommandSigner {
  readonly sign: (canonicalPayload: string) => Promise<string>
}

export class GameExecutionError extends Schema.TaggedError<GameExecutionError>()(
  'GameExecutionError',
  { code: Schema.String, message: Schema.String },
) {}

const terminalStateFor = (action: GameWorkflowPayload['action']): GameObservation['state'] => {
  switch (action) {
    case 'delete':
      return 'deleted'
    case 'stop':
      return 'stopped'
    default:
      return 'running'
  }
}

/**
 * Workflow completion is based on the tenant-scoped observation reduction,
 * never on a node health response. The operation and exact next revision are
 * part of the evidence, so a responsive node cannot falsely complete a game
 * mutation or adopt another operation's observation.
 */
export const verifyGameObservation = (
  payload: GameWorkflowPayload,
  priorRevision: number,
  observation: GameObservation,
): Effect.Effect<
  { readonly revision: number; readonly state: GameObservation['state'] },
  GameExecutionError
> => {
  const expectedState = terminalStateFor(payload.action)
  if (
    observation.organizationId !== payload.organizationId ||
    observation.serverId !== payload.serverId ||
    observation.operationId !== payload.operationId ||
    observation.observedRevision !== priorRevision + 1 ||
    observation.state !== expectedState ||
    observation.error !== undefined
  )
    return Effect.fail(
      new GameExecutionError({
        code: 'authoritative-observation-required',
        message: `operation requires tenant-scoped ${expectedState} observation at revision ${priorRevision + 1}`,
      }),
    )
  return Effect.succeed({ revision: observation.observedRevision, state: observation.state })
}

const mounts = (serverId: string) =>
  [
    {
      source: `/var/lib/gridora/servers/${serverId}/game`,
      target: '/opt/gridora/game',
      readOnly: false,
    },
    {
      source: `/var/lib/gridora/servers/${serverId}/config`,
      target: '/opt/gridora/config',
      readOnly: true,
    },
    {
      source: `/var/lib/gridora/servers/${serverId}/data`,
      target: '/opt/gridora/data',
      readOnly: false,
    },
    {
      source: `/var/lib/gridora/servers/${serverId}/mods`,
      target: '/opt/gridora/mods',
      readOnly: false,
    },
    {
      source: `/var/lib/gridora/servers/${serverId}/state`,
      target: '/opt/gridora/state',
      readOnly: false,
    },
  ] as const

export const makeDeploymentSpec = (
  payload: GameWorkflowPayload,
): Effect.Effect<typeof DeploymentSpec.Type, GameExecutionError> =>
  Schema.decodeUnknownEffect(DeploymentSpec, { onExcessProperty: 'error' })({
    apiVersion: 'agent.gridora.dev/v1alpha1',
    organizationId: payload.organizationId,
    nodeId: payload.nodeId,
    serverId: payload.serverId,
    deploymentId: payload.deploymentId,
    operationId: payload.operationId,
    revision: Math.max(1, (payload.expectedPriorRevision ?? 0) + 1),
    plugin: {
      id: payload.plugin.id,
      version: payload.plugin.version,
      apiVersion: 'gridora.plugin/v1alpha1',
    },
    image: payload.image,
    ports: payload.ports.map(({ protocol, containerPort, publicPort }) => ({
      host: publicPort,
      container: containerPort,
      protocol,
    })),
    mounts: mounts(payload.serverId),
    // Game lifecycle control exposes the tenant's CPU/RAM/disk request. The
    // agent container PID ceiling is a platform policy, never a client knob.
    resources: { ...payload.resources, pids: 256 },
    expiresAt: payload.expiresAt,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GameExecutionError({ code: 'invalid-deployment-spec', message: String(cause) }),
    ),
  )

const boundActionPayload = (payload: GameWorkflowPayload): typeof ServerActionPayload.Type => ({
  deploymentId: payload.deploymentId,
})

export const makeAgentCommandSpec = (
  payload: GameWorkflowPayload,
  step: GameWorkflowStepName,
): Effect.Effect<GameAgentCommandSpec, GameExecutionError> => {
  const plugin = { id: payload.plugin.id, version: payload.plugin.version }
  if (step === 'install')
    return makeDeploymentSpec(payload).pipe(
      Effect.map((deployment) => ({ type: 'deployment.apply' as const, payload: deployment })),
    )
  if (step === 'remove')
    return Effect.succeed({
      type: 'deployment.remove' as const,
      payload: { deploymentId: payload.deploymentId } satisfies typeof DeploymentRemovePayload.Type,
    })
  if (step === 'start' || step === 'stop' || step === 'restart' || step === 'stop-source')
    return Effect.succeed({
      type: step === 'stop-source' ? ('server.stop' as const) : (`server.${step}` as const),
      payload: boundActionPayload(payload),
    })
  if (step === 'update')
    return Effect.succeed({
      type: 'server.update' as const,
      payload: {
        operationId: payload.operationId,
        serverId: payload.serverId,
        deploymentId: payload.deploymentId,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        image: payload.image.installer,
        backupBeforeUpdate: payload.backupBeforeUpdate ?? true,
      } satisfies typeof ServerUpdatePayload.Type,
    })
  if (step === 'apply-config')
    return Effect.succeed({
      type: 'config.apply' as const,
      payload: {
        operationId: payload.operationId,
        serverId: payload.serverId,
        deploymentId: payload.deploymentId,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        configRevision: payload.configRevision,
        config: payload.config,
      } satisfies typeof ConfigApplyPayload.Type,
    })
  if (step === 'sync-mods')
    return Effect.succeed({
      type: 'mods.sync' as const,
      payload: {
        operationId: payload.operationId,
        serverId: payload.serverId,
        deploymentId: payload.deploymentId,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        image: payload.image.installer,
        modRevision: Math.max(1, payload.modRevision),
        mods: payload.mods,
      } satisfies typeof ModSyncPayload.Type,
    })
  if (step === 'verify-observation')
    return Effect.fail(
      new GameExecutionError({
        code: 'authoritative-observation-required',
        message: 'verify-observation is coordinator-only and must read game_observation_reductions',
      }),
    )
  return Effect.fail(
    new GameExecutionError({
      code: 'step-no-command',
      message: `Step ${step} is coordinator-only`,
    }),
  )
}

/**
 * Materializes the fixed game command spec into the signed AgentCommand
 * envelope consumed by NodeCoordinatorDO.  Command identity is supplied by
 * the API adapter from the durable operation/step tuple; callers must reuse
 * that identity when adopting a response-loss retry.
 */
export const makeSignedGameAgentCommand = (
  payload: GameWorkflowPayload,
  step: GameWorkflowStepName,
  input: {
    readonly commandId: string
    readonly issuedAt: string
    readonly expiresAt: string
    readonly idempotencyKey: string
    readonly signer: GameAgentCommandSigner
  },
): Effect.Effect<AgentCommandType, GameExecutionError> =>
  makeAgentCommandSpec(payload, step).pipe(
    Effect.flatMap((spec) =>
      Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })({
        apiVersion: 'agent.gridora.dev/v1alpha1',
        commandId: input.commandId,
        operationId: payload.operationId,
        organizationId: payload.organizationId,
        nodeId: payload.nodeId,
        resourceId: payload.serverId,
        type: spec.type,
        payloadSchemaVersion: 1,
        plugin: { id: payload.plugin.id, version: payload.plugin.version },
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        idempotencyKey: input.idempotencyKey,
        expectedPriorRevision: payload.expectedPriorRevision,
        payload: spec.payload,
        signature: 'unsigned-command-placeholder-00000000',
      }).pipe(
        Effect.mapError(
          (cause) => new GameExecutionError({ code: 'invalid-command', message: String(cause) }),
        ),
        Effect.flatMap((unsigned) =>
          Effect.tryPromise({
            try: () => input.signer.sign(canonicalCommandPayload(unsigned)),
            catch: (cause) =>
              new GameExecutionError({
                code: 'command-signing-failed',
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        ),
        Effect.flatMap((signature) =>
          Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })({
            ...spec,
            apiVersion: 'agent.gridora.dev/v1alpha1',
            commandId: input.commandId,
            operationId: payload.operationId,
            organizationId: payload.organizationId,
            nodeId: payload.nodeId,
            resourceId: payload.serverId,
            type: spec.type,
            payloadSchemaVersion: 1,
            plugin: { id: payload.plugin.id, version: payload.plugin.version },
            issuedAt: input.issuedAt,
            expiresAt: input.expiresAt,
            idempotencyKey: input.idempotencyKey,
            expectedPriorRevision: payload.expectedPriorRevision,
            payload: spec.payload,
            signature,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new GameExecutionError({ code: 'invalid-signed-command', message: String(cause) }),
            ),
          ),
        ),
      ),
    ),
  )

export const endpointIntent = (
  payload: GameWorkflowPayload,
  target: string,
): Effect.Effect<GameEndpointIntent, GameExecutionError> =>
  payload.domain === undefined
    ? Effect.fail(
        new GameExecutionError({
          code: 'endpoint-not-requested',
          message: 'No DNS endpoint was requested',
        }),
      )
    : Effect.succeed({
        organizationId: payload.organizationId,
        serverId: payload.serverId,
        hostname: payload.domain,
        target,
        proxyMode: 'dns_only',
        ports: payload.ports,
      })

export interface GameDnsPublication {
  readonly zoneId: string
  readonly organizationId: string
  readonly serverId: string
  readonly hostname: string
  /** A/AAAA only. Port leases remain the authoritative player endpoint suffix. */
  readonly target: string
}

const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const ipv6 = /^[0-9a-f:]+$/i

const dnsRecordType = (target: string): 'A' | 'AAAA' | undefined => {
  if (ipv4.test(target) && target.split('.').every((part) => Number(part) <= 255)) return 'A'
  if (ipv6.test(target) && target.includes(':')) return 'AAAA'
  return undefined
}

/** Cloudflare adapter for the workflow's authoritative DNS publication step. */
export const publishGameDns = (
  api: CloudflareApiShape,
  input: GameDnsPublication,
): Effect.Effect<unknown, GameExecutionError> => {
  const type = dnsRecordType(input.target)
  if (type === undefined)
    return Effect.fail(
      new GameExecutionError({
        code: 'invalid-endpoint-target',
        message: 'Endpoint target must be an IPv4 or IPv6 address',
      }),
    )
  return makeCloudflareControl(api)
    .upsertDnsRecord({
      zoneId: input.zoneId,
      name: input.hostname,
      type,
      content: input.target,
      proxied: false,
      organizationId: input.organizationId,
      ownerResourceId: input.serverId,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new GameExecutionError({ code: 'dns-publication-failed', message: error.message }),
      ),
    )
}

/** Teardown is ownership-checked by @gridora/cloudflare-control before delete. */
export const teardownGameDns = (
  api: CloudflareApiShape,
  input: GameDnsPublication & {
    readonly type: 'A' | 'AAAA'
    readonly providerRecordId: string
  },
): Effect.Effect<unknown, GameExecutionError> =>
  makeCloudflareControl(api)
    .deleteDnsRecord({
      zoneId: input.zoneId,
      name: input.hostname,
      type: input.type,
      organizationId: input.organizationId,
      ownerResourceId: input.serverId,
      expectedRecordId: input.providerRecordId,
      expectedContent: input.target,
    })
    .pipe(
      Effect.mapError(
        (error) => new GameExecutionError({ code: 'dns-teardown-failed', message: error.message }),
      ),
    )

export const reduceGameObservation = (
  priorRevision: number,
  observation: GameObservation,
): Effect.Effect<
  {
    readonly revision: number
    readonly state: GameObservation['state']
    readonly complete: boolean
  },
  GameExecutionError
> => {
  if (observation.observedRevision !== priorRevision + 1)
    return Effect.fail(
      new GameExecutionError({
        code: 'observation-revision-conflict',
        message: 'Observation must advance exactly one revision',
      }),
    )
  const complete =
    observation.state === 'failed' ||
    observation.state === 'deleted' ||
    observation.state === 'running' ||
    observation.state === 'stopped'
  return Effect.succeed({
    revision: observation.observedRevision,
    state: observation.state,
    complete,
  })
}

export const signedAgentCommandShape = (spec: GameAgentCommandSpec): unknown => spec

export * from './workflow.js'

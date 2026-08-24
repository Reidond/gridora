import { Schema } from 'effect'
import {
  TunnelCredentialInstallPayload,
  TunnelCredentialRevokePayload,
} from '@gridora/tunnel-credential'

export {
  TunnelCredentialInstallPayload,
  TunnelCredentialRevokePayload,
} from '@gridora/tunnel-credential'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((value) =>
    value !== '.' && value !== '..' ? undefined : 'identifier must not be a traversal segment',
  ),
)
const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const canonicalAbsolute = (value: string): boolean =>
  value.startsWith('/') &&
  !value.includes('\0') &&
  !value.includes('//') &&
  value
    .slice(1)
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
const CanonicalAbsolutePath = Schema.String.check(
  Schema.isPattern(/^\/[A-Za-z0-9._/-]+$/),
  Schema.makeFilter((value) => (canonicalAbsolute(value) ? undefined : 'path must be canonical')),
)
const AbsoluteGridoraPath = CanonicalAbsolutePath.check(
  Schema.isPattern(
    /^\/var\/lib\/gridora\/servers\/[A-Za-z0-9._-]+\/(game|config|data|mods|staging|backups|state)(\/[^\0]*)?$/,
  ),
)
const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65_535 }))

export const ResourceLimits = Schema.Struct({
  cpu: Schema.Number.check(Schema.isGreaterThan(0)),
  memoryMiB: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(128)),
  pids: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 16, maximum: 65_536 })),
  diskGiB: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 }),
  ),
})

export const DeploymentPort = Schema.Struct({
  host: Port,
  container: Port,
  protocol: Schema.Literals(['tcp', 'udp']),
})

export const DeploymentMount = Schema.Struct({
  source: AbsoluteGridoraPath,
  target: CanonicalAbsolutePath,
  readOnly: Schema.Boolean,
})

export const DeploymentSpec = Schema.Struct({
  apiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
  organizationId: Identifier,
  nodeId: Identifier,
  serverId: Identifier,
  deploymentId: Identifier,
  operationId: Identifier,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  plugin: Schema.Struct({
    id: Identifier,
    version: Identifier,
    apiVersion: Schema.Literal('gridora.plugin/v1alpha1'),
  }),
  image: Schema.Struct({ installer: Sha256Digest, runtime: Sha256Digest }),
  ports: Schema.Array(DeploymentPort),
  mounts: Schema.Array(DeploymentMount),
  resources: ResourceLimits,
  expiresAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
})
export type DeploymentSpec = typeof DeploymentSpec.Type

export const CommandType = Schema.Literals([
  'deployment.apply',
  'deployment.remove',
  'server.start',
  'server.stop',
  'server.restart',
  'server.update',
  'config.apply',
  'mods.sync',
  'backup.create',
  'backup.restore',
  'health.inspect',
  'tunnel.credential.install',
  'tunnel.credential.revoke',
  'agent.self-update',
])

const AgentCommandFields = {
  apiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
  commandId: Identifier,
  operationId: Identifier,
  organizationId: Identifier,
  nodeId: Identifier,
  resourceId: Identifier,
  type: CommandType,
  payloadSchemaVersion: Schema.Literal(1),
  plugin: Schema.optional(Schema.Struct({ id: Identifier, version: Identifier })),
  issuedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  expiresAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  idempotencyKey: Identifier,
  expectedPriorRevision: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  payload: Schema.Unknown,
  signature: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(1024)),
}
export const AgentCommand = Schema.Struct(AgentCommandFields)
export type AgentCommand = typeof AgentCommand.Type

export const TunnelCredentialInstallAgentCommand = Schema.Struct({
  ...AgentCommandFields,
  type: Schema.Literal('tunnel.credential.install'),
  payload: TunnelCredentialInstallPayload,
})
export type TunnelCredentialInstallAgentCommand = typeof TunnelCredentialInstallAgentCommand.Type

export const TunnelCredentialRevokeAgentCommand = Schema.Struct({
  ...AgentCommandFields,
  type: Schema.Literal('tunnel.credential.revoke'),
  payload: TunnelCredentialRevokePayload,
})
export type TunnelCredentialRevokeAgentCommand = typeof TunnelCredentialRevokeAgentCommand.Type

export const TunnelCredentialAgentCommand = Schema.Union([
  TunnelCredentialInstallAgentCommand,
  TunnelCredentialRevokeAgentCommand,
])
export type TunnelCredentialAgentCommand = typeof TunnelCredentialAgentCommand.Type

const AgentReleaseVersion = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/),
)
const HttpsArtifactSource = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
const Ed25519Signature = Schema.String.check(
  Schema.isMinLength(80),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
)

/**
 * The release signing input. `signature` is deliberately excluded by
 * `canonicalAgentUpdateManifest`; every remaining field is authenticated.
 */
export const AgentUpdateManifest = Schema.Struct({
  apiVersion: Schema.Literal('agent-update.gridora.dev/v1alpha1'),
  version: AgentReleaseVersion,
  /** Monotonic signer-issued release sequence; root persists the high-water mark. */
  releaseSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  /** Signer-issued security floor. Rollback is the only permitted local regression. */
  securityEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  architecture: Schema.Literals(['amd64', 'arm64']),
  source: Schema.Struct({
    url: HttpsArtifactSource,
    sha256: Sha256Digest,
    sizeBytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 128 * 1024 * 1024 }),
    ),
  }),
  compatibility: Schema.Struct({
    commandApiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
    minimumControlPlaneApiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
    maximumControlPlaneApiVersion: Schema.Literal('agent.gridora.dev/v1alpha1'),
  }),
  issuedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  signature: Ed25519Signature,
})
export type AgentUpdateManifest = typeof AgentUpdateManifest.Type

export const AgentSelfUpdatePayload = Schema.Struct({
  apiVersion: Schema.Literal('agent-update.gridora.dev/v1alpha1'),
  action: Schema.Literal('activate'),
  deliveryId: Identifier,
  organizationId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  manifest: AgentUpdateManifest,
})
export type AgentSelfUpdatePayload = typeof AgentSelfUpdatePayload.Type

export const AgentSelfUpdateAgentCommand = Schema.Struct({
  ...AgentCommandFields,
  type: Schema.Literal('agent.self-update'),
  payload: AgentSelfUpdatePayload,
})
export type AgentSelfUpdateAgentCommand = typeof AgentSelfUpdateAgentCommand.Type

export const DeploymentRemovePayload = Schema.Struct({
  deploymentId: Identifier,
})
export const ServerActionPayload = Schema.Struct({
  deploymentId: Identifier,
})
export const ServerUpdatePayload = Schema.Struct({
  operationId: Identifier,
  serverId: Identifier,
  deploymentId: Identifier,
  pluginId: Identifier,
  pluginVersion: Identifier,
  image: Sha256Digest,
  backupBeforeUpdate: Schema.Boolean,
})
export const ConfigApplyPayload = Schema.Struct({
  operationId: Identifier,
  serverId: Identifier,
  deploymentId: Identifier,
  pluginId: Identifier,
  pluginVersion: Identifier,
  configRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  config: Schema.Record(Schema.String, Schema.Unknown),
})
export const ModSyncPayload = Schema.Struct({
  operationId: Identifier,
  serverId: Identifier,
  deploymentId: Identifier,
  pluginId: Identifier,
  pluginVersion: Identifier,
  image: Sha256Digest,
  modRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  mods: Schema.Array(
    Schema.Struct({
      source: Identifier,
      id: Identifier,
      requestedVersion: Schema.optional(Identifier),
      loadOrder: Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 0, maximum: 10_000 }),
      ),
    }),
  ).check(Schema.isMaxLength(256)),
})
const BackupFiles = Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state']))
export const BackupManifestPayload = Schema.Struct({
  apiVersion: Schema.Literal('backup.gridora.dev/v1alpha1'),
  backupId: Identifier,
  organizationId: Identifier,
  serverId: Identifier,
  pluginId: Identifier,
  pluginVersion: Identifier,
  consistency: Schema.Literals(['crash-consistent', 'plugin-quiesced']),
  createdAt: Schema.String,
  sha256: Sha256Digest,
  files: BackupFiles,
  diskBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1024 ** 5 }),
  ),
})
export const BackupCreatePayload = Schema.Struct({
  backupId: Identifier,
  pluginId: Identifier,
  pluginVersion: Identifier,
  consistency: Schema.Literals(['crash-consistent', 'plugin-quiesced']),
  files: BackupFiles,
  diskBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1024 ** 5 }),
  ),
})
export const BackupRestorePayload = Schema.Struct({
  manifest: BackupManifestPayload,
  targetServerId: Identifier,
  phase: Schema.Literals(['stage', 'validate', 'commit', 'rollback', 'finalize']),
})
export const HealthInspectPayload = Schema.Struct({})

export type DeploymentRemovePayload = typeof DeploymentRemovePayload.Type
export type ServerActionPayload = typeof ServerActionPayload.Type
export type ServerUpdatePayload = typeof ServerUpdatePayload.Type
export type ConfigApplyPayload = typeof ConfigApplyPayload.Type
export type ModSyncPayload = typeof ModSyncPayload.Type
export type BackupCreatePayload = typeof BackupCreatePayload.Type
export type BackupRestorePayload = typeof BackupRestorePayload.Type

export const CommandResult = Schema.Struct({
  commandId: Identifier,
  operationId: Identifier,
  status: Schema.Literals(['succeeded', 'failed', 'rejected']),
  revision: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  code: Identifier,
  message: Schema.String,
  duplicate: Schema.Boolean,
  evidence: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal('backup-uploaded'),
      backupId: Identifier,
      bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      sha256: Sha256Digest,
      checksum: Sha256Digest,
      encryptionVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      r2Key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      manifestVerified: Schema.Literal(true),
    }),
  ),
  completedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
})
export type CommandResult = typeof CommandResult.Type

export const decodeAgentCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })(input)
export const decodeTunnelCredentialAgentCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(TunnelCredentialAgentCommand, { onExcessProperty: 'error' })(input)
export const decodeAgentSelfUpdateAgentCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(AgentSelfUpdateAgentCommand, { onExcessProperty: 'error' })(input)
export const decodeDeploymentSpec = (input: unknown) =>
  Schema.decodeUnknownEffect(DeploymentSpec, { onExcessProperty: 'error' })(input)

/** Signature input excludes the signature and is recursively key-sorted. */
export const canonicalCommandPayload = (command: AgentCommand): string => {
  const { signature: _, ...unsigned } = command
  return canonicalJson(unsigned)
}

/** Signature input for the independent, long-lived release-signing key. */
export const canonicalAgentUpdateManifest = (manifest: AgentUpdateManifest): string => {
  const { signature: _, ...unsigned } = manifest
  return canonicalJson(unsigned)
}

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

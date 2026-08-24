import { Schema } from 'effect'
import {
  AccessSessionView,
  AuthBootstrap,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateProviderAccountInput,
  InvitationEmailRemediation,
  InvitationEmailRemediationPage,
  MutationCompleted,
  Operation,
  OperationDetail,
  OrganizationSummary,
  ResendInvitationInput,
  PluginList,
  PluginManifest,
  UpdateMembershipRoleInput,
  UpdateOrganizationProfileInput,
  UpdateProviderAccountInput,
} from '@gridora/contracts'
import {
  Identity,
  Organization,
  OrganizationInvitation,
  OrganizationMembership,
} from '@gridora/domain'
import { AgentCommand, CommandResult } from '@gridora/agent-protocol'
import { BackupMetadata } from '@gridora/backup-control'
import {
  AgentObservationEvent,
  type AgentObservationReceipt,
} from '@gridora/agent-observation-control'
import {
  ConfigPreviewInput,
  GameConfigPreviewResponse,
  GameConfigReadResponse,
  GameModsReadResponse,
  GameModsPlanResponse,
  ModsPlanInput,
} from '@gridora/game-desired-state-control'
import { GameCreateIntent } from '@gridora/game-lifecycle-control'
import {
  GameServerManifest,
  GameServerManifestApplyResponse,
  GameServerCloneInput,
  GameServerCloneResponse,
  GameServerDraftCreateResponse,
  GameServerDraftScheduleInput,
  GameServerDraftScheduleResponse,
  GameServerManifestInput,
  GameServerManifestPlanResponse,
  GameServerManifestValidationResponse,
} from '@gridora/game-server-manifest-control'
import { Problem } from '@gridora/http-hono-effect'
import { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  ProviderAccountLifecycleBody,
  ProviderAccountLifecycleResult,
} from '@gridora/provider-account-control'
import {
  ServerApplyIntent,
  ServerApplyPlanSchema,
  ServerCreateIntent,
  ServerProvisionAcceptanceSchema,
} from '@gridora/server-plan-control'
import {
  AuditEventView,
  BackupView,
  GameServerView,
  NodeImageView,
  NodeView,
  ProviderAccountView,
  ProviderAllocationView,
} from '@gridora/inventory-contracts'
import { CreateNodeIntent } from '@gridora/node-provision-control'
import { PlatformAllocation, PlatformProviderAccount } from '@gridora/platform-provider-control'
import { HealthAlert, HealthResourceType, HealthStatus } from '@gridora/health-control'
import { LogEntry } from '@gridora/log-control'

export const DisplayName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
export const PutOrganizationPolicyBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  policy: OrganizationPolicyV1,
})
export const CompleteSignUpBody = Schema.Struct({ displayName: Schema.optional(DisplayName) })
export const CreateAuthenticationIntentBody = Schema.Struct({
  intent: Schema.Literals(['sign-in', 'sign-up', 'accept-invitation']),
  returnTo: Schema.String,
  invitationToken: Schema.optional(Schema.String),
  displayName: Schema.optional(DisplayName),
})
const NodeLifecycleRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NodeLifecycleIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
/** Public runtime actions cannot carry a provider ID, credential, or desired state. */
export const NodeRuntimeLifecycleBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedDesiredRevision: NodeLifecycleRevision,
})
/** Route-specific validation additionally requires targetImageId for rebuild only. */
export const NodeLifecycleBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedNodeRevision: NodeLifecycleRevision,
  force: Schema.Boolean,
  backupPolicy: Schema.Literals(['required', 'skip-authorized']),
  targetImageId: Schema.optional(NodeLifecycleIdentifier),
})
export const NodeRuntimeLifecycleAcceptedResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  organizationId: NodeLifecycleIdentifier,
  nodeId: NodeLifecycleIdentifier,
  action: Schema.Literals(['start', 'stop', 'reboot', 'reconcile']),
  operationId: NodeLifecycleIdentifier,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
  transition: Schema.Struct({
    previousDesiredState: Schema.Literals(['ready', 'stopped']),
    previousDesiredRevision: NodeLifecycleRevision,
    desiredState: Schema.Literals(['ready', 'stopped']),
    desiredRevision: NodeLifecycleRevision,
  }),
  workflowStart: Schema.Struct({
    id: NodeLifecycleIdentifier,
    state: Schema.Literals(['pending', 'started', 'adopted']),
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    lastError: Schema.NullOr(Schema.String),
  }),
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
export const NodeLifecycleAcceptedResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  operationId: NodeLifecycleIdentifier,
  nodeId: NodeLifecycleIdentifier,
  state: Schema.String,
  desiredNodeRevision: NodeLifecycleRevision,
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
const GameMutationRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const GameMutationIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const GameMutationMods = Schema.Array(
  Schema.Struct({
    source: GameMutationIdentifier,
    id: GameMutationIdentifier,
    requestedVersion: Schema.optional(GameMutationIdentifier),
    loadOrder: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  }),
).check(Schema.isMaxLength(256))
const GameMutationConfig = Schema.Record(Schema.String, Schema.Unknown)
const GameUpdateMutationBody = Schema.Struct({
  expectedRevision: GameMutationRevision,
  action: Schema.Literal('update'),
  expectedConfigRevision: GameMutationRevision,
  expectedModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  backupBeforeUpdate: Schema.Boolean,
})

/** The product PATCH route is a logical game update, not a metadata/provider mutation. */
export const GameServerPatchBody = GameUpdateMutationBody

/**
 * Public game mutation bodies are enumerated here so OpenAPI cannot imply a
 * client may choose a deployment, image, node, provider, or Workflow.  The
 * HTTP adapter applies the same exact-property decoding before persistence.
 */
export const GameLifecycleMutationBody = Schema.Union([
  Schema.Struct({ expectedRevision: GameMutationRevision, action: Schema.Literal('start') }),
  Schema.Struct({ expectedRevision: GameMutationRevision, action: Schema.Literal('stop') }),
  Schema.Struct({ expectedRevision: GameMutationRevision, action: Schema.Literal('restart') }),
  GameUpdateMutationBody,
  Schema.Struct({
    expectedRevision: GameMutationRevision,
    action: Schema.Literal('apply-config'),
    expectedConfigRevision: GameMutationRevision,
    config: GameMutationConfig,
  }),
  Schema.Struct({
    expectedRevision: GameMutationRevision,
    action: Schema.Literal('sync-mods'),
    expectedConfigRevision: GameMutationRevision,
    expectedModRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    mods: GameMutationMods,
  }),
  Schema.Struct({
    expectedRevision: GameMutationRevision,
    action: Schema.Literal('delete'),
    backupPolicy: Schema.Literals(['required', 'skip-authorized']),
  }),
  Schema.Struct({
    expectedRevision: GameMutationRevision,
    action: Schema.Literal('move'),
    targetNodeId: GameMutationIdentifier,
    backupPolicy: Schema.Literal('required'),
  }),
])
export const GameLifecycleAcceptedResponse = Schema.Struct({
  operationId: GameMutationIdentifier,
  resourceId: GameMutationIdentifier,
  status: Schema.Literals([
    'requested',
    'queued',
    'running',
    'waiting_external',
    'cancelling',
    'cancelled',
    'succeeded',
    'failed',
    'retrying',
    'failed_terminal',
  ]),
  links: Schema.Struct({ operation: Schema.String }),
})
export const CancelOperationBody = Schema.Struct({
  expectedOperationRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export const DeleteOrganizationBody = Schema.Struct({
  expectedOrganizationRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  typedSlug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  backupPolicy: Schema.Literals(['retain', 'delete-after-retention'] as const),
})
export const OrganizationDeletionAcceptedResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted'] as const),
  requestedSlug: Schema.String,
  state: Schema.String,
  operation: Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    actorId: Schema.String,
    action: Schema.String,
    resourceType: Schema.String,
    resourceId: Schema.String,
    state: Schema.String,
    revision: Schema.Int,
    acceptedAt: Schema.String,
    updatedAt: Schema.String,
  }),
  workflowStart: Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    operationId: Schema.String,
    workflowType: Schema.String,
    workflowInstanceId: Schema.String,
    paramsFingerprint: Schema.String,
    state: Schema.String,
    attempts: Schema.Int,
    lastErrorCode: Schema.NullOr(Schema.String),
  }),
})
export const CancellationAcceptedResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted'] as const),
  signalState: Schema.Literals(['pending-delivery', 'delivered', 'cancelled'] as const),
  operation: Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    actorId: Schema.String,
    action: Schema.String,
    resourceType: Schema.String,
    resourceId: Schema.String,
    cancellationPolicy: Schema.Literals([
      'not-cancellable',
      'before-provider-delete',
      'cooperative',
    ] as const),
    revision: Schema.Int,
    state: Schema.String,
  }),
  facts: Schema.Struct({
    organizationId: Schema.String,
    operationId: Schema.String,
    resourceType: Schema.String,
    resourceId: Schema.String,
    resourceOperationDoName: Schema.String,
    workflowBinding: Schema.String,
    workflowType: Schema.String,
    workflowInstanceId: Schema.String,
    policy: Schema.String,
    phase: Schema.String,
    activeStepName: Schema.optional(Schema.String),
    activeStepOrdinal: Schema.optional(Schema.Int),
    revision: Schema.Int,
  }),
})
export const BackupCreateBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  includes: Schema.Array(Schema.Literals(['config', 'data', 'mods', 'state'] as const)),
  expiresAt: Schema.NullOr(Schema.String),
})
export const BackupRestoreBody = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targetServerId: Schema.optional(Schema.String),
  targetNodeId: Schema.optional(Schema.String),
})
export const PublicBackupArtifact = Schema.Struct({
  organizationId: Schema.String,
  id: Schema.String,
  serverId: Schema.String,
  checksum: Schema.String,
  encryptionVersion: Schema.Int,
  metadata: BackupMetadata,
  state: Schema.Literals([
    'creating',
    'available',
    'restoring',
    'expired',
    'deleted',
    'failed',
  ] as const),
  revision: Schema.Int,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
})
export const BackupAcceptedResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted'] as const),
  job: Schema.Struct({
    organizationId: Schema.String,
    id: Schema.String,
    operationId: Schema.String,
    mode: Schema.Literals(['create', 'restore'] as const),
    trigger: Schema.Literals([
      'manual',
      'scheduled',
      'pre-update',
      'pre-rebuild',
      'pre-retire',
    ] as const),
    backupId: Schema.String,
    sourceServerId: Schema.String,
    targetServerId: Schema.NullOr(Schema.String),
    sourceNodeId: Schema.NullOr(Schema.String),
    targetNodeId: Schema.NullOr(Schema.String),
    state: Schema.Literals([
      'reserved',
      'running',
      'waiting_external',
      'cancelling',
      'cancelled',
      'succeeded',
      'failed',
      'failed_terminal',
    ] as const),
    revision: Schema.Int,
    createdAt: Schema.String,
    updatedAt: Schema.String,
    cancelledAt: Schema.NullOr(Schema.String),
  }),
  artifact: PublicBackupArtifact,
})
export const InternalWorkflowStepBody = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
  actorId: Schema.String,
  correlationId: Schema.String,
  idempotencyKey: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  stepName: Schema.String,
  ordinal: Schema.Number,
})
export const InternalQueueEventBody = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  partitionKey: Schema.String,
  type: Schema.String,
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
})
export const LifecycleWorkflowStartRequestedPayload = Schema.Struct({
  operationId: Schema.String,
  workflowStartRecordId: Schema.String,
  resourceKind: Schema.Literals(['node', 'server']),
  resourceId: Schema.String,
  action: Schema.Literals([
    'provision-node',
    'retire-node',
    'delete-node',
    'deploy-server',
    'set-server-state',
    'configure-server',
    'update-server-mods',
    'create-backup',
    'restore-backup',
    'move-server',
    'delete-server',
  ]),
})
export const RevisionBody = Schema.Struct({ expectedRevision: Schema.Number })
export const OwnershipTransferBody = Schema.Struct({ targetIdentityId: Schema.String })
export const AgentRegistrationExchangeBody = Schema.Struct({
  organizationId: Schema.String,
  nodeId: Schema.String,
  providerInstanceId: Schema.String,
  agentVersion: Schema.String,
  installerPublicKey: Schema.String.check(
    Schema.isMinLength(512),
    Schema.isMaxLength(2048),
    Schema.isPattern(/^rsa-oaep-spki-v1\.[A-Za-z0-9_-]+$/),
  ),
  registrationToken: Schema.String.check(Schema.isMinLength(32)),
})
export const AgentRegistrationExchangeResponse = Schema.Struct({
  nodeCredential: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  credentialId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  credentialVersion: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  sessionVersion: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  registrationTokenConsumed: Schema.Literal(true),
})
export const AgentObservationReceiptResponse = Schema.Struct({
  organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  observedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  observedState: Schema.Literals(['bootstrapping', 'ready', 'degraded']),
  capacityPublished: Schema.Boolean,
  acceptedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
}) satisfies Schema.Codec<AgentObservationReceipt, unknown, never, never>
export const OrganizationRealtimeTicketResponse = Schema.Struct({
  ticket: Schema.String.check(
    Schema.isMinLength(32),
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  ),
  expiresAt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
})
export const AgentRegistrationRevokeBody = Schema.Struct({
  organizationId: Schema.String,
  nodeId: Schema.String,
  registrationToken: Schema.String.check(Schema.isMinLength(32)),
})
export const TunnelCredentialDeliveryBody = Schema.Struct({
  action: Schema.Literals(['install', 'rotate', 'revoke']),
  expectedPriorRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export const TunnelCredentialDeliveryResponse = Schema.Struct({
  deliveryId: Schema.String,
  operationId: Schema.String,
  nodeId: Schema.String,
  tunnelId: Schema.String,
  action: Schema.Literals(['install', 'rotate', 'revoke']),
  revision: Schema.Number,
  state: Schema.Literals(['issuing', 'queued', 'delivered', 'acknowledged', 'revoked', 'failed']),
})
export const NodeProvisionResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  nodeId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  operationId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
  billing: Schema.Struct({
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
    estimatedMonthlyMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    committedMonthlyBeforeMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    projectedCommittedMonthlyMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    warnings: Schema.Array(
      Schema.Struct({
        code: Schema.Literal('soft_budget_exceeded'),
        message: Schema.String,
        projectedEstimatedMonthlyMinor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
      }),
    ),
  }),
})
export const PlatformProviderCredentialBody = Schema.Struct({
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  credentialsBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32768)),
})
export const PlatformProviderRevisionBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export const PlatformProviderRotateBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  credentialsBase64: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(32768)),
})
export const PlatformProviderAllocationBody = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  allowedRegions: PlatformAllocation.fields.allowedRegions,
  allowedPlans: PlatformAllocation.fields.allowedPlans,
  maxActiveNodes: PlatformAllocation.fields.maxActiveNodes,
  monthlyBudgetMinor: PlatformAllocation.fields.monthlyBudgetMinor,
  status: PlatformAllocation.fields.status,
})
export const OrganizationList = Schema.Array(OrganizationSummary)
export const MembershipList = Schema.Array(OrganizationMembership)
export const InvitationList = Schema.Array(OrganizationInvitation)
export const AuthenticationIntentCreated = Schema.Struct({
  state: Schema.String,
  expiresAt: Schema.Number,
})
export const AuthenticationCompletion = Schema.Struct({
  intent: Schema.Literals(['sign-in', 'sign-up', 'accept-invitation']),
  next: Schema.Literals(['dashboard', 'setup-organization']),
  returnTo: Schema.String,
  identity: Identity,
  membership: Schema.optional(OrganizationMembership),
})
const inventoryPageSchema = (item: Schema.Top) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optional(Schema.String),
  })

const ApiIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const ApiArchiveIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
)
const ApiTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)
const ApiPositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Public projection. R2 object locations must never appear in API responses. */
export const PublicLogArchiveResponse = Schema.Struct({
  organizationId: ApiIdentifier,
  id: ApiArchiveIdentifier,
  serverId: ApiIdentifier,
  nodeId: ApiIdentifier,
  streamEpoch: Schema.optional(ApiIdentifier),
  compression: Schema.Literal('gzip'),
  firstTimestamp: ApiTimestamp,
  lastTimestamp: ApiTimestamp,
  entryCount: ApiPositiveInteger,
  uncompressedBytes: ApiPositiveInteger,
  compressedBytes: ApiPositiveInteger,
  sha256: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  state: Schema.Literals(['pending', 'available', 'expired', 'deleted', 'failed']),
  createdAt: ApiTimestamp,
  expiresAt: Schema.NullOr(ApiTimestamp),
})
export const LogArchiveListResponse = Schema.Struct({
  items: Schema.Array(PublicLogArchiveResponse),
  nextCursor: Schema.optional(Schema.String),
})
export const LogArchiveReadResponse = Schema.Struct({
  archive: PublicLogArchiveResponse,
  entries: Schema.Array(LogEntry),
})
export const LiveLogTicketResponse = Schema.Struct({
  ticket: Schema.String.check(
    Schema.isMinLength(32),
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  ),
  expiresAt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  /** Canonical tenant ID used to validate frames; this is never the route slug. */
  organizationId: ApiIdentifier,
  /** Current deployment epoch; a move invalidates the ticket and cursor. */
  streamEpoch: ApiIdentifier,
})

export const HealthSnapshotResponse = Schema.Struct({
  organizationId: ApiIdentifier,
  resourceType: HealthResourceType,
  resourceId: ApiIdentifier,
  nodeId: ApiIdentifier,
  serverId: Schema.NullOr(ApiIdentifier),
  sampledAt: ApiTimestamp,
  status: HealthStatus,
  summary: Schema.Record(Schema.String, Schema.Unknown),
})
export const HealthHistoryResponse = Schema.Struct({
  items: Schema.Array(HealthSnapshotResponse),
  nextCursor: Schema.optional(ApiTimestamp),
})
export const HealthAlertsResponse = Schema.Struct({ items: Schema.Array(HealthAlert) })

const AgentTelemetryContainer = Schema.Struct({
  id: ApiIdentifier,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  state: Schema.Literals([
    'created',
    'running',
    'paused',
    'restarting',
    'exited',
    'dead',
    'unknown',
  ]),
  health: Schema.Literals(['healthy', 'unhealthy', 'starting', 'none', 'unknown']),
  restartCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cpuUsedMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  memoryUsedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const AgentServerHealth = Schema.Struct({
  serverId: ApiIdentifier,
  deploymentId: ApiIdentifier,
  containerId: ApiIdentifier,
  game: Schema.Struct({
    process: Schema.Literals(['running', 'stopped', 'unknown']),
    query: Schema.Literals(['healthy', 'unhealthy', 'unsupported', 'unknown']),
    mods: Schema.Literals(['healthy', 'degraded', 'unhealthy', 'unknown']),
    map: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
    scenario: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
    playerCount: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
    ),
    version: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  }),
})
export const AgentTelemetryBody = Schema.Struct({
  health: Schema.Struct({
    apiVersion: Schema.Literal('agent.telemetry.gridora.dev/v1alpha1'),
    organizationId: ApiIdentifier,
    nodeId: ApiIdentifier,
    sampledAt: ApiTimestamp,
    agentVersion: ApiIdentifier,
    tunnel: Schema.Literals(['connected', 'degraded', 'offline', 'unknown']),
    docker: Schema.Literals(['healthy', 'degraded', 'offline', 'unknown']),
    firewall: Schema.Literals(['ready', 'degraded', 'offline', 'unknown']),
    cpuUsedMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cpuTotalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ramUsedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ramTotalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    diskUsedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    diskTotalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    loadPermille: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    networkReceiveBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    networkTransmitBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    containers: Schema.Array(AgentTelemetryContainer),
  }),
  logs: Schema.optional(
    Schema.Struct({
      organizationId: ApiIdentifier,
      nodeId: ApiIdentifier,
      entries: Schema.Array(LogEntry),
      firstSequence: Schema.optional(ApiPositiveInteger),
      lastSequence: Schema.optional(ApiPositiveInteger),
      uncompressedBytes: Schema.optional(ApiPositiveInteger),
    }),
  ),
  serverHealth: Schema.optional(Schema.Array(AgentServerHealth)),
})
export const AgentTelemetryReceiptResponse = Schema.Struct({
  organizationId: ApiIdentifier,
  nodeId: ApiIdentifier,
  acceptedAt: ApiTimestamp,
  replayed: Schema.Boolean,
  logFirstSequence: Schema.optional(ApiPositiveInteger),
  logLastSequence: Schema.optional(ApiPositiveInteger),
})

type ApiRoute = {
  readonly method: 'get' | 'post' | 'patch' | 'put' | 'delete'
  readonly path: string
  readonly operationId: string
  readonly successStatus: number
  readonly request?: Schema.Top
  readonly response: Schema.Top
  readonly mutation?: boolean
  readonly bearerAuth?: boolean
  readonly websocket?: boolean
  readonly queryParameters?: readonly {
    readonly name: string
    readonly required: boolean
    readonly schema: Readonly<Record<string, unknown>>
  }[]
  readonly pathParameterSchemas?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export const apiRoutes: readonly ApiRoute[] = [
  {
    method: 'get',
    path: '/v1/plugins',
    operationId: 'listPlugins',
    successStatus: 200,
    response: PluginList,
  },
  {
    method: 'get',
    path: '/v1/plugins/{id}',
    operationId: 'getPlugin',
    successStatus: 200,
    response: PluginManifest,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}',
    operationId: 'deleteOrganization',
    successStatus: 202,
    request: DeleteOrganizationBody,
    response: OrganizationDeletionAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/auth/intents',
    operationId: 'createAuthenticationIntent',
    successStatus: 201,
    request: CreateAuthenticationIntentBody,
    response: AuthenticationIntentCreated,
  },
  {
    method: 'post',
    path: '/v1/auth/complete',
    operationId: 'completeAuthentication',
    successStatus: 200,
    request: CompleteSignUpBody,
    response: AuthenticationCompletion,
  },
  {
    method: 'get',
    path: '/v1/auth/bootstrap',
    operationId: 'authBootstrap',
    successStatus: 200,
    response: AuthBootstrap,
  },
  {
    method: 'post',
    path: '/v1/auth/sign-up/complete',
    operationId: 'completeSignUp',
    successStatus: 200,
    request: CompleteSignUpBody,
    response: AuthenticationCompletion,
  },
  {
    method: 'post',
    path: '/v1/platform/provider-accounts',
    operationId: 'createPlatformProviderAccount',
    successStatus: 201,
    request: PlatformProviderCredentialBody,
    response: PlatformProviderAccount,
    mutation: true,
    queryParameters: [
      {
        name: 'id',
        required: true,
        schema: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
        },
      },
    ],
  },
  ...(['validate', 'disable', 'remove'] as const).map((action) => ({
    method: 'post' as const,
    path: `/v1/platform/provider-accounts/{accountId}/actions/${action}`,
    operationId: `${action}PlatformProviderAccount`,
    successStatus: 200,
    request: PlatformProviderRevisionBody,
    response: PlatformProviderAccount,
    mutation: true,
  })),
  {
    method: 'post',
    path: '/v1/platform/provider-accounts/{accountId}/actions/rotate',
    operationId: 'rotatePlatformProviderAccount',
    successStatus: 200,
    request: PlatformProviderRotateBody,
    response: PlatformProviderAccount,
    mutation: true,
  },
  {
    method: 'put',
    path: '/v1/platform/provider-accounts/{accountId}/allocations/{organizationId}',
    operationId: 'putPlatformProviderAllocation',
    successStatus: 200,
    request: PlatformProviderAllocationBody,
    response: PlatformAllocation,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/actions/switch',
    operationId: 'switchOrganization',
    successStatus: 200,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/agent/registrations/exchange',
    operationId: 'exchangeAgentRegistration',
    successStatus: 200,
    request: AgentRegistrationExchangeBody,
    response: AgentRegistrationExchangeResponse,
  },
  {
    method: 'post',
    path: '/v1/agent/events',
    operationId: 'acceptAgentEvents',
    successStatus: 200,
    request: AgentObservationEvent,
    response: AgentObservationReceiptResponse,
    bearerAuth: true,
  },
  {
    method: 'post',
    path: '/v1/agent/telemetry',
    operationId: 'acceptAgentTelemetry',
    successStatus: 200,
    request: AgentTelemetryBody,
    response: AgentTelemetryReceiptResponse,
    bearerAuth: true,
  },
  {
    method: 'post',
    path: '/v1/agent/registrations/revoke',
    operationId: 'revokeAgentRegistration',
    successStatus: 204,
    request: AgentRegistrationRevokeBody,
    response: Schema.Void,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{nodeId}/tunnels/{tunnelId}/credential-deliveries',
    operationId: 'deliverTunnelCredential',
    successStatus: 202,
    request: TunnelCredentialDeliveryBody,
    response: TunnelCredentialDeliveryResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/agent/nodes/{nodeId}/commands',
    operationId: 'pollAgentCommand',
    successStatus: 200,
    response: AgentCommand,
  },
  {
    method: 'post',
    path: '/v1/agent/nodes/{nodeId}/commands/{commandId}/result',
    operationId: 'recordAgentCommandResult',
    successStatus: 200,
    request: CommandResult,
    response: Schema.Unknown,
  },
  { method: 'get', path: '/v1/me', operationId: 'getMe', successStatus: 200, response: Identity },
  {
    method: 'get',
    path: '/v1/me/session',
    operationId: 'getMyAccessSession',
    successStatus: 200,
    response: AccessSessionView,
  },
  {
    method: 'get',
    path: '/v1/me/organizations',
    operationId: 'listMyOrganizations',
    successStatus: 200,
    response: OrganizationList,
  },
  {
    method: 'post',
    path: '/v1/organizations',
    operationId: 'createOrganization',
    successStatus: 201,
    request: CreateOrganizationInput,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}',
    operationId: 'getOrganization',
    successStatus: 200,
    response: Organization,
  },
  {
    method: 'put',
    path: '/v1/organizations/{organization}',
    operationId: 'updateOrganizationProfile',
    successStatus: 200,
    request: UpdateOrganizationProfileInput,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/events/ticket',
    operationId: 'issueOrganizationEventsTicket',
    successStatus: 200,
    response: OrganizationRealtimeTicketResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/events',
    operationId: 'streamOrganizationEvents',
    successStatus: 101,
    response: Schema.Void,
    websocket: true,
    queryParameters: [
      {
        name: 'ticket',
        required: true,
        schema: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
          pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
        },
      },
    ],
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/policy',
    operationId: 'getOrganizationPolicy',
    successStatus: 200,
    response: OrganizationPolicyV1,
  },
  {
    method: 'put',
    path: '/v1/organizations/{organization}/policy',
    operationId: 'updateOrganizationPolicy',
    successStatus: 200,
    request: PutOrganizationPolicyBody,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/members',
    operationId: 'listMembers',
    successStatus: 200,
    response: MembershipList,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/invitations',
    operationId: 'listInvitations',
    successStatus: 200,
    response: InvitationList,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/notification-remediation',
    operationId: 'listNotificationRemediation',
    successStatus: 200,
    response: InvitationEmailRemediationPage,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/notification-remediation/{eventId}',
    operationId: 'getNotificationRemediation',
    successStatus: 200,
    response: InvitationEmailRemediation,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/invitations',
    operationId: 'createInvitation',
    successStatus: 201,
    request: CreateInvitationInput,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/invitations/{token}/actions/accept',
    operationId: 'acceptInvitation',
    successStatus: 200,
    response: MutationCompleted,
    mutation: true,
    pathParameterSchemas: {
      token: {
        type: 'string',
        minLength: 64,
        maxLength: 64,
        pattern: '^[0-9a-f]{64}$',
      },
    },
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/invitations/{invitation}/actions/resend',
    operationId: 'resendInvitation',
    successStatus: 200,
    request: ResendInvitationInput,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'patch',
    path: '/v1/organizations/{organization}/members/{identity}',
    operationId: 'updateMemberRole',
    successStatus: 200,
    request: UpdateMembershipRoleInput,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}/members/{identity}',
    operationId: 'removeMember',
    successStatus: 200,
    request: RevisionBody,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/actions/leave',
    operationId: 'leaveOrganization',
    successStatus: 200,
    request: RevisionBody,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/actions/transfer-ownership',
    operationId: 'transferOwnership',
    successStatus: 200,
    request: OwnershipTransferBody,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}/invitations/{invitation}',
    operationId: 'revokeInvitation',
    successStatus: 200,
    request: RevisionBody,
    response: MutationCompleted,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/operations/{id}',
    operationId: 'getOperation',
    successStatus: 200,
    response: OperationDetail,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/operations',
    operationId: 'listOperations',
    successStatus: 200,
    response: inventoryPageSchema(Operation),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/provider-accounts',
    operationId: 'listProviderAccounts',
    successStatus: 200,
    response: inventoryPageSchema(ProviderAccountView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/provider-accounts/{id}',
    operationId: 'getProviderAccount',
    successStatus: 200,
    response: ProviderAccountView,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/provider-accounts',
    operationId: 'createProviderAccount',
    successStatus: 201,
    request: CreateProviderAccountInput,
    response: ProviderAccountView,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/provider-accounts/{id}/test',
    operationId: 'testProviderAccount',
    successStatus: 200,
    request: ProviderAccountLifecycleBody,
    response: ProviderAccountLifecycleResult,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/provider-accounts/{id}/refresh',
    operationId: 'refreshProviderAccount',
    successStatus: 200,
    request: ProviderAccountLifecycleBody,
    response: ProviderAccountLifecycleResult,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/provider-accounts/{id}/actions/disable',
    operationId: 'disableProviderAccount',
    successStatus: 200,
    request: ProviderAccountLifecycleBody,
    response: ProviderAccountLifecycleResult,
    mutation: true,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}/provider-accounts/{id}',
    operationId: 'deleteProviderAccount',
    successStatus: 200,
    request: ProviderAccountLifecycleBody,
    response: ProviderAccountLifecycleResult,
    mutation: true,
  },
  {
    method: 'patch',
    path: '/v1/organizations/{organization}/provider-accounts/{id}',
    operationId: 'updateProviderAccountCredentials',
    successStatus: 200,
    request: UpdateProviderAccountInput,
    response: ProviderAccountView,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/provider-allocations',
    operationId: 'listProviderAllocations',
    successStatus: 200,
    response: inventoryPageSchema(ProviderAllocationView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/provider-allocations/{id}',
    operationId: 'getProviderAllocation',
    successStatus: 200,
    response: ProviderAllocationView,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/node-images',
    operationId: 'listNodeImages',
    successStatus: 200,
    response: inventoryPageSchema(NodeImageView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/node-images/{id}',
    operationId: 'getNodeImage',
    successStatus: 200,
    response: NodeImageView,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/nodes',
    operationId: 'listNodes',
    successStatus: 200,
    response: inventoryPageSchema(NodeView),
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes',
    operationId: 'createNode',
    successStatus: 202,
    request: CreateNodeIntent,
    response: NodeProvisionResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/nodes/{id}',
    operationId: 'getNode',
    successStatus: 200,
    response: NodeView,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/start',
    operationId: 'startNode',
    successStatus: 202,
    request: NodeRuntimeLifecycleBody,
    response: NodeRuntimeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/stop',
    operationId: 'stopNode',
    successStatus: 202,
    request: NodeRuntimeLifecycleBody,
    response: NodeRuntimeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/reboot',
    operationId: 'rebootNode',
    successStatus: 202,
    request: NodeRuntimeLifecycleBody,
    response: NodeRuntimeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/reconcile',
    operationId: 'reconcileNode',
    successStatus: 202,
    request: NodeRuntimeLifecycleBody,
    response: NodeRuntimeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/drain',
    operationId: 'drainNode',
    successStatus: 202,
    request: NodeLifecycleBody,
    response: NodeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/uncordon',
    operationId: 'uncordonNode',
    successStatus: 202,
    request: NodeLifecycleBody,
    response: NodeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/nodes/{id}/actions/rebuild',
    operationId: 'rebuildNode',
    successStatus: 202,
    request: NodeLifecycleBody,
    response: NodeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}/nodes/{id}',
    operationId: 'retireNode',
    successStatus: 202,
    request: NodeLifecycleBody,
    response: NodeLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/nodes/{nodeId}/health',
    operationId: 'getNodeHealth',
    successStatus: 200,
    response: HealthSnapshotResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/nodes/{nodeId}/health/history',
    operationId: 'listNodeHealthHistory',
    successStatus: 200,
    response: HealthHistoryResponse,
    queryParameters: [
      { name: 'from', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'to', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'before', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers',
    operationId: 'listGameServers',
    successStatus: 200,
    response: inventoryPageSchema(GameServerView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{id}',
    operationId: 'getGameServer',
    successStatus: 200,
    response: GameServerView,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/manifest',
    operationId: 'exportGameServerManifest',
    successStatus: 200,
    response: GameServerManifest,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/health',
    operationId: 'getGameServerHealth',
    successStatus: 200,
    response: HealthSnapshotResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/health/history',
    operationId: 'listGameServerHealthHistory',
    successStatus: 200,
    response: HealthHistoryResponse,
    queryParameters: [
      { name: 'from', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'to', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'before', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/health-alerts',
    operationId: 'listHealthAlerts',
    successStatus: 200,
    response: HealthAlertsResponse,
    queryParameters: [
      {
        name: 'resourceType',
        required: false,
        schema: { type: 'string', enum: ['node', 'server', 'container'] },
      },
      {
        name: 'resourceId',
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      },
      { name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/logs',
    operationId: 'listLogArchives',
    successStatus: 200,
    response: LogArchiveListResponse,
    queryParameters: [
      { name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      { name: 'from', required: false, schema: { type: 'string', format: 'date-time' } },
      { name: 'to', required: false, schema: { type: 'string', format: 'date-time' } },
      {
        name: 'cursor',
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    ],
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-server-manifests/plan',
    operationId: 'planGameServerManifest',
    successStatus: 200,
    request: GameServerManifestInput,
    response: GameServerManifestPlanResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-server-manifests/validate',
    operationId: 'validateGameServerManifest',
    successStatus: 200,
    request: GameServerManifestInput,
    response: GameServerManifestValidationResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-server-drafts',
    operationId: 'createGameServerDraft',
    successStatus: 201,
    request: GameServerManifestInput,
    response: GameServerDraftCreateResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-server-drafts/{draftId}',
    operationId: 'getGameServerDraft',
    successStatus: 200,
    response: GameServerDraftCreateResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-server-drafts/{draftId}/actions/schedule',
    operationId: 'scheduleGameServerDraft',
    successStatus: 202,
    request: GameServerDraftScheduleInput,
    response: GameServerDraftScheduleResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-server-manifests/apply',
    operationId: 'applyGameServerManifest',
    successStatus: 202,
    request: GameServerManifestInput,
    response: GameServerManifestApplyResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream/ticket',
    operationId: 'issueLiveLogTicket',
    successStatus: 200,
    response: LiveLogTicketResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/logs/stream',
    operationId: 'streamLiveLogs',
    successStatus: 101,
    response: Schema.Void,
    websocket: true,
    queryParameters: [
      {
        name: 'ticket',
        required: true,
        schema: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
          pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
        },
      },
    ],
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{serverId}/logs/{archiveId}',
    operationId: 'getLogArchive',
    successStatus: 200,
    response: LogArchiveReadResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/plan',
    operationId: 'planGameServer',
    successStatus: 200,
    request: ServerCreateIntent,
    response: ServerApplyPlanSchema,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/apply',
    operationId: 'applyGameServer',
    successStatus: 202,
    request: ServerApplyIntent,
    response: ServerProvisionAcceptanceSchema,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers',
    operationId: 'createGameServer',
    successStatus: 202,
    request: GameCreateIntent,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'delete',
    path: '/v1/organizations/{organization}/game-servers/{id}',
    operationId: 'deleteGameServer',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'patch',
    path: '/v1/organizations/{organization}/game-servers/{id}',
    operationId: 'patchGameServer',
    successStatus: 202,
    request: GameServerPatchBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  ...(['start', 'stop', 'restart', 'update'] as const).map((action) => ({
    method: 'post' as const,
    path: `/v1/organizations/{organization}/game-servers/{id}/actions/${action}`,
    operationId: `${action}GameServer`,
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  })),
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/actions/move',
    operationId: 'moveGameServer',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/actions/validate-files',
    operationId: 'validateGameServerFiles',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/actions/force-cleanup',
    operationId: 'forceCleanupGameServer',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/actions/clone',
    operationId: 'cloneGameServer',
    successStatus: 202,
    request: GameServerCloneInput,
    response: GameServerCloneResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/config',
    operationId: 'applyGameConfig',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'put',
    path: '/v1/organizations/{organization}/game-servers/{id}/mods',
    operationId: 'syncMods',
    successStatus: 202,
    request: GameLifecycleMutationBody,
    response: GameLifecycleAcceptedResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{id}/config',
    operationId: 'getGameConfig',
    successStatus: 200,
    response: GameConfigReadResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/game-servers/{id}/mods',
    operationId: 'getGameMods',
    successStatus: 200,
    response: GameModsReadResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/config/plan',
    operationId: 'previewGameConfig',
    successStatus: 200,
    request: ConfigPreviewInput,
    response: GameConfigPreviewResponse,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/mods/plan',
    operationId: 'planMods',
    successStatus: 200,
    request: ModsPlanInput,
    response: GameModsPlanResponse,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/backups',
    operationId: 'listBackups',
    successStatus: 200,
    response: inventoryPageSchema(BackupView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/backups/{id}',
    operationId: 'getBackup',
    successStatus: 200,
    response: BackupView,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/game-servers/{id}/backups',
    operationId: 'backupGameServer',
    successStatus: 202,
    request: BackupCreateBody,
    response: BackupAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/backups/{id}/actions/restore',
    operationId: 'restoreGameServer',
    successStatus: 202,
    request: BackupRestoreBody,
    response: BackupAcceptedResponse,
    mutation: true,
  },
  {
    method: 'post',
    path: '/v1/organizations/{organization}/operations/{id}/actions/cancel',
    operationId: 'cancelOperation',
    successStatus: 202,
    request: CancelOperationBody,
    response: CancellationAcceptedResponse,
    mutation: true,
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/audit-events',
    operationId: 'listAuditEvents',
    successStatus: 200,
    response: inventoryPageSchema(AuditEventView),
  },
  {
    method: 'get',
    path: '/v1/organizations/{organization}/audit-events/{id}',
    operationId: 'getAuditEvent',
    successStatus: 200,
    response: AuditEventView,
  },
] as const

export const unsupportedApiRoutes: readonly ApiRoute[] = [] as const

const jsonSchema = (schema: Schema.Top): unknown => Schema.toJsonSchemaDocument(schema).schema

const pathParameters = (route: ApiRoute) =>
  [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: route.pathParameterSchemas?.[match[1]!] ?? { type: 'string' },
  }))

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Gridora API',
    version: '0.1.0',
    description: 'Multi-organization game server operations API',
  },
  paths: [...apiRoutes, ...unsupportedApiRoutes].reduce<Record<string, Record<string, unknown>>>(
    (paths, route) => {
      const operation = {
        operationId: route.operationId,
        parameters: [
          ...pathParameters(route),
          ...(route.queryParameters ?? []).map((parameter) => ({
            in: 'query',
            ...parameter,
          })),
        ],
        ...(route.mutation
          ? {
              parameters: [
                ...pathParameters(route),
                ...(route.queryParameters ?? []).map((parameter) => ({
                  in: 'query',
                  ...parameter,
                })),
                {
                  in: 'header',
                  name: 'Idempotency-Key',
                  required: true,
                  schema: { type: 'string', minLength: 8, maxLength: 255 },
                },
              ],
            }
          : {}),
        ...(route.bearerAuth ? { security: [{ agentBearer: [] }] } : {}),
        ...(route.request === undefined
          ? {}
          : {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: jsonSchema(route.request) } },
              },
            }),
        responses: {
          [route.successStatus]: {
            description:
              route.successStatus === 501
                ? 'Not implemented'
                : route.websocket === true
                  ? 'Switching Protocols'
                  : 'Success',
            ...(route.websocket === true
              ? {}
              : { content: { 'application/json': { schema: jsonSchema(route.response) } } }),
          },
          default: {
            description: 'Problem',
            content: { 'application/problem+json': { schema: jsonSchema(Problem) } },
          },
        },
      }
      paths[route.path] = { ...paths[route.path], [route.method]: operation }
      return paths
    },
    {},
  ),
  components: {
    securitySchemes: {
      agentBearer: { type: 'http', scheme: 'bearer' },
    },
  },
} as const

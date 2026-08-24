import { Hono, type Context as HonoContext } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { Effect, Layer, Schema } from 'effect'
import {
  AuditRequestContext,
  isAuditIpAddress,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  AgentObservationAuthenticationError,
  AgentObservationClock,
  AgentObservationConflictError,
  AgentObservationPersistenceError,
  AgentObservationRepository,
  AgentObservationValidationError,
  makeAgentObservationControl,
} from '@gridora/agent-observation-control'
import {
  makeAgentMachineAuditRepositoryD1,
  makeAgentObservationRepositoryD1,
  type AgentMachinePrincipal,
} from '@gridora/agent-observation-d1'
import {
  AutomationIdentityClockLayer,
  AutomationIdentityControl,
  AutomationIdentityControlLive,
  AutomationIdentityIdGeneratorLayer,
  AutomationIdentityPersistenceError,
  AutomationIdentityRepositoryLayer,
  WebCryptoAutomationIdentityIdGenerator,
} from '@gridora/automation-identity-control'
import { WebCryptoAutomationCredentialIssuerLayer } from '@gridora/automation-identity-auth'
import { makeAutomationIdentityRepositoryD1 } from '@gridora/automation-identity-d1'
import {
  CommandResult,
  canonicalCommandPayload,
  decodeTunnelCredentialAgentCommand,
  type AgentCommand,
} from '@gridora/agent-protocol'
import {
  BackupR2Transport,
  deleteBackupObjectPrefix,
  makeCloudflareBackupR2DeletionBucket,
} from '@gridora/backup-r2'
import {
  BackupClockLayer,
  BackupConflictError,
  BackupControl,
  BackupControlLive,
  BackupFingerprintLayer,
  BackupObjectDeletionLayer,
  BackupPersistenceError,
  type BackupControlShape,
  type BackupJob,
  BackupPluginCompatibilityLayer,
  WebCryptoBackupFingerprint,
} from '@gridora/backup-control'
import { SignedBackupWorkflowStep } from '@gridora/backup-workflow'
import {
  acceptBackupUploadSession,
  claimBackupUploadSession,
  closeBackupUploadSession,
  makeBackupRepositoryD1Layer,
  makeBackupServerFactsD1Layer,
  loadBackupWorkflowState,
  validateBackupUploadSession,
} from '@gridora/backup-d1'
import {
  AccessJwtVerifier,
  assertionFromRequest,
  makeAccessJwtVerifier,
  verifyInternalRequest,
  validReturnTarget,
  type AccessClaims,
} from '@gridora/auth-cloudflare-access'
import {
  ApplicationClock,
  AuthorizationService,
  AuthorizationServiceLive,
  IdentifierGenerator,
  InvitationTokenService,
} from '@gridora/application'
import {
  AuthorizationError,
  ConflictError,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateProviderAccountInput,
  InvitationError,
  InvitationEmailRemediation,
  NotFoundError,
  PersistenceError,
  ProviderAccountMetadata,
  ResendInvitationInput,
  UpdateMembershipRoleInput,
  UpdateOrganizationProfileInput,
  UpdateProviderAccountInput,
} from '@gridora/contracts'
import {
  CloudflareControlError,
  tunnelResourceName,
  type CloudflareApiShape,
} from '@gridora/cloudflare-control'
import {
  AgentRegistrationRepository,
  IdentityRepository,
  OperationDetailRepository,
  OperationRepository,
  OrganizationInvitationRepository,
  OrganizationMembershipRepository,
  OrganizationRepository,
  ProviderAccountRepository,
} from '@gridora/db-contracts'
import { makeD1RepositoriesLayer, makeRegistrationPolicyD1Layer } from '@gridora/db-d1'
import { makeHealthRepositoryD1 } from '@gridora/health-d1'
import {
  CorrelationId,
  EmailAddress,
  IdempotencyKey,
  IdentityId,
  InvitationId,
  IsoDateTime,
  OperationId,
  OrganizationId,
  OrganizationSlug,
  OutboxEventId,
  OrganizationContext as OrganizationContextValue,
  type Identity,
  type OrganizationContext,
} from '@gridora/domain'
import {
  effectHandler,
  correlationIdFromContext,
  jsonResponse,
  makeWorkerEffectRuntime,
  problemFromError,
  problemResponse,
  requestIdFromContext,
  type HttpFailure,
  type WorkerEffectRuntime,
} from '@gridora/http-hono-effect'
import { IdentityService, IdentityServiceLive } from '@gridora/identity'
import {
  GameDesiredStateControl,
  GameDesiredStateControlLive,
  GameDesiredStateRepositoryLayer,
  makeGameDesiredStateRepositoryD1,
} from '@gridora/game-desired-state-control'
import { GameWorkflowPayload, GameWorkflowStepError } from '@gridora/game-lifecycle-execution'
import {
  GameLifecycleD1ClientLayer,
  GameLifecycleD1Repository,
  GameLifecycleD1RepositoryLive,
  GameLifecycleObservationD1Live,
  GameLifecyclePlanningD1,
  GameLifecyclePlanningD1Live,
} from '@gridora/game-lifecycle-d1'
import {
  makeGameServerDraftD1Repository,
  makeGameServerManifestD1Repository,
} from '@gridora/game-server-manifest-d1'
import {
  GameServerManifest,
  manifestToServerApplyIntent,
} from '@gridora/game-server-manifest-control'
import {
  makeAuthoritativeGameWorkflowPayload,
  registerGameLifecycleRoutes,
} from './game-lifecycle-routes.js'
import {
  AuditEventInventory,
  BackupInventory,
  GameServerInventory,
  InventoryPageRequest,
  NodeImageInventory,
  NodeInventory,
  OperationInventory,
  ProviderInventory,
} from '@gridora/inventory-contracts'
import { makeInventoryD1Layer } from '@gridora/inventory-d1'
import type { LiveLogArchiveAvailableEvent } from '@gridora/log-control'
import { makeLogArchiveRepositoryD1 } from '@gridora/log-d1'
import { makeCloudflareLogR2Bucket } from '@gridora/log-r2'
import {
  OrganizationService,
  OrganizationServiceLive,
  type CoreMutationRequest,
} from '@gridora/organizations'
import { apiPluginManifests, findApiPluginManifest } from '@gridora/plugin-registry'
import {
  ContaboProviderAccountValidator,
  ContaboProviderAccountValidatorLayer,
  OvhProviderAccountValidator,
  OvhProviderAccountValidatorLayer,
  ProviderAccountActionRepositoryLayer,
  ProviderAccountControl,
  ProviderAccountControlLive,
} from '@gridora/provider-account-control'
import { makeProviderAccountActionRepositoryD1 } from '@gridora/provider-account-d1'
import {
  makeContaboProviderAccountValidator,
  makeOvhProviderAccountValidator,
} from '@gridora/provider-account-validators'
import {
  RegistrationDeniedError,
  RegistrationPolicyService,
  RegistrationPolicyServiceLive,
} from '@gridora/registration-policy'
import {
  makeWebCryptoServerCreateIdentity,
  ServerCreateIdentityPortLayer,
  ServerPlanClockLayer,
  ServerPlanControl,
  ServerPlanControlLive,
  ServerPlanRepositoryLayer,
} from '@gridora/server-plan-control'
import { makeServerPlanRepositoryD1 } from '@gridora/server-plan-d1'
import {
  executeServerProvisionPlanStep,
  makeServerProvisionPlanControlRuntime,
  makeServerProvisionRetirementPort,
  ServerProvisionWorkflowPayload,
} from './server-provision-runtime.js'
import type {
  AuthIntentRateLimitDO,
  AuthIntentStateDO,
  InternalReplayGuardDO,
  LiveLogStreamDO,
  NodeCoordinatorDO,
  OrganizationEventsDO,
  ResourceOperationDO,
} from '@gridora/realtime'
import {
  KekPort,
  SecretEnvelopeRepository,
  SecretEnvelopeService,
  SecretEnvelopeServiceLive,
  prepareSecretEnvelope,
  prepareSecretEnvelopeReplacement,
} from '@gridora/secret-envelope'
import { makeSecretEnvelopeRepositoryD1Layer } from '@gridora/secret-envelope-d1'
import {
  CloudflareSecretsStoreKekLayer,
  type CloudflareKekKeyring,
  type SecretsStoreSecretBinding,
} from '@gridora/secret-kek-cloudflare'
import {
  LifecycleControl,
  LifecycleRepository,
  WorkflowStarter,
  WorkflowStartReconciliationRepository,
  type NativeLifecycleWorkflowBinding,
  makeLifecycleControlLayer,
} from './lifecycle-runtime.js'
import { PersistenceError as LifecyclePersistenceError } from '@gridora/lifecycle-control'
import {
  AgentRegistrationExchangeBody,
  AgentRegistrationRevokeBody,
  CancelOperationBody,
  DeleteOrganizationBody,
  CompleteSignUpBody,
  CreateAuthenticationIntentBody,
  DisplayName,
  InternalQueueEventBody,
  InternalWorkflowStepBody,
  LifecycleWorkflowStartRequestedPayload,
  OwnershipTransferBody,
  RevisionBody,
  TunnelCredentialDeliveryBody,
  openApiDocument,
} from './contracts.js'
import {
  createSignedTunnelCommand,
  finalizeTunnelDelivery,
  loadTunnelDeliveryById,
  makeCloudflareTunnelTokenClient,
  markTunnelCommandDelivered,
  reserveTunnelDelivery,
  validateInstallerPublicKey,
} from './tunnel-delivery.js'
import { registerPolicyRoutes } from './policy-routes.js'
import { registerProviderAccountRoutes } from './provider-account-routes.js'
import { registerGameDesiredStateRoutes } from './game-desired-state-routes.js'
import { registerGameServerManifestRoutes } from './game-server-manifest-routes.js'
import { registerOrganizationEventsRoutes } from './organization-events-routes.js'
import { registerServerPlanRoutes } from './server-plan-routes.js'
import { registerInvitationAcceptanceRoutes } from './invitation-acceptance-routes.js'
import { makeApiBackupTransportLayer } from './backup-runtime.js'
import { registerBackupAgentUploadRoutes } from './backup-agent-upload-routes.js'
import { makeBackupUploadObjectPublisher } from './backup-upload-runtime.js'
import { registerBackupRoutes } from './backup-routes.js'
import { registerNodeProvisionRoutes } from './node-provision-routes.js'
import { registerPlatformProviderRoutes } from './platform-provider-routes.js'
import {
  executeNodeProvision,
  makeNodeBootstrapTrustedConfiguration,
  makeNodeProvisionControlRuntime,
  makeNodeRegistrationTokenSecret,
} from './node-provision-runtime.js'
import { nodeBootstrapCloudInit } from '@gridora/node-provision-execution'
import { makePlatformAuthorityD1 } from '@gridora/platform-authority'
import {
  makePlatformProviderControl,
  type PlatformProviderControlShape,
} from '@gridora/platform-provider-control'
import {
  makePlatformProviderRepositoryD1,
  makePlatformSecretRepositoryD1,
} from '@gridora/platform-provider-d1'
import { makePlatformSecretEnvelope } from '@gridora/platform-secret-envelope'
import { ProviderCreateUncertainError } from '@gridora/provider-sdk'
import { OrphanControlError } from '@gridora/orphan-control'
import { makeLiveOrphanProviderFactories } from '@gridora/orphan-provider-live'
import { decodeOrphanScheduleTask, makeOrphanScheduleStore } from '@gridora/orphan-schedule'
import { makeOrphanReconciliation } from './orphan-runtime.js'
import {
  executeGameLifecycleWorkflowStep,
  makeGameDnsAuthorityReceiptRecorder,
  makeGameDnsAuthorityResolver,
  makeGameMoveCoordinator,
  type GameMoveBackupAdapter,
} from './game-lifecycle-runtime.js'
import { makeCancellationControl, makeCancellationSignal } from './cancellation-runtime.js'
import {
  beginOrganizationDeletion,
  executeOrganizationDeletionStep,
} from './organization-deletion-runtime.js'
import { scheduledBackupAuditRequest } from './backup-schedule-audit.js'
import { makeBackupWorkflowExecutor } from './backup-workflow-runtime.js'
import { registerAutomationIdentityRoutes } from './automation-identity-routes.js'
import { matchesAcceptedGameWorkflowPayload } from './game-lifecycle-routes.js'
import { registerNodeImageRoutes } from './node-image-routes.js'
import { registerNodeRuntimeLifecycleRoutes } from './node-runtime-lifecycle-routes.js'
import { registerNodeLifecycleRoutes } from './node-lifecycle-routes.js'
import { makeNodeTerminationWorkflowStarter } from './node-termination-runtime.js'
import {
  executeNodeRuntimeLifecycleWorkflow,
  makeNodeRuntimeLifecycleControlRuntime,
  NodeRuntimeLifecycleWorkflowPayload,
} from './node-runtime-lifecycle-runtime.js'
import {
  executeNodeTerminationWorkflowEffect,
  observeNodeTerminationWorkflowEffect,
} from './node-termination-execution-runtime.js'
import {
  makeNodeTerminationProviderAdapterResolver,
  makeProviderNodeLifecycleAdapterResolver,
} from './provider-node-lifecycle-runtime.js'
import { makeNodeTerminationTunnelAdapter } from './node-termination-tunnel-runtime.js'
import { makeNodeImageControlRuntime, makeNodeImageExecutionRuntime } from './node-image-runtime.js'
import { makeNodeImageExecutionRepositoryD1 } from '@gridora/node-image-d1'
import { executeSignedNodeImageWorkflowStep } from '@gridora/node-image-workflow'
import { makeTerminationControl } from '@gridora/lifecycle-termination-control'
import {
  makeTerminationD1Repository,
  makeWorkflowStepD1Repository,
} from '@gridora/lifecycle-termination-d1'
import { executeSignedTerminationWorkflowStep } from '@gridora/lifecycle-termination-workflow'
import {
  makePolicyLifecycleActionExecutor,
  registerPolicyReconciliationRoutes,
} from './policy-reconciliation-routes.js'
import { makePolicyScheduleStore } from '@gridora/policy-schedule'
import { makePolicyReconciliationControl } from '@gridora/policy-reconciliation-control'
import { makePolicyReconciliationRepositoryD1 } from '@gridora/policy-reconciliation-d1'
import { registerHealthRoutes } from './health-routes.js'
import { registerLogMonitoringRoutes } from './log-monitoring-routes.js'
import { makeLogMonitoringRealtime } from './log-monitoring-realtime.js'
import { makeTelemetryIngestor } from './telemetry-runtime.js'

interface WorkflowPayload {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: string
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: Readonly<Record<string, unknown>>
}

export type ApiBindings = Omit<
  Env,
  | 'RESOURCE_OPERATION'
  | 'ORGANIZATION_EVENTS'
  | 'INTERNAL_REPLAY_GUARD'
  | 'AUTH_INTENT_RATE_LIMIT'
  | 'AUTH_INTENT_STATE'
  | 'NODE_COORDINATOR'
  | 'DELETE_ORGANIZATION'
  | 'PROVISION_NODE'
  | 'PROVIDER_KEK_ACTIVE_VERSION'
  | 'PROVIDER_KEK_V1'
  | 'PROVIDER_KEK_V2'
  | 'PROVIDER_BYOP_ENABLED'
  | 'REGISTRATION_MODE'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDFLARE_TUNNEL_API_TOKEN'
  | 'AGENT_COMMAND_SIGNING_KEY'
  | 'REBUILD_NODE'
  | 'RETIRE_NODE'
  | 'DRAIN_NODE'
  | 'LEAVE_DRAIN_NODE'
  | 'NODE_RUNTIME_LIFECYCLE'
  | 'NODE_IMAGE_LIFECYCLE'
  | 'NODE_IMAGE_TRUSTED_PUBLIC_KEY_DIGESTS'
  | 'DEPLOY_GAME_SERVER'
  | 'START_GAME_SERVER'
  | 'STOP_GAME_SERVER'
  | 'RESTART_GAME_SERVER'
  | 'UPDATE_GAME_SERVER'
  | 'APPLY_GAME_CONFIG'
  | 'SYNC_MODS'
  | 'BACKUP_GAME_SERVER'
  | 'RESTORE_GAME_SERVER'
  | 'MOVE_GAME_SERVER'
  | 'DELETE_GAME_SERVER'
  | 'REGISTER_PROVIDER_IMAGE'
  | 'RECONCILE_ORPHAN'
  | 'LOGS'
  | 'TELEMETRY'
  | 'LIVE_LOG_STREAM'
> & {
  INVITATION_TOKEN_SECRET: string
  INVITATION_TOKEN_SECRET_PREVIOUS?: string
  INVITATION_TOKEN_KEY_VERSION: string
  INVITATION_TOKEN_PREVIOUS_KEY_VERSION?: string
  NODE_CREDENTIAL_SECRET: string
  NODE_CREDENTIAL_SECRET_PREVIOUS?: string
  NODE_REGISTRATION_TOKEN_SECRET: string
  NODE_REGISTRATION_TOKEN_SECRET_PREVIOUS?: string
  NODE_REGISTRATION_TOKEN_KEY_VERSION: string
  NODE_REGISTRATION_TOKEN_PREVIOUS_KEY_VERSION?: string
  CONTROL_PLANE_URL: string
  AGENT_VERSION: string
  AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM: string
  NODE_BOOTSTRAP_TTL_SECONDS: string
  /** Comma-separated sha256: digests of platform CI Ed25519 public keys. */
  NODE_IMAGE_TRUSTED_PUBLIC_KEY_DIGESTS: string
  PROVIDER_KEK_ACTIVE_VERSION: string
  PROVIDER_KEK_V1: SecretsStoreSecretBinding
  PROVIDER_KEK_V2?: SecretsStoreSecretBinding
  PROVIDER_BYOP_ENABLED: string
  REGISTRATION_MODE: string
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_TUNNEL_API_TOKEN: SecretsStoreSecretBinding
  /** Optional DNS-only Cloudflare control-plane credentials. Domain workflows
   * remain explicitly pending when this reviewed binding is absent. */
  CLOUDFLARE_DNS_ZONE_ID?: string
  CLOUDFLARE_DNS_API_TOKEN?: SecretsStoreSecretBinding
  AGENT_COMMAND_SIGNING_KEY: SecretsStoreSecretBinding
  BACKUPS: R2Bucket
  LOGS: R2Bucket
  NOTIFICATION_REMEDIATION: R2Bucket
  TELEMETRY: Queue<LiveLogArchiveAvailableEvent>
  OUTBOX_WAKEUPS: Queue<{
    readonly reason:
      | 'membership-revoked'
      | 'invitation-created'
      | 'organization-created'
      | 'tunnel-credential-delivery'
    readonly organizationId: string
  }>
  RESOURCE_OPERATION: DurableObjectNamespace<ResourceOperationDO>
  ORGANIZATION_EVENTS: DurableObjectNamespace<OrganizationEventsDO>
  INTERNAL_REPLAY_GUARD: DurableObjectNamespace<InternalReplayGuardDO>
  AUTH_INTENT_RATE_LIMIT: DurableObjectNamespace<AuthIntentRateLimitDO>
  AUTH_INTENT_STATE: DurableObjectNamespace<AuthIntentStateDO>
  NODE_COORDINATOR: DurableObjectNamespace<NodeCoordinatorDO>
  LIVE_LOG_STREAM: DurableObjectNamespace<LiveLogStreamDO>
  DELETE_ORGANIZATION: Workflow<WorkflowPayload>
  PROVISION_NODE: Workflow<WorkflowPayload>
  SERVER_PROVISION_PLAN: Workflow<WorkflowPayload>
  REBUILD_NODE: Workflow<WorkflowPayload>
  RETIRE_NODE: Workflow<WorkflowPayload>
  DRAIN_NODE: Workflow<WorkflowPayload>
  LEAVE_DRAIN_NODE: Workflow<WorkflowPayload>
  NODE_RUNTIME_LIFECYCLE: Workflow<WorkflowPayload>
  NODE_IMAGE_LIFECYCLE: Workflow<unknown>
  DEPLOY_GAME_SERVER: Workflow<WorkflowPayload>
  START_GAME_SERVER?: Workflow<WorkflowPayload>
  STOP_GAME_SERVER?: Workflow<WorkflowPayload>
  RESTART_GAME_SERVER?: Workflow<WorkflowPayload>
  UPDATE_GAME_SERVER: Workflow<WorkflowPayload>
  APPLY_GAME_CONFIG: Workflow<WorkflowPayload>
  SYNC_MODS: Workflow<WorkflowPayload>
  BACKUP_GAME_SERVER: Workflow<WorkflowPayload>
  RESTORE_GAME_SERVER: Workflow<WorkflowPayload>
  MOVE_GAME_SERVER: Workflow<WorkflowPayload>
  DELETE_GAME_SERVER: Workflow<WorkflowPayload>
  REGISTER_PROVIDER_IMAGE: Workflow<WorkflowPayload>
  RECONCILE_ORPHAN: Workflow<WorkflowPayload>
}

type RuntimeServices =
  | AccessJwtVerifier
  | AutomationIdentityControl
  | AgentRegistrationRepository
  | ApplicationClock
  | AuthorizationService
  | IdentifierGenerator
  | IdentityRepository
  | IdentityService
  | InvitationTokenService
  | LifecycleControl
  | LifecycleRepository
  | GameLifecycleD1Repository
  | GameLifecyclePlanningD1
  | WorkflowStarter
  | WorkflowStartReconciliationRepository
  | ProviderInventory
  | ProviderAccountControl
  | OvhProviderAccountValidator
  | ContaboProviderAccountValidator
  | ServerPlanControl
  | ProviderAccountRepository
  | RegistrationPolicyService
  | NodeImageInventory
  | NodeInventory
  | GameServerInventory
  | GameDesiredStateControl
  | BackupInventory
  | BackupControl
  | BackupR2Transport
  | AuditEventInventory
  | OperationInventory
  | KekPort
  | SecretEnvelopeRepository
  | SecretEnvelopeService
  | OperationRepository
  | OperationDetailRepository
  | OrganizationInvitationRepository
  | OrganizationMembershipRepository
  | OrganizationRepository
  | OrganizationService

type Variables = { accessClaims: AccessClaims }
type AppEnv = { Bindings: ApiBindings; Variables: Variables }

export class RequestValidationError extends Schema.TaggedError<RequestValidationError>()(
  'RequestValidationError',
  {
    message: Schema.String,
  },
) {}

export const operationIdempotencyScope = (
  organizationId: string,
  actorId: string,
  routeAction: string,
  resourceType: string,
  resourceId: string,
  clientKey: string,
): string =>
  `${organizationId}:${actorId}:${routeAction}:${resourceType}:${resourceId}:${clientKey}`

export const canonicalMutationFingerprint = (
  routeAction: string,
  resourceType: string,
  resourceId: string,
  input: object,
): string => canonicalize({ routeAction, resourceType, resourceId, input })

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () => new RequestValidationError({ message: 'The request does not match the API contract' }),
    ),
  )

const decodeExact = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      () => new RequestValidationError({ message: 'The request does not match the API contract' }),
    ),
  )

const id = <S extends Schema.Top>(schema: S, prefix: string) =>
  Effect.suspend(() => Schema.decodeUnknownEffect(schema)(`${prefix}_${crypto.randomUUID()}`)).pipe(
    Effect.orDie,
  )

const now = Effect.suspend(() =>
  Schema.decodeUnknownEffect(IsoDateTime)(new Date().toISOString()),
).pipe(Effect.orDie)

const identifiers = Layer.succeed(
  IdentifierGenerator,
  IdentifierGenerator.of({
    identityId: id(IdentityId, 'identity'),
    organizationId: id(OrganizationId, 'org'),
    invitationId: id(InvitationId, 'inv'),
    operationId: id(OperationId, 'op'),
    outboxEventId: id(OutboxEventId, 'event'),
  }),
)

const clock = Layer.succeed(ApplicationClock, ApplicationClock.of({ now }))

export const deriveInvitationToken = (secret: string, scope: string) =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const token = Array.from(
        new Uint8Array(
          await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(`gridora-invitation-v1:${scope}`),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      return { token, hash }
    },
    catch: (cause) => new Error(cause instanceof Error ? cause.message : 'Token generation failed'),
  }).pipe(Effect.orDie)

export const validateSecretKeyring = (
  current: string,
  previous?: string,
): ReadonlyArray<string> => {
  if (new TextEncoder().encode(current).byteLength < 32)
    throw new Error('Current HMAC secret must contain at least 32 bytes')
  if (previous !== undefined && new TextEncoder().encode(previous).byteLength < 32) {
    throw new Error('Previous HMAC secret must contain at least 32 bytes')
  }
  if (previous === current) throw new Error('Current and previous HMAC secrets must be distinct')
  return previous === undefined ? [current] : [current, previous]
}

export const recoverInvitationToken = (
  keys: ReadonlyArray<{ readonly secret: string; readonly version: string }>,
  scope: string,
  expectedHash: string,
) =>
  Effect.gen(function* () {
    for (const key of keys) {
      const candidate = yield* deriveInvitationToken(key.secret, scope)
      if (candidate.hash === expectedHash) return { ...candidate, keyVersion: key.version }
    }
    return yield* Effect.die(
      new Error('No configured invitation key version matches the persisted token hash'),
    )
  })

const invitationTokens = (
  secret: string,
  version: string,
  previous?: string,
  previousVersion?: string,
) => {
  const secrets = validateSecretKeyring(secret, previous)
  if (
    version.length === 0 ||
    (previous !== undefined && (previousVersion === undefined || previousVersion === version))
  ) {
    throw new Error('Invitation token key versions must be present and distinct')
  }
  const keys = secrets.map((key, index) => ({
    key,
    version: index === 0 ? version : previousVersion!,
  }))
  return Layer.succeed(
    InvitationTokenService,
    InvitationTokenService.of({
      issue: (scope) =>
        deriveInvitationToken(keys[0]!.key, scope).pipe(
          Effect.map((issued) => ({ ...issued, keyVersion: keys[0]!.version })),
        ),
      recover: (scope, expectedHash) =>
        Effect.gen(function* () {
          return yield* recoverInvitationToken(
            keys.map((key) => ({ secret: key.key, version: key.version })),
            scope,
            expectedHash,
          )
        }),
      hash: (token) =>
        Effect.tryPromise({
          try: async () =>
            Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
              ),
              (byte) => byte.toString(16).padStart(2, '0'),
            ).join(''),
          catch: (cause) =>
            new Error(cause instanceof Error ? cause.message : 'Token hashing failed'),
        }).pipe(Effect.orDie),
    }),
  )
}

const runtimeCache = new WeakMap<ApiBindings, WorkerEffectRuntime<RuntimeServices>>()

/**
 * Workload image digests are generated by the reviewed release pipeline.  No
 * runtime/D1 value is accepted as a substitute.  Until that release catalog
 * is supplied this remains intentionally empty and create requests fail
 * closed with `plugin_unavailable`.
 */
const reviewedGameImageCatalog = [] as const

const lifecycleBinding = (binding: Workflow<WorkflowPayload>): NativeLifecycleWorkflowBinding => ({
  create: async (options) => ({ id: (await binding.create(options)).id }),
  get: async (id) => ({ id: (await binding.get(id)).id }),
})

const optionalLifecycleBinding = (
  binding: Workflow<WorkflowPayload> | undefined,
): NativeLifecycleWorkflowBinding | undefined =>
  binding === undefined ? undefined : lifecycleBinding(binding)

const nodeImageWorkflowBinding = (binding: Workflow<unknown>) => ({
  create: async (options: { readonly id: string; readonly params: unknown }) => ({
    id: (await binding.create({ id: options.id, params: options.params })).id,
  }),
  get: async (id: string) => ({ id: (await binding.get(id)).id }),
})

export const buildProviderKekKeyring = (
  bindings: Pick<
    ApiBindings,
    'PROVIDER_KEK_ACTIVE_VERSION' | 'PROVIDER_KEK_V1' | 'PROVIDER_KEK_V2'
  >,
): CloudflareKekKeyring => {
  if (!/^[1-9][0-9]*$/.test(bindings.PROVIDER_KEK_ACTIVE_VERSION)) {
    throw new Error('Provider KEK active version is invalid')
  }
  const activeVersion = Number(bindings.PROVIDER_KEK_ACTIVE_VERSION)
  if (!Number.isSafeInteger(activeVersion) || (activeVersion !== 1 && activeVersion !== 2)) {
    throw new Error('Provider KEK active version is unsupported')
  }
  const keys: Record<number, SecretsStoreSecretBinding> = { 1: bindings.PROVIDER_KEK_V1 }
  if (bindings.PROVIDER_KEK_V2 !== undefined) keys[2] = bindings.PROVIDER_KEK_V2
  if (keys[activeVersion] === undefined)
    throw new Error('Provider KEK active binding is unavailable')
  return { activeVersion, keys }
}

const runtimeFor = (env: ApiBindings): WorkerEffectRuntime<RuntimeServices> => {
  const cached = runtimeCache.get(env)
  if (cached !== undefined) return cached
  const repositories = makeD1RepositoriesLayer(env.DB)
  const kek = CloudflareSecretsStoreKekLayer(buildProviderKekKeyring(env))
  const serverPlanFoundation = Layer.mergeAll(
    ServerPlanRepositoryLayer(makeServerPlanRepositoryD1(env.DB)),
    ServerPlanClockLayer({
      now: Effect.sync(() => {
        const date = new Date()
        return { iso: date.toISOString(), epochMilliseconds: date.getTime() }
      }),
    }),
    ServerCreateIdentityPortLayer(makeWebCryptoServerCreateIdentity()),
  )
  const gameDesiredStateFoundation = GameDesiredStateRepositoryLayer(
    makeGameDesiredStateRepositoryD1(env.DB),
  )
  const gameLifecycleClient = GameLifecycleD1ClientLayer(env.DB)
  const gameLifecycleFoundation = Layer.mergeAll(
    GameLifecycleD1RepositoryLive.pipe(Layer.provide(gameLifecycleClient)),
    GameLifecyclePlanningD1Live({ imageCatalog: reviewedGameImageCatalog }).pipe(
      Layer.provide(gameLifecycleClient),
    ),
    GameLifecycleObservationD1Live.pipe(Layer.provide(gameLifecycleClient)),
  )
  const automationIdentityFoundation = Layer.mergeAll(
    AutomationIdentityRepositoryLayer(makeAutomationIdentityRepositoryD1(env.DB)),
    AutomationIdentityClockLayer({
      now: Effect.sync(() => new Date().toISOString()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(IsoDateTime)),
        Effect.mapError(
          () => new AutomationIdentityPersistenceError({ operation: 'automationIdentity.clock' }),
        ),
      ),
    }),
    AutomationIdentityIdGeneratorLayer(WebCryptoAutomationIdentityIdGenerator),
    WebCryptoAutomationCredentialIssuerLayer(),
  )
  const backupControlFoundation = BackupControlLive.pipe(
    Layer.provide(makeBackupRepositoryD1Layer(env.DB)),
    Layer.provide(makeBackupServerFactsD1Layer(env.DB)),
    Layer.provide(BackupClockLayer({ now: Effect.sync(() => new Date().toISOString()) })),
    Layer.provide(BackupFingerprintLayer(WebCryptoBackupFingerprint)),
    Layer.provide(
      BackupPluginCompatibilityLayer({
        validateRestore: ({ metadata }) =>
          findApiPluginManifest(metadata.pluginId) === undefined
            ? Effect.fail(
                new BackupConflictError({
                  code: 'plugin_incompatible',
                  message: 'The backup plugin is not available in the reviewed registry',
                }),
              )
            : Effect.void,
      }),
    ),
    Layer.provide(
      BackupObjectDeletionLayer({
        remove: ({ r2Key }) =>
          deleteBackupObjectPrefix(
            makeCloudflareBackupR2DeletionBucket({
              list: (input) => env.BACKUPS.list(input),
              delete: (keys) => env.BACKUPS.delete(typeof keys === 'string' ? keys : [...keys]),
            }),
            r2Key,
          ).pipe(
            Effect.mapError(() => new BackupPersistenceError({ operation: 'backup.delete.r2' })),
          ),
      }),
    ),
  )
  const foundation = Layer.mergeAll(
    repositories,
    makeInventoryD1Layer(env.DB),
    ProviderAccountActionRepositoryLayer(makeProviderAccountActionRepositoryD1(env.DB)),
    OvhProviderAccountValidatorLayer(makeOvhProviderAccountValidator()),
    ContaboProviderAccountValidatorLayer(makeContaboProviderAccountValidator()),
    makeSecretEnvelopeRepositoryD1Layer(env.DB),
    makeRegistrationPolicyD1Layer(env.DB, env.REGISTRATION_MODE),
    makeLifecycleControlLayer({
      database: env.DB,
      workflows: {
        provisionNode: lifecycleBinding(env.PROVISION_NODE),
        retireNode: lifecycleBinding(env.RETIRE_NODE),
        deployServer: lifecycleBinding(env.DEPLOY_GAME_SERVER),
        configureServer: lifecycleBinding(env.APPLY_GAME_CONFIG),
        updateServerMods: lifecycleBinding(env.SYNC_MODS),
        createBackup: lifecycleBinding(env.BACKUP_GAME_SERVER),
        restoreBackup: lifecycleBinding(env.RESTORE_GAME_SERVER),
        moveServer: lifecycleBinding(env.MOVE_GAME_SERVER),
        deleteServer: lifecycleBinding(env.DELETE_GAME_SERVER),
      },
    }),
    kek,
    makeApiBackupTransportLayer({ database: env.DB, bucket: env.BACKUPS, kek }),
    serverPlanFoundation,
    gameDesiredStateFoundation,
    gameLifecycleFoundation,
    automationIdentityFoundation,
    backupControlFoundation,
    identifiers,
    clock,
    invitationTokens(
      env.INVITATION_TOKEN_SECRET,
      env.INVITATION_TOKEN_KEY_VERSION,
      env.INVITATION_TOKEN_SECRET_PREVIOUS,
      env.INVITATION_TOKEN_PREVIOUS_KEY_VERSION,
    ),
    makeAccessJwtVerifier({ issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE }),
  )
  const coreServices = Layer.mergeAll(
    AuthorizationServiceLive,
    IdentityServiceLive,
    OrganizationServiceLive,
    SecretEnvelopeServiceLive,
    RegistrationPolicyServiceLive,
  ).pipe(Layer.provide(foundation))
  const providerAccountServices = ProviderAccountControlLive.pipe(
    Layer.provide(Layer.merge(foundation, coreServices)),
  )
  const serverPlanServices = ServerPlanControlLive.pipe(Layer.provide(serverPlanFoundation))
  const gameDesiredStateServices = GameDesiredStateControlLive.pipe(
    Layer.provide(gameDesiredStateFoundation),
  )
  const automationIdentityServices = AutomationIdentityControlLive.pipe(
    Layer.provide(automationIdentityFoundation),
  )
  const services = Layer.mergeAll(
    coreServices,
    providerAccountServices,
    serverPlanServices,
    gameDesiredStateServices,
    automationIdentityServices,
  )
  const runtime = makeWorkerEffectRuntime(
    Layer.merge(foundation, services),
  ) as WorkerEffectRuntime<RuntimeServices>
  runtimeCache.set(env, runtime)
  return runtime
}

const correlationId = (
  context: HonoContext<AppEnv>,
): Effect.Effect<typeof CorrelationId.Type, never> =>
  Schema.decodeUnknownEffect(CorrelationId)(correlationIdFromContext(context)).pipe(Effect.orDie)

const accessIdentity = (claims: AccessClaims) =>
  Effect.gen(function* () {
    const identities = yield* IdentityRepository
    const identity = yield* identities.findByAccessSubject(claims.sub)
    if (identity === null)
      return yield* new ConflictError({
        code: 'account_not_found',
        message: 'Complete sign-up before using Gridora',
      })
    if (identity.status !== 'active') {
      return yield* new AuthorizationError({
        code: 'identity_suspended',
        message: 'The identity is suspended',
      })
    }
    return identity
  })

const agentCredential = (context: HonoContext<AppEnv>) =>
  Effect.gen(function* () {
    const authorization = context.req.header('authorization')
    if (
      authorization === undefined ||
      !authorization.startsWith('Bearer ') ||
      authorization.length < 40
    ) {
      return yield* new AuthorizationError({
        code: 'membership_required',
        message: 'A node credential is required',
      })
    }
    const repositories = yield* AgentRegistrationRepository
    return yield* repositories.authenticate(
      yield* sha256(authorization.slice('Bearer '.length)),
      yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now)),
    )
  })

const authorizeOrganization = (
  identity: Identity,
  rawOrganization: string,
  correlation: typeof CorrelationId.Type,
  minimumRole: 'viewer' | 'operator' | 'administrator' | 'owner' = 'viewer',
) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService
    const slug = yield* Effect.result(Schema.decodeUnknownEffect(OrganizationSlug)(rawOrganization))
    return slug._tag === 'Success'
      ? yield* authorization.authorizeBySlug(identity.id, slug.success, correlation, minimumRole)
      : yield* authorization.authorizeById(
          identity.id,
          yield* decode(OrganizationId, rawOrganization),
          correlation,
          minimumRole,
        )
  })

const parseJson = (request: Request): Effect.Effect<unknown, RequestValidationError> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new RequestValidationError({ message: 'The request body must be valid JSON' }),
  })

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const sha256 = (value: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () => new Error('SHA-256 unavailable'),
  }).pipe(Effect.orDie)

export const authenticationIntentStoredState = (body: {
  readonly intent: 'sign-in' | 'sign-up' | 'accept-invitation'
  readonly returnTo: string
  readonly displayName?: string | undefined
  readonly invitationToken?: string | undefined
}) =>
  Effect.gen(function* () {
    return {
      intent: body.intent,
      returnTo: body.returnTo,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.invitationToken === undefined
        ? {}
        : { invitationTokenHash: yield* sha256(body.invitationToken) }),
    }
  })

export const canonicalCreateResourceId = (
  organizationId: string,
  actorId: string,
  routeAction: string,
  resourcePrefix: string,
  clientKey: string,
): Effect.Effect<string> =>
  sha256(`${organizationId}:${actorId}:${routeAction}:${clientKey}`).pipe(
    Effect.map((digest) => `${resourcePrefix}_${digest.slice(0, 24)}`),
  )

const randomSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

export const deriveNodeCredential = (
  secret: string,
  tokenHash: string,
  organizationId: string,
  nodeId: string,
  providerInstanceId: string,
): Effect.Effect<{ readonly credential: string; readonly credentialId: string }> =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const bytes = new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(
            `gridora-node-credential-v1:${organizationId}:${nodeId}:${providerInstanceId}:${tokenHash}`,
          ),
        ),
      )
      const credential = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return { credential, credentialId: `credential_${credential.slice(0, 24)}` }
    },
    catch: () => new Error('Node credential derivation failed'),
  }).pipe(Effect.orDie)

export const deriveNodeCredentialCandidates = (
  current: string,
  previous: string | undefined,
  tokenHash: string,
  organizationId: string,
  nodeId: string,
  providerInstanceId: string,
): Effect.Effect<ReadonlyArray<{ readonly credential: string; readonly credentialId: string }>> =>
  Effect.forEach(validateSecretKeyring(current, previous), (key) =>
    deriveNodeCredential(key, tokenHash, organizationId, nodeId, providerInstanceId),
  )

const cookieValue = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)
    ?.slice(1)
    .join('=')

export const consumeAuthenticationIntentState = async (
  env: Pick<ApiBindings, 'AUTH_INTENT_STATE'>,
  state: string,
  cookieHeader: string | undefined,
  accessSubject: string,
): Promise<Awaited<ReturnType<AuthIntentStateDO['consume']>>> => {
  const verifier = cookieValue(cookieHeader, '__Host-gridora_auth_intent')
  if (verifier === undefined || verifier.length !== 64) return null
  const verifierHash = await Effect.runPromise(sha256(verifier))
  return env.AUTH_INTENT_STATE.getByName(state).consume(verifierHash, accessSubject)
}

export const persistWithReservationRelease = <A, E, R>(
  persist: Effect.Effect<A, E, R>,
  release: () => Promise<unknown>,
): Effect.Effect<A, E, R> =>
  persist.pipe(
    Effect.catch((error) =>
      Effect.tryPromise({
        try: release,
        catch: () => error,
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  )

/**
 * Browser credentials have two deliberately separate routes:
 *
 * - the public application can create an Access intent only;
 * - the authenticated console can call human API routes.
 *
 * Agent and internal routes never receive browser CORS headers. Their
 * credentials are intentionally non-browser protocols and are checked by the
 * following authentication middleware.
 */
export interface BrowserCorsPolicyInput {
  readonly path: string
  readonly method: string
  readonly origin: string | undefined
  readonly publicAppOrigin: string | undefined
  readonly consoleOrigin: string | undefined
}

interface BrowserCorsPolicy {
  readonly methods: ReadonlyArray<string>
  readonly headers: ReadonlyArray<string>
}

const consoleBrowserMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const consoleBrowserHeaders = [
  'content-type',
  'idempotency-key',
  'x-gridora-auth-state',
  'x-request-id',
  'x-correlation-id',
] as const
const publicIntentHeaders = ['content-type', 'x-request-id', 'x-correlation-id'] as const

const isNonBrowserRoute = (path: string): boolean =>
  path.startsWith('/v1/agent/') || path.startsWith('/v1/internal/')

const isConsoleHumanApiRoute = (path: string): boolean =>
  path.startsWith('/v1/') && !isNonBrowserRoute(path) && path !== '/v1/auth/intents'

/** Returns no policy for a path/origin pair that must not be browser-readable. */
export const browserCorsPolicyFor = ({
  path,
  method,
  origin,
  publicAppOrigin,
  consoleOrigin,
}: BrowserCorsPolicyInput): BrowserCorsPolicy | undefined => {
  if (origin === undefined || isNonBrowserRoute(path)) return undefined

  // Treat ambiguous deployment configuration as deny-by-default. A single
  // origin needs no cross-origin CORS at all, and must not gain console scope
  // merely because both variables were set to the same value.
  if (
    publicAppOrigin !== undefined &&
    publicAppOrigin === consoleOrigin &&
    origin === publicAppOrigin
  )
    return undefined

  if (origin === publicAppOrigin && path === '/v1/auth/intents' && method === 'POST')
    return {
      methods: ['POST'],
      headers: publicIntentHeaders,
    }

  if (
    origin === consoleOrigin &&
    isConsoleHumanApiRoute(path) &&
    consoleBrowserMethods.some((allowedMethod) => allowedMethod === method)
  )
    return {
      methods: consoleBrowserMethods,
      headers: consoleBrowserHeaders,
    }

  return undefined
}

const requestedHeaderNames = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter((header) => header.length > 0)

const browserCorsPolicyForContext = (
  context: HonoContext<AppEnv>,
  method: string,
): BrowserCorsPolicy | undefined =>
  browserCorsPolicyFor({
    path: context.req.path,
    method,
    origin: context.req.header('origin'),
    publicAppOrigin: context.env?.PUBLIC_APP_ORIGIN,
    consoleOrigin: context.env?.CONSOLE_ORIGIN,
  })

export const app = new Hono<AppEnv>()

// Establish the request identity before any middleware can reject the request.
// This makes problem responses from edge middleware use the same safe IDs as
// the operation and audit paths below.
app.use('*', async (context, next) => {
  const requestId = requestIdFromContext(context)
  const correlationId = correlationIdFromContext(context)
  await next()
  context.header('x-request-id', requestId)
  context.header('x-correlation-id', correlationId)
})

export const trustedCloudflareIp = (value: string | undefined): string | undefined =>
  value !== undefined && isAuditIpAddress(value) ? value : undefined

export const auditRequestContextFor = (context: HonoContext<AppEnv>): AuditRequestContextValue => {
  const claims = context.get('accessClaims') as AccessClaims | undefined
  const ip = trustedCloudflareIp(context.req.header('cf-connecting-ip'))
  return {
    origin: 'http',
    requestId: requestIdFromContext(context),
    correlationId: correlationIdFromContext(context),
    source: {
      ip:
        ip === undefined
          ? { state: 'not-available', reason: 'cloudflare-source-ip-not-available' }
          : { state: 'captured', value: ip },
      access:
        claims === undefined
          ? { state: 'not-available', reason: 'access-claim-not-present' }
          : {
              state: 'captured',
              value: {
                subject: claims.sub,
                identityId: null,
                issuer: claims.iss,
                email: claims.email,
              },
            },
    },
  }
}

/**
 * Agent bearer credentials are a machine boundary, never a Cloudflare Access
 * browser session. Keep the edge request/correlation identifiers and trusted
 * source IP when present, but make the unavailable Access evidence explicit so
 * machine audit repositories cannot accidentally inherit the HTTP/human layer.
 */
export const machineAuditRequestContextFor = (
  context: HonoContext<AppEnv>,
): AuditRequestContextValue => {
  const ip = trustedCloudflareIp(context.req.header('cf-connecting-ip'))
  return {
    origin: 'machine',
    requestId: requestIdFromContext(context),
    correlationId: correlationIdFromContext(context),
    source: {
      ip:
        ip === undefined
          ? { state: 'not-available', reason: 'machine-source-ip-not-available' }
          : { state: 'captured', value: ip },
      access: { state: 'not-available', reason: 'machine-bearer-credential' },
    },
  }
}

const auditRequestContextAtApiBoundary = (
  context: HonoContext<AppEnv>,
): AuditRequestContextValue =>
  context.req.path.startsWith('/v1/agent/')
    ? machineAuditRequestContextFor(context)
    : auditRequestContextFor(context)

const machineAuditRepositoryFor = (context: HonoContext<AppEnv>) =>
  makeAgentMachineAuditRepositoryD1(context.env.DB, {
    auditRequestContext: machineAuditRequestContextFor(context),
  })

const agentObservationControlFor = (context: HonoContext<AppEnv>) =>
  makeAgentObservationControl.pipe(
    Effect.provideService(
      AgentObservationRepository,
      makeAgentObservationRepositoryD1(context.env.DB, {
        auditRequestContext: machineAuditRequestContextFor(context),
      }),
    ),
    Effect.provideService(AgentObservationClock, {
      nowEpochMilliseconds: () => Date.now(),
    }),
  )

const coreMutationRequest = (
  context: HonoContext<AppEnv>,
  actor: OrganizationContext,
  action: string,
  resourceType: string,
  resourceId: string,
  input: object,
): Effect.Effect<CoreMutationRequest, RequestValidationError> =>
  Effect.gen(function* () {
    const rawKey = context.req.header('idempotency-key')
    if (rawKey === undefined)
      return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
    const idempotencyKey = yield* decode(IdempotencyKey, rawKey)
    const scope = operationIdempotencyScope(
      actor.organizationId,
      actor.identityId,
      action,
      resourceType,
      resourceId,
      rawKey,
    )
    return {
      idempotencyKey,
      operationIdempotencyKey: yield* decode(IdempotencyKey, yield* sha256(scope)),
      requestFingerprint: yield* sha256(
        canonicalMutationFingerprint(action, resourceType, resourceId, {
          actorId: actor.identityId,
          organizationId: actor.organizationId,
          ...input,
        }),
      ),
      request: auditRequestContextFor(context),
      resourceId,
    }
  })

const platformCoreMutationRequest = (
  context: HonoContext<AppEnv>,
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  input: object,
): Effect.Effect<CoreMutationRequest, RequestValidationError> =>
  Effect.gen(function* () {
    const rawKey = context.req.header('idempotency-key')
    if (rawKey === undefined)
      return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
    return {
      idempotencyKey: yield* decode(IdempotencyKey, rawKey),
      operationIdempotencyKey: yield* decode(
        IdempotencyKey,
        yield* sha256(`platform:${actorId}:${action}:${resourceType}:${resourceId}:${rawKey}`),
      ),
      requestFingerprint: yield* sha256(
        canonicalMutationFingerprint(action, resourceType, resourceId, { actorId, ...input }),
      ),
      request: auditRequestContextFor(context),
      resourceId,
    }
  })

const completedMutationResponse = (
  context: Pick<OrganizationContext, 'organizationId'>,
  result: { readonly operationId: string; readonly resourceId: string },
) => ({
  operationId: result.operationId,
  resourceId: result.resourceId,
  status: 'succeeded' as const,
  links: {
    operation: `/v1/organizations/${context.organizationId}/operations/${result.operationId}`,
  },
})

const apiEffectHandler = <Failure>(
  program: (context: HonoContext<AppEnv>) => Effect.Effect<Response, Failure, RuntimeServices>,
) =>
  effectHandler<AppEnv, RuntimeServices, Failure>(
    (context) => runtimeFor(context.env),
    (context) =>
      program(context).pipe(
        Effect.provideService(AuditRequestContext, auditRequestContextAtApiBoundary(context)),
      ),
  )

const routeParam = (context: HonoContext<AppEnv>, name: string): string =>
  context.req.param(name) ?? ''

const standardBodyLimit = bodyLimit({
  maxSize: 1_048_576,
  onError: (context) =>
    context.json(
      {
        type: 'https://errors.gridora.example/request-too-large',
        title: 'Request too large',
        status: 413,
        code: 'REQUEST_TOO_LARGE',
        detail: 'The request body exceeds 1 MiB',
        requestId: requestIdFromContext(context),
        retryable: false,
        fields: [],
      },
      413,
    ),
})
app.use('/v1/*', async (context, next) =>
  /^\/v1\/agent\/nodes\/[^/]+\/backups\/[^/]+\/archive$/.test(context.req.path) ||
  context.req.path === '/v1/agent/telemetry'
    ? next()
    : standardBodyLimit(context, next),
)

app.use('/*', async (context, next) => {
  const origin = context.req.header('origin')
  if (context.req.method === 'OPTIONS') {
    const requestedMethod = context.req.header('access-control-request-method')?.toUpperCase()
    const policy =
      requestedMethod === undefined
        ? undefined
        : browserCorsPolicyForContext(context, requestedMethod)
    const requestedHeaders = requestedHeaderNames(
      context.req.header('access-control-request-headers'),
    )
    if (
      origin === undefined ||
      policy === undefined ||
      !requestedHeaders.every((header) => policy.headers.includes(header))
    )
      return new Response(null, { status: 403 })
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': policy.methods.join(','),
        'access-control-allow-headers': policy.headers.join(','),
        'access-control-max-age': '600',
        vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      },
    })
  }
  await next()
  if (
    origin !== undefined &&
    browserCorsPolicyForContext(context, context.req.method) !== undefined
  ) {
    context.header('access-control-allow-origin', origin)
    context.header('access-control-allow-credentials', 'true')
    context.header('vary', 'Origin', { append: true })
  }
})

app.use('/v1/*', async (context, next) => {
  if (context.req.path === '/v1/auth/intents' && context.req.method === 'POST') return next()
  if (
    context.req.path === '/v1/agent/registrations/exchange' ||
    context.req.path === '/v1/agent/registrations/revoke' ||
    context.req.path === '/v1/agent/events' ||
    context.req.path === '/v1/agent/telemetry' ||
    context.req.path.startsWith('/v1/agent/nodes/')
  )
    return next()
  if (context.req.path.startsWith('/v1/internal/')) {
    const result = await Effect.runPromise(
      Effect.result(verifyInternalRequest(context.req.raw, context.env.INTERNAL_SERVICE_SECRET)),
    )
    if (result._tag === 'Failure')
      return problemResponse({
        status: 403,
        problem: {
          type: 'https://errors.gridora.example/internal-authentication-failed',
          title: 'Internal authentication failed',
          status: 403,
          code: 'INTERNAL_AUTHENTICATION_FAILED',
          detail: 'The internal request signature is invalid or expired',
          requestId: requestIdFromContext(context),
          retryable: false,
          fields: [],
        },
      })
    const verified = result.success
    const guard = context.env.INTERNAL_REPLAY_GUARD.getByName(
      `internal-nonce:${verified.nonce.slice(0, 2)}`,
    )
    if (!(await guard.claim('internal-hmac', verified.nonce, verified.expiresAt)))
      return problemResponse({
        status: 409,
        problem: {
          type: 'https://errors.gridora.example/internal-request-replayed',
          title: 'Internal request replayed',
          status: 409,
          code: 'INTERNAL_REQUEST_REPLAYED',
          detail: 'The internal request nonce was already used',
          requestId: requestIdFromContext(context),
          retryable: false,
          fields: [],
        },
      })
    return next()
  }
  const result = await runtimeFor(context.env).run(
    assertionFromRequest(context.req.raw).pipe(
      Effect.flatMap((assertion) =>
        AccessJwtVerifier.pipe(Effect.flatMap((verifier) => verifier.verify(assertion))),
      ),
    ),
    requestIdFromContext(context),
  )
  if (typeof result === 'object' && result !== null && 'problem' in result)
    return problemResponse(result)
  context.set('accessClaims', result as AccessClaims)
  await next()
})

app.use('/v1/*', async (context, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(context.req.method)) {
    const origin = context.req.header('origin')
    const sameOrigin = origin === new URL(context.req.url).origin
    if (
      origin !== undefined &&
      !sameOrigin &&
      browserCorsPolicyForContext(context, context.req.method) === undefined
    ) {
      return context.json(
        {
          type: 'https://errors.gridora.example/csrf-rejected',
          title: 'Cross-site request rejected',
          status: 403,
          code: 'CSRF_REJECTED',
          detail: 'The request Origin is not permitted for this API route',
          requestId: requestIdFromContext(context),
          retryable: false,
          fields: [],
        },
        403,
        { 'content-type': 'application/problem+json' },
      )
    }
  }
  await next()
})

app.get('/health', (context) => context.json({ status: 'ok' }))
app.get('/openapi.json', (context) => context.json(openApiDocument))

app.get(
  '/v1/plugins',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      yield* accessIdentity(context.get('accessClaims'))
      return context.json(apiPluginManifests)
    }),
  ),
)

app.put(
  '/v1/organizations/:organization',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* mutationContext(context, 'administrator')
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(UpdateOrganizationProfileInput, value)),
      )
      const organizations = yield* OrganizationRepository
      const identifiers = yield* IdentifierGenerator
      const result = yield* organizations.updateProfile(
        authorized,
        {
          name: body.name,
          timezone: body.timezone,
          defaultRegion: body.defaultRegion,
        },
        body.expectedRevision,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.profile.update',
          'organization',
          authorized.organizationId,
          body,
        ).pipe(
          Effect.flatMap((request) =>
            Effect.gen(function* () {
              return {
                operationId: yield* identifiers.operationId,
                ...request,
                action: 'organization.profile.update',
                resourceType: 'organization',
                resourceId: authorized.organizationId,
                now: yield* ApplicationClock.pipe(Effect.flatMap((clock) => clock.now)),
              }
            }),
          ),
        ),
        yield* identifiers.outboxEventId,
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)
app.post(
  '/v1/organizations/:organization/actions/switch',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* mutationContext(context, 'viewer')
      const organizations = yield* OrganizationRepository
      const identifiers = yield* IdentifierGenerator
      const request = yield* coreMutationRequest(
        context,
        authorized,
        'identity.organization.switch',
        'organization',
        authorized.organizationId,
        { organizationId: authorized.organizationId },
      )
      const result = yield* organizations.recordSwitch(
        authorized,
        {
          operationId: yield* identifiers.operationId,
          ...request,
          action: 'identity.organization.switch',
          resourceType: 'organization',
          resourceId: authorized.organizationId,
          now: yield* ApplicationClock.pipe(Effect.flatMap((clock) => clock.now)),
        },
        yield* identifiers.outboxEventId,
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)
app.get(
  '/v1/plugins/:id',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      yield* accessIdentity(context.get('accessClaims'))
      const plugin = findApiPluginManifest(routeParam(context, 'id'))
      return plugin === undefined
        ? problemResponse({
            status: 404,
            problem: {
              type: 'https://errors.gridora.example/not-found',
              title: 'Plugin not found',
              status: 404,
              code: 'NOT_FOUND',
              detail: 'The plugin does not exist',
              requestId: requestIdFromContext(context),
              retryable: false,
              fields: [],
            },
          })
        : context.json(plugin)
    }),
  ),
)

app.post('/v1/auth/intents', async (context) => {
  const rateKey = context.req.header('cf-connecting-ip') ?? 'unknown-client'
  if (
    !(await context.env.AUTH_INTENT_RATE_LIMIT.getByName(`auth-intent-rate:${rateKey}`).allow(
      Date.now(),
    ))
  ) {
    return problemResponse({
      status: 429,
      problem: {
        type: 'https://errors.gridora.example/rate-limited',
        title: 'Too many authentication attempts',
        status: 429,
        code: 'AUTH_INTENT_RATE_LIMITED',
        detail: 'Wait before creating another authentication state',
        requestId: requestIdFromContext(context),
        retryable: true,
        fields: [],
      },
    })
  }
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const body = yield* parseJson(context.req.raw).pipe(
          Effect.flatMap((value) => decode(CreateAuthenticationIntentBody, value)),
        )
        if (!validReturnTarget(body.returnTo)) {
          return yield* new RequestValidationError({ message: 'The return target is not allowed' })
        }
        if (
          body.intent === 'sign-up' &&
          (body.displayName === undefined || body.displayName.length === 0)
        ) {
          return yield* new RequestValidationError({
            message: 'Display name is required for sign-up',
          })
        }
        if (body.intent === 'accept-invitation' && body.invitationToken === undefined) {
          return yield* new RequestValidationError({ message: 'Invitation token is required' })
        }
        const state = `state_${crypto.randomUUID()}`
        const verifier = randomSecret()
        const expiresAt = Date.now() + 5 * 60_000
        const verifierHash = yield* sha256(verifier)
        const storedState = yield* authenticationIntentStoredState(body)
        const issued = yield* Effect.tryPromise({
          try: () =>
            context.env.AUTH_INTENT_STATE.getByName(state).issue(
              verifierHash,
              expiresAt,
              storedState,
            ),
          catch: () =>
            new RequestValidationError({ message: 'Authentication state is unavailable' }),
        })
        if (!issued)
          return yield* new RequestValidationError({
            message: 'Authentication state could not be issued',
          })
        return { state, expiresAt, verifier }
      }),
    ),
  )
  if (result._tag === 'Failure')
    return problemResponse({
      status: 400,
      problem: {
        type: 'https://errors.gridora.example/invalid-authentication-intent',
        title: 'Invalid authentication intent',
        status: 400,
        code: 'INVALID_AUTHENTICATION_INTENT',
        detail: 'The authentication intent is invalid',
        requestId: requestIdFromContext(context),
        retryable: false,
        fields: [],
      },
    })
  const { verifier, ...body } = result.success
  return context.json(body, 201, {
    'cache-control': 'no-store',
    'set-cookie': `__Host-gridora_auth_intent=${verifier}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`,
  })
})

app.get(
  '/v1/auth/bootstrap',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const claims = context.get('accessClaims')
      const identities = yield* IdentityRepository
      const memberships = yield* OrganizationMembershipRepository
      const organizations = yield* OrganizationRepository
      const identity = yield* identities.findByAccessSubject(claims.sub)
      if (identity === null)
        return jsonResponse({
          authenticated: true,
          intent: 'sign-in',
          next: 'sign-up',
          organizations: [],
        })
      if (identity.status !== 'active') {
        return yield* new AuthorizationError({
          code: 'identity_suspended',
          message: 'The identity is suspended',
        })
      }
      const memberRows = yield* memberships.listForIdentity(identity.id)
      const summaries = yield* Effect.forEach(memberRows, (membership) =>
        organizations
          .getById(membership.organizationId)
          .pipe(Effect.map((organization) => ({ organization, role: membership.role }))),
      )
      return jsonResponse({
        authenticated: true,
        identityId: identity.id,
        intent: 'sign-in',
        next: summaries.length === 0 ? 'setup-organization' : 'dashboard',
        organizations: summaries,
      })
    }),
  ),
)

const completeAuthentication = (context: HonoContext<AppEnv>) =>
  Effect.gen(function* () {
    const claims = context.get('accessClaims')
    const state = context.req.header('x-gridora-auth-state')
    if (state === undefined) {
      return yield* new RequestValidationError({ message: 'Authentication state is required' })
    }
    const rawIdempotencyKey = context.req.header('idempotency-key')
    if (rawIdempotencyKey === undefined)
      return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
    const authIdempotencyKey = yield* decode(IdempotencyKey, rawIdempotencyKey)
    const intent = yield* Effect.tryPromise({
      try: () =>
        consumeAuthenticationIntentState(
          context.env,
          state,
          context.req.header('cookie'),
          claims.sub,
        ),
      catch: () => new RequestValidationError({ message: 'Authentication state is unavailable' }),
    })
    if (intent === null) {
      return yield* new RequestValidationError({
        message: 'Authentication state is invalid, expired, or already used',
      })
    }
    const body = yield* parseJson(context.req.raw).pipe(
      Effect.flatMap((value) => decode(CompleteSignUpBody, value)),
    )
    if (body.displayName !== undefined && body.displayName !== intent.displayName) {
      return yield* new RequestValidationError({
        message: 'Sign-up fields do not match the issued authentication state',
      })
    }
    const identities = yield* IdentityRepository
    const existingIdentity = yield* identities.findByAccessSubject(claims.sub)
    if (existingIdentity !== null && existingIdentity.status !== 'active') {
      return yield* new AuthorizationError({
        code: 'identity_suspended',
        message: 'The identity is suspended',
      })
    }
    const invitationBinding =
      intent.intent === 'accept-invitation' && intent.invitationTokenHash !== undefined
        ? yield* Effect.gen(function* () {
            const invitations = yield* OrganizationInvitationRepository
            const result = yield* Effect.result(
              invitations.findByTokenHash(intent.invitationTokenHash!),
            )
            if (result._tag === 'Failure') {
              if (result.failure._tag === 'NotFoundError') return null
              return yield* result.failure
            }
            const invitation = result.success
            return {
              invitationId: invitation.id,
              boundExternalIdentity:
                invitation.email.toLowerCase() === claims.email.toLowerCase()
                  ? claims.sub
                  : `binding-mismatch:${claims.sub}`,
              expiresAtEpochMilliseconds: Date.parse(invitation.expiresAt),
              consumedAtEpochMilliseconds: invitation.status === 'pending' ? null : 0,
            }
          })
        : null
    const registrationPolicy = yield* RegistrationPolicyService
    yield* registrationPolicy.decide({
      decisionId: state,
      intent:
        intent.intent === 'sign-up'
          ? 'public-sign-up'
          : intent.intent === 'accept-invitation'
            ? 'invitation-completion'
            : 'sign-in',
      externalIdentity: claims.sub,
      identityKnown: existingIdentity !== null,
      invitation: invitationBinding,
    })
    const invitationAcceptance =
      intent.intent === 'accept-invitation'
        ? yield* Effect.gen(function* () {
            if (intent.invitationTokenHash === undefined) {
              return yield* new RequestValidationError({
                message: 'Invitation state is missing its token',
              })
            }
            const service = yield* OrganizationService
            return yield* service
              .acceptInvitationForAccessIdentityByTokenHash(
                {
                  accessSubject: claims.sub,
                  email: yield* decode(EmailAddress, claims.email),
                  displayName: yield* decode(
                    DisplayName,
                    intent.displayName ??
                      claims.name ??
                      claims.email.split('@')[0] ??
                      'Gridora user',
                  ),
                },
                intent.invitationTokenHash,
                {
                  idempotencyKey: authIdempotencyKey,
                  operationIdempotencyKey: yield* decode(
                    IdempotencyKey,
                    yield* sha256(`auth-complete:${claims.sub}:${rawIdempotencyKey}`),
                  ),
                  requestFingerprint: yield* sha256(
                    canonicalize({ state, subject: claims.sub, intent: intent.intent }),
                  ),
                  request: auditRequestContextFor(context),
                  resourceId: intent.invitationTokenHash,
                },
              )
              .pipe(
                Effect.mapError((error) =>
                  error._tag === 'InvitationError'
                    ? new RegistrationDeniedError({ code: 'registration_not_available' })
                    : error,
                ),
              )
          })
        : undefined
    const identity =
      intent.intent === 'sign-up'
        ? yield* Effect.gen(function* () {
            if (intent.displayName === undefined) {
              return yield* new RequestValidationError({
                message: 'Sign-up state is missing the display name',
              })
            }
            const service = yield* IdentityService
            const mutation = yield* platformCoreMutationRequest(
              context,
              claims.sub,
              'identity.sign-up',
              'identity',
              `access:${claims.sub}`,
              { state, email: claims.email, displayName: intent.displayName },
            )
            return yield* service.completeSignUp(
              {
                accessSubject: claims.sub,
                email: yield* decode(EmailAddress, claims.email),
                displayName: intent.displayName,
              },
              mutation,
            )
          })
        : intent.intent === 'accept-invitation'
          ? invitationAcceptance!.identity
          : yield* Effect.gen(function* () {
              const current = yield* accessIdentity(claims)
              const service = yield* IdentityService
              return yield* service
                .recordLogin(
                  claims.sub,
                  yield* platformCoreMutationRequest(
                    context,
                    current.id,
                    'identity.sign-in',
                    'identity',
                    current.id,
                    { state, intent: intent.intent },
                  ),
                )
                .pipe(
                  Effect.flatMap((recorded) =>
                    recorded === null
                      ? Effect.fail(
                          new ConflictError({
                            code: 'account_not_found',
                            message: 'Complete sign-up before using Gridora',
                          }),
                        )
                      : Effect.succeed(recorded),
                  ),
                )
            })
    const membership = invitationAcceptance?.membership
    const memberships = yield* OrganizationMembershipRepository
    const organizationMemberships = yield* memberships.listForIdentity(identity.id)
    return jsonResponse(
      {
        intent: intent.intent,
        next:
          organizationMemberships.length === 0 && membership === undefined
            ? 'setup-organization'
            : 'dashboard',
        returnTo: intent.returnTo,
        identity,
        ...(membership === undefined ? {} : { membership }),
      },
      200,
      {
        'set-cookie':
          '__Host-gridora_auth_intent=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      },
    )
  })

app.post('/v1/auth/complete', apiEffectHandler(completeAuthentication))
app.post('/v1/auth/sign-up/complete', apiEffectHandler(completeAuthentication))

const notImplemented = (context: HonoContext<AppEnv>, capability: string): Response =>
  new Response(
    JSON.stringify({
      type: 'https://errors.gridora.example/not-implemented',
      title: 'Capability not implemented',
      status: 501,
      code: 'NOT_IMPLEMENTED',
      detail: `${capability} is not implemented in this release slice`,
      requestId: requestIdFromContext(context),
      retryable: false,
      fields: [],
    }),
    { status: 501, headers: { 'content-type': 'application/problem+json' } },
  )

export const supportedWorkflowProgress = (
  _workflow: string,
  _step: string,
): {
  readonly status: 'running' | 'succeeded'
  readonly progress: number
} | null => {
  // A Workflow step is supported only after its side effect and durable
  // evidence are composed below. Step names alone are never success evidence.
  return null
}

const gameWorkflowActions: Readonly<Record<string, string>> = {
  'deploy-game-server': 'create',
  'start-game-server': 'start',
  'stop-game-server': 'stop',
  'restart-game-server': 'restart',
  'update-game-server': 'update',
  'apply-game-config': 'apply-config',
  'sync-mods': 'sync-mods',
  'move-game-server': 'move',
  'delete-game-server': 'delete',
}

app.post(
  '/v1/internal/orphan-reconciliations/execute',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const payload = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) =>
          decodeOrphanScheduleTask(value).pipe(
            Effect.mapError(
              () =>
                new RequestValidationError({
                  message: 'The orphan task does not match the contract',
                }),
            ),
          ),
        ),
      )
      if (
        context.req.header('x-gridora-workflow') !== 'reconcile-orphan' ||
        context.req.header('x-gridora-organization-id') !== payload.organizationId ||
        context.req.header('idempotency-key') !== `workflow:${payload.idempotencyKey}`
      )
        return yield* new RequestValidationError({
          message: 'Signed orphan Workflow routing does not match the durable task',
        })

      const scheduler = makeOrphanScheduleStore(context.env.DB)
      yield* scheduler
        .assertExecutionLease(payload)
        .pipe(
          Effect.mapError(
            () => new RequestValidationError({ message: 'The orphan task lease is not active' }),
          ),
        )
      const kek = yield* KekPort
      const organizationSecrets = yield* SecretEnvelopeService
      const platformSecrets = makePlatformSecretEnvelope(
        makePlatformSecretRepositoryD1(context.env.DB),
        kek,
      )
      const reconciliation = makeOrphanReconciliation({
        database: context.env.DB,
        secrets: organizationSecrets,
        openPlatformCredentials: (accountId, _providerType) =>
          platformSecrets.open(accountId).pipe(
            Effect.mapError(
              () =>
                new OrphanControlError({
                  operation: 'orphan.runtime.credentials.platform',
                  code: 'discovery-failed',
                  message: 'orphan reconciliation failed',
                }),
            ),
          ),
        providers: makeLiveOrphanProviderFactories(),
      })
      const result = yield* reconciliation({
        organizationId: payload.organizationId,
        providerAccountId: payload.providerAccountId,
        providerType: payload.providerType,
        runId: payload.runId,
        idempotencyKey: payload.idempotencyKey,
        actorId: payload.actorId,
      }).pipe(
        Effect.mapError(
          () =>
            new RequestValidationError({
              message: 'Orphan reconciliation did not pass its scope fence',
            }),
        ),
      )
      const events = context.env.ORGANIZATION_EVENTS.getByName(`${payload.organizationId}:events`)
      yield* Effect.tryPromise({
        try: async () => {
          await events.initialize(payload.organizationId)
          await events.publish({
            id: `orphan-reconciliation:${payload.workflowId}`,
            organizationId: payload.organizationId,
            type: result.opened > 0 ? 'orphan.finding.detected' : 'orphan.reconciliation.completed',
            resourceId: payload.providerAccountId,
            occurredAt: new Date().toISOString(),
            data: {
              runId: payload.runId,
              providerAccountId: payload.providerAccountId,
              providerType: payload.providerType,
              severity: result.opened > 0 ? 'high' : 'none',
              opened: result.opened,
              updated: result.updated,
              resolved: result.resolved,
              unchanged: result.unchanged,
            },
          })
        },
        catch: () =>
          new RequestValidationError({
            message: 'The orphan reconciliation event could not be published',
          }),
      })
      yield* scheduler
        .complete(payload)
        .pipe(
          Effect.mapError(
            () => new RequestValidationError({ message: 'The orphan task could not be completed' }),
          ),
        )
      return jsonResponse(result)
    }),
  ),
)

app.post(
  '/v1/internal/node-image-workflow/execute',
  apiEffectHandler((context) =>
    executeSignedNodeImageWorkflowStep({
      request: context.req.raw,
      secret: context.env.INTERNAL_SERVICE_SECRET,
      now: Date.now(),
      reservations: makeNodeImageExecutionRepositoryD1(context.env.DB),
      executor: makeNodeImageExecutionRuntime(context.env.DB),
    }).pipe(
      Effect.map((result) => jsonResponse(result)),
      Effect.mapError(
        () =>
          new PersistenceError({
            operation: 'node-image.workflow.execute',
            message: 'The accepted platform node image Workflow step did not commit',
          }),
      ),
    ),
  ),
)

app.post(
  '/v1/internal/workflow-steps/execute',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const workflow = context.req.header('x-gridora-workflow')
      const step = context.req.header('x-gridora-workflow-step')
      const ordinal = context.req.header('x-gridora-workflow-step-ordinal')
      const routedOrganizationId = context.req.header('x-gridora-organization-id')
      if (
        workflow === 'DrainNodeWorkflow' ||
        workflow === 'LeaveDrainNodeWorkflow' ||
        workflow === 'RebuildNodeWorkflow' ||
        workflow === 'RetireNodeWorkflow'
      ) {
        const kek = yield* KekPort
        const terminationDependencies = {
          providers: makeNodeTerminationProviderAdapterResolver(context.env.DB, kek),
          tunnels: makeNodeTerminationTunnelAdapter({
            accountId: context.env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: context.env.CLOUDFLARE_TUNNEL_API_TOKEN,
          }),
          rebuildBootstrap: {
            registrationTokens: makeNodeRegistrationTokenSecret(context.env),
            trusted: makeNodeBootstrapTrustedConfiguration(context.env),
            cloudInit: nodeBootstrapCloudInit,
          },
        }
        const executed = yield* executeSignedTerminationWorkflowStep({
          request: context.req.raw,
          secret: context.env.INTERNAL_SERVICE_SECRET,
          now: Date.now(),
          repository: makeWorkflowStepD1Repository(context.env.DB),
          execute: (envelope, lease) =>
            executeNodeTerminationWorkflowEffect(
              context.env.DB,
              envelope,
              lease,
              terminationDependencies,
            ),
          observeExpiredEffect: (input) =>
            observeNodeTerminationWorkflowEffect(context.env.DB, input, terminationDependencies),
        }).pipe(
          Effect.mapError(
            (error) =>
              new PersistenceError({
                operation: `node.termination.workflow.${error.code}`,
                message:
                  'The accepted node termination Workflow step does not yet have authoritative execution evidence',
              }),
          ),
        )
        return jsonResponse(executed)
      }
      const rawPayload = yield* parseJson(context.req.raw)
      if (workflow === 'backup-game-server' || workflow === 'restore-game-server') {
        const backupStep = yield* decode(SignedBackupWorkflowStep, rawPayload)
        if (
          backupStep.step !== step ||
          String(backupStep.ordinal) !== ordinal ||
          backupStep.organizationId !== routedOrganizationId
        )
          return yield* new RequestValidationError({
            message: 'Signed backup Workflow routing does not match the request body',
          })
        const loaded = yield* loadBackupWorkflowState(
          context.env.DB,
          backupStep.organizationId,
          backupStep.operationId,
        )
        if (loaded === null || loaded.job.id !== backupStep.jobId)
          return yield* new PersistenceError({
            operation: 'backup.workflow.authority',
            message: 'Authoritative backup Workflow state is unavailable',
          })
        const control = yield* BackupControl
        const executor = yield* makeBackupWorkflowExecutor(
          {
            database: context.env.DB,
            nodeCoordinator: context.env.NODE_COORDINATOR,
            signingKey: context.env.AGENT_COMMAND_SIGNING_KEY,
            internalSecret: context.env.INTERNAL_SERVICE_SECRET,
            ...(makeGameCloudflareApi(context.env) === undefined
              ? {}
              : { cloudflare: makeGameCloudflareApi(context.env)! }),
            dnsZoneId: context.env.CLOUDFLARE_DNS_ZONE_ID,
          },
          control,
          loaded.job,
          loaded.artifact,
        )
        const executed = yield* executor
          .execute(backupStep, loaded.job, loaded.artifact, new Date().toISOString())
          .pipe(
            Effect.mapError(
              () =>
                new PersistenceError({
                  operation: `backup.workflow.${backupStep.step}`,
                  message: 'Backup Workflow step did not produce authoritative execution evidence',
                }),
            ),
          )
        return jsonResponse({ status: 'completed', resourceRevision: executed.job.revision })
      }
      const payload = yield* decode(InternalWorkflowStepBody, rawPayload)
      if (
        payload.stepName !== step ||
        String(payload.ordinal) !== ordinal ||
        payload.organizationId !== routedOrganizationId
      ) {
        return yield* new RequestValidationError({
          message: 'Signed workflow routing headers do not match the request body',
        })
      }
      if (workflow === 'NodeRuntimeLifecycleWorkflow') {
        const runtimePayload = yield* decode(NodeRuntimeLifecycleWorkflowPayload, rawPayload)
        if (
          runtimePayload.stepName !== 'execute-runtime-lifecycle' ||
          runtimePayload.stepName !== step ||
          runtimePayload.organizationId !== routedOrganizationId ||
          String(runtimePayload.ordinal) !== ordinal
        )
          return yield* new RequestValidationError({
            message: 'The node runtime Workflow routing does not match its signed body',
          })
        const kek = yield* KekPort
        const result = yield* executeNodeRuntimeLifecycleWorkflow({
          bindings: context.env,
          resolver: makeProviderNodeLifecycleAdapterResolver(context.env.DB, kek),
          payload: runtimePayload,
          attemptedAt: new Date().toISOString(),
        }).pipe(
          Effect.mapError(
            () =>
              new PersistenceError({
                operation: 'node.runtime.workflow.execute',
                message:
                  'The accepted node runtime Workflow step did not commit authoritative evidence',
              }),
          ),
        )
        return jsonResponse(result)
      }
      if (workflow === 'delete-organization') {
        if (payload.resourceType !== 'organization')
          return yield* new RequestValidationError({
            message: 'The organization deletion Workflow resource does not match the request body',
          })
        const planning = yield* GameLifecyclePlanningD1
        const backup = yield* BackupControl
        const executed = yield* executeOrganizationDeletionStep(
          context.env,
          {
            planning,
            deletionWorkflow: lifecycleBinding(context.env.DELETE_GAME_SERVER),
            backup,
          },
          {
            organizationId: payload.organizationId,
            operationId: payload.operationId,
            resourceId: payload.resourceId,
            stepName: payload.stepName,
            now: new Date().toISOString(),
          },
        ).pipe(
          Effect.mapError(
            () =>
              new ConflictError({
                code: 'organization_deletion_cleanup_pending',
                message: 'Organization deletion cleanup does not yet have terminal child evidence',
              }),
          ),
        )
        return jsonResponse(executed)
      }
      if (workflow === 'provision-node' && step === 'create-or-adopt-instance' && ordinal === '0') {
        if (payload.resourceType !== 'node' || payload.resourceId.length === 0)
          return yield* new RequestValidationError({
            message: 'The node provision Workflow resource does not match the request body',
          })
        const kek = yield* KekPort
        const executed = yield* Effect.result(
          executeNodeProvision(context.env, kek, {
            organizationId: payload.organizationId,
            operationId: payload.operationId,
            attemptedAt: new Date().toISOString(),
          }),
        )
        if (executed._tag === 'Failure') {
          if (executed.failure instanceof ProviderCreateUncertainError)
            return jsonResponse({
              status: 'waiting',
              retryMode: 'adopt_only',
              nextAttemptAt: new Date(executed.failure.nextAttemptAtEpochMs).toISOString(),
              recoveryDeadlineAt: new Date(
                executed.failure.recoveryDeadlineAtEpochMs,
              ).toISOString(),
            })
          return yield* new PersistenceError({
            operation: 'node.provision.execute',
            message: 'The accepted node provision execution did not commit',
          })
        }
        if (
          executed.success.organizationId !== payload.organizationId ||
          executed.success.operationId !== payload.operationId ||
          executed.success.nodeId !== payload.resourceId
        )
          return yield* new PersistenceError({
            operation: 'node.provision.execute',
            message: 'The node provision result does not match the signed Workflow route',
          })
        return jsonResponse({
          status: executed.success.disposition === 'adopted' ? 'adopted' : 'completed',
          providerRequestId: executed.success.providerInstanceId,
        })
      }
      if (workflow === 'server-provision-plan') {
        const serverPayload = yield* decode(ServerProvisionWorkflowPayload, rawPayload)
        if (
          serverPayload.stepName !== step ||
          String(serverPayload.ordinal) !== ordinal ||
          serverPayload.organizationId !== routedOrganizationId
        )
          return yield* new RequestValidationError({
            message: 'The server provision Workflow routing does not match its signed body',
          })
        const repository = yield* GameLifecycleD1Repository
        const planning = yield* GameLifecyclePlanningD1
        const executed = yield* executeServerProvisionPlanStep({
          bindings: context.env,
          payload: serverPayload,
          gameRepository: repository,
          gamePlanning: planning,
          retirement: makeServerProvisionRetirementPort(context.env),
          now: new Date().toISOString(),
        }).pipe(
          Effect.mapError(
            () =>
              new PersistenceError({
                operation: 'server.provision.workflow.execute',
                message:
                  'The accepted server provisioning Workflow step did not commit authoritative evidence',
              }),
          ),
        )
        return jsonResponse(executed)
      }
      const gameAction = gameWorkflowActions[workflow ?? '']
      if (gameAction !== undefined) {
        if (payload.resourceType !== 'server' || payload.resourceId.length === 0)
          return yield* new RequestValidationError({
            message: 'The game Workflow resource does not match the request body',
          })
        const planning = yield* GameLifecyclePlanningD1
        const workflowData = yield* planning
          .readWorkflowData(payload.organizationId, payload.operationId)
          .pipe(
            Effect.mapError(
              () =>
                new PersistenceError({
                  operation: 'game.workflow.authority',
                  message: 'The accepted game Workflow state is unavailable',
                }),
            ),
          )
        if (
          workflowData.organizationId !== payload.organizationId ||
          workflowData.actorId !== payload.actorId ||
          workflowData.serverId !== payload.resourceId ||
          workflowData.action !== gameAction
        )
          return yield* new RequestValidationError({
            message: 'The signed game Workflow route is not bound to the accepted operation',
          })
        const image = workflowData.image
        if (image === undefined)
          return yield* new PersistenceError({
            operation: 'game.workflow.authority.image',
            message: 'The accepted game image is not present in the reviewed build catalog',
          })
        const authoritativeInput = yield* makeAuthoritativeGameWorkflowPayload(
          workflowData,
          image,
        ).pipe(
          Effect.mapError(
            () =>
              new PersistenceError({
                operation: 'game.workflow.authority.payload',
                message: 'The accepted game Workflow payload cannot be reconstructed',
              }),
          ),
        )
        const suppliedInput = yield* Effect.result(
          Schema.decodeUnknownEffect(GameWorkflowPayload, {
            onExcessProperty: 'error',
          })(payload.input),
        )
        if (
          suppliedInput._tag === 'Failure' ||
          !matchesAcceptedGameWorkflowPayload(suppliedInput.success, authoritativeInput)
        )
          return yield* new RequestValidationError({
            message: 'The game Workflow input is not the exact accepted tenant plan',
          })
        const resolveDns = makeGameDnsAuthorityResolver(
          context.env.DB,
          context.env.CLOUDFLARE_DNS_ZONE_ID ?? '',
        )
        const requiresNativeBackup =
          gameAction === 'move' ||
          (gameAction === 'update' && authoritativeInput.backupBeforeUpdate === true) ||
          (gameAction === 'delete' && authoritativeInput.backupPolicy === 'required')
        const backupAdapter = requiresNativeBackup
          ? yield* makeNativeGameMoveBackupAdapter(context.env, yield* BackupControl)
          : undefined
        const moveAdapter = gameAction === 'move' ? backupAdapter : undefined
        const cloudflare = makeGameCloudflareApi(context.env)
        const executed = yield* Effect.result(
          executeGameLifecycleWorkflowStep(
            {
              database: context.env.DB,
              nodeCoordinator: context.env.NODE_COORDINATOR,
              signingKey: context.env.AGENT_COMMAND_SIGNING_KEY,
              ...(cloudflare === undefined ? {} : { cloudflare }),
              resolveDns,
              recordDns: makeGameDnsAuthorityReceiptRecorder(context.env.DB, resolveDns),
              ...(moveAdapter === undefined
                ? {}
                : { move: makeGameMoveCoordinator(context.env.DB, moveAdapter) }),
              ...(backupAdapter === undefined ? {} : { backup: backupAdapter.backupSource }),
            },
            payload.input,
            step ?? '',
          ),
        )
        if (executed._tag === 'Failure')
          return yield* new PersistenceError({
            operation: `game.workflow.${step ?? 'unknown'}`,
            message: 'The game Workflow step did not produce authoritative execution evidence',
          })
        return jsonResponse({
          status: 'completed',
          ...(executed.success.revision === undefined
            ? {}
            : { resourceRevision: executed.success.revision }),
        })
      }
      const target = supportedWorkflowProgress(workflow ?? '', step ?? '')
      if (target === null) return notImplemented(context, 'Workflow step execution')
      const organizationId = yield* decode(OrganizationId, payload.organizationId)
      const identityId = yield* decode(IdentityId, payload.actorId)
      const operationId = yield* decode(OperationId, payload.operationId)
      const correlation = yield* decode(CorrelationId, payload.correlationId)
      const organizations = yield* OrganizationRepository
      const operations = yield* OperationRepository
      const organization = yield* organizations.getById(organizationId)
      const organizationContext = new OrganizationContextValue({
        organizationId,
        organizationSlug: organization.slug,
        identityId,
        role: 'automation',
        correlationId: correlation,
      })
      const current = yield* operations.get(organizationContext, operationId)
      const updated =
        current.progress >= target.progress &&
        (target.status !== 'succeeded' || current.status === 'succeeded')
          ? current
          : yield* operations.updateStatus(
              organizationContext,
              operationId,
              target.status,
              target.progress,
              current.revision,
              yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now)),
            )
      return jsonResponse({ status: 'completed', resourceRevision: updated.revision })
    }),
  ),
)

const recoverLifecycleWorkflowStart = (
  event: typeof InternalQueueEventBody.Type,
  payload: typeof LifecycleWorkflowStartRequestedPayload.Type,
) =>
  Effect.gen(function* () {
    if (event.partitionKey !== `${event.organizationId}:operation:${payload.operationId}`) {
      return yield* new RequestValidationError({
        message: 'Lifecycle queue partition does not match the operation',
      })
    }
    const reconciliation = yield* WorkflowStartReconciliationRepository
    const authoritative = yield* reconciliation
      .load({
        organizationId: event.organizationId,
        operationId: payload.operationId,
        workflowStartRecordId: payload.workflowStartRecordId,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === 'PersistenceError'
            ? error
            : new RequestValidationError({
                message: 'Lifecycle Workflow start event does not match durable state',
              }),
        ),
      )
    if (
      authoritative.operation.organizationId !== event.organizationId ||
      authoritative.operation.resourceId !== payload.resourceId ||
      authoritative.operation.action !== payload.action ||
      authoritative.reservation.resourceKind !== payload.resourceKind
    ) {
      return yield* new RequestValidationError({
        message: 'Lifecycle Workflow start payload does not match durable state',
      })
    }
    if (authoritative.workflowStart.state === 'started') {
      return {
        status: 'replayed' as const,
        operationId: authoritative.operation.id,
        workflowState: 'started' as const,
      }
    }
    const repository = yield* LifecycleRepository
    const starter = yield* WorkflowStarter
    const started = yield* Effect.result(
      starter.start({
        workflowInstanceId: authoritative.operation.id,
        startRecordId: authoritative.workflowStart.id,
        operation: authoritative.operation,
        reservation: authoritative.reservation,
      }),
    )
    if (started._tag === 'Failure') {
      yield* repository.recordWorkflowStartFailure(
        authoritative.operation.organizationId,
        authoritative.operation.id,
        started.failure.message,
      )
      return yield* new LifecyclePersistenceError({
        operation: 'lifecycle.workflow-start.reconcile',
        message: 'Workflow start remains pending reconciliation',
      })
    }
    yield* repository.markWorkflowStarted(
      authoritative.operation.organizationId,
      authoritative.operation.id,
    )
    return {
      status: 'applied' as const,
      operationId: authoritative.operation.id,
      workflowState: 'started' as const,
    }
  })

app.post('/v1/internal/queue-events', async (context) => {
  const queue = context.req.header('x-gridora-queue')
  const decoded = await Effect.runPromise(
    Effect.result(
      parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(InternalQueueEventBody, value)),
      ),
    ),
  )
  if (decoded._tag === 'Failure')
    return problemResponse({
      status: 400,
      problem: {
        type: 'https://errors.gridora.example/invalid-queue-event',
        title: 'Invalid queue event',
        status: 400,
        code: 'INVALID_QUEUE_EVENT',
        detail: 'The queue event does not match the contract',
        requestId: requestIdFromContext(context),
        retryable: false,
        fields: [],
      },
    })
  const event = decoded.success
  if (context.req.header('x-gridora-organization-id') !== event.organizationId) {
    return problemResponse({
      status: 400,
      problem: {
        type: 'https://errors.gridora.example/queue-routing-mismatch',
        title: 'Queue routing mismatch',
        status: 400,
        code: 'QUEUE_ROUTING_MISMATCH',
        detail: 'The signed organization routing header does not match the event',
        requestId: requestIdFromContext(context),
        retryable: false,
        fields: [],
      },
    })
  }
  const isOutboxEvent =
    queue === 'gridora-outbox' && event.partitionKey.startsWith(`${event.organizationId}:`)
  const isReconciliation =
    queue === 'gridora-reconciliation' &&
    event.type === 'reconciliation.scheduled' &&
    event.partitionKey === `${event.organizationId}:reconciliation`
  if (!isOutboxEvent && !isReconciliation) {
    return notImplemented(context, 'Queue event application')
  }
  if (queue === 'gridora-outbox' && event.type === 'lifecycle.workflow-start.requested') {
    const payload = await Effect.runPromise(
      Effect.result(
        Schema.decodeUnknownEffect(LifecycleWorkflowStartRequestedPayload, {
          onExcessProperty: 'error',
        })(event.payload),
      ),
    )
    if (payload._tag === 'Failure')
      return problemResponse({
        status: 400,
        problem: {
          type: 'https://errors.gridora.example/invalid-lifecycle-workflow-start-event',
          title: 'Invalid lifecycle Workflow start event',
          status: 400,
          code: 'INVALID_LIFECYCLE_WORKFLOW_START_EVENT',
          detail: 'The lifecycle Workflow start payload does not match the contract',
          requestId: requestIdFromContext(context),
          retryable: false,
          fields: [],
        },
      })
    const requestId = requestIdFromContext(context)
    const recovered = await runtimeFor(context.env).run(
      recoverLifecycleWorkflowStart(event, payload.success),
      requestId,
    )
    return 'problem' in Object(recovered)
      ? problemResponse(recovered as HttpFailure)
      : jsonResponse(recovered)
  }
  if (queue === 'gridora-outbox' && event.type === 'agent.command.sealed') {
    const decodedCommand = await Effect.runPromise(
      Effect.result(decodeTunnelCredentialAgentCommand(event.payload)),
    )
    if (decodedCommand._tag === 'Failure')
      return problemResponse(
        problemFromError(
          new RequestValidationError({
            message: 'The sealed agent command does not match the contract',
          }),
          requestIdFromContext(context),
        ),
      )
    const command = decodedCommand.success
    if (
      command.organizationId !== event.organizationId ||
      event.partitionKey !==
        `${event.organizationId}:tunnel_credential_delivery:${command.commandId}`
    )
      return problemResponse(
        problemFromError(
          new RequestValidationError({
            message: 'The sealed agent command routing does not match durable scope',
          }),
          requestIdFromContext(context),
        ),
      )
    const authoritativeResult = await Effect.runPromise(
      Effect.result(
        loadTunnelDeliveryById(context.env.DB, event.organizationId, command.commandId),
      ),
    )
    if (authoritativeResult._tag === 'Failure')
      return problemResponse(
        problemFromError(authoritativeResult.failure, requestIdFromContext(context)),
      )
    const authoritative = authoritativeResult.success
    if (
      authoritative.command === null ||
      authoritative.operationId !== command.operationId ||
      authoritative.nodeId !== command.nodeId ||
      authoritative.tunnelId !== command.resourceId ||
      authoritative.command.signature !== command.signature ||
      canonicalCommandPayload(authoritative.command) !== canonicalCommandPayload(command)
    )
      return problemResponse(
        problemFromError(
          new RequestValidationError({
            message: 'The sealed agent command does not match durable state',
          }),
          requestIdFromContext(context),
        ),
      )
    const coordinator = context.env.NODE_COORDINATOR.getByName(
      `${command.organizationId}:${command.nodeId}`,
    )
    const delivered = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => coordinator.enqueue(command),
            catch: () =>
              new ConflictError({
                code: 'node_coordinator_unavailable',
                message: 'The agent command could not be queued',
              }),
          })
          return yield* markTunnelCommandDelivered(
            context.env.DB,
            command.organizationId,
            command,
            event.occurredAt,
          )
        }),
      ),
    )
    if (delivered._tag === 'Failure')
      return problemResponse(problemFromError(delivered.failure, requestIdFromContext(context)))
    return context.json(
      { status: delivered.success, eventId: event.id, commandId: command.commandId },
      200,
    )
  }
  const events = context.env.ORGANIZATION_EVENTS.getByName(`${event.organizationId}:events`)
  await events.initialize(event.organizationId)
  const applied = await events.publish({
    id: event.id,
    organizationId: event.organizationId,
    type: event.type,
    occurredAt: event.occurredAt,
    data: event.payload,
  })
  return context.json({ status: applied ? 'applied' : 'replayed', eventId: event.id }, 200)
})

app.post(
  '/v1/agent/registrations/exchange',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(AgentRegistrationExchangeBody, value)),
      )
      const installerKey = yield* validateInstallerPublicKey(body.installerPublicKey).pipe(
        Effect.mapError(
          () => new RequestValidationError({ message: 'The installer public key is invalid' }),
        ),
      )
      const tokenHash = yield* sha256(body.registrationToken)
      const organizationId = yield* decode(OrganizationId, body.organizationId)
      const candidates = yield* deriveNodeCredentialCandidates(
        context.env.NODE_CREDENTIAL_SECRET,
        context.env.NODE_CREDENTIAL_SECRET_PREVIOUS,
        tokenHash,
        organizationId,
        body.nodeId,
        body.providerInstanceId,
      )
      const exchangeTime = yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now))
      const repository = machineAuditRepositoryFor(context)
      let accepted:
        | {
            readonly derived: (typeof candidates)[number]
            readonly principal: AgentMachinePrincipal
          }
        | undefined
      let rejected: ConflictError | PersistenceError | undefined
      for (const derived of candidates) {
        const attempt = yield* Effect.result(
          repository
            .exchange({
              tokenHash,
              organizationId,
              nodeId: body.nodeId,
              providerInstanceId: body.providerInstanceId,
              credentialId: derived.credentialId,
              credentialHash: yield* sha256(derived.credential),
              agentVersion: body.agentVersion,
              installerPublicKey: installerKey.publicKey,
              installerPublicKeyFingerprint: installerKey.fingerprint,
              now: exchangeTime,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === 'AgentMachineAuditConflictError'
                  ? new ConflictError({
                      code: 'registration_exchange_rejected',
                      message: 'Registration exchange failed',
                    })
                  : new PersistenceError({
                      operation: error.operation,
                      message: 'The registration exchange could not be persisted',
                    }),
              ),
            ),
        )
        if (attempt._tag === 'Success') {
          accepted = { derived, principal: attempt.success }
          break
        }
        rejected = attempt.failure
      }
      if (accepted === undefined) {
        if (rejected !== undefined) return yield* rejected
        return yield* new ConflictError({
          code: 'registration_exchange_rejected',
          message: 'Registration exchange failed',
        })
      }
      const { derived, principal } = accepted
      const coordinator = context.env.NODE_COORDINATOR.getByName(
        `${principal.organizationId}:${principal.nodeId}`,
      )
      yield* Effect.tryPromise({
        try: () =>
          coordinator.initialize(
            principal.organizationId,
            principal.nodeId,
            principal.sessionVersion,
          ),
        catch: () =>
          new ConflictError({
            code: 'node_coordinator_unavailable',
            message: 'The node session could not be initialized',
          }),
      })
      return jsonResponse({
        nodeCredential: derived.credential,
        credentialId: principal.credentialId,
        credentialVersion: principal.version,
        sessionVersion: principal.sessionVersion,
        registrationTokenConsumed: true,
      })
    }),
  ),
)

app.post(
  '/v1/agent/registrations/revoke',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const principal = yield* agentCredential(context)
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(AgentRegistrationRevokeBody, value)),
      )
      if (body.organizationId !== principal.organizationId || body.nodeId !== principal.nodeId) {
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'The node credential is not valid for this registration token',
        })
      }
      yield* machineAuditRepositoryFor(context)
        .revokeRegistrationToken(
          principal,
          yield* sha256(body.registrationToken),
          yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now)),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === 'AgentMachineAuditConflictError'
              ? new ConflictError({
                  code: 'registration_token_revoke_rejected',
                  message: 'The registration token does not match this node',
                })
              : new PersistenceError({
                  operation: error.operation,
                  message: 'The registration token could not be revoked',
                }),
          ),
        )
      return new Response(null, { status: 204 })
    }),
  ),
)

registerBackupAgentUploadRoutes(app, {
  runtimeFor,
  authenticate: agentCredential,
  transport: () => BackupR2Transport,
  claimUpload: (bindings, input) =>
    Effect.gen(function* () {
      const claimedAt = yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now))
      const claimedAtMs = Date.parse(claimedAt)
      return yield* claimBackupUploadSession(bindings.DB, {
        ...input,
        now: claimedAt,
        leaseExpiresAt: new Date(claimedAtMs + 10 * 60_000).toISOString(),
        uploadWatchUntil: new Date(claimedAtMs + 20 * 60_000).toISOString(),
      })
    }),
  validateUpload: (bindings, input) =>
    ApplicationClock.pipe(
      Effect.flatMap((service) => service.now),
      Effect.flatMap((publicationAt) =>
        validateBackupUploadSession(bindings.DB, { ...input, now: publicationAt }),
      ),
    ),
  publishUploadObject: (bindings, authority) =>
    makeBackupUploadObjectPublisher(
      bindings,
      authority,
      ApplicationClock.pipe(Effect.flatMap((service) => service.now)),
    ),
  acceptUpload: (bindings, input) =>
    ApplicationClock.pipe(
      Effect.flatMap((service) => service.now),
      Effect.flatMap((acceptedAt) =>
        acceptBackupUploadSession(bindings.DB, { ...input, now: acceptedAt }),
      ),
    ),
  closeUpload: (bindings, input) =>
    ApplicationClock.pipe(
      Effect.flatMap((service) => service.now),
      Effect.flatMap((closedAt) =>
        closeBackupUploadSession(bindings.DB, {
          ...input,
          reason: 'request-failed',
          now: closedAt,
        }),
      ),
    ),
  authorizeRestore: (bindings, input) =>
    loadBackupWorkflowState(bindings.DB, input.organizationId, input.operationId).pipe(
      Effect.flatMap(({ job }) =>
        job.mode === 'restore' &&
        job.backupId === input.backupId &&
        job.sourceServerId === input.sourceServerId &&
        job.targetServerId === input.targetServerId &&
        job.targetNodeId === input.targetNodeId &&
        (job.state === 'reserved' || job.state === 'running' || job.state === 'waiting_external')
          ? Effect.void
          : Effect.fail(
              new PersistenceError({
                operation: 'backup.agent-restore.authority',
                message: 'The restore request does not match the accepted operation',
              }),
            ),
      ),
    ),
})

app.get(
  '/v1/agent/nodes/:nodeId/commands',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const principal = yield* agentCredential(context)
      if (routeParam(context, 'nodeId') !== principal.nodeId) {
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'The node credential is not valid for this node',
        })
      }
      const waitSeconds = Number(context.req.query('waitSeconds') ?? '1')
      if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 30) {
        return yield* new RequestValidationError({
          message: 'waitSeconds must be an integer from 1 through 30',
        })
      }
      const coordinator = context.env.NODE_COORDINATOR.getByName(
        `${principal.organizationId}:${principal.nodeId}`,
      )
      const command = yield* Effect.tryPromise({
        try: async (): Promise<AgentCommand | null> =>
          coordinator.waitForCommand(principal.organizationId, principal.nodeId, waitSeconds),
        catch: () =>
          new ConflictError({
            code: 'node_coordinator_unavailable',
            message: 'Commands could not be read',
          }),
      })
      return command === null ? new Response(null, { status: 204 }) : jsonResponse(command)
    }),
  ),
)

app.post(
  '/v1/agent/nodes/:nodeId/commands/:commandId/result',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const principal = yield* agentCredential(context)
      if (routeParam(context, 'nodeId') !== principal.nodeId) {
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'The node credential is not valid for this node',
        })
      }
      const result = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(CommandResult, value)),
      )
      if (result.commandId !== routeParam(context, 'commandId')) {
        return yield* new RequestValidationError({
          message: 'Command result does not match the route',
        })
      }
      const coordinator = context.env.NODE_COORDINATOR.getByName(
        `${principal.organizationId}:${principal.nodeId}`,
      )
      const outcome = yield* Effect.tryPromise({
        try: () =>
          coordinator.acceptCommandResult(principal.organizationId, principal.nodeId, result),
        catch: () =>
          new ConflictError({
            code: 'node_coordinator_unavailable',
            message: 'The command result could not be recorded',
          }),
      })
      if (!outcome.accepted && !outcome.replayed) {
        return yield* new ConflictError({
          code: 'command_result_rejected',
          message: 'The command is not queued for this node',
        })
      }
      // The coordinator is the authoritative proof that the command was queued
      // for this exact node. Once it accepts or replays, commit the D1 delivery
      // transition, terminal machine operation, v1 envelope, and receipt as one
      // atomic unit. A lost response replays both durable receipts without a
      // second delivery acknowledgement.
      yield* machineAuditRepositoryFor(context)
        .recordCommandResult({
          principal,
          result,
          acceptedAt: yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now)),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === 'AgentMachineAuditConflictError'
              ? new ConflictError({
                  code: 'command_result_rejected',
                  message: 'The command result no longer matches accepted delivery state',
                })
              : new PersistenceError({
                  operation: error.operation,
                  message: 'The command result could not be persisted',
                }),
          ),
        )
      return jsonResponse({
        accepted: outcome.accepted,
        duplicate: outcome.replayed,
        watermark: outcome.lastSequence,
      })
    }),
  ),
)

app.post(
  '/v1/agent/events',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const principal = yield* agentCredential(context)
      const body = yield* parseJson(context.req.raw)
      const control = yield* agentObservationControlFor(context)
      const receipt = yield* control.ingest(principal, body).pipe(
        Effect.mapError((error) => {
          if (error instanceof AgentObservationValidationError)
            return new RequestValidationError({
              message: 'The agent observation does not match the API contract',
            })
          if (error instanceof AgentObservationAuthenticationError)
            return new AuthorizationError({
              code: 'membership_required',
              message: 'The node credential is not valid for this observation',
            })
          if (error instanceof AgentObservationConflictError)
            return new ConflictError({
              code: 'agent_observation_rejected',
              message: 'The agent observation is stale or out of order',
            })
          if (error instanceof AgentObservationPersistenceError)
            return new PersistenceError({
              operation: error.operation,
              message: 'The agent observation could not be persisted',
            })
          return error
        }),
      )
      return jsonResponse(receipt)
    }),
  ),
)

app.get(
  '/v1/me',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      return jsonResponse(identity)
    }),
  ),
)

app.get(
  '/v1/me/session',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const claims = context.get('accessClaims')
      const identity = yield* accessIdentity(claims)
      return context.json(
        {
          provider: 'cloudflare-access' as const,
          identity,
          subject: claims.sub,
          email: claims.email,
          issuer: claims.iss,
          issuedAt: claims.iat ?? null,
          expiresAt: claims.exp,
          management: {
            authority: 'cloudflare-access' as const,
            localSessionStorage: false as const,
            canEnumerateOtherSessions: false as const,
            signOutPath: '/cdn-cgi/access/logout' as const,
          },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    }),
  ),
)

app.get(
  '/v1/me/organizations',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const memberships = yield* OrganizationMembershipRepository
      const organizations = yield* OrganizationRepository
      const rows = yield* memberships.listForIdentity(identity.id)
      return jsonResponse(
        yield* Effect.forEach(rows, (membership) =>
          organizations
            .getById(membership.organizationId)
            .pipe(Effect.map((organization) => ({ organization, role: membership.role }))),
        ),
      )
    }),
  ),
)

app.post(
  '/v1/organizations',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const clientKey = context.req.header('idempotency-key')
      if (clientKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) =>
          decode(CreateOrganizationInput, { ...(value as object), idempotencyKey: clientKey }),
        ),
      )
      if (
        (input.budgetWarningThresholdMinor === undefined) !==
        (input.budgetWarningCurrency === undefined)
      ) {
        return yield* new RequestValidationError({
          message:
            'Budget warning threshold minor units and ISO 4217 currency must be provided together',
        })
      }
      const service = yield* OrganizationService
      const organizationId = yield* canonicalCreateResourceId(
        'platform',
        identity.id,
        'organization.create',
        'org',
        clientKey,
      )
      const created = yield* service.create(
        identity,
        input,
        yield* platformCoreMutationRequest(
          context,
          identity.id,
          'organization.create',
          'organization',
          organizationId,
          input,
        ),
      )
      context.executionCtx.waitUntil(
        context.env.OUTBOX_WAKEUPS.send({
          reason: 'organization-created',
          organizationId: created.organization.id,
        }),
      )
      return jsonResponse(
        {
          operationId: created.operationId,
          resourceId: created.organization.id,
          status: 'succeeded',
          links: { operation: `/v1/platform/operations/${created.operationId}` },
        },
        201,
      )
    }),
  ),
)

app.get(
  '/v1/organizations/:organization',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
      )
      const organizations = yield* OrganizationRepository
      return jsonResponse(yield* organizations.getForContext(authorized))
    }),
  ),
)

const inventoryPage = (context: HonoContext<AppEnv>) =>
  decode(InventoryPageRequest, {
    limit: Number(context.req.query('limit') ?? '50'),
    ...(context.req.query('cursor') === undefined ? {} : { cursor: context.req.query('cursor') }),
  })

const inventoryContext = (
  context: HonoContext<AppEnv>,
  minimumRole: 'viewer' | 'operator' | 'administrator' | 'owner' = 'viewer',
) =>
  Effect.gen(function* () {
    const identity = yield* accessIdentity(context.get('accessClaims'))
    return yield* authorizeOrganization(
      identity,
      routeParam(context, 'organization'),
      yield* correlationId(context),
      minimumRole,
    )
  })

/**
 * Mutation controls that persist an Access membership fence receive the
 * revision read at the HTTP edge. Their D1 acceptance repeats it atomically.
 */
const mutationContext = (
  context: HonoContext<AppEnv>,
  minimumRole: 'viewer' | 'operator' | 'administrator' | 'owner',
) =>
  Effect.gen(function* () {
    const actor = yield* inventoryContext(context, minimumRole)
    const memberships = yield* OrganizationMembershipRepository
    const membership = yield* memberships.get(actor.organizationId, actor.identityId)
    if (
      membership.status !== 'active' ||
      membership.organizationId !== actor.organizationId ||
      membership.identityId !== actor.identityId
    )
      return yield* new AuthorizationError({
        code: 'membership_required',
        message: 'Active organization membership is required',
      })
    return {
      organizationId: actor.organizationId,
      organizationSlug: actor.organizationSlug,
      identityId: actor.identityId,
      role: actor.role,
      correlationId: actor.correlationId,
      membershipRevision: membership.revision,
    }
  })

app.delete(
  '/v1/organizations/:organization',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* mutationContext(context, 'owner')
      const idempotencyKey = context.req.header('idempotency-key')
      if (idempotencyKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      yield* decode(IdempotencyKey, idempotencyKey)
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(DeleteOrganizationBody, value)),
      )
      if (body.typedSlug !== authorized.organizationSlug)
        return yield* new ConflictError({
          code: 'organization_confirmation_mismatch',
          message: 'The typed organization slug does not match the authorized organization',
        })
      const accepted = yield* beginOrganizationDeletion(
        context.env,
        auditRequestContextFor(context),
        {
          organizationId: authorized.organizationId,
          actorId: authorized.identityId,
          role: 'owner',
          correlationId: authorized.correlationId,
          idempotencyKey,
          expectedOrganizationRevision: body.expectedOrganizationRevision,
          typedSlug: body.typedSlug,
          backupPolicy: body.backupPolicy,
        },
      ).pipe(
        Effect.mapError(
          () =>
            new ConflictError({
              code: 'organization_deletion_rejected',
              message: 'Organization deletion could not be accepted or started',
            }),
        ),
      )
      return jsonResponse(accepted, 202)
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/invitations/:invitation/actions/resend',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(ResendInvitationInput, value)),
      )
      const invitationId = yield* decode(InvitationId, routeParam(context, 'invitation'))
      const service = yield* OrganizationService
      const result = yield* service.resendInvitation(
        authorized,
        invitationId,
        body.expectedRevision,
        body.expiresAt,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.invitation.resend',
          'organization_invitation',
          invitationId,
          body,
        ),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/operations/:id/actions/cancel',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      const idempotencyKey = context.req.header('idempotency-key')
      if (idempotencyKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      yield* decode(IdempotencyKey, idempotencyKey)
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(CancelOperationBody, value)),
      )
      const cancellation = yield* makeCancellationControl(context.env)
        .cancelOperation({
          organizationId: authorized.organizationId,
          actorId: authorized.identityId,
          role: authorized.role,
          correlationId: authorized.correlationId,
          idempotencyKey,
          operationId: routeParam(context, 'id'),
          expectedOperationRevision: body.expectedOperationRevision,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConflictError({
                code: 'operation_cancellation_rejected',
                message: 'The operation cancellation could not be accepted or delivered',
              }),
          ),
        )
      return jsonResponse(cancellation, 202)
    }),
  ),
)

const startBackupWorkflow = (
  env: ApiBindings,
  actor: OrganizationContext,
  job: BackupJob,
): Effect.Effect<void, BackupPersistenceError> =>
  Effect.tryPromise({
    try: async () => {
      const binding = job.mode === 'create' ? env.BACKUP_GAME_SERVER : env.RESTORE_GAME_SERVER
      const resourceId = job.mode === 'create' ? job.sourceServerId : (job.targetServerId ?? '')
      if (resourceId.length === 0) throw new Error('backup Workflow target is unavailable')
      const params: WorkflowPayload = {
        operationId: job.operationId,
        organizationId: job.organizationId,
        resourceId,
        resourceType: 'game-server',
        actorId: actor.identityId,
        correlationId: actor.correlationId,
        idempotencyKey: job.idempotencyKey,
        input: {
          backupJobId: job.id,
          backupId: job.backupId,
          mode: job.mode,
          acceptedAt: job.createdAt,
        },
      }
      let instance: { readonly id: string }
      try {
        instance = await binding.create({ id: job.operationId, params })
      } catch {
        instance = await binding.get(job.operationId)
      }
      if (instance.id !== job.operationId) throw new Error('backup Workflow identity mismatch')
      const startRecordId = `workflow-start:${job.operationId}`
      const outcome = await env.DB.prepare(`UPDATE lifecycle_workflow_starts
        SET state = 'started', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE organization_id = ? AND operation_id = ? AND start_record_id = ?
          AND state IN ('pending', 'started')
          AND EXISTS (
            SELECT 1 FROM backup_jobs job
            WHERE job.organization_id = ? AND job.operation_id = ? AND job.id = ?
          )`)
        .bind(
          new Date().toISOString(),
          job.organizationId,
          job.operationId,
          startRecordId,
          job.organizationId,
          job.operationId,
          job.id,
        )
        .run()
      if (!outcome.success || (outcome.meta.changes ?? 0) !== 1)
        throw new Error('backup Workflow start evidence was not persisted')
    },
    catch: () => new BackupPersistenceError({ operation: 'backup.workflow.start' }),
  })

const startingBackupControl = (
  env: ApiBindings,
  control: BackupControlShape,
): BackupControlShape => ({
  ...control,
  create: (actor, input) =>
    control
      .create(actor, input)
      .pipe(Effect.tap((reservation) => startBackupWorkflow(env, actor, reservation.job))),
  restore: (actor, input) =>
    control
      .restore(actor, input)
      .pipe(Effect.tap((reservation) => startBackupWorkflow(env, actor, reservation.job))),
})

type GameMovePayload = Parameters<GameMoveBackupAdapter['backupSource']>[0]

const gameMoveFailure = (code: string, message: string) =>
  new GameWorkflowStepError({ code, message })

const makeInternalMoveActor = (env: ApiBindings, payload: GameMovePayload) =>
  Effect.gen(function* () {
    const organizationId = yield* decode(OrganizationId, payload.organizationId)
    const identityId = yield* decode(IdentityId, payload.actorId)
    const correlationId = yield* decode(CorrelationId, payload.operationId)
    const organization = yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare('SELECT slug FROM organizations WHERE id = ?')
          .bind(payload.organizationId)
          .first<{ readonly slug: string }>(),
      catch: () => new Error('move organization authority is unavailable'),
    })
    if (organization === null)
      return yield* gameMoveFailure(
        'move-organization-missing',
        'move organization authority is unavailable',
      )
    const organizationSlug = yield* decode(OrganizationSlug, organization.slug)
    const auditRequestContext: AuditRequestContextValue = {
      origin: 'internal',
      requestId: `workflow:${payload.operationId}`,
      correlationId: payload.operationId,
      source: {
        ip: { state: 'not-available', reason: 'internal-workflow-has-no-network-source' },
        access: { state: 'not-available', reason: 'internal-workflow-has-no-access-assertion' },
      },
    }
    return new OrganizationContextValue({
      organizationId,
      organizationSlug,
      identityId,
      role: 'operator',
      correlationId,
      auditRequestContext,
    } as OrganizationContext & { readonly auditRequestContext: AuditRequestContextValue })
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GameWorkflowStepError
        ? error
        : gameMoveFailure('move-actor-invalid', String(error)),
    ),
  )

const loadMoveBackupJob = (env: ApiBindings, organizationId: string, operationId: string) =>
  loadBackupWorkflowState(env.DB, organizationId, operationId).pipe(
    Effect.mapError(() =>
      gameMoveFailure('backup-state-unavailable', 'native backup Workflow state is unavailable'),
    ),
  )

const loadMoveBackupJobByKey = (
  env: ApiBindings,
  organizationId: string,
  idempotencyKey: string,
  mode: 'create' | 'restore',
) =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(`SELECT operation_id AS operationId
      FROM backup_jobs WHERE organization_id = ? AND idempotency_key = ? AND mode = ?`)
          .bind(organizationId, idempotencyKey, mode)
          .first<{ readonly operationId: string }>(),
      catch: () => new Error('native backup idempotency state is unavailable'),
    })
    if (row === null || row.operationId.length === 0)
      return yield* gameMoveFailure(
        'backup-state-unavailable',
        'native backup idempotency state is unavailable',
      )
    return yield* loadMoveBackupJob(env, organizationId, row.operationId)
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GameWorkflowStepError
        ? error
        : gameMoveFailure(
            'backup-state-unavailable',
            'native backup idempotency state is unavailable',
          ),
    ),
  )

const requireSucceededBackupJobByKey = (
  env: ApiBindings,
  organizationId: string,
  idempotencyKey: string,
  mode: 'create' | 'restore',
) =>
  Effect.gen(function* () {
    const loaded = yield* loadMoveBackupJobByKey(env, organizationId, idempotencyKey, mode)
    if (loaded.job.state === 'succeeded') return loaded
    if (
      loaded.job.state === 'failed' ||
      loaded.job.state === 'failed_terminal' ||
      loaded.job.state === 'cancelled'
    )
      return yield* gameMoveFailure(
        'backup-failed',
        'native backup Workflow reached a terminal failure',
      )
    return yield* gameMoveFailure(
      'backup-pending',
      'native backup Workflow has not produced terminal evidence',
    )
  })

const requireSucceededBackupJob = (env: ApiBindings, organizationId: string, operationId: string) =>
  Effect.gen(function* () {
    const loaded = yield* loadMoveBackupJob(env, organizationId, operationId)
    if (loaded.job.state === 'succeeded') return loaded
    if (
      loaded.job.state === 'failed' ||
      loaded.job.state === 'failed_terminal' ||
      loaded.job.state === 'cancelled'
    )
      return yield* gameMoveFailure(
        'backup-failed',
        'native backup Workflow reached a terminal failure',
      )
    return yield* gameMoveFailure(
      'backup-pending',
      'native backup Workflow has not produced terminal evidence',
    )
  })

const makeNativeGameMoveBackupAdapter = (
  env: ApiBindings,
  control: BackupControlShape,
): Effect.Effect<GameMoveBackupAdapter, GameWorkflowStepError> => {
  const wrapped = startingBackupControl(env, control)
  const actor = (payload: GameMovePayload) => makeInternalMoveActor(env, payload)
  return Effect.succeed({
    backupSource: (payload) =>
      Effect.gen(function* () {
        const context = yield* actor(payload)
        const reservation = yield* wrapped
          .create(context, {
            serverId: payload.serverId,
            idempotencyKey: `${payload.action === 'move' ? 'game-move' : 'game-lifecycle'}:${payload.operationId}:backup`,
            intent: {
              schemaVersion: 1,
              includes: ['config', 'data', 'mods', 'state'],
              expiresAt: null,
            },
          })
          .pipe(
            Effect.mapError(() =>
              gameMoveFailure(
                'backup-reservation-failed',
                'native source backup could not be reserved',
              ),
            ),
          )
        const loaded = yield* requireSucceededBackupJob(
          env,
          payload.organizationId,
          reservation.job.operationId,
        )
        return { backupId: loaded.job.backupId, sourcePreserved: true as const }
      }),
    restoreTarget: (payload, backupId) =>
      Effect.gen(function* () {
        if (payload.targetNodeId === undefined)
          return yield* gameMoveFailure(
            'move-target-missing',
            'native restore requires the reserved target node',
          )
        const context = yield* actor(payload)
        const reservation = yield* wrapped
          .restore(context, {
            idempotencyKey: `game-move:${payload.operationId}:restore`,
            intent: {
              schemaVersion: 1,
              backupId,
              targetServerId: payload.serverId,
              targetNodeId: payload.targetNodeId,
            },
          })
          .pipe(
            Effect.mapError(() =>
              gameMoveFailure(
                'restore-reservation-failed',
                'native target restore could not be reserved',
              ),
            ),
          )
        const loaded = yield* requireSucceededBackupJob(
          env,
          payload.organizationId,
          reservation.job.operationId,
        )
        const cutover = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT state, source_preserved AS sourcePreserved
          FROM backup_restore_cutovers WHERE organization_id = ? AND job_id = ?`)
              .bind(payload.organizationId, loaded.job.id)
              .first<{ readonly state: string; readonly sourcePreserved: number }>(),
          catch: () => new Error('native restore cutover evidence is unavailable'),
        }).pipe(
          Effect.mapError(() =>
            gameMoveFailure(
              'restore-state-unavailable',
              'native restore cutover evidence is unavailable',
            ),
          ),
        )
        if (cutover === null || cutover.state !== 'committed' || cutover.sourcePreserved !== 1)
          return yield* gameMoveFailure(
            'restore-evidence-missing',
            'native restore has no committed source-preserving cutover',
          )
        return { restored: true as const }
      }),
    verifyTarget: (payload, backupId) =>
      Effect.gen(function* () {
        const loaded = yield* requireSucceededBackupJobByKey(
          env,
          payload.organizationId,
          `game-move:${payload.operationId}:restore`,
          'restore',
        )
        if (loaded.job.backupId !== backupId || loaded.job.mode !== 'restore')
          return yield* gameMoveFailure(
            'restore-scope-mismatch',
            'native restore evidence is not bound to the move backup',
          )
        return { validated: true as const }
      }),
    cutoverEndpoint: (payload, backupId) =>
      Effect.gen(function* () {
        const loaded = yield* requireSucceededBackupJobByKey(
          env,
          payload.organizationId,
          `game-move:${payload.operationId}:restore`,
          'restore',
        )
        if (loaded.job.backupId !== backupId || loaded.job.mode !== 'restore')
          return yield* gameMoveFailure(
            'cutover-scope-mismatch',
            'native restore endpoint evidence is not bound to the move backup',
          )
        const cutover = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT state, source_preserved AS sourcePreserved
          FROM backup_restore_cutovers WHERE organization_id = ? AND job_id = ?`)
              .bind(payload.organizationId, loaded.job.id)
              .first<{ readonly state: string; readonly sourcePreserved: number }>(),
          catch: () => new Error('native endpoint cutover evidence is unavailable'),
        }).pipe(
          Effect.mapError(() =>
            gameMoveFailure(
              'cutover-state-unavailable',
              'native endpoint cutover evidence is unavailable',
            ),
          ),
        )
        if (cutover === null || cutover.state !== 'committed' || cutover.sourcePreserved !== 1)
          return yield* gameMoveFailure(
            'cutover-evidence-missing',
            'native restore endpoint cutover is not committed',
          )
        return { cutover: true as const, sourcePreserved: true as const }
      }),
    rollback: (payload, backupId) =>
      Effect.gen(function* () {
        const loaded = yield* loadMoveBackupJobByKey(
          env,
          payload.organizationId,
          `game-move:${payload.operationId}:restore`,
          'restore',
        )
        if (loaded.job.backupId !== backupId || loaded.job.mode !== 'restore')
          return yield* gameMoveFailure(
            'rollback-scope-mismatch',
            'rollback evidence is not bound to the move backup',
          )
        if (
          loaded.job.state === 'failed' ||
          loaded.job.state === 'failed_terminal' ||
          loaded.job.state === 'cancelled'
        )
          return yield* gameMoveFailure(
            'rollback-evidence-missing',
            'native restore failed before source-preserving evidence',
          )
        return { rolledBack: true as const, sourcePreserved: true as const }
      }),
  } satisfies GameMoveBackupAdapter)
}

const makeGameCloudflareApi = (env: ApiBindings): CloudflareApiShape | undefined => {
  if (env.CLOUDFLARE_DNS_API_TOKEN === undefined || env.CLOUDFLARE_DNS_ZONE_ID === undefined)
    return undefined
  return {
    request: (input) =>
      Effect.tryPromise({
        try: async () => {
          const token = await env.CLOUDFLARE_DNS_API_TOKEN!.get()
          const response = await fetch(`https://api.cloudflare.com/client/v4${input.path}`, {
            method: input.method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          })
          const body: unknown = await response.json()
          if (!response.ok)
            throw new Error(`Cloudflare DNS control returned HTTP ${response.status}`)
          return body
        },
        catch: (cause) =>
          new CloudflareControlError({
            operation: `dns.${input.method.toLowerCase()}`,
            message: cause instanceof Error ? cause.message : 'Cloudflare DNS request failed',
            retryable: true,
          }),
      }),
  }
}

registerGameLifecycleRoutes(app, {
  runtimeFor,
  authorize: inventoryContext,
  auditRequestContext: auditRequestContextFor,
  repository: () => GameLifecycleD1Repository,
  planning: () => GameLifecyclePlanningD1,
  workflow: (bindings, action) => {
    switch (action) {
      case 'create':
        return lifecycleBinding(bindings.DEPLOY_GAME_SERVER)
      case 'delete':
        return lifecycleBinding(bindings.DELETE_GAME_SERVER)
      case 'start':
        return optionalLifecycleBinding(bindings.START_GAME_SERVER)
      case 'stop':
        return optionalLifecycleBinding(bindings.STOP_GAME_SERVER)
      case 'restart':
        return optionalLifecycleBinding(bindings.RESTART_GAME_SERVER)
      case 'update':
        return lifecycleBinding(bindings.UPDATE_GAME_SERVER)
      case 'apply-config':
        return lifecycleBinding(bindings.APPLY_GAME_CONFIG)
      case 'sync-mods':
        return lifecycleBinding(bindings.SYNC_MODS)
      case 'move':
        return lifecycleBinding(bindings.MOVE_GAME_SERVER)
    }
  },
})

registerBackupRoutes(app, {
  runtimeFor,
  authorize: (context, minimumRole) =>
    inventoryContext(context, minimumRole).pipe(
      Effect.map(
        (actor) =>
          ({
            organizationId: actor.organizationId,
            organizationSlug: actor.organizationSlug,
            identityId: actor.identityId,
            role: actor.role,
            correlationId: actor.correlationId,
            auditRequestContext: auditRequestContextFor(context),
          }) as OrganizationContext & { readonly auditRequestContext: AuditRequestContextValue },
      ),
    ),
  control: (bindings) =>
    BackupControl.pipe(Effect.map((control) => startingBackupControl(bindings, control))),
})

const ScheduledBackupDispatch = Schema.Struct({
  organizationId: Schema.String,
  scheduleId: Schema.String,
  serverId: Schema.String,
  scheduledFor: IsoDateTime,
  scheduleRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  retentionDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
  claimId: Schema.String,
  actorId: Schema.String,
})

app.post(
  '/v1/internal/scheduled-backups/dispatch',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(ScheduledBackupDispatch, value)),
      )
      if (context.req.header('x-gridora-organization-id') !== input.organizationId)
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'Scheduled backup organization routing does not match',
        })
      const exact = yield* Effect.tryPromise({
        try: () =>
          context.env.DB.prepare(`SELECT organization.slug AS organizationSlug
          FROM backup_schedule_dispatches dispatch
          JOIN backup_schedules schedule ON schedule.organization_id = dispatch.organization_id
            AND schedule.id = dispatch.schedule_id
          JOIN organizations organization ON organization.id = dispatch.organization_id
          JOIN policy_reconciliation_scheduler_identities scheduler
            ON scheduler.organization_id = dispatch.organization_id AND scheduler.identity_id = ?
          JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
          JOIN organization_memberships membership ON membership.organization_id = scheduler.organization_id
            AND membership.identity_id = scheduler.identity_id AND membership.role = 'automation' AND membership.status = 'active'
          WHERE dispatch.organization_id = ? AND dispatch.schedule_id = ?
            AND dispatch.scheduled_for = ? AND dispatch.schedule_revision = ?
            AND dispatch.server_id = ? AND dispatch.state = 'dispatching'
            AND dispatch.claim_id = ? AND dispatch.lease_expires_at > ?
            AND schedule.enabled = 1 AND schedule.revision = dispatch.schedule_revision
            AND schedule.server_id = dispatch.server_id AND organization.status = 'active'`)
            .bind(
              input.actorId,
              input.organizationId,
              input.scheduleId,
              input.scheduledFor,
              input.scheduleRevision,
              input.serverId,
              input.claimId,
              new Date().toISOString(),
            )
            .first<{ organizationSlug: string }>(),
        catch: () =>
          new PersistenceError({
            operation: 'scheduled-backup.dispatch.load',
            message: 'Scheduled backup dispatch could not be loaded',
          }),
      })
      if (exact === null)
        return yield* new ConflictError({
          code: 'scheduled_backup_dispatch_fenced',
          message: 'Scheduled backup dispatch is stale or no longer eligible',
        })
      const organizationId = yield* decode(OrganizationId, input.organizationId)
      const organizationSlug = yield* decode(OrganizationSlug, exact.organizationSlug)
      const identityId = yield* decode(IdentityId, input.actorId)
      const correlationDigest = yield* sha256(
        `${input.organizationId}\n${input.scheduleId}\n${input.scheduledFor}`,
      ).pipe(
        Effect.mapError(
          () =>
            new RequestValidationError({
              message: 'Scheduled backup identity could not be derived',
            }),
        ),
      )
      const scheduledCorrelationId = yield* decode(
        CorrelationId,
        `scheduled-backup-${correlationDigest}`,
      )
      const scheduledAuditRequest = scheduledBackupAuditRequest(
        correlationDigest,
        scheduledCorrelationId,
      )
      const actor: OrganizationContext = {
        organizationId,
        organizationSlug,
        identityId,
        role: 'automation',
        correlationId: scheduledCorrelationId,
        auditActorType: 'system',
        auditRequestContext: scheduledAuditRequest,
      } as OrganizationContext & {
        readonly auditActorType: 'system'
        readonly auditRequestContext: AuditRequestContextValue
      }
      const control = startingBackupControl(context.env, yield* BackupControl)
      const expiresAt = new Date(
        Date.parse(input.scheduledFor) + input.retentionDays * 24 * 60 * 60_000,
      ).toISOString()
      const reservation = yield* control.create(actor, {
        serverId: input.serverId,
        idempotencyKey: `scheduled:${input.scheduleId}:${input.scheduledFor}`,
        intent: { schemaVersion: 1, includes: ['config', 'data', 'mods', 'state'], expiresAt },
      })
      return jsonResponse(
        {
          backupJobId: reservation.job.id,
          operationId: reservation.job.operationId,
          backupId: reservation.artifact.id,
        },
        202,
      )
    }),
  ),
)

app.post(
  '/v1/internal/scheduled-backups/retention',
  apiEffectHandler(() =>
    Effect.gen(function* () {
      const control = yield* BackupControl
      const deleted = yield* control.expire(new Date().toISOString(), 100).pipe(
        Effect.mapError(
          () =>
            new PersistenceError({
              operation: 'scheduled-backup.retention',
              message: 'Scheduled backup retention could not be reconciled',
            }),
        ),
      )
      return jsonResponse({ deleted: deleted.length })
    }),
  ),
)

registerPolicyRoutes(app, {
  runtimeFor,
  database: (bindings) => bindings.DB,
  auditRequestContext: auditRequestContextFor,
  authorize: inventoryContext,
})

registerPolicyReconciliationRoutes(app, {
  runtimeFor,
  // `app.use('/v1/*')` verifies the HMAC with INTERNAL_SERVICE_SECRET and
  // consumes the replay nonce before this route can run. The route-level
  // hook deliberately does not read a secret from a request header.
  authenticate: () => Effect.void,
  schedule: (bindings) => Effect.succeed(makePolicyScheduleStore(bindings.DB)),
  control: (bindings) =>
    Effect.gen(function* () {
      const game = yield* GameLifecycleD1Repository
      return makePolicyReconciliationControl({
        repository: makePolicyReconciliationRepositoryD1(bindings.DB),
        executor: makePolicyLifecycleActionExecutor({
          gameLifecycle: game,
          termination: makeCancellationControl(bindings),
        }),
        clock: { now: Effect.sync(() => new Date()) },
      })
    }),
  publish: (bindings, result) =>
    Effect.tryPromise({
      try: async () => {
        const events = bindings.ORGANIZATION_EVENTS.getByName(`${result.organizationId}:events`)
        await events.initialize(result.organizationId)
        await events.publish({
          id: `policy-reconciliation-${result.runId}`,
          organizationId: result.organizationId,
          type: 'policy.reconciliation.completed',
          resourceId: result.runId,
          occurredAt: new Date().toISOString(),
          data: {
            runId: result.runId,
            policyRevision: result.policyRevision,
            actionCount: result.actions.length,
            dispatchStates: result.actions.map((action) => action.dispatchState),
            replayed: result.replayed,
          },
        })
      },
      catch: () =>
        new PersistenceError({
          operation: 'policy.reconciliation.publish',
          message: 'Policy reconciliation event publication is unavailable',
        }),
    }),
})

registerProviderAccountRoutes(app, {
  runtimeFor,
  authorize: inventoryContext,
  byopEnabled: (bindings) => bindings.PROVIDER_BYOP_ENABLED === 'true',
  control: () => ProviderAccountControl,
  mutation: (context, actor, action, resourceType, resourceId, input) =>
    coreMutationRequest(context, actor, action, resourceType, resourceId, input).pipe(
      Effect.map((request) => ({
        idempotencyKey: request.idempotencyKey,
        operationIdempotencyKey: request.operationIdempotencyKey,
        requestFingerprint: request.requestFingerprint,
        auditRequestContext: request.request,
      })),
    ),
})

registerServerPlanRoutes(app, {
  runtimeFor,
  // Server apply persists a membership revision and repeats it in the parent
  // acceptance. A plan uses the same context so its later apply contract does
  // not silently discard the edge authorization fence.
  authorize: mutationContext,
  control: () => ServerPlanControl,
  provisionControl: (bindings, serverPlan) =>
    Effect.try({
      try: () => makeServerProvisionPlanControlRuntime(bindings, serverPlan),
      catch: () =>
        new PersistenceError({
          operation: 'server.provision.runtime',
          message: 'Server provisioning composition is unavailable',
        }),
    }).pipe(Effect.orDie),
  auditRequestContext: auditRequestContextFor,
})

registerGameServerManifestRoutes(app, {
  runtimeFor,
  // Export is a viewer-safe desired-state read; plans and applies capture the
  // current membership revision before their durable mutation admission.
  authorize: (context, minimumRole) =>
    minimumRole === 'viewer'
      ? inventoryContext(context, 'viewer')
      : mutationContext(context, 'operator'),
  repository: (bindings) => Effect.succeed(makeGameServerManifestD1Repository(bindings.DB)),
  draftRepository: (bindings) => Effect.succeed(makeGameServerDraftD1Repository(bindings.DB)),
  serverPlan: () => ServerPlanControl,
  provisionControl: (bindings, serverPlan) =>
    Effect.try({
      try: () => makeServerProvisionPlanControlRuntime(bindings, serverPlan),
      catch: () =>
        new PersistenceError({
          operation: 'server.provision.runtime',
          message: 'Server provisioning composition is unavailable',
        }),
    }),
  lifecycle: () => GameLifecycleD1Repository,
  lifecyclePlanning: () => GameLifecyclePlanningD1,
  lifecycleWorkflow: (bindings, action) => {
    switch (action) {
      case 'create':
        return lifecycleBinding(bindings.DEPLOY_GAME_SERVER)
      case 'delete':
        return lifecycleBinding(bindings.DELETE_GAME_SERVER)
      case 'start':
        return optionalLifecycleBinding(bindings.START_GAME_SERVER)
      case 'stop':
        return optionalLifecycleBinding(bindings.STOP_GAME_SERVER)
      case 'restart':
        return optionalLifecycleBinding(bindings.RESTART_GAME_SERVER)
      case 'update':
        return lifecycleBinding(bindings.UPDATE_GAME_SERVER)
      case 'apply-config':
        return lifecycleBinding(bindings.APPLY_GAME_CONFIG)
      case 'sync-mods':
        return lifecycleBinding(bindings.SYNC_MODS)
      case 'move':
        return lifecycleBinding(bindings.MOVE_GAME_SERVER)
    }
  },
  auditRequestContext: auditRequestContextFor,
})

const ScheduledGameServerDispatch = Schema.Struct({
  organizationId: Schema.String,
  scheduleId: Schema.String,
  draftId: Schema.String,
  scheduledFor: IsoDateTime,
  scheduleRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  claimId: Schema.String,
  actorId: Schema.String,
})

app.post(
  '/v1/internal/game-server-schedules/dispatch',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(ScheduledGameServerDispatch, value)),
      )
      if (context.req.header('x-gridora-organization-id') !== input.organizationId)
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'Scheduled game-server organization routing does not match',
        })
      const exact = yield* Effect.tryPromise({
        try: () =>
          context.env.DB.prepare(`SELECT
            draft.manifest_json AS manifestJson,
            organization.slug AS organizationSlug,
            membership.revision AS membershipRevision
          FROM game_server_draft_schedules schedule
          JOIN game_server_drafts draft
            ON draft.organization_id = schedule.organization_id AND draft.id = schedule.draft_id
          JOIN organizations organization
            ON organization.id = schedule.organization_id AND organization.status = 'active'
          JOIN policy_reconciliation_scheduler_identities scheduler
            ON scheduler.organization_id = schedule.organization_id AND scheduler.identity_id = ?
          JOIN identities actor
            ON actor.id = scheduler.identity_id AND actor.status = 'active'
          JOIN organization_memberships membership
            ON membership.organization_id = scheduler.organization_id
           AND membership.identity_id = scheduler.identity_id
           AND membership.role = 'automation' AND membership.status = 'active'
          WHERE schedule.organization_id = ? AND schedule.id = ?
            AND schedule.draft_id = ? AND schedule.scheduled_for = ?
            AND schedule.revision = ? AND schedule.state = 'dispatching'
            AND schedule.claim_id = ? AND schedule.lease_expires_at > ?
            AND draft.state = 'scheduled'`)
            .bind(
              input.actorId,
              input.organizationId,
              input.scheduleId,
              input.draftId,
              input.scheduledFor,
              input.scheduleRevision,
              input.claimId,
              new Date().toISOString(),
            )
            .first<{
              manifestJson: string
              organizationSlug: string
              membershipRevision: number
            }>(),
        catch: () =>
          new PersistenceError({
            operation: 'scheduled-game-server.dispatch.load',
            message: 'Scheduled game-server dispatch could not be loaded',
          }),
      })
      if (exact === null)
        return yield* new ConflictError({
          code: 'scheduled_game_server_dispatch_fenced',
          message: 'Scheduled game-server dispatch is stale or no longer eligible',
        })
      const manifestUnknown = yield* Effect.try({
        try: () => JSON.parse(exact.manifestJson) as unknown,
        catch: () =>
          new PersistenceError({
            operation: 'scheduled-game-server.dispatch.manifest',
            message: 'Scheduled game-server manifest is invalid',
          }),
      })
      const manifest = yield* decode(GameServerManifest, manifestUnknown)
      const organizationId = yield* decode(OrganizationId, input.organizationId)
      const identityId = yield* decode(IdentityId, input.actorId)
      const correlationDigest = yield* sha256(
        `${input.organizationId}\n${input.scheduleId}\n${input.scheduledFor}`,
      ).pipe(
        Effect.mapError(
          () =>
            new RequestValidationError({
              message: 'Scheduled game-server identity could not be derived',
            }),
        ),
      )
      const correlationId = yield* decode(CorrelationId, `scheduled-game-${correlationDigest}`)
      const scheduledAuditRequest: AuditRequestContextValue = {
        origin: 'scheduler',
        requestId: `scheduled-game-${correlationDigest}`,
        correlationId,
        source: {
          ip: { state: 'not-available', reason: 'scheduled-game-dispatch-has-no-request-source' },
          access: {
            state: 'not-available',
            reason: 'scheduled-game-dispatch-has-no-access-assertion',
          },
        },
      }
      const serverPlan = yield* ServerPlanControl
      const provision = makeServerProvisionPlanControlRuntime(context.env, serverPlan)
      const acceptance = yield* provision.apply({
        context: {
          organizationId,
          actorId: identityId,
          actorRole: 'operator',
          correlationId,
          actorMembershipRevision: exact.membershipRevision,
        },
        idempotencyKey: `scheduled-game:${input.scheduleId}`,
        intent: manifestToServerApplyIntent(manifest),
        auditRequestContext: scheduledAuditRequest,
      })
      return jsonResponse({ targetOperationId: acceptance.operationId }, 202)
    }),
  ),
)

registerGameDesiredStateRoutes(app, {
  runtimeFor,
  authorize: inventoryContext,
  control: () => GameDesiredStateControl,
})

registerOrganizationEventsRoutes(app, {
  runtimeFor,
  authorize: (context, minimumRole) =>
    Effect.gen(function* () {
      const actor = yield* inventoryContext(context, minimumRole)
      const memberships = yield* OrganizationMembershipRepository
      const membership = yield* memberships.get(actor.organizationId, actor.identityId)
      if (
        membership.status !== 'active' ||
        membership.organizationId !== actor.organizationId ||
        membership.identityId !== actor.identityId
      )
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'Active organization membership is required',
        })
      return {
        organizationId: actor.organizationId,
        identityId: actor.identityId,
        membershipRevision: membership.revision,
      }
    }),
  ticketSecret: (bindings) => bindings.REALTIME_TICKET_SECRET,
  organizationEvents: (bindings) => bindings.ORGANIZATION_EVENTS,
})

registerHealthRoutes(app, {
  runtimeFor,
  authorize: inventoryContext,
  health: (bindings) => makeHealthRepositoryD1(bindings.DB),
})

registerLogMonitoringRoutes(app, {
  runtimeFor,
  // A membership revision alone can be reused after deletion/regrant. The
  // D1-generated authorization generation is therefore carried to the stream
  // DO and makes an old ticket permanently stale across that lifecycle.
  authorize: (context, minimumRole) =>
    Effect.gen(function* () {
      const actor = yield* mutationContext(context, minimumRole)
      const value = yield* Effect.tryPromise({
        try: () =>
          context.env.DB.prepare(`SELECT authorization_generation AS authorizationGeneration,
          membership_revision AS membershipRevision, state
          FROM live_log_membership_authorizations
          WHERE organization_id = ? AND identity_id = ?`)
            .bind(actor.organizationId, actor.identityId)
            .first(),
        catch: () =>
          new PersistenceError({
            operation: 'logs.stream.membership-authorization',
            message: 'Live log membership authorization is unavailable',
          }),
      })
      const row =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined
      const authorizationGeneration =
        row === undefined ||
        typeof row.authorizationGeneration !== 'number' ||
        !Number.isSafeInteger(row.authorizationGeneration) ||
        row.authorizationGeneration < 1
          ? undefined
          : row.authorizationGeneration
      const membershipRevision =
        row === undefined ||
        typeof row.membershipRevision !== 'number' ||
        !Number.isSafeInteger(row.membershipRevision) ||
        row.membershipRevision < 1
          ? undefined
          : row.membershipRevision
      if (
        authorizationGeneration === undefined ||
        membershipRevision !== actor.membershipRevision ||
        row?.state !== 'active'
      )
        return yield* new AuthorizationError({
          code: 'membership_required',
          message: 'Live log membership authorization is no longer active',
        })
      return { ...actor, membershipAuthorizationGeneration: authorizationGeneration }
    }),
  logs: (bindings) => makeLogArchiveRepositoryD1(bindings.DB),
  logArchiveBucket: (bindings) => makeCloudflareLogR2Bucket(bindings.LOGS),
  liveTicket: (bindings) =>
    makeLogMonitoringRealtime({
      secret: bindings.REALTIME_TICKET_SECRET,
      liveLogStream: bindings.LIVE_LOG_STREAM,
    }).ticketIssuer,
  liveTicketVerifier: (bindings) =>
    makeLogMonitoringRealtime({
      secret: bindings.REALTIME_TICKET_SECRET,
      liveLogStream: bindings.LIVE_LOG_STREAM,
    }).ticketVerifier,
  logStream: (bindings) =>
    makeLogMonitoringRealtime({
      secret: bindings.REALTIME_TICKET_SECRET,
      liveLogStream: bindings.LIVE_LOG_STREAM,
    }).stream,
  liveStreamScope: (bindings, organizationId, serverId) =>
    Effect.tryPromise({
      try: () =>
        bindings.DB.prepare(`SELECT deployment.id AS deploymentId,
          authorization.authorization_generation AS organizationAuthorizationGeneration
          FROM organizations organization
          JOIN live_log_organization_authorizations authorization
            ON authorization.organization_id = organization.id
          JOIN game_servers server
            ON server.organization_id = organization.id
          JOIN deployments deployment
            ON deployment.organization_id = server.organization_id
           AND deployment.server_id = server.id
          WHERE organization.id = ?
            AND organization.status = 'active'
            AND authorization.state = 'active'
            AND authorization.terminal = 0
            AND server.id = ?
            AND server.desired_state <> 'deleted'
            AND server.observed_state <> 'deleted'
            AND deployment.observed_state = 'running'`)
          .bind(organizationId, serverId)
          .first(),
      catch: () =>
        new PersistenceError({
          operation: 'logs.stream.server-scope',
          message: 'Live log server scope is unavailable',
        }),
    }).pipe(
      Effect.flatMap((value) => {
        const row =
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
        const deploymentId =
          row === undefined || typeof row.deploymentId !== 'string' ? undefined : row.deploymentId
        const organizationAuthorizationGeneration =
          row === undefined ||
          typeof row.organizationAuthorizationGeneration !== 'number' ||
          !Number.isSafeInteger(row.organizationAuthorizationGeneration) ||
          row.organizationAuthorizationGeneration < 1
            ? undefined
            : row.organizationAuthorizationGeneration
        return deploymentId === undefined || organizationAuthorizationGeneration === undefined
          ? Effect.succeed(null)
          : Effect.succeed({
              deploymentId,
              streamEpoch: deploymentId,
              organizationAuthorizationGeneration,
            })
      }),
    ),
  cursorSecret: (bindings) => bindings.REALTIME_TICKET_SECRET,
  agentAuthorize: agentCredential,
  agentIngest: (bindings) =>
    makeTelemetryIngestor({
      database: bindings.DB,
      logBucket: bindings.LOGS,
      telemetryQueue: bindings.TELEMETRY,
      supportedAgentVersion: bindings.AGENT_VERSION,
    }),
})

registerInvitationAcceptanceRoutes(app, {
  runtimeFor,
  authenticatedIdentity: (context) =>
    Effect.gen(function* () {
      const claims = context.get('accessClaims')
      const identity = yield* accessIdentity(claims)
      const authenticatedEmail = yield* decode(EmailAddress, claims.email)
      if (identity.email.toLowerCase() !== authenticatedEmail.toLowerCase()) {
        return yield* new InvitationError({ code: 'email_mismatch' })
      }
      return identity
    }),
  acceptInvitation: (context, identity, token) =>
    Effect.gen(function* () {
      const mutation = yield* platformCoreMutationRequest(
        context,
        identity.id,
        'organization.invitation.accept',
        'organization_invitation',
        'invitation-from-token',
        { token },
      )
      const organizations = yield* OrganizationService
      const result = yield* organizations.acceptInvitation(identity, token, mutation)
      return completedMutationResponse({ organizationId: result.value.organizationId }, result)
    }),
})

registerNodeProvisionRoutes(app, {
  runtimeFor,
  authorize: inventoryContext,
  control: (bindings, context) =>
    Effect.try({
      try: () => makeNodeProvisionControlRuntime(bindings, auditRequestContextFor(context)),
      catch: () =>
        new PersistenceError({
          operation: 'node.provision.runtime',
          message: 'Node provisioning configuration is unavailable',
        }),
    }).pipe(Effect.orDie),
})

registerAutomationIdentityRoutes(app, {
  runtimeFor,
  auditRequestContext: auditRequestContextFor,
  authorize: mutationContext,
  control: () => AutomationIdentityControl,
})

// The public action paths bind only a node ID and optimistic revision. The
// control roots reconstruct the exact provider account/envelope coordinates
// from the accepted operation and attach the HTTP audit provenance before any
// durable mutation is attempted.
registerNodeRuntimeLifecycleRoutes(app, {
  runtimeFor,
  authorize: mutationContext,
  control: (context) =>
    Effect.gen(function* () {
      const kek = yield* KekPort
      return makeNodeRuntimeLifecycleControlRuntime({
        bindings: context.env,
        auditRequestContext: auditRequestContextFor(context),
        resolver: makeProviderNodeLifecycleAdapterResolver(context.env.DB, kek),
      })
    }),
})

registerNodeLifecycleRoutes(app, {
  runtimeFor,
  authorize: mutationContext,
  control: (context) =>
    Effect.succeed(
      makeTerminationControl(
        makeTerminationD1Repository(context.env.DB, {
          auditRequestContext: auditRequestContextFor(context),
        }),
        makeCancellationSignal(context.env),
      ),
    ),
  startWorkflow: (bindings, acceptance) =>
    makeNodeTerminationWorkflowStarter(bindings.DB, bindings).start(acceptance),
})

registerNodeImageRoutes(app, {
  runtimeFor,
  authorizePlatformAdministrator: (context) =>
    makePlatformAuthorityD1(context.env.DB)
      .authorize({
        accessSubject: context.get('accessClaims').sub,
        correlationId: correlationIdFromContext(context),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === 'PlatformAuthorizationError'
            ? new AuthorizationError({
                code: 'role_required',
                message: 'An active Platform Administrator grant is required',
              })
            : new PersistenceError({
                operation: 'platform.authority',
                message: 'Platform authority is unavailable',
              }),
        ),
      ),
  control: (bindings, context) =>
    Effect.sync(() =>
      makeNodeImageControlRuntime({
        database: bindings.DB,
        artifacts: bindings.ARTIFACTS,
        trustedPublicKeyDigests: bindings.NODE_IMAGE_TRUSTED_PUBLIC_KEY_DIGESTS,
        workflow: nodeImageWorkflowBinding(bindings.NODE_IMAGE_LIFECYCLE),
        auditRequestContext: auditRequestContextFor(context),
      }),
    ),
})

registerPlatformProviderRoutes(app, {
  runtimeFor,
  authorizePlatformAdministrator: (context) =>
    makePlatformAuthorityD1(context.env.DB)
      .authorize({
        accessSubject: context.get('accessClaims').sub,
        correlationId: correlationIdFromContext(context),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === 'PlatformAuthorizationError'
            ? new AuthorizationError({
                code: 'role_required',
                message: 'An active Platform Administrator grant is required',
              })
            : new PersistenceError({
                operation: 'platform.authority',
                message: 'Platform authority is unavailable',
              }),
        ),
      ),
  control: (
    bindings,
    context,
  ): Effect.Effect<PlatformProviderControlShape, never, RuntimeServices> =>
    Effect.gen(function* () {
      const kek = yield* KekPort
      const ovh = yield* OvhProviderAccountValidator
      const contabo = yield* ContaboProviderAccountValidator
      const repository = makePlatformProviderRepositoryD1(bindings.DB, {
        auditRequestContext: auditRequestContextFor(context),
      })
      const secrets = makePlatformSecretEnvelope(makePlatformSecretRepositoryD1(bindings.DB), kek)
      return makePlatformProviderControl(repository, secrets, (providerType) =>
        providerType === 'ovhcloud' ? ovh : contabo,
      )
    }),
})

app.get(
  '/v1/organizations/:organization/provider-accounts',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      const inventory = yield* ProviderInventory
      return jsonResponse(yield* inventory.list(authorized, yield* inventoryPage(context)))
    }),
  ),
)
app.get(
  '/v1/organizations/:organization/provider-accounts/:id',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      return jsonResponse(
        yield* ProviderInventory.pipe(
          Effect.flatMap((inventory) => inventory.get(authorized, routeParam(context, 'id'))),
        ),
      )
    }),
  ),
)
app.post(
  '/v1/organizations/:organization/provider-accounts',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'owner')
      if (context.env.PROVIDER_BYOP_ENABLED !== 'true') {
        return yield* new AuthorizationError({
          code: 'role_required',
          message: 'Organization-owned provider accounts are not enabled',
        })
      }
      const clientKeyText = context.req.header('idempotency-key')
      if (clientKeyText === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(CreateProviderAccountInput, value)),
      )
      const accountId = yield* canonicalCreateResourceId(
        authorized.organizationId,
        authorized.identityId,
        '/v1/organizations/:organization/provider-accounts',
        'provider',
        clientKeyText,
      )
      const mutation = yield* coreMutationRequest(
        context,
        authorized,
        'provider-account.create',
        'provider_account',
        accountId,
        input,
      )
      const repository = yield* ProviderAccountRepository
      const replay = yield* repository.findMutationReplay(
        authorized,
        mutation.idempotencyKey,
        mutation.requestFingerprint,
        'create',
      )
      if (replay !== null) return jsonResponse(replay, 201)
      const now = yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now))
      const plaintext = new TextEncoder().encode(JSON.stringify(input.credentials))
      const envelope = yield* prepareSecretEnvelope(authorized, {
        id: `${accountId}.credentials`,
        scopeType: 'provider-account',
        scopeId: accountId,
        plaintext,
        now,
      }).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
      const account = new ProviderAccountMetadata({
        id: accountId,
        scope: 'organization',
        organizationId: authorized.organizationId,
        providerType: input.providerType,
        status: 'disabled',
        revision: 1,
        credentialRevision: 1,
        createdAt: now,
        updatedAt: now,
      })
      return jsonResponse(
        yield* repository.create(authorized, {
          account,
          credentialEnvelope: envelope,
          idempotencyKey: mutation.idempotencyKey,
          operationIdempotencyKey: mutation.operationIdempotencyKey,
          requestFingerprint: mutation.requestFingerprint,
          auditRequestContext: mutation.request,
        }),
        201,
      )
    }),
  ),
)
app.patch(
  '/v1/organizations/:organization/provider-accounts/:id',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'owner')
      if (context.env.PROVIDER_BYOP_ENABLED !== 'true') {
        return yield* new AuthorizationError({
          code: 'role_required',
          message: 'Organization-owned provider accounts are not enabled',
        })
      }
      const clientKeyText = context.req.header('idempotency-key')
      if (clientKeyText === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      const accountId = routeParam(context, 'id')
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(UpdateProviderAccountInput, value)),
      )
      const repository = yield* ProviderAccountRepository
      const mutation = yield* coreMutationRequest(
        context,
        authorized,
        'provider-account.credentials.update',
        'provider_account',
        accountId,
        input,
      )
      const replay = yield* repository.findMutationReplay(
        authorized,
        mutation.idempotencyKey,
        mutation.requestFingerprint,
        'update-credentials',
      )
      if (replay !== null) return jsonResponse(replay)
      const currentEnvelope = yield* repository.getCredentialEnvelope(authorized, accountId)
      if (currentEnvelope.revision !== input.expectedCredentialRevision) {
        return yield* new ConflictError({
          code: 'provider_credential_revision_mismatch',
          message: 'Provider credential and account revisions must advance together',
        })
      }
      const now = yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now))
      const plaintext = new TextEncoder().encode(JSON.stringify(input.credentials))
      const replacement = yield* prepareSecretEnvelopeReplacement(
        authorized,
        currentEnvelope,
        plaintext,
        now,
      ).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
      return jsonResponse(
        yield* repository.updateCredentials(authorized, {
          accountId,
          providerType: input.providerType,
          expectedRevision: input.expectedRevision,
          expectedCredentialRevision: input.expectedCredentialRevision,
          credentialEnvelope: replacement,
          idempotencyKey: mutation.idempotencyKey,
          operationIdempotencyKey: mutation.operationIdempotencyKey,
          requestFingerprint: mutation.requestFingerprint,
          auditRequestContext: mutation.request,
          now,
        }),
      )
    }),
  ),
)
app.get(
  '/v1/organizations/:organization/provider-allocations',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      const inventory = yield* ProviderInventory
      return jsonResponse(
        yield* inventory.listAllocations(authorized, yield* inventoryPage(context)),
      )
    }),
  ),
)
app.get(
  '/v1/organizations/:organization/provider-allocations/:id',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      return jsonResponse(
        yield* ProviderInventory.pipe(
          Effect.flatMap((inventory) =>
            inventory.getAllocation(authorized, routeParam(context, 'id')),
          ),
        ),
      )
    }),
  ),
)

const inventoryRoutes = <Service extends RuntimeServices, View>(options: {
  readonly path: string
  readonly service: Effect.Effect<
    {
      readonly list: (
        context: OrganizationContext,
        page: InventoryPageRequest,
      ) => Effect.Effect<
        { readonly items: ReadonlyArray<View>; readonly nextCursor?: string },
        unknown
      >
      readonly get: (context: OrganizationContext, id: string) => Effect.Effect<View, unknown>
    },
    never,
    Service
  >
  readonly minimumRole?: 'viewer' | 'administrator'
}): void => {
  app.get(
    `/v1/organizations/:organization/${options.path}`,
    apiEffectHandler((context) =>
      Effect.gen(function* () {
        const authorized = yield* inventoryContext(context, options.minimumRole)
        const inventory = yield* options.service
        return jsonResponse(yield* inventory.list(authorized, yield* inventoryPage(context)))
      }),
    ),
  )
  app.get(
    `/v1/organizations/:organization/${options.path}/:id`,
    apiEffectHandler((context) =>
      Effect.gen(function* () {
        const authorized = yield* inventoryContext(context, options.minimumRole)
        const inventory = yield* options.service
        return jsonResponse(yield* inventory.get(authorized, routeParam(context, 'id')))
      }),
    ),
  )
}

inventoryRoutes({ path: 'node-images', service: NodeImageInventory })
inventoryRoutes({ path: 'nodes', service: NodeInventory })
inventoryRoutes({ path: 'game-servers', service: GameServerInventory })
inventoryRoutes({ path: 'backups', service: BackupInventory })
inventoryRoutes({ path: 'operations', service: OperationInventory })
inventoryRoutes({
  path: 'audit-events',
  service: AuditEventInventory,
  minimumRole: 'viewer',
})

app.get(
  '/v1/organizations/:organization/members',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
      )
      const memberships = yield* OrganizationMembershipRepository
      return jsonResponse(yield* memberships.listForOrganization(authorized))
    }),
  ),
)

app.get(
  '/v1/organizations/:organization/invitations',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const invitations = yield* OrganizationInvitationRepository
      return jsonResponse(yield* invitations.list(authorized))
    }),
  ),
)

const notificationRemediationPrefix = (organizationId: string): string =>
  `organizations/${encodeURIComponent(organizationId)}/notification-remediation/`

const readNotificationRemediation = (bucket: R2Bucket, organizationId: string, eventId: string) =>
  Effect.gen(function* () {
    const key = `${notificationRemediationPrefix(organizationId)}${encodeURIComponent(eventId)}.json`
    const object = yield* Effect.tryPromise({
      try: () => bucket.get(key),
      catch: () => new NotFoundError({ resource: 'notification-remediation', id: eventId }),
    })
    if (object === null)
      return yield* new NotFoundError({ resource: 'notification-remediation', id: eventId })
    const record = yield* Effect.tryPromise({
      try: () => object.json<unknown>(),
      catch: () => new NotFoundError({ resource: 'notification-remediation', id: eventId }),
    }).pipe(Effect.flatMap((value) => decode(InvitationEmailRemediation, value)))
    if (record.organizationId !== organizationId || record.eventId !== eventId) {
      return yield* new NotFoundError({ resource: 'notification-remediation', id: eventId })
    }
    return record
  })

app.get(
  '/v1/organizations/:organization/notification-remediation',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      const cursor = context.req.query('cursor')
      const listed = yield* Effect.tryPromise({
        try: () =>
          context.env.NOTIFICATION_REMEDIATION.list({
            prefix: notificationRemediationPrefix(authorized.organizationId),
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        catch: (cause) => cause,
      })
      const records = yield* Effect.forEach(
        listed.objects,
        (object) => {
          const filename = object.key.slice(
            notificationRemediationPrefix(authorized.organizationId).length,
          )
          const eventId = decodeURIComponent(filename.replace(/\.json$/, ''))
          return readNotificationRemediation(
            context.env.NOTIFICATION_REMEDIATION,
            authorized.organizationId,
            eventId,
          ).pipe(Effect.option)
        },
        { concurrency: 10 },
      )
      return jsonResponse({
        items: records.flatMap((record) => (record._tag === 'Some' ? [record.value] : [])),
        ...(listed.truncated ? { cursor: listed.cursor } : {}),
        truncated: listed.truncated,
      })
    }),
  ),
)

app.get(
  '/v1/organizations/:organization/notification-remediation/:eventId',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const authorized = yield* inventoryContext(context, 'administrator')
      return jsonResponse(
        yield* readNotificationRemediation(
          context.env.NOTIFICATION_REMEDIATION,
          authorized.organizationId,
          routeParam(context, 'eventId'),
        ),
      )
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/invitations',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const clientKey = context.req.header('idempotency-key')
      if (clientKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      const input = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) =>
          decode(CreateInvitationInput, { ...(value as object), idempotencyKey: clientKey }),
        ),
      )
      const service = yield* OrganizationService
      const invitationId = yield* canonicalCreateResourceId(
        authorized.organizationId,
        authorized.identityId,
        'organization.invitation.create',
        'inv',
        clientKey,
      )
      const issued = yield* service.invite(
        authorized,
        input,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.invitation.create',
          'organization_invitation',
          invitationId,
          input,
        ),
      )
      context.executionCtx.waitUntil(
        context.env.OUTBOX_WAKEUPS.send({
          reason: 'invitation-created',
          organizationId: authorized.organizationId,
        }),
      )
      return jsonResponse(
        {
          ...completedMutationResponse(authorized, issued),
        },
        201,
      )
    }),
  ),
)

app.patch(
  '/v1/organizations/:organization/members/:identity',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const targetIdentityId = yield* decode(IdentityId, routeParam(context, 'identity'))
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(UpdateMembershipRoleInput, value)),
      )
      if (body.identityId !== targetIdentityId)
        return yield* new RequestValidationError({
          message: 'Membership identity does not match the route',
        })
      const service = yield* OrganizationService
      const result = yield* service.updateMemberRole(
        authorized,
        targetIdentityId,
        body.role,
        body.expectedRevision,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.membership.role.update',
          'organization_membership',
          targetIdentityId,
          body,
        ),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.delete(
  '/v1/organizations/:organization/members/:identity',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const targetIdentityId = yield* decode(IdentityId, routeParam(context, 'identity'))
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(RevisionBody, value)),
      )
      const service = yield* OrganizationService
      const result = yield* service.removeMember(
        authorized,
        targetIdentityId,
        body.expectedRevision,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.membership.remove',
          'organization_membership',
          targetIdentityId,
          body,
        ),
      )
      context.executionCtx.waitUntil(
        context.env.OUTBOX_WAKEUPS.send({
          reason: 'membership-revoked',
          organizationId: authorized.organizationId,
        }),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/actions/leave',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const organizationReference = routeParam(context, 'organization')
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(RevisionBody, value)),
      )
      const memberships = yield* OrganizationMembershipRepository
      const rawKey = context.req.header('idempotency-key')
      if (rawKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      const clientKey = yield* decode(IdempotencyKey, rawKey)
      const replay = yield* memberships.findLeaveMutationReplay!(
        organizationReference,
        identity.id,
        clientKey,
      )
      if (replay !== null) {
        const expectedFingerprint = yield* sha256(
          canonicalMutationFingerprint(
            'organization.membership.leave',
            'organization_membership',
            identity.id,
            {
              actorId: identity.id,
              organizationId: replay.organizationId,
              ...body,
            },
          ),
        )
        if (expectedFingerprint !== replay.requestFingerprint)
          return yield* new ConflictError({
            code: 'idempotency_key_payload_mismatch',
            message: 'Idempotency key was already used with a different mutation payload',
          })
        return jsonResponse({
          operationId: replay.operationId,
          resourceId: replay.resourceId,
          status: 'succeeded',
          links: {
            operation: `/v1/organizations/${replay.organizationId}/operations/${replay.operationId}`,
          },
        })
      }
      const authorized = yield* authorizeOrganization(
        identity,
        organizationReference,
        yield* correlationId(context),
        'viewer',
      )
      const service = yield* OrganizationService
      const result = yield* service.leave(
        authorized,
        body.expectedRevision,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.membership.leave',
          'organization_membership',
          authorized.identityId,
          body,
        ),
      )
      context.executionCtx.waitUntil(
        context.env.OUTBOX_WAKEUPS.send({
          reason: 'membership-left',
          organizationId: authorized.organizationId,
        }),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/actions/transfer-ownership',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'owner',
      )
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(OwnershipTransferBody, value)),
      )
      const service = yield* OrganizationService
      const targetIdentityId = yield* decode(IdentityId, body.targetIdentityId)
      const result = yield* service.transferOwnership(
        authorized,
        targetIdentityId,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.ownership.transfer',
          'organization',
          authorized.organizationId,
          body,
        ),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.delete(
  '/v1/organizations/:organization/invitations/:invitation',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decode(RevisionBody, value)),
      )
      const service = yield* OrganizationService
      const invitationId = yield* decode(InvitationId, routeParam(context, 'invitation'))
      const result = yield* service.revokeInvitation(
        authorized,
        invitationId,
        body.expectedRevision,
        yield* coreMutationRequest(
          context,
          authorized,
          'organization.invitation.revoke',
          'organization_invitation',
          invitationId,
          body,
        ),
      )
      return jsonResponse(completedMutationResponse(authorized, result))
    }),
  ),
)

app.get(
  '/v1/organizations/:organization/operations/:id',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
      )
      const operations = yield* OperationDetailRepository
      return jsonResponse(
        yield* operations.get(authorized, yield* decode(OperationId, routeParam(context, 'id'))),
      )
    }),
  ),
)

app.post(
  '/v1/organizations/:organization/nodes/:nodeId/tunnels/:tunnelId/credential-deliveries',
  apiEffectHandler((context) =>
    Effect.gen(function* () {
      const identity = yield* accessIdentity(context.get('accessClaims'))
      const authorized = yield* authorizeOrganization(
        identity,
        routeParam(context, 'organization'),
        yield* correlationId(context),
        'administrator',
      )
      const rawIdempotencyKey = context.req.header('idempotency-key')
      if (rawIdempotencyKey === undefined)
        return yield* new RequestValidationError({ message: 'Idempotency-Key is required' })
      yield* decode(IdempotencyKey, rawIdempotencyKey)
      const body = yield* parseJson(context.req.raw).pipe(
        Effect.flatMap((value) => decodeExact(TunnelCredentialDeliveryBody, value)),
      )
      const nodeId = routeParam(context, 'nodeId')
      const tunnelId = routeParam(context, 'tunnelId')
      const routeAction = `tunnel.credential.delivery:${nodeId}:${tunnelId}`
      const operationId = yield* canonicalCreateResourceId(
        authorized.organizationId,
        authorized.identityId,
        routeAction,
        'op',
        rawIdempotencyKey,
      )
      const idempotencyKey = yield* decode(
        IdempotencyKey,
        yield* sha256(
          operationIdempotencyScope(
            authorized.organizationId,
            authorized.identityId,
            routeAction,
            'tunnel',
            tunnelId,
            rawIdempotencyKey,
          ),
        ),
      )
      const requestFingerprint = yield* sha256(
        canonicalize({
          organizationId: authorized.organizationId,
          actorId: authorized.identityId,
          nodeId,
          tunnelId,
          action: body.action,
          expectedPriorRevision: body.expectedPriorRevision,
        }),
      )
      const deliveryId = `tunnel_${(yield* sha256(`${authorized.organizationId}:${idempotencyKey}`)).slice(0, 48)}`
      const issuedAt = yield* ApplicationClock.pipe(Effect.flatMap((service) => service.now))
      const requestAuditContext = auditRequestContextFor(context)
      const request = {
        organizationId: authorized.organizationId,
        nodeId,
        tunnelId,
        operationId,
        actorId: authorized.identityId,
        correlationId: authorized.correlationId,
        idempotencyKey,
        requestFingerprint: `sha256:${requestFingerprint}`,
        action: body.action,
        expectedPriorRevision: body.expectedPriorRevision,
        deliveryId,
        now: issuedAt,
        auditRequestContext: {
          ...requestAuditContext,
          correlationId: authorized.correlationId,
        },
      } as const
      const reservation = yield* reserveTunnelDelivery(context.env.DB, request)
      let current = reservation
      if (reservation.command === null) {
        const [apiToken, signingKeyPem] = yield* Effect.all([
          Effect.tryPromise({
            try: () => context.env.CLOUDFLARE_TUNNEL_API_TOKEN.get(),
            catch: (cause) =>
              new PersistenceError({
                operation: 'tunnel.cloudflare.api-token',
                message: cause instanceof Error ? cause.message : 'Tunnel API token unavailable',
              }),
          }),
          Effect.tryPromise({
            try: () => context.env.AGENT_COMMAND_SIGNING_KEY.get(),
            catch: (cause) =>
              new PersistenceError({
                operation: 'tunnel.command.signing-key',
                message:
                  cause instanceof Error ? cause.message : 'Agent command signing key unavailable',
              }),
          }),
        ])
        const client = makeCloudflareTunnelTokenClient({
          accountId: context.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken,
          expectedTunnelName: tunnelResourceName({
            accountId: context.env.CLOUDFLARE_ACCOUNT_ID,
            organizationId: authorized.organizationId,
            ownerResourceId: nodeId,
            name: 'Node tunnel',
          }),
          fetch,
        })
        const credential =
          body.action === 'revoke'
            ? (yield* client.invalidate(tunnelId), undefined)
            : yield* client.issue(tunnelId, body.action === 'rotate')
        const expiresAt = new Date(Date.parse(issuedAt) + 10 * 60_000).toISOString()
        const command = yield* createSignedTunnelCommand({
          reservation,
          ...(credential === undefined ? {} : { credential }),
          issuedAt,
          expiresAt,
          signingKeyPem,
        })
        current = yield* finalizeTunnelDelivery(context.env.DB, request, command)
        context.executionCtx.waitUntil(
          context.env.OUTBOX_WAKEUPS.send({
            reason: 'tunnel-credential-delivery',
            organizationId: authorized.organizationId,
          }),
        )
      }
      return jsonResponse(
        {
          deliveryId: current.deliveryId,
          operationId: current.operationId,
          nodeId: current.nodeId,
          tunnelId: current.tunnelId,
          action: current.action,
          revision: current.revision,
          state: current.state,
        },
        202,
      )
    }),
  ),
)

const tenantNotImplemented = (
  path: string,
  capability: string,
  minimumRole: 'viewer' | 'operator' | 'administrator' | 'owner' = 'viewer',
): void => {
  app.all(
    path,
    apiEffectHandler((context) =>
      Effect.gen(function* () {
        const identity = yield* accessIdentity(context.get('accessClaims'))
        yield* authorizeOrganization(
          identity,
          routeParam(context, 'organization'),
          yield* correlationId(context),
          minimumRole,
        )
        return notImplemented(context, capability)
      }),
    ),
  )
}

tenantNotImplemented(
  '/v1/organizations/:organization/game-servers/:id/actions/*',
  'Game server action',
  'operator',
)
app.notFound((context) =>
  context.json(
    {
      type: 'https://errors.gridora.example/not-found',
      title: 'Route not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested API route does not exist',
      requestId: requestIdFromContext(context),
      retryable: false,
      fields: [],
    },
    404,
    { 'content-type': 'application/problem+json' },
  ),
)

export default {
  fetch(request: Request, env: ApiBindings, context: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, context))
  },
} satisfies ExportedHandler<ApiBindings>

import { Effect, Schema } from 'effect'
import {
  AccessSessionView,
  AuthBootstrap,
  CreateProviderAccountInput,
  InvitationEmailRemediation,
  InvitationEmailRemediationPage,
  MutationAccepted,
  MutationCompleted,
  Operation,
  OperationDetail,
  OrganizationSummary,
  PluginList,
  PluginManifest,
  UpdateProviderAccountInput,
} from '@gridora/contracts'
import {
  Identity,
  Organization,
  OrganizationInvitation,
  OrganizationMembership,
} from '@gridora/domain'
import {
  ConfigPreviewInput,
  GameConfigPreviewResponse,
  GameConfigReadResponse,
  GameModsReadResponse,
  GameModsPlanResponse,
  ModsPlanInput,
} from '@gridora/game-desired-state-control'
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
import { CreateNodeIntent } from '@gridora/node-provision-control'
import {
  NodeRuntimeLifecycleAcceptanceContract,
  NodeRuntimeLifecycleAction,
} from '@gridora/node-runtime-lifecycle-control'
import {
  NodeRetirementBackupPolicy,
  NodeTerminationState,
} from '@gridora/lifecycle-termination-control'
import { PlatformAllocation, PlatformProviderAccount } from '@gridora/platform-provider-control'
import { BackupMetadata } from '@gridora/backup-control'
import { GameCreateIntent, type GameMoveIntent } from '@gridora/game-lifecycle-control'
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
import { HealthAlert, HealthResourceType, HealthStatus } from '@gridora/health-control'
import { LogEntry } from '@gridora/log-control'

export type { OrganizationPolicyV1 } from '@gridora/policy-control'
import {
  AuditEventView,
  GameServerView,
  NodeImageView,
  NodeView,
  ProviderAccountView,
  ProviderAllocationView,
} from '@gridora/inventory-contracts'

const inventoryPage = <A>(item: Schema.Codec<A, unknown, never, never>) =>
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
export const PublicLogArchive = Schema.Struct({
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
export const LogArchiveList = Schema.Struct({
  items: Schema.Array(PublicLogArchive),
  nextCursor: Schema.optional(Schema.String),
})
export const LogArchiveRead = Schema.Struct({
  archive: PublicLogArchive,
  entries: Schema.Array(LogEntry),
})
export const LiveLogTicket = Schema.Struct({
  ticket: Schema.String.check(
    Schema.isMinLength(32),
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  ),
  expiresAt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  /** Canonical organization ID for rejecting route-slug frame confusion. */
  organizationId: ApiIdentifier,
  streamEpoch: ApiIdentifier,
})
export const HealthSnapshot = Schema.Struct({
  organizationId: ApiIdentifier,
  resourceType: HealthResourceType,
  resourceId: ApiIdentifier,
  nodeId: ApiIdentifier,
  serverId: Schema.NullOr(ApiIdentifier),
  sampledAt: ApiTimestamp,
  status: HealthStatus,
  summary: Schema.Record(Schema.String, Schema.Unknown),
})
export const HealthHistory = Schema.Struct({
  items: Schema.Array(HealthSnapshot),
  nextCursor: Schema.optional(ApiTimestamp),
})
export const HealthAlerts = Schema.Struct({ items: Schema.Array(HealthAlert) })

export class GridoraClientError extends Schema.TaggedError<GridoraClientError>()(
  'GridoraClientError',
  {
    status: Schema.Number,
    code: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
}

export interface RequestOptions {
  readonly idempotencyKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}
export interface PlatformProviderCredentialInput {
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly credentialsBase64: string
}
export interface PlatformProviderAllocationInput {
  readonly expectedRevision: number
  readonly allowedRegions: readonly string[]
  readonly allowedPlans: readonly string[]
  readonly maxActiveNodes: number
  readonly monthlyBudgetMinor: number | null
  readonly status: 'active' | 'disabled'
}

export type ReadOnlyRequestOptions = Omit<RequestOptions, 'idempotencyKey'> & {
  readonly idempotencyKey?: never
}
export interface HealthHistoryQuery {
  readonly from?: string
  readonly to?: string
  readonly before?: string
  readonly limit?: number
}
export interface HealthAlertQuery {
  readonly resourceType?: 'node' | 'server' | 'container'
  readonly resourceId?: string
  readonly limit?: number
}
export interface LogArchiveQuery {
  readonly from?: string
  readonly to?: string
  readonly limit?: number
  readonly cursor?: string
}

/** Public move DTO: placement/provider coordinates remain server-side facts. */
export type GameMoveRequest = typeof GameMoveIntent.Type & {
  readonly expectedRevision: number
}

const encoded = (value: string): string => encodeURIComponent(value)
const query = (values: object): string => {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(
    values as Readonly<Record<string, string | number | undefined>>,
  )) {
    if (value !== undefined) parameters.set(key, String(value))
  }
  const encodedValues = parameters.toString()
  return encodedValues.length === 0 ? '' : `?${encodedValues}`
}
const AuthenticationIntentCreated = Schema.Struct({
  state: Schema.String,
  expiresAt: Schema.Number,
})
const AuthenticationCompletion = Schema.Struct({
  intent: Schema.Literals(['sign-in', 'sign-up', 'accept-invitation']),
  next: Schema.Literals(['dashboard', 'setup-organization']),
  returnTo: Schema.String,
  identity: Identity,
  membership: Schema.optional(OrganizationMembership),
})
const OrganizationRealtimeTicket = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
)
export const OrganizationRealtimeTicketResponse = Schema.Struct({
  ticket: OrganizationRealtimeTicket,
  expiresAt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
})
const NodeProvisionResponse = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  nodeId: Schema.String,
  operationId: Schema.String,
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
  billing: Schema.Struct({
    providerType: Schema.Literals(['ovhcloud', 'contabo']),
    currency: Schema.String,
    estimatedMonthlyMinor: Schema.Int,
    billingCadence: Schema.Literals(['hourly', 'monthly', 'contract']),
    contractMonths: Schema.Int,
    committedMonthlyBeforeMinor: Schema.Int,
    projectedCommittedMonthlyMinor: Schema.Int,
    warnings: Schema.Array(Schema.Unknown),
  }),
})
/** Public node-runtime intent. The URL, rather than the body, selects the action. */
export const NodeRuntimeLifecycleIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedDesiredRevision: ApiPositiveInteger,
})
export type NodeRuntimeLifecycleIntent = typeof NodeRuntimeLifecycleIntent.Type

/**
 * Public termination intent. Provider identifiers and credentials are never a
 * client input; the accepted operation binds the authoritative coordinates.
 */
export const NodeLifecycleIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedNodeRevision: ApiPositiveInteger,
  force: Schema.Boolean,
  backupPolicy: NodeRetirementBackupPolicy,
  targetImageId: Schema.optional(ApiIdentifier),
})
export type NodeLifecycleIntent = typeof NodeLifecycleIntent.Type

const NodeLifecycleAcceptance = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  operationId: ApiIdentifier,
  nodeId: ApiIdentifier,
  state: NodeTerminationState,
  desiredNodeRevision: ApiPositiveInteger,
  workflowState: Schema.Literals(['started', 'pending-reconciliation']),
})
const GameLifecycleAcceptedResponse = Schema.Struct({
  operationId: ApiIdentifier,
  resourceId: ApiIdentifier,
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
const OrganizationDeletionAcceptance = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
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
const PublicBackupArtifact = Schema.Struct({
  organizationId: Schema.String,
  id: Schema.String,
  serverId: Schema.String,
  checksum: Schema.String,
  encryptionVersion: Schema.Int,
  metadata: BackupMetadata,
  state: Schema.Literals(['creating', 'available', 'restoring', 'expired', 'deleted', 'failed']),
  revision: Schema.Int,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
})
const PublicBackupJob = Schema.Struct({
  organizationId: Schema.String,
  id: Schema.String,
  operationId: Schema.String,
  mode: Schema.Literals(['create', 'restore']),
  trigger: Schema.Literals(['manual', 'scheduled', 'pre-update', 'pre-rebuild', 'pre-retire']),
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
  ]),
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  cancelledAt: Schema.NullOr(Schema.String),
})
const BackupAcceptance = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  job: PublicBackupJob,
  artifact: PublicBackupArtifact,
})
const CancellationRequest = Schema.Struct({
  disposition: Schema.Literals(['created', 'adopted']),
  signalState: Schema.Literals(['pending-delivery', 'delivered', 'cancelled']),
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
    ]),
    revision: Schema.Int,
    state: Schema.String,
  }),
  facts: Schema.Record(Schema.String, Schema.Unknown),
})

export class GridoraClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#headers = options.headers ?? {}
  }

  createPlatformProviderAccount = (
    accountId: string,
    body: PlatformProviderCredentialInput,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/platform/provider-accounts?id=${encoded(accountId)}`,
      PlatformProviderAccount,
      body,
      options,
    )

  platformProviderAccountAction = (
    accountId: string,
    action: 'validate' | 'disable' | 'remove',
    expectedRevision: number,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/platform/provider-accounts/${encoded(accountId)}/actions/${action}`,
      PlatformProviderAccount,
      { expectedRevision },
      options,
    )

  rotatePlatformProviderAccount = (
    accountId: string,
    body: { readonly expectedRevision: number; readonly credentialsBase64: string },
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/platform/provider-accounts/${encoded(accountId)}/actions/rotate`,
      PlatformProviderAccount,
      body,
      options,
    )

  putPlatformProviderAllocation = (
    accountId: string,
    organizationId: string,
    body: PlatformProviderAllocationInput,
    options: RequestOptions,
  ) =>
    this.request(
      'PUT',
      `/v1/platform/provider-accounts/${encoded(accountId)}/allocations/${encoded(organizationId)}`,
      PlatformAllocation,
      body,
      options,
    )

  request<A>(
    method: string,
    path: string,
    responseSchema: Schema.Codec<A, unknown, never, never>,
    body?: unknown,
    options: RequestOptions = {},
  ): Effect.Effect<A, GridoraClientError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          credentials: 'include',
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...this.#headers,
            ...options.headers,
            ...(options.idempotencyKey === undefined
              ? {}
              : { 'idempotency-key': options.idempotencyKey }),
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const payload: unknown = response.status === 204 ? null : await response.json()
        if (!response.ok) {
          const decoded = await Effect.runPromise(
            Effect.result(Schema.decodeUnknownEffect(Problem)(payload)),
          )
          if (decoded._tag === 'Success') {
            throw new GridoraClientError({
              status: decoded.success.status,
              code: decoded.success.code,
              detail: decoded.success.detail,
              retryable: decoded.success.retryable,
            })
          }
          throw new GridoraClientError({
            status: response.status,
            code: 'INVALID_ERROR_RESPONSE',
            detail: 'The API returned an invalid error response',
            retryable: response.status >= 500,
          })
        }
        const decoded = await Effect.runPromise(
          Effect.result(Schema.decodeUnknownEffect(responseSchema)(payload)),
        )
        if (decoded._tag === 'Failure') {
          throw new GridoraClientError({
            status: 502,
            code: 'INVALID_SUCCESS_RESPONSE',
            detail: 'The API returned a response that does not match its contract',
            retryable: false,
          })
        }
        return decoded.success
      },
      catch: (cause) =>
        cause instanceof GridoraClientError
          ? cause
          : new GridoraClientError({
              status: 0,
              code: 'NETWORK_ERROR',
              detail: cause instanceof Error ? cause.message : 'The API request failed',
              retryable: true,
            }),
    })
  }

  authBootstrap = (options?: RequestOptions) =>
    this.request('GET', '/v1/auth/bootstrap', AuthBootstrap, undefined, options)
  plugins = (options?: RequestOptions) =>
    this.request('GET', '/v1/plugins', PluginList, undefined, options)
  plugin = (id: string, options?: RequestOptions) =>
    this.request('GET', `/v1/plugins/${encoded(id)}`, PluginManifest, undefined, options)
  createAuthenticationIntent = (
    body: {
      readonly intent: 'sign-in' | 'sign-up' | 'accept-invitation'
      readonly returnTo: string
      readonly displayName?: string
      readonly invitationToken?: string
    },
    options?: RequestOptions,
  ) => this.request('POST', '/v1/auth/intents', AuthenticationIntentCreated, body, options)
  completeAuthentication = (state: string, options?: RequestOptions) =>
    this.request(
      'POST',
      '/v1/auth/complete',
      AuthenticationCompletion,
      {},
      {
        ...options,
        headers: {
          ...options?.headers,
          'x-gridora-auth-state': state,
          'idempotency-key': options?.idempotencyKey ?? state,
        },
      },
    )
  completeSignUp = (state: string, options?: RequestOptions) =>
    this.completeAuthentication(state, options)
  me = (options?: RequestOptions) => this.request('GET', '/v1/me', Identity, undefined, options)
  accessSession = (options?: RequestOptions) =>
    this.request('GET', '/v1/me/session', AccessSessionView, undefined, options)
  organizations = (options?: RequestOptions) =>
    this.request(
      'GET',
      '/v1/me/organizations',
      Schema.Array(OrganizationSummary),
      undefined,
      options,
    )
  createOrganization = (body: unknown, options: RequestOptions) =>
    this.request('POST', '/v1/organizations', MutationCompleted, body, options)
  organization = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}`,
      Organization,
      undefined,
      options,
    )
  updateOrganizationProfile = (
    organization: string,
    body: {
      readonly name: string
      readonly timezone: string
      readonly defaultRegion: string
      readonly expectedRevision: number
    },
    options: RequestOptions,
  ) =>
    this.request(
      'PUT',
      `/v1/organizations/${encoded(organization)}`,
      MutationCompleted,
      body,
      options,
    )
  issueOrganizationEventsTicket = (organization: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/events/ticket`,
      OrganizationRealtimeTicketResponse,
      undefined,
      options,
    )
  organizationEventsWebSocketUrl = (organization: string, ticket: string): string => {
    if (!Schema.is(OrganizationRealtimeTicket)(ticket))
      throw new TypeError('Organization realtime ticket is invalid')
    const url = new URL(`${this.#baseUrl}/v1/organizations/${encoded(organization)}/events`)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol === 'http:') url.protocol = 'ws:'
    else throw new TypeError('Gridora API base URL must use HTTP or HTTPS')
    url.searchParams.set('ticket', ticket)
    return url.toString()
  }
  organizationPolicy = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/policy`,
      OrganizationPolicyV1,
      undefined,
      options,
    )
  updateOrganizationPolicy = (
    organization: string,
    body: { readonly expectedRevision: number; readonly policy: typeof OrganizationPolicyV1.Type },
    options: RequestOptions,
  ) =>
    this.request(
      'PUT',
      `/v1/organizations/${encoded(organization)}/policy`,
      MutationCompleted,
      body,
      options,
    )
  providerAccounts = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/provider-accounts`,
      inventoryPage(ProviderAccountView),
      undefined,
      options,
    )
  providerAccount = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}`,
      ProviderAccountView,
      undefined,
      options,
    )
  createProviderAccount = (
    organization: string,
    body: typeof CreateProviderAccountInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/provider-accounts`,
      ProviderAccountView,
      body,
      options,
    )
  updateProviderAccountCredentials = (
    organization: string,
    id: string,
    body: typeof UpdateProviderAccountInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'PATCH',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}`,
      ProviderAccountView,
      body,
      options,
    )
  testProviderAccount = (
    organization: string,
    id: string,
    body: typeof ProviderAccountLifecycleBody.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}/test`,
      ProviderAccountLifecycleResult,
      body,
      options,
    )
  refreshProviderAccount = (
    organization: string,
    id: string,
    body: typeof ProviderAccountLifecycleBody.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}/refresh`,
      ProviderAccountLifecycleResult,
      body,
      options,
    )
  disableProviderAccount = (
    organization: string,
    id: string,
    body: typeof ProviderAccountLifecycleBody.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}/actions/disable`,
      ProviderAccountLifecycleResult,
      body,
      options,
    )
  deleteProviderAccount = (
    organization: string,
    id: string,
    body: typeof ProviderAccountLifecycleBody.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}/provider-accounts/${encoded(id)}`,
      ProviderAccountLifecycleResult,
      body,
      options,
    )
  providerAllocations = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/provider-allocations`,
      inventoryPage(ProviderAllocationView),
      undefined,
      options,
    )
  providerAllocation = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/provider-allocations/${encoded(id)}`,
      ProviderAllocationView,
      undefined,
      options,
    )
  nodeImages = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/node-images`,
      inventoryPage(NodeImageView),
      undefined,
      options,
    )
  nodeImage = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/node-images/${encoded(id)}`,
      NodeImageView,
      undefined,
      options,
    )
  nodes = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/nodes`,
      inventoryPage(NodeView),
      undefined,
      options,
    )
  createNode = (
    organization: string,
    body: typeof CreateNodeIntent.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/nodes`,
      NodeProvisionResponse,
      body,
      options,
    )
  node = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(id)}`,
      NodeView,
      undefined,
      options,
    )
  nodeRuntimeAction = (
    organization: string,
    nodeId: string,
    action: typeof NodeRuntimeLifecycleAction.Type,
    body: NodeRuntimeLifecycleIntent,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(nodeId)}/actions/${action}`,
      NodeRuntimeLifecycleAcceptanceContract,
      body,
      options,
    )
  nodeLifecycleAction = (
    organization: string,
    nodeId: string,
    action: 'drain' | 'uncordon' | 'rebuild',
    body: NodeLifecycleIntent,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(nodeId)}/actions/${action}`,
      NodeLifecycleAcceptance,
      body,
      options,
    )
  retireNode = (
    organization: string,
    nodeId: string,
    body: NodeLifecycleIntent,
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(nodeId)}`,
      NodeLifecycleAcceptance,
      body,
      options,
    )
  gameServers = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers`,
      inventoryPage(GameServerView),
      undefined,
      options,
    )
  gameServer = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}`,
      GameServerView,
      undefined,
      options,
    )
  exportGameServerManifest = (
    organization: string,
    serverId: string,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/manifest`,
      GameServerManifest,
      undefined,
      options,
    )
  nodeHealth = (organization: string, nodeId: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(nodeId)}/health`,
      HealthSnapshot,
      undefined,
      options,
    )
  nodeHealthHistory = (
    organization: string,
    nodeId: string,
    filters: HealthHistoryQuery = {},
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/nodes/${encoded(nodeId)}/health/history${query(filters)}`,
      HealthHistory,
      undefined,
      options,
    )
  gameServerHealth = (organization: string, serverId: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/health`,
      HealthSnapshot,
      undefined,
      options,
    )
  gameServerHealthHistory = (
    organization: string,
    serverId: string,
    filters: HealthHistoryQuery = {},
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/health/history${query(filters)}`,
      HealthHistory,
      undefined,
      options,
    )
  healthAlerts = (
    organization: string,
    filters: HealthAlertQuery = {},
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/health-alerts${query(filters)}`,
      HealthAlerts,
      undefined,
      options,
    )
  logArchives = (
    organization: string,
    serverId: string,
    filters: LogArchiveQuery = {},
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/logs${query(filters)}`,
      LogArchiveList,
      undefined,
      options,
    )
  logArchive = (
    organization: string,
    serverId: string,
    archiveId: string,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/logs/${encoded(archiveId)}`,
      LogArchiveRead as unknown as Schema.Codec<typeof LogArchiveRead.Type, unknown, never, never>,
      undefined,
      options,
    )
  issueLiveLogTicket = (organization: string, serverId: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/logs/stream/ticket`,
      LiveLogTicket,
      undefined,
      options,
    )
  liveLogWebSocketUrl = (organization: string, serverId: string, ticket: string): string => {
    if (!Schema.is(LiveLogTicket.fields.ticket)(ticket))
      throw new TypeError('Live log ticket is invalid')
    const url = new URL(
      `${this.#baseUrl}/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/logs/stream`,
    )
    if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol === 'http:') url.protocol = 'ws:'
    else throw new TypeError('Gridora API base URL must use HTTP or HTTPS')
    url.searchParams.set('ticket', ticket)
    return url.toString()
  }
  planGameServer = (
    organization: string,
    body: typeof ServerCreateIntent.Type,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/plan`,
      ServerApplyPlanSchema,
      body,
      options,
    )
  applyGameServer = (
    organization: string,
    body: typeof ServerApplyIntent.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/apply`,
      ServerProvisionAcceptanceSchema,
      body,
      options,
    )
  planGameServerManifest = (
    organization: string,
    body: typeof GameServerManifestInput.Type,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-server-manifests/plan`,
      GameServerManifestPlanResponse,
      body,
      options,
    )
  validateGameServerManifest = (
    organization: string,
    body: typeof GameServerManifestInput.Type,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-server-manifests/validate`,
      GameServerManifestValidationResponse,
      body,
      options,
    )
  createGameServerDraft = (
    organization: string,
    body: typeof GameServerManifestInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-server-drafts`,
      GameServerDraftCreateResponse,
      body,
      options,
    )
  gameServerDraft = (organization: string, draftId: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-server-drafts/${encoded(draftId)}`,
      GameServerDraftCreateResponse,
      undefined,
      options,
    )
  scheduleGameServerDraft = (
    organization: string,
    draftId: string,
    body: typeof GameServerDraftScheduleInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-server-drafts/${encoded(draftId)}/actions/schedule`,
      GameServerDraftScheduleResponse,
      body,
      options,
    )
  applyGameServerManifest = (
    organization: string,
    body: typeof GameServerManifestInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-server-manifests/apply`,
      GameServerManifestApplyResponse,
      body,
      options,
    )
  createGameServer = (
    organization: string,
    body: typeof GameCreateIntent.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  deleteGameServer = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  patchGameServer = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'PATCH',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  gameServerAction = (
    organization: string,
    id: string,
    action: 'start' | 'stop' | 'restart' | 'update',
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/actions/${action}`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  moveGameServer = (
    organization: string,
    id: string,
    body: GameMoveRequest,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/actions/move`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  validateGameServerFiles = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/actions/validate-files`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  forceCleanupGameServer = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/actions/force-cleanup`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  cloneGameServer = (
    organization: string,
    id: string,
    body: typeof GameServerCloneInput.Type,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/actions/clone`,
      GameServerCloneResponse,
      body,
      options,
    )
  getGameConfig = (organization: string, id: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/config`,
      GameConfigReadResponse,
      undefined,
      options,
    )
  getGameMods = (organization: string, id: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/mods`,
      GameModsReadResponse,
      undefined,
      options,
    )
  previewGameConfig = (
    organization: string,
    id: string,
    body: typeof ConfigPreviewInput.Type,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/config/plan`,
      GameConfigPreviewResponse,
      body,
      options,
    )
  planMods = (
    organization: string,
    id: string,
    body: typeof ModsPlanInput.Type,
    options?: ReadOnlyRequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/mods/plan`,
      GameModsPlanResponse,
      body,
      options,
    )
  applyGameConfig = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/config`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  syncGameMods = (
    organization: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ) =>
    this.request(
      'PUT',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(id)}/mods`,
      GameLifecycleAcceptedResponse,
      body,
      options,
    )
  backups = (organization: string, serverId?: string, options?: ReadOnlyRequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/backups${serverId === undefined ? '' : `?serverId=${encoded(serverId)}`}`,
      inventoryPage(PublicBackupArtifact),
      undefined,
      options,
    )
  backup = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/backups/${encoded(id)}`,
      PublicBackupArtifact,
      undefined,
      options,
    )
  operations = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/operations`,
      inventoryPage(Operation),
      undefined,
      options,
    )
  auditEvents = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/audit-events`,
      inventoryPage(AuditEventView),
      undefined,
      options,
    )
  auditEvent = (organization: string, id: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/audit-events/${encoded(id)}`,
      AuditEventView,
      undefined,
      options,
    )
  members = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/members`,
      Schema.Array(OrganizationMembership),
      undefined,
      options,
    )
  invitations = (organization: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/invitations`,
      Schema.Array(OrganizationInvitation),
      undefined,
      options,
    )
  switchOrganization = (organization: string, options: RequestOptions) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/actions/switch`,
      MutationCompleted,
      undefined,
      options,
    )
  createInvitation = (
    organization: string,
    body: { readonly email: string; readonly role: string; readonly expiresAt: string },
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/invitations`,
      MutationCompleted,
      body,
      options,
    )
  resendInvitation = (
    organization: string,
    invitation: string,
    body: { readonly expectedRevision: number; readonly expiresAt: string },
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/invitations/${encoded(invitation)}/actions/resend`,
      MutationCompleted,
      body,
      options,
    )
  acceptInvitation = (token: string, options: RequestOptions) =>
    this.request(
      'POST',
      `/v1/invitations/${encoded(token)}/actions/accept`,
      MutationCompleted,
      undefined,
      options,
    )
  notificationRemediation = (organization: string, cursor?: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/notification-remediation${cursor === undefined ? '' : `?cursor=${encoded(cursor)}`}`,
      InvitationEmailRemediationPage,
      undefined,
      options,
    )
  notificationRemediationRecord = (
    organization: string,
    eventId: string,
    options?: RequestOptions,
  ) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/notification-remediation/${encoded(eventId)}`,
      InvitationEmailRemediation,
      undefined,
      options,
    )
  operation = (organization: string, operationId: string, options?: RequestOptions) =>
    this.request(
      'GET',
      `/v1/organizations/${encoded(organization)}/operations/${encoded(operationId)}`,
      OperationDetail,
      undefined,
      options,
    )
  createBackup = (
    organization: string,
    serverId: string,
    body: {
      readonly schemaVersion: 1
      readonly includes: readonly ('config' | 'data' | 'mods' | 'state')[]
      readonly expiresAt: string | null
    },
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/game-servers/${encoded(serverId)}/backups`,
      BackupAcceptance,
      body,
      options,
    )
  restoreBackup = (
    organization: string,
    backupId: string,
    body: {
      readonly schemaVersion: 1
      readonly targetServerId?: string
      readonly targetNodeId?: string
    },
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/backups/${encoded(backupId)}/actions/restore`,
      BackupAcceptance,
      body,
      options,
    )
  cancelOperation = (
    organization: string,
    operationId: string,
    expectedOperationRevision: number,
    options: RequestOptions,
  ) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/operations/${encoded(operationId)}/actions/cancel`,
      CancellationRequest,
      { expectedOperationRevision },
      options,
    )
  deleteOrganization = (
    organization: string,
    body: {
      readonly expectedOrganizationRevision: number
      readonly typedSlug: string
      readonly backupPolicy: 'retain' | 'delete-after-retention'
    },
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}`,
      OrganizationDeletionAcceptance,
      body,
      options,
    )
  updateMemberRole = (
    organization: string,
    identityId: string,
    role: string,
    expectedRevision: number,
    options: RequestOptions,
  ) =>
    this.request(
      'PATCH',
      `/v1/organizations/${encoded(organization)}/members/${encoded(identityId)}`,
      MutationCompleted,
      {
        identityId,
        role,
        expectedRevision,
      },
      options,
    )
  removeMember = (
    organization: string,
    identityId: string,
    expectedRevision: number,
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}/members/${encoded(identityId)}`,
      MutationCompleted,
      { expectedRevision },
      options,
    )
  leaveOrganization = (organization: string, expectedRevision: number, options: RequestOptions) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/actions/leave`,
      MutationCompleted,
      { expectedRevision },
      options,
    )
  transferOwnership = (organization: string, targetIdentityId: string, options: RequestOptions) =>
    this.request(
      'POST',
      `/v1/organizations/${encoded(organization)}/actions/transfer-ownership`,
      MutationCompleted,
      { targetIdentityId },
      options,
    )
  revokeInvitation = (
    organization: string,
    invitationId: string,
    expectedRevision: number,
    options: RequestOptions,
  ) =>
    this.request(
      'DELETE',
      `/v1/organizations/${encoded(organization)}/invitations/${encoded(invitationId)}`,
      MutationCompleted,
      { expectedRevision },
      options,
    )

  mutate = (
    organization: string,
    resourcePath: string,
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    body: unknown,
    options: RequestOptions,
  ) =>
    this.request(
      method,
      `/v1/organizations/${encoded(organization)}/${resourcePath.split('/').map(encoded).join('/')}`,
      MutationAccepted,
      body,
      options,
    )
}

export const createGridoraClient = (options: ClientOptions): GridoraClient =>
  new GridoraClient(options)

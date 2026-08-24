import { createGridoraClient, GridoraClientError } from '@gridora/generated-client'
import type { OrganizationPolicyV1 } from '@gridora/generated-client'
import type { ServerApplyPlan } from '@gridora/server-plan-control'
import { Effect } from 'effect'
import type {
  AuditEvent,
  Backup,
  GameServer,
  Invitation,
  Member,
  Node,
  NodeImage,
  NotificationRemediation,
  Operation,
  Organization,
  Plugin,
  ProviderAccount,
  Role,
} from '~/types/gridora'
import type { AuthCompletion, AuthIntent } from '~/services/demo-auth-state'
import {
  browserIdempotencyStorage,
  createIdempotentMutationRunner,
} from '~/services/idempotent-mutation'
import type { IdempotentMutationRunner } from '~/services/idempotent-mutation'

type GeneratedGridoraClient = ReturnType<typeof createGridoraClient>
export type ServerPlanRequest = Parameters<GeneratedGridoraClient['planGameServer']>[1]
export type ServerApplyRequest = Parameters<GeneratedGridoraClient['applyGameServer']>[1]
/** The generated client keeps the move target/revision DTO aligned with the API. */
export type GameServerMoveRequest = Parameters<GeneratedGridoraClient['moveGameServer']>[2]
export type ServerPlanResponse = ServerApplyPlan
export interface BackupRestoreRequest {
  readonly backupId: string
  readonly targetServerId?: string
  readonly targetNodeId?: string
}

export class GridoraApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The public problem code emitted when a signed commercial offer no longer
 * matches current authoritative planning facts. This is not a retryable
 * conflict: callers must request and show a fresh plan before another apply.
 */
export const CommercialReviewRequiredApiCode = 'COMMERCIAL_REVIEW_REQUIRED' as const
export type CommercialReviewRequiredApiCode = typeof CommercialReviewRequiredApiCode

export const isCommercialReviewRequired = (error: unknown): error is GridoraApiError =>
  error instanceof GridoraApiError &&
  error.status === 409 &&
  error.code === CommercialReviewRequiredApiCode

/**
 * A commercial review conflict is definitive for its idempotency key and
 * proof. The caller must discard both local review state and acknowledgement
 * before it offers another explicit preview action.
 */
export interface CommercialReviewRecovery {
  readonly discardReviewedPlan: true
  readonly resetCommercialAcknowledgement: true
  readonly requireExplicitPreview: true
}

export const commercialReviewRecoveryFor = (
  error: unknown,
): CommercialReviewRecovery | undefined =>
  isCommercialReviewRequired(error)
    ? {
        discardReviewedPlan: true,
        resetCommercialAcknowledgement: true,
        requireExplicitPreview: true,
      }
    : undefined

const roleFromApi = (role: string): Role =>
  (({
    owner: 'Owner',
    administrator: 'Administrator',
    operator: 'Operator',
    viewer: 'Viewer',
    automation: 'Viewer',
  })[role] as Role) ?? 'Viewer'
const organizationFromApi = (summary: {
  organization: {
    id: string
    slug: string
    name: string
    status: string
    defaultRegion: string
    timezone: string
    revision?: number
  }
  role: string
}): Organization => ({
  id: summary.organization.id,
  slug: summary.organization.slug,
  name: summary.organization.name,
  status: summary.organization.status === 'suspended' ? 'suspended' : 'active',
  role: roleFromApi(summary.role),
  region: summary.organization.defaultRegion,
  timezone: summary.organization.timezone,
  budgetUsed: 0,
  budgetWarning: 0,
  ...(summary.organization.revision === undefined
    ? {}
    : { revision: summary.organization.revision }),
})

type CapabilityStatus = 'available' | 'not-implemented' | 'forbidden'
type GameMutationResponse = {
  readonly operationId: string
  readonly resourceId?: string
  readonly status: string
}

const providerName = (provider: string): string =>
  provider === 'ovhcloud' ? 'OVHcloud' : provider === 'contabo' ? 'Contabo' : provider

export const nodeFromApi = (node: {
  id: string
  providerType: string
  region: string
  plan: string
  imageId: string
  desiredState: string
  desiredRevision?: number
  observedState: string
  reconciliationError: string | null
  lastReconciledAt: string | null
}): Node => ({
  id: node.id,
  name: node.id,
  provider: providerName(node.providerType) as Node['provider'],
  region: node.region,
  plan: node.plan,
  status:
    node.desiredState === 'draining'
      ? 'draining'
      : node.observedState === 'ready'
        ? 'ready'
        : ['offline', 'deleted', 'failed'].includes(node.observedState)
          ? 'offline'
          : 'provisioning',
  health:
    node.observedState === 'ready'
      ? 'healthy'
      : node.observedState === 'degraded'
        ? 'degraded'
        : node.observedState === 'failed'
          ? 'failed'
          : 'unknown',
  image: node.imageId,
  ...(node.desiredRevision === undefined ? {} : { revision: node.desiredRevision }),
  ...(node.lastReconciledAt === null ? {} : { lastReconciledAt: node.lastReconciledAt }),
  ...(node.reconciliationError === null ? {} : { reconciliationError: node.reconciliationError }),
})

export const gameServerFromApi = (server: {
  id: string
  name: string
  pluginId: string
  pluginVersion: string
  observedState: string
  placementPolicy: Record<string, unknown>
  domain: string | null
  desiredRevision?: number
}): GameServer => ({
  id: server.id,
  name: server.name,
  plugin: server.pluginId,
  pluginVersion: server.pluginVersion,
  status:
    server.observedState === 'running'
      ? 'running'
      : server.observedState === 'stopped'
        ? 'stopped'
        : server.observedState === 'failed'
          ? 'failed'
          : 'deploying',
  health: server.observedState === 'failed' ? 'failed' : 'unknown',
  nodeId:
    typeof server.placementPolicy.nodeId === 'string'
      ? server.placementPolicy.nodeId
      : 'Not assigned',
  ...(server.desiredRevision === undefined ? {} : { revision: server.desiredRevision }),
  ...(server.domain === null ? {} : { endpoint: server.domain }),
})

const operationStatusFromApi = (status: string): Operation['status'] =>
  status === 'waiting_external'
    ? 'waiting'
    : status === 'failed_terminal'
      ? 'failed'
      : status === 'requested' || status === 'retrying' || status === 'cancelling'
        ? 'queued'
        : (status as Operation['status'])

const operationResourceTypeFromApi = (resourceType: string): Operation['resourceType'] => {
  if (resourceType === 'game-server') return 'server'
  if (resourceType === 'server' || resourceType === 'node' || resourceType === 'backup')
    return resourceType
  return 'organization'
}

export const operationFromApi = (operation: {
  id: string
  revision: number
  type: string
  resourceType: string
  resourceId: string
  actorId: string
  status: string
  progress: number
  createdAt: string
  updatedAt: string
  retryCount?: number
  waitingReason?: string | null
  providerReferenceHint?: string | null
  cancellable?: boolean
  recovery?: { message: string; retryAction: null }
  finalResource?: { type: string; id: string } | null
  steps?: ReadonlyArray<{
    key: string
    label: string
    state: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'
    attempt: number
  }>
  logs?: ReadonlyArray<{ id: string; action: string; result: string; createdAt: string }>
}): Operation => ({
  id: operation.id,
  revision: operation.revision,
  title: operation.type,
  resource: operation.resourceId,
  resourceType: operationResourceTypeFromApi(operation.resourceType),
  status: operationStatusFromApi(operation.status),
  progress: operation.progress,
  actor: operation.actorId,
  startedAt: operation.createdAt,
  elapsed: `${Math.max(0, Math.round((Date.parse(operation.updatedAt) - Date.parse(operation.createdAt)) / 1000))}s`,
  ...(operation.retryCount === undefined ? {} : { retries: operation.retryCount }),
  ...(operation.waitingReason === undefined || operation.waitingReason === null
    ? {}
    : { waitingReason: operation.waitingReason }),
  ...(operation.providerReferenceHint === undefined || operation.providerReferenceHint === null
    ? {}
    : { providerRequestId: operation.providerReferenceHint }),
  ...(operation.recovery === undefined ? {} : { recoveryGuidance: operation.recovery.message }),
  ...(operation.finalResource === undefined || operation.finalResource === null
    ? {}
    : {
        finalResource: {
          type: operationResourceTypeFromApi(operation.finalResource.type),
          id: operation.finalResource.id,
        },
      }),
  cancellable: operation.cancellable ?? false,
  steps: (operation.steps ?? []).map((step) => ({
    label: step.label,
    status: step.state,
    attempt: step.attempt,
  })),
  logs: (operation.logs ?? []).map(
    (entry) => `${entry.createdAt} · ${entry.action} · ${entry.result}`,
  ),
})

export const backupFromApi = (backup: {
  id: string
  serverId: string
  checksum: string
  metadata: { consistency?: string }
  state: string
  createdAt: string
  expiresAt: string | null
}): Backup => {
  const status: Backup['status'] =
    backup.state === 'reserved' || backup.state === 'deleting'
      ? 'creating'
      : backup.state === 'available' ||
          backup.state === 'deleted' ||
          backup.state === 'expired' ||
          backup.state === 'failed' ||
          backup.state === 'restoring'
        ? backup.state
        : 'failed'
  return {
    id: backup.id,
    serverId: backup.serverId,
    server: backup.serverId,
    createdAt: backup.createdAt,
    status,
    checksum: backup.checksum,
    ...(backup.metadata.consistency === 'quiesced' ||
    backup.metadata.consistency === 'plugin-quiesced' ||
    backup.metadata.consistency === 'crash-consistent'
      ? {
          consistency:
            backup.metadata.consistency === 'plugin-quiesced'
              ? 'quiesced'
              : backup.metadata.consistency,
        }
      : {}),
    ...(backup.expiresAt === null ? {} : { retainedUntil: backup.expiresAt }),
  }
}

export type ProviderAccountType = 'ovhcloud' | 'contabo'

export interface OvhProviderCredentialsInput {
  readonly authUrl: string
  readonly region: string
  readonly projectId: string
  readonly applicationCredentialId: string
  readonly applicationCredentialSecret: string
}

export interface ContaboProviderCredentialsInput {
  readonly tokenUrl: string
  readonly apiBaseUrl: string
  readonly clientId: string
  readonly clientSecret: string
  readonly apiUser: string
  readonly apiPassword: string
}

export type CreateOrganizationProviderAccountInput =
  | {
      readonly providerType: 'ovhcloud'
      readonly credentials: OvhProviderCredentialsInput
    }
  | {
      readonly providerType: 'contabo'
      readonly credentials: ContaboProviderCredentialsInput
    }

export type ReplaceOrganizationProviderCredentialsInput =
  | {
      readonly providerType: 'ovhcloud'
      readonly expectedRevision: number
      readonly expectedCredentialRevision: number
      readonly credentials: OvhProviderCredentialsInput
    }
  | {
      readonly providerType: 'contabo'
      readonly expectedRevision: number
      readonly expectedCredentialRevision: number
      readonly credentials: ContaboProviderCredentialsInput
    }

export interface ProviderAccountApiRecord {
  readonly id: string
  readonly scope: 'platform' | 'organization'
  readonly organizationId: string | null
  readonly providerType: ProviderAccountType
  readonly status: 'active' | 'disabled' | 'error'
  readonly revision: number
  readonly credentialRevision: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProviderAllocationApiRecord {
  readonly organizationId: string
  readonly providerAccountId: string
  readonly providerType: ProviderAccountType
  readonly accountScope: 'platform' | 'organization'
  readonly allowedRegions: ReadonlyArray<string>
  readonly allowedPlans: ReadonlyArray<string>
  readonly maxActiveNodes: number
  readonly monthlyBudgetMinor: number | null
  readonly status: 'active' | 'disabled'
  readonly revision: number
}

export interface ProviderAllocationViewModel {
  readonly status: 'active' | 'disabled'
  readonly revision: number
  readonly allowedRegions: ReadonlyArray<string>
  readonly allowedPlans: ReadonlyArray<string>
  readonly maxActiveNodes: number
  readonly monthlyBudgetMinor: number | null
}

export interface ProviderAccountViewModel extends ProviderAccount {
  readonly providerType: ProviderAccountType
  readonly accountScope: 'platform' | 'organization'
  readonly credentialRevision?: number
  readonly allocation?: ProviderAllocationViewModel
}

export const providerFromApi = (provider: ProviderAccountApiRecord): ProviderAccountViewModel => ({
  id: provider.id,
  provider: providerName(provider.providerType),
  providerType: provider.providerType,
  accountScope: provider.scope,
  source: provider.scope === 'platform' ? 'Platform allocation' : 'Organization account',
  status:
    provider.status === 'active'
      ? 'healthy'
      : provider.status === 'disabled'
        ? 'disabled'
        : 'error',
  regions: [],
  refreshedAt: provider.updatedAt,
  revision: provider.revision,
  ...(provider.credentialRevision === null
    ? {}
    : { credentialRevision: provider.credentialRevision }),
})

export const providersFromApi = (
  accounts: ReadonlyArray<ProviderAccountApiRecord>,
  allocations: ReadonlyArray<ProviderAllocationApiRecord>,
): ReadonlyArray<ProviderAccountViewModel> =>
  accounts.map((account) => {
    const provider = providerFromApi(account)
    if (account.scope !== 'platform') return provider
    const matches = allocations.filter(
      (allocation) =>
        allocation.providerAccountId === account.id &&
        allocation.providerType === account.providerType &&
        allocation.accountScope === account.scope,
    )
    if (matches.length !== 1) return provider
    const allocation = matches[0]
    if (allocation === undefined) return provider
    return {
      ...provider,
      status: allocation.status === 'disabled' ? 'disabled' : provider.status,
      regions: [...allocation.allowedRegions],
      allocation: {
        status: allocation.status,
        revision: allocation.revision,
        allowedRegions: [...allocation.allowedRegions],
        allowedPlans: [...allocation.allowedPlans],
        maxActiveNodes: allocation.maxActiveNodes,
        monthlyBudgetMinor: allocation.monthlyBudgetMinor,
      },
    }
  })

export interface ProviderAccountActionPermissions {
  readonly canTest: boolean
  readonly canRefresh: boolean
  readonly canReplaceCredentials: boolean
  readonly canDisable: boolean
  readonly canBeginRemove: boolean
}

export const providerAccountActionPermissions = (
  role: Role | undefined,
  provider: ProviderAccountViewModel,
  interactive = true,
): ProviderAccountActionPermissions => {
  const organizationAccount = provider.accountScope === 'organization'
  const administrator = role === 'Owner' || role === 'Administrator'
  const owner = role === 'Owner'
  const hasAccountRevision = provider.revision !== undefined
  return {
    canTest: interactive && organizationAccount && administrator && hasAccountRevision,
    canRefresh:
      interactive &&
      organizationAccount &&
      administrator &&
      hasAccountRevision &&
      provider.status === 'healthy',
    canReplaceCredentials:
      interactive &&
      organizationAccount &&
      owner &&
      hasAccountRevision &&
      provider.credentialRevision !== undefined,
    canDisable:
      interactive &&
      organizationAccount &&
      owner &&
      hasAccountRevision &&
      provider.status !== 'disabled',
    canBeginRemove:
      interactive &&
      organizationAccount &&
      owner &&
      hasAccountRevision &&
      provider.status === 'disabled',
  }
}

export const canConfirmProviderAccountRemoval = (
  role: Role | undefined,
  provider: ProviderAccountViewModel,
  confirmation: string,
  interactive = true,
): boolean =>
  providerAccountActionPermissions(role, provider, interactive).canBeginRemove &&
  confirmation === provider.id

export type ProviderAccountUiAction =
  | 'create'
  | 'replace credentials'
  | 'validate access'
  | 'refresh metadata'
  | 'disable'
  | 'remove'

export const providerAccountErrorMessage = (
  error: unknown,
  action: ProviderAccountUiAction,
): string => {
  if (!(error instanceof GridoraApiError))
    return `Gridora could not ${action} for this provider account. The result may be uncertain; retry the same submission.`
  if (error.status === 401)
    return 'Your Gridora session expired. Sign in again before changing provider accounts.'
  if (error.status === 403)
    return `This feature is unavailable for your organization or role, so Gridora cannot ${action}.`
  if (error.status === 404)
    return 'This provider account is no longer available in the organization.'
  if (error.status === 409)
    return 'The provider account changed or is still referenced. Refresh the page, review its current state, and try again.'
  if (error.status === 400 || error.status === 422)
    return 'The provider-account request was rejected. Check every field and submit again.'
  if (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  )
    return `Gridora could not confirm whether it completed the ${action} request. Retry the exact same submission so the idempotency key can converge.`
  return `Gridora could not ${action} for this provider account.`
}

type ProviderAccountMutationClient = Pick<
  ReturnType<typeof createGridoraClient>,
  | 'createProviderAccount'
  | 'updateProviderAccountCredentials'
  | 'testProviderAccount'
  | 'refreshProviderAccount'
  | 'disableProviderAccount'
  | 'deleteProviderAccount'
>

export const createProviderAccountActions = (dependencies: {
  readonly client: ProviderAccountMutationClient
  readonly run: <A>(effect: Effect.Effect<A, GridoraClientError>) => Promise<A>
  readonly mutations: IdempotentMutationRunner
}) => ({
  createProviderAccount: (organization: string, input: CreateOrganizationProviderAccountInput) =>
    dependencies.mutations
      .run(
        `organization.${organization}.provider-account.${input.providerType}.create`,
        input,
        (idempotencyKey) =>
          dependencies.run(
            dependencies.client.createProviderAccount(organization, input, { idempotencyKey }),
          ),
      )
      .then(providerFromApi),
  updateProviderAccountCredentials: (
    organization: string,
    accountId: string,
    input: ReplaceOrganizationProviderCredentialsInput,
  ) =>
    dependencies.mutations
      .run(
        `organization.${organization}.provider-account.${accountId}.credentials.replace`,
        input,
        (idempotencyKey) =>
          dependencies.run(
            dependencies.client.updateProviderAccountCredentials(organization, accountId, input, {
              idempotencyKey,
            }),
          ),
      )
      .then(providerFromApi),
  testProviderAccount: (organization: string, accountId: string, expectedRevision: number) =>
    dependencies.mutations.run(
      `organization.${organization}.provider-account.${accountId}.test`,
      { accountId, expectedRevision },
      (idempotencyKey) =>
        dependencies.run(
          dependencies.client.testProviderAccount(
            organization,
            accountId,
            { expectedRevision },
            { idempotencyKey },
          ),
        ),
    ),
  refreshProviderAccount: (organization: string, accountId: string, expectedRevision: number) =>
    dependencies.mutations.run(
      `organization.${organization}.provider-account.${accountId}.refresh`,
      { accountId, expectedRevision },
      (idempotencyKey) =>
        dependencies.run(
          dependencies.client.refreshProviderAccount(
            organization,
            accountId,
            { expectedRevision },
            { idempotencyKey },
          ),
        ),
    ),
  disableProviderAccount: (organization: string, accountId: string, expectedRevision: number) =>
    dependencies.mutations.run(
      `organization.${organization}.provider-account.${accountId}.disable`,
      { accountId, expectedRevision },
      (idempotencyKey) =>
        dependencies.run(
          dependencies.client.disableProviderAccount(
            organization,
            accountId,
            { expectedRevision },
            { idempotencyKey },
          ),
        ),
    ),
  deleteProviderAccount: (organization: string, accountId: string, expectedRevision: number) =>
    dependencies.mutations.run(
      `organization.${organization}.provider-account.${accountId}.remove`,
      { accountId, expectedRevision },
      (idempotencyKey) =>
        dependencies.run(
          dependencies.client.deleteProviderAccount(
            organization,
            accountId,
            { expectedRevision },
            { idempotencyKey },
          ),
        ),
    ),
})

type GameServerMoveMutationClient = Pick<ReturnType<typeof createGridoraClient>, 'moveGameServer'>

/**
 * Keeps the browser move submission on the generated DTO and idempotent
 * replay path. The server remains authoritative for target eligibility.
 */
export const createGameServerMoveActions = (dependencies: {
  readonly client: GameServerMoveMutationClient
  readonly run: <A>(effect: Effect.Effect<A, GridoraClientError>) => Promise<A>
  readonly mutations: IdempotentMutationRunner
}) => ({
  moveGameServer: (organization: string, serverId: string, input: GameServerMoveRequest) =>
    dependencies.mutations.run(
      `organization.${organization}.game-server.${serverId}.move`,
      input,
      (idempotencyKey) =>
        dependencies.run(
          dependencies.client.moveGameServer(organization, serverId, input, { idempotencyKey }),
        ),
    ),
})

export const nodeImageFromApi = (image: {
  id: string
  version: string
  checksum: string
  signature: string
  providerMappings: Record<string, unknown>
  status: NodeImage['status']
  createdAt: string
  promotedAt: string | null
}): NodeImage => ({
  ...image,
  ...(image.promotedAt === null ? { promotedAt: undefined } : { promotedAt: image.promotedAt }),
})

export const auditEventFromApi = (event: {
  id: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  result: string
  correlationId: string
  createdAt: string
  schemaVersion: 0 | 1
  captureStatus: 'legacy' | 'complete'
  envelope: {
    version: 0 | 1
    captureStatus: 'legacy' | 'complete'
    actor: { type: string; id: string }
    request: { id: string; correlationId: string }
    operationId: string
    forced: boolean
    breakGlass: boolean
    [key: string]: unknown
  }
}): AuditEvent => ({
  id: event.id,
  action: event.action,
  actor: event.envelope.actor.id,
  target: `${event.targetType}:${event.targetId}`,
  at: event.createdAt,
  outcome: event.result === 'succeeded' ? 'success' : (event.result as 'denied' | 'failed'),
  requestId: event.envelope.request.correlationId,
  schemaVersion: event.schemaVersion,
  captureStatus: event.captureStatus,
  operationId: event.envelope.operationId,
  actorType: event.envelope.actor.type,
  forced: event.envelope.forced,
  breakGlass: event.envelope.breakGlass,
  envelope: event.envelope,
})

export const notificationRemediationFromApi = (record: {
  eventId: string
  invitationId: string
  disposition: 'permanent-failure'
  action: 'reissue-invitation'
  code: string
  eventCreatedAt: string
}): NotificationRemediation => ({
  eventId: record.eventId,
  invitationId: record.invitationId,
  disposition: record.disposition,
  action: record.action,
  code: record.code,
  eventCreatedAt: record.eventCreatedAt,
})

interface NotificationRemediationPage<A> {
  readonly items: ReadonlyArray<A>
  readonly cursor?: string
  readonly truncated: boolean
}

export const collectNotificationRemediation = async <A>(
  load: (cursor?: string) => Promise<NotificationRemediationPage<A>>,
): Promise<ReadonlyArray<A>> => {
  const items: A[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await load(cursor)
    items.push(...page.items)
    if (!page.truncated) return items
    if (!page.cursor || cursors.has(page.cursor))
      throw new Error('The remediation inventory returned an invalid pagination cursor.')
    cursors.add(page.cursor)
    cursor = page.cursor
  }
  throw new Error('The remediation inventory exceeded the safe pagination limit.')
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; idempotencyKey?: string }

export const createAuthenticationApi = (baseUrl: string, fetcher: typeof fetch) => {
  const authRequest = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1${path}`, init)
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        code?: string
        detail?: string
        title?: string
      }
      throw new GridoraApiError(
        response.status,
        problem.code ?? 'HTTP_ERROR',
        problem.detail ?? problem.title ?? `Request failed (${response.status})`,
      )
    }
    return response.json() as Promise<T>
  }
  return {
    create: (input: {
      intent: AuthIntent
      returnTo: string
      displayName?: string
      invitationToken?: string
    }) =>
      authRequest<{ state: string; expiresAt: number }>('/auth/intents', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    complete: (state: string) =>
      authRequest<
        AuthCompletion & { identity: { id: string; displayName: string; email: string } }
      >('/auth/complete', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-gridora-auth-state': state,
          'idempotency-key': state,
        },
        body: '{}',
      }),
  }
}

export const useGridoraApi = () => {
  const config = useRuntimeConfig()
  const base = String(config.public.apiBase).replace(/\/$/, '')
  const credentialedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, credentials: 'include' })
  const authentication = createAuthenticationApi(base, credentialedFetch)
  const client = createGridoraClient({ baseUrl: base, fetch: credentialedFetch })
  const run = async <A>(effect: Effect.Effect<A, GridoraClientError>): Promise<A> => {
    try {
      return await Effect.runPromise(effect)
    } catch (error) {
      if (error instanceof GridoraClientError)
        throw new GridoraApiError(error.status, error.code, error.detail)
      throw error
    }
  }
  const mutations = createIdempotentMutationRunner({
    storage: browserIdempotencyStorage(),
    isAmbiguous: (error) =>
      !(error instanceof GridoraApiError) ||
      error.status === 0 ||
      error.status >= 500 ||
      [408, 425, 429].includes(error.status),
  })
  const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.idempotencyKey !== undefined) headers.set('Idempotency-Key', options.idempotencyKey)
    const response = await credentialedFetch(`${base}/v1${path}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        code?: string
        detail?: string
        title?: string
      }
      throw new GridoraApiError(
        response.status,
        problem.code ?? 'HTTP_ERROR',
        problem.detail ?? problem.title ?? `Request failed (${response.status})`,
      )
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  const missingAsEmpty = async <T>(loader: () => Promise<T[]>): Promise<T[]> =>
    loader().catch((error) => {
      if (error instanceof GridoraApiError && error.status === 404) return []
      throw error
    })
  const providerAccountActions = createProviderAccountActions({ client, run, mutations })
  const gameServerMoveActions = createGameServerMoveActions({ client, run, mutations })
  return {
    createAuthIntent: authentication.create,
    completeAuthentication: authentication.complete,
    ...providerAccountActions,
    bootstrap: async () => {
      const result = await run(client.authBootstrap())
      const identity = result.identityId ? await run(client.me()) : undefined
      return {
        identity: identity
          ? { id: identity.id, name: identity.displayName, email: identity.email }
          : undefined,
        organizations: result.organizations.map(organizationFromApi),
        next: result.next,
      }
    },
    accessSession: () => run(client.accessSession()),
    workspace: async (slug: string) => {
      const unavailable: string[] = []
      const capabilities: Record<string, CapabilityStatus> = {}
      const capability = async <T>(
        name: string,
        label: string,
        loader: () => Promise<ReadonlyArray<T>>,
      ): Promise<ReadonlyArray<T>> =>
        loader().catch((error) => {
          if (error instanceof GridoraApiError && error.status === 501) {
            unavailable.push(label)
            capabilities[name] = 'not-implemented'
            return []
          }
          if (error instanceof GridoraApiError && error.status === 403) {
            unavailable.push(`${label} (not permitted for your role)`)
            capabilities[name] = 'forbidden'
            return []
          }
          throw error
        })
      const [
        servers,
        nodes,
        operations,
        backups,
        apiProviders,
        providerAllocations,
        images,
        apiMembers,
        apiInvitations,
        audit,
      ] = await Promise.all([
        capability('gameServers', 'Game server inventory', () =>
          run(client.gameServers(slug)).then((page) => page.items.map(gameServerFromApi)),
        ),
        capability('nodes', 'Node inventory', () =>
          run(client.nodes(slug)).then((page) => page.items.map(nodeFromApi)),
        ),
        capability('operations', 'Operation inventory', () =>
          run(client.operations(slug)).then((page) => page.items.map(operationFromApi)),
        ),
        capability('backups', 'Backup inventory', () =>
          run(client.backups(slug)).then((page) => page.items.map(backupFromApi)),
        ),
        capability('providers', 'Provider accounts', () =>
          run(client.providerAccounts(slug)).then((page) => page.items),
        ),
        capability('providerAllocations', 'Provider allocation policies', () =>
          run(client.providerAllocations(slug)).then((page) => page.items),
        ),
        capability('images', 'Node images', () =>
          run(client.nodeImages(slug)).then((page) => page.items.map(nodeImageFromApi)),
        ),
        capability('members', 'Members', () => run(client.members(slug))),
        capability('invitations', 'Invitations', () => run(client.invitations(slug))),
        capability('audit', 'Audit events', () =>
          run(client.auditEvents(slug)).then((page) => page.items.map(auditEventFromApi)),
        ),
      ])
      const members: Member[] = apiMembers.map((member) => ({
        id: member.identityId,
        name: member.identityId,
        email: 'Identity details protected',
        role: roleFromApi(member.role),
        source: member.invitedBy ? 'Invitation' : 'Created organization',
        joinedAt: member.joinedAt,
        status: member.status,
        revision: member.revision,
      }))
      const invitations: Invitation[] = apiInvitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: roleFromApi(invitation.role) as Exclude<Role, 'Owner'>,
        status: invitation.status,
        invitedBy: invitation.inviterId,
        expiresAt: invitation.expiresAt,
        revision: invitation.revision,
      }))
      const providers: ReadonlyArray<ProviderAccount> = providersFromApi(
        apiProviders,
        providerAllocations,
      )
      return {
        servers,
        nodes,
        operations,
        backups,
        providers,
        images,
        members,
        invitations,
        audit,
        unavailable,
        capabilities,
      }
    },
    plugins: () =>
      missingAsEmpty(() =>
        run(client.plugins()).then((plugins) =>
          plugins.map((plugin): Plugin => ({
            id: plugin.id,
            name: plugin.displayName,
            version: plugin.version,
            apiVersion: plugin.apiVersion,
            enabled: true,
            capabilities: [...plugin.capabilities],
            limitations: [],
          })),
        ),
      ),
    notificationRemediation: (slug: string) =>
      collectNotificationRemediation((cursor) =>
        run(client.notificationRemediation(slug, cursor)),
      ).then((records) => records.map(notificationRemediationFromApi)),
    /**
     * Observability routes are composed API contracts, not optional workspace
     * capabilities.  Callers receive their actual authorization/availability
     * error rather than silently rendering an empty inventory on a 501.
     */
    gameServerHealth: (slug: string, serverId: string) =>
      run(client.gameServerHealth(slug, serverId)),
    gameServerLogArchives: (
      slug: string,
      serverId: string,
      filters: {
        readonly from?: string
        readonly to?: string
        readonly limit?: number
        readonly cursor?: string
      } = {},
    ) => run(client.logArchives(slug, serverId, filters)),
    gameServerLogArchive: (slug: string, serverId: string, archiveId: string) =>
      run(client.logArchive(slug, serverId, archiveId)),
    issueGameServerLiveLogTicket: (slug: string, serverId: string) =>
      run(client.issueLiveLogTicket(slug, serverId)),
    gameServerLiveLogUrl: (slug: string, serverId: string, ticket: string) =>
      client.liveLogWebSocketUrl(slug, serverId, ticket),
    organizationEventsTicket: (slug: string, signal?: AbortSignal) =>
      request<{ readonly ticket: string; readonly expiresAt: number }>(
        `/organizations/${encodeURIComponent(slug)}/events/ticket`,
        { method: 'POST', cache: 'no-store', signal },
      ),
    organizationPolicy: (slug: string) => run(client.organizationPolicy(slug)),
    updateOrganizationProfile: async (
      slug: string,
      input: {
        readonly name: string
        readonly timezone: string
        readonly defaultRegion: string
        readonly expectedRevision: number
      },
    ) => {
      await mutations.run(`organization.${slug}.profile.update`, input, (idempotencyKey) =>
        run(client.updateOrganizationProfile(slug, input, { idempotencyKey })),
      )
      return run(client.organization(slug))
    },
    updateOrganizationPolicy: async (
      slug: string,
      policy: OrganizationPolicyV1,
    ): Promise<OrganizationPolicyV1> => {
      const body = { expectedRevision: policy.revision - 1, policy }
      await mutations.run(`organization.${slug}.policy.update`, body, (idempotencyKey) =>
        run(client.updateOrganizationPolicy(slug, body, { idempotencyKey })),
      )
      return run(client.organizationPolicy(slug))
    },
    createOrganization: async (input: {
      name: string
      slug: string
      timezone: string
      region: string
      termsAccepted?: boolean
      budgetWarningThresholdMinor?: number
      budgetWarningCurrency?: string
      initialInvitations?: ReadonlyArray<{
        readonly email: string
        readonly role: 'administrator' | 'operator' | 'viewer'
      }>
    }) => {
      const body = {
        name: input.name,
        slug: input.slug,
        timezone: input.timezone,
        defaultRegion: input.region,
        termsAccepted: input.termsAccepted === true,
        ...(input.budgetWarningThresholdMinor === undefined
          ? {}
          : { budgetWarningThresholdMinor: input.budgetWarningThresholdMinor }),
        ...(input.budgetWarningCurrency === undefined
          ? {}
          : { budgetWarningCurrency: input.budgetWarningCurrency }),
        ...(input.initialInvitations === undefined
          ? {}
          : { initialInvitations: input.initialInvitations }),
      }
      const result = await mutations.run('organization.create', body, (idempotencyKey) =>
        run(client.createOrganization(body, { idempotencyKey })),
      )
      const created = (await run(client.organizations())).find(
        (summary) => summary.organization.id === result.resourceId,
      )
      if (created === undefined) {
        throw new Error(
          'Created organization is not visible in the authoritative organization list',
        )
      }
      return {
        ...organizationFromApi({
          organization: created.organization,
          role: created.role,
        }),
        budgetWarning: (input.budgetWarningThresholdMinor ?? 0) / 100,
      }
    },
    planServer: (slug: string, input: ServerPlanRequest) => run(client.planGameServer(slug, input)),
    createServer: async (slug: string, input: ServerApplyRequest) => {
      const result = await mutations.run(
        `organization.${slug}.game-server.apply`,
        input,
        (idempotencyKey) => run(client.applyGameServer(slug, input, { idempotencyKey })),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId ?? 'pending',
        status: result.state,
        workflowState: result.workflowState,
      }
    },
    createNode: async (
      slug: string,
      input: {
        readonly schemaVersion: 1
        readonly placementMode: 'shared' | 'dedicated'
        readonly temporaryLifetimeHours: number | null
        readonly nonHourlyCommitmentConfirmed: boolean
      },
    ) =>
      mutations.run(`organization.${slug}.node.create`, input, (idempotencyKey) =>
        run(client.createNode(slug, input, { idempotencyKey })),
      ),
    nodeRuntimeAction: async (
      slug: string,
      nodeId: string,
      action: 'start' | 'stop' | 'reboot' | 'reconcile',
      expectedDesiredRevision: number,
    ) => {
      const body = { schemaVersion: 1 as const, expectedDesiredRevision }
      return mutations.run(
        `organization.${slug}.node.${nodeId}.runtime.${action}`,
        body,
        (idempotencyKey) =>
          run(client.nodeRuntimeAction(slug, nodeId, action, body, { idempotencyKey })),
      )
    },
    nodeLifecycleAction: async (
      slug: string,
      nodeId: string,
      action: 'drain' | 'uncordon' | 'rebuild' | 'retire',
      input: {
        readonly expectedNodeRevision: number
        readonly force: boolean
        readonly backupPolicy: 'required' | 'skip-authorized'
        readonly targetImageId?: string
      },
    ) => {
      const body = { schemaVersion: 1 as const, ...input }
      return mutations.run(
        `organization.${slug}.node.${nodeId}.lifecycle.${action}`,
        body,
        (idempotencyKey) =>
          action === 'retire'
            ? run(client.retireNode(slug, nodeId, body, { idempotencyKey }))
            : run(client.nodeLifecycleAction(slug, nodeId, action, body, { idempotencyKey })),
      )
    },
    operation: (slug: string, operationId: string) =>
      run(client.operation(slug, operationId)).then(operationFromApi),
    serverAction: async (slug: string, serverId: string, action: string, expectedRevision = 1) => {
      const body =
        action === 'backup'
          ? {
              schemaVersion: 1,
              includes: ['config', 'data', 'mods', 'state'],
              expiresAt: null,
            }
          : { expectedRevision, action }
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.server.${serverId}.${action}`,
        body,
        async (idempotencyKey) => {
          if (action === 'backup') {
            const accepted = await run(
              client.createBackup(
                slug,
                serverId,
                body as {
                  readonly schemaVersion: 1
                  readonly includes: readonly ('config' | 'data' | 'mods' | 'state')[]
                  readonly expiresAt: string | null
                },
                { idempotencyKey },
              ),
            )
            return {
              operationId: accepted.job.operationId,
              resourceId: accepted.job.backupId,
              status: accepted.job.state,
            }
          }
          const accepted = await run(
            client.gameServerAction(
              slug,
              serverId,
              action as 'start' | 'stop' | 'restart' | 'update',
              body,
              { idempotencyKey },
            ),
          )
          return {
            operationId: accepted.operationId,
            resourceId: accepted.resourceId,
            status: accepted.status,
          }
        },
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    updateGameServer: async (
      slug: string,
      serverId: string,
      body: Readonly<Record<string, unknown>>,
    ) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.patch`,
        body,
        (idempotencyKey) => run(client.patchGameServer(slug, serverId, body, { idempotencyKey })),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    deleteGameServer: async (
      slug: string,
      serverId: string,
      body: Readonly<Record<string, unknown>>,
    ) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.delete`,
        body,
        (idempotencyKey) => run(client.deleteGameServer(slug, serverId, body, { idempotencyKey })),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    moveGameServer: async (slug: string, serverId: string, body: GameServerMoveRequest) => {
      const result = await gameServerMoveActions.moveGameServer(slug, serverId, body)
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    validateGameServerFiles: async (
      slug: string,
      serverId: string,
      body: Readonly<Record<string, unknown>>,
    ) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.validate-files`,
        body,
        (idempotencyKey) =>
          run(client.validateGameServerFiles(slug, serverId, body, { idempotencyKey })),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    forceCleanupGameServer: async (
      slug: string,
      serverId: string,
      body: Readonly<Record<string, unknown>>,
    ) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.force-cleanup`,
        body,
        (idempotencyKey) =>
          run(client.forceCleanupGameServer(slug, serverId, body, { idempotencyKey })),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    cloneGameServer: (slug: string, serverId: string, body: unknown) =>
      mutations.run(`organization.${slug}.game-server.${serverId}.clone`, body, (idempotencyKey) =>
        run(client.cloneGameServer(slug, serverId, body as never, { idempotencyKey })),
      ),
    validateGameServerManifest: (slug: string, body: unknown) =>
      run(client.validateGameServerManifest(slug, body as never)),
    createGameServerDraft: (slug: string, body: unknown) =>
      mutations.run(`organization.${slug}.game-server-draft.create`, body, (idempotencyKey) =>
        run(client.createGameServerDraft(slug, body as never, { idempotencyKey })),
      ),
    scheduleGameServerDraft: (slug: string, draftId: string, body: unknown) =>
      mutations.run(
        `organization.${slug}.game-server-draft.${draftId}.schedule`,
        body,
        (idempotencyKey) =>
          run(client.scheduleGameServerDraft(slug, draftId, body as never, { idempotencyKey })),
      ),
    gameConfig: (slug: string, serverId: string) => run(client.getGameConfig(slug, serverId)),
    gameConfigPreview: (slug: string, serverId: string, body: unknown) =>
      run(client.previewGameConfig(slug, serverId, body as never)),
    gameMods: (slug: string, serverId: string) => run(client.getGameMods(slug, serverId)),
    gameModsPlan: (slug: string, serverId: string, body: unknown) =>
      run(client.planMods(slug, serverId, body as never)),
    applyGameConfig: async (slug: string, serverId: string, body: unknown) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.config.apply`,
        body,
        (idempotencyKey) =>
          run(
            client.applyGameConfig(slug, serverId, body as Readonly<Record<string, unknown>>, {
              idempotencyKey,
            }),
          ),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    syncGameMods: async (slug: string, serverId: string, body: unknown) => {
      const result = await mutations.run<GameMutationResponse>(
        `organization.${slug}.game-server.${serverId}.mods.sync`,
        body,
        (idempotencyKey) =>
          run(
            client.syncGameMods(slug, serverId, body as Readonly<Record<string, unknown>>, {
              idempotencyKey,
            }),
          ),
      )
      return {
        operationId: result.operationId,
        resourceId: result.resourceId,
        status: result.status,
      }
    },
    restoreBackup: async (slug: string, input: BackupRestoreRequest) => {
      const result = await mutations.run(
        `organization.${slug}.backup.restore`,
        {
          schemaVersion: 1 as const,
          backupId: input.backupId,
          ...(input.targetServerId === undefined ? {} : { targetServerId: input.targetServerId }),
          ...(input.targetNodeId === undefined ? {} : { targetNodeId: input.targetNodeId }),
        },
        (idempotencyKey) =>
          run(
            client.restoreBackup(
              slug,
              input.backupId,
              {
                schemaVersion: 1,
                ...(input.targetServerId === undefined
                  ? {}
                  : { targetServerId: input.targetServerId }),
                ...(input.targetNodeId === undefined ? {} : { targetNodeId: input.targetNodeId }),
              },
              {
                idempotencyKey,
              },
            ),
          ),
      )
      return { operationId: result.job.operationId, status: result.job.state }
    },
    invite: async (slug: string, input: { email: string; role: string }) => {
      const body = {
        email: input.email,
        role: input.role.toLowerCase(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }
      const completed = await mutations.run(
        `organization.${slug}.invitation.create`,
        body,
        (idempotencyKey) => run(client.createInvitation(slug, body, { idempotencyKey })),
      )
      const invitation = (await run(client.invitations(slug))).find(
        (entry) => entry.id === completed.resourceId,
      )
      if (invitation === undefined)
        throw new GridoraApiError(
          409,
          'AUTHORITATIVE_STATE_UNAVAILABLE',
          'Invitation committed but authoritative state is not available',
        )
      return {
        id: invitation.id,
        email: invitation.email,
        role: roleFromApi(invitation.role) as Exclude<Role, 'Owner'>,
        status: invitation.status,
        invitedBy: invitation.inviterId,
        expiresAt: invitation.expiresAt,
        revision: invitation.revision,
      }
    },
    updateMemberRole: (slug: string, memberId: string, role: Role, expectedRevision: number) => {
      const body = { identityId: memberId, role: role.toLowerCase(), expectedRevision }
      return mutations.run(`organization.${slug}.member.role`, body, (idempotencyKey) =>
        run(
          client.updateMemberRole(slug, memberId, body.role, expectedRevision, { idempotencyKey }),
        ),
      )
    },
    removeMember: (slug: string, memberId: string, expectedRevision: number) => {
      const body = { memberId, expectedRevision }
      return mutations.run(`organization.${slug}.member.remove`, body, (idempotencyKey) =>
        run(client.removeMember(slug, memberId, expectedRevision, { idempotencyKey })),
      )
    },
    leaveOrganization: (slug: string, expectedRevision: number) => {
      const body = { expectedRevision }
      return mutations.run(`organization.${slug}.leave`, body, (idempotencyKey) =>
        run(client.leaveOrganization(slug, expectedRevision, { idempotencyKey })),
      )
    },
    deleteOrganization: (
      slug: string,
      expectedOrganizationRevision: number,
      typedSlug: string,
      backupPolicy: 'retain' | 'delete-after-retention',
    ) => {
      const body = { expectedOrganizationRevision, typedSlug, backupPolicy }
      return mutations.run(`organization.${slug}.delete`, body, (idempotencyKey) =>
        run(client.deleteOrganization(slug, body, { idempotencyKey })),
      )
    },
    transferOwnership: (slug: string, targetIdentityId: string) =>
      mutations.run(
        `organization.${slug}.ownership.transfer`,
        { targetIdentityId },
        (idempotencyKey) =>
          run(client.transferOwnership(slug, targetIdentityId, { idempotencyKey })),
      ),
    switchOrganization: (slug: string) =>
      mutations.run(`organization.${slug}.switch`, { slug }, (idempotencyKey) =>
        run(client.switchOrganization(slug, { idempotencyKey })),
      ),
    revokeInvitation: (slug: string, invitationId: string, expectedRevision: number) => {
      const body = { invitationId, expectedRevision }
      return mutations.run(`organization.${slug}.invitation.revoke`, body, (idempotencyKey) =>
        run(client.revokeInvitation(slug, invitationId, expectedRevision, { idempotencyKey })),
      )
    },
    resendInvitation: (
      slug: string,
      invitationId: string,
      expectedRevision: number,
      expiresAt: string,
    ) => {
      const body = { expectedRevision, expiresAt }
      return mutations.run(`organization.${slug}.invitation.resend`, body, (idempotencyKey) =>
        run(client.resendInvitation(slug, invitationId, body, { idempotencyKey })),
      )
    },
    cancelOperation: (slug: string, operationId: string, expectedOperationRevision: number) =>
      mutations.run(
        `organization.${slug}.operation.cancel`,
        { operationId, expectedOperationRevision },
        (idempotencyKey) =>
          run(
            client.cancelOperation(slug, operationId, expectedOperationRevision, {
              idempotencyKey,
            }),
          ),
      ),
  }
}

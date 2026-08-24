import { Effect } from 'effect'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderBillingActionRequiredError,
  ProviderConflictError,
  ProviderNotFoundError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTemporaryError,
  ProviderUnknownError,
  ProviderUnsupportedCapabilityError,
  ProviderValidationError,
  authorizeProviderAccount,
  createOrAdopt,
  managedMetadata,
  type ComputeProviderShape,
  type CreateNodeInput,
  type FirewallResult,
  type ProviderCapabilities,
  type ProviderAccountRef,
  type ProviderError,
  type ProviderNode,
  type RetirementResult,
} from '@gridora/provider-sdk'
export {
  makeContaboHttpApi,
  makeContaboOAuthHttpClient,
  type ContaboHttpOptions,
  type ContaboOAuthOptions,
} from './http.js'

export interface ContaboApiError {
  readonly status?: number
  readonly code?: string
  readonly message: string
  readonly retryAfterSeconds?: number
}
export interface ContaboApi {
  readonly regions: () => Effect.Effect<readonly { id: string; name: string }[], ContaboApiError>
  readonly products: (region?: string) => Effect.Effect<
    readonly {
      id: string
      region: string
      cpu: number
      ramMiB: number
      diskGiB: number
      monthly: number
    }[],
    ContaboApiError
  >
  readonly images: (
    region?: string,
  ) => Effect.Effect<
    readonly { id: string; name: string; architecture: 'amd64' | 'arm64'; version?: string }[],
    ContaboApiError
  >
  readonly instances: (
    labels: Readonly<Record<string, string>>,
  ) => Effect.Effect<readonly ProviderNode[], ContaboApiError>
  readonly createInstance: (
    input: CreateNodeInput,
    labels: Readonly<Record<string, string>>,
  ) => Effect.Effect<ProviderNode, ContaboApiError>
  readonly getInstance: (id: string) => Effect.Effect<ProviderNode, ContaboApiError>
  readonly action: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'reinstall',
    body?: unknown,
  ) => Effect.Effect<void, ContaboApiError>
  readonly scheduleCancellation: (
    id: string,
  ) => Effect.Effect<{ cancellationDate: string; billingStopsAt: string }, ContaboApiError>
  readonly secureWipeAndStop: (
    id: string,
  ) => Effect.Effect<{ cancellationDate?: string }, ContaboApiError>
  readonly createSnapshot: (
    id: string,
    name: string,
  ) => Effect.Effect<{ id: string; state: 'creating' }, ContaboApiError>
  readonly deleteSnapshot: (
    providerNodeId: string,
    snapshotId: string,
  ) => Effect.Effect<void, ContaboApiError>
  readonly replaceFirewall: (
    id: string,
    rules: readonly unknown[],
  ) => Effect.Effect<void, ContaboApiError>
}
export const capabilities: ProviderCapabilities = {
  hourlyBilling: false,
  immediateDelete: false,
  scheduledCancellation: true,
  cloudInit: true,
  customImages: true,
  snapshots: true,
  nativeFirewall: true,
  privateNetworking: true,
  floatingIp: false,
  rebuild: true,
}
export const normalizeContaboError = (error: ContaboApiError, operation: string): ProviderError => {
  const fields = { provider: 'contabo', operation, message: error.message }
  if (error.status === 401) return new ProviderAuthenticationError(fields)
  if (error.status === 403) return new ProviderAuthorizationError(fields)
  if (error.status === 404) return new ProviderNotFoundError(fields)
  if (error.status === 409) return new ProviderConflictError(fields)
  if (error.status === 400 || error.status === 422) return new ProviderValidationError(fields)
  if (error.status === 429)
    return new ProviderRateLimitError({ ...fields, retryAfterSeconds: error.retryAfterSeconds })
  if (error.code === 'QUOTA_EXCEEDED') return new ProviderQuotaError(fields)
  if (error.code === 'PAYMENT_REQUIRED') return new ProviderBillingActionRequiredError(fields)
  if (error.status !== undefined && error.status >= 500) return new ProviderTemporaryError(fields)
  return new ProviderUnknownError(fields)
}
const map = <A>(
  op: string,
  effect: Effect.Effect<A, ContaboApiError>,
): Effect.Effect<A, ProviderError> => Effect.mapError(effect, (e) => normalizeContaboError(e, op))
const labels = (input: CreateNodeInput): Readonly<Record<string, string>> => {
  const m = managedMetadata(input)
  return {
    'managed-by': m.managedBy,
    'organization-id': m.organizationId,
    'node-id': m.nodeId,
    'operation-id': m.operationId,
    'image-version': m.imageVersion,
  }
}

export const makeContaboProvider = (
  api: ContaboApi,
  nativeFirewallEntitled: boolean,
  account: ProviderAccountRef,
): ComputeProviderShape => {
  const authorized = <A>(
    organizationId: string,
    operation: string,
    effect: () => Effect.Effect<A, ProviderError>,
  ): Effect.Effect<A, ProviderError> =>
    Effect.andThen(
      authorizeProviderAccount(account, 'contabo', organizationId, operation),
      Effect.suspend(effect),
    )
  const listNodes: ComputeProviderShape['listNodes'] = (input) =>
    authorized(input.organizationId, 'listNodes', () =>
      map(
        'listNodes',
        api.instances({
          'managed-by': 'gridora',
          'organization-id': input.organizationId,
          ...(input.operationId === undefined ? {} : { 'operation-id': input.operationId }),
        }),
      ),
    )
  const owned = (
    organizationId: string,
    providerNodeId: string,
    operation: string,
    expectedNodeId?: string,
  ): Effect.Effect<ProviderNode, ProviderError> =>
    authorized(organizationId, operation, () =>
      Effect.flatMap(map(operation, api.getInstance(providerNodeId)), (node) =>
        node.metadata.organizationId === organizationId &&
        (expectedNodeId === undefined || node.metadata.nodeId === expectedNodeId)
          ? Effect.succeed(node)
          : Effect.fail(
              new ProviderNotFoundError({
                provider: 'contabo',
                operation,
                message: 'node not found in organization',
              }),
            ),
      ),
    )
  return {
    capabilities,
    listRegions: (input) =>
      authorized(input.organizationId, 'listRegions', () =>
        Effect.map(map('listRegions', api.regions()), (xs) =>
          xs.map((r) => ({ id: r.id, displayName: r.name })),
        ),
      ),
    listPlans: (i) =>
      authorized(i.organizationId, 'listPlans', () =>
        Effect.map(map('listPlans', api.products(i.regionId)), (xs) =>
          xs.map((p) => ({
            id: p.id,
            regionId: p.region,
            cpu: p.cpu,
            memoryMiB: p.ramMiB,
            diskGiB: p.diskGiB,
            estimatedMonthlyCost: p.monthly,
          })),
        ),
      ),
    listImages: (i) =>
      authorized(i.organizationId, 'listImages', () => map('listImages', api.images(i.regionId))),
    listNodes,
    createNode: (i) =>
      Effect.andThen(
        authorizeProviderAccount(account, 'contabo', i.organizationId, 'createNode'),
        Effect.suspend(() =>
          createOrAdopt(
            i,
            listNodes,
            (fresh) => map('createNode', api.createInstance(fresh, labels(fresh))),
            { provider: 'contabo' },
          ),
        ),
      ),
    getNode: (i) => owned(i.organizationId, i.providerNodeId, 'getNode'),
    startNode: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'startNode', i.nodeId), () =>
        map('startNode', api.action(i.providerNodeId, 'start')),
      ),
    stopNode: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'stopNode', i.nodeId), () =>
        map('stopNode', api.action(i.providerNodeId, 'stop')),
      ),
    rebootNode: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'rebootNode', i.nodeId), () =>
        map('rebootNode', api.action(i.providerNodeId, 'restart')),
      ),
    rebuildNode: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'rebuildNode', i.nodeId), () =>
        map(
          'rebuildNode',
          api.action(i.providerNodeId, 'reinstall', {
            imageId: i.imageId,
            imageVersion: i.imageVersion,
            userData: i.cloudInit,
          }),
        ),
      ),
    retireNode: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'retireNode', i.nodeId), () =>
        i.mode === 'delete'
          ? Effect.fail(
              new ProviderUnsupportedCapabilityError({
                provider: 'contabo',
                operation: 'retireNode',
                capability: 'immediateDelete',
                message: 'Contabo contracts cannot be represented as immediate deletion',
              }),
            )
          : i.mode === 'secure_wipe_and_stop'
            ? Effect.map(
                map('retireNode', api.secureWipeAndStop(i.providerNodeId)),
                (r): RetirementResult => ({
                  kind: 'secure_wipe_and_stop',
                  billingStopped: false,
                  ...(r.cancellationDate === undefined
                    ? {}
                    : { cancellationDate: r.cancellationDate }),
                }),
              )
            : Effect.map(
                map('retireNode', api.scheduleCancellation(i.providerNodeId)),
                (r): RetirementResult => ({ kind: 'cancel_at_earliest_date', ...r }),
              ),
      ),
    createSnapshot: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'createSnapshot', i.nodeId), () =>
        Effect.map(map('createSnapshot', api.createSnapshot(i.providerNodeId, i.name)), (s) => ({
          ...s,
          nodeId: i.providerNodeId,
        })),
      ),
    deleteSnapshot: (i) =>
      Effect.flatMap(owned(i.organizationId, i.providerNodeId, 'deleteSnapshot', i.nodeId), () =>
        map('deleteSnapshot', api.deleteSnapshot(i.providerNodeId, i.snapshotId)),
      ),
    applyFirewall: (i) =>
      Effect.flatMap(
        owned(i.organizationId, i.providerNodeId, 'applyFirewall', i.nodeId),
        (): Effect.Effect<FirewallResult, ProviderError> =>
          nativeFirewallEntitled
            ? Effect.as(map('applyFirewall', api.replaceFirewall(i.providerNodeId, i.rules)), {
                applied: true,
                mode: 'native',
                rules: i.rules,
              })
            : i.allowHostOnlyFallback
              ? Effect.succeed({ applied: false, mode: 'host-only', rules: i.rules })
              : Effect.fail(
                  new ProviderBillingActionRequiredError({
                    provider: 'contabo',
                    operation: 'applyFirewall',
                    message: 'native firewall entitlement is required',
                  }),
                ),
      ),
  }
}

import { Effect } from 'effect'
import {
  ProviderAuthenticationError,
  ProviderAuthorizationError,
  ProviderConflictError,
  ProviderNotFoundError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTemporaryError,
  ProviderUnknownError,
  ProviderValidationError,
  authorizeProviderAccount,
  createOrAdopt,
  managedMetadata,
  type ComputeProviderShape,
  type CreateNodeInput,
  type ProviderCapabilities,
  type ProviderAccountRef,
  type ProviderError,
  type ProviderNode,
  type RetirementResult,
} from '@gridora/provider-sdk'
export { makeOvhOpenStackHttpApi, type OvhOpenStackHttpOptions } from './http.js'

export interface OvhApiError {
  readonly status?: number
  readonly code?: string
  readonly message: string
  readonly retryAfterSeconds?: number
}
export interface OvhOpenStackApi {
  readonly regions: () => Effect.Effect<readonly { id: string; name: string }[], OvhApiError>
  readonly flavors: (region?: string) => Effect.Effect<
    readonly {
      id: string
      region: string
      vcpus: number
      ramMiB: number
      diskGiB: number
      monthly?: number
    }[],
    OvhApiError
  >
  readonly images: (
    region?: string,
  ) => Effect.Effect<
    readonly { id: string; name: string; architecture: 'amd64' | 'arm64'; version?: string }[],
    OvhApiError
  >
  readonly servers: (
    metadata: Readonly<Record<string, string>>,
  ) => Effect.Effect<readonly ProviderNode[], OvhApiError>
  readonly createServer: (
    input: CreateNodeInput,
    metadata: Readonly<Record<string, string>>,
  ) => Effect.Effect<ProviderNode, OvhApiError>
  readonly getServer: (id: string) => Effect.Effect<ProviderNode, OvhApiError>
  readonly action: (
    id: string,
    action: 'start' | 'stop' | 'reboot' | 'rebuild',
    body?: unknown,
  ) => Effect.Effect<void, OvhApiError>
  readonly deleteServer: (id: string) => Effect.Effect<void, OvhApiError>
  readonly createSnapshot: (
    id: string,
    name: string,
    metadata: Readonly<Record<string, string>>,
  ) => Effect.Effect<{ id: string; state: 'creating' }, OvhApiError>
  readonly getSnapshot: (
    id: string,
  ) => Effect.Effect<{ id: string; organizationId: string; nodeId: string }, OvhApiError>
  readonly deleteSnapshot: (id: string) => Effect.Effect<void, OvhApiError>
  readonly replaceSecurityGroupRules: (
    id: string,
    rules: readonly unknown[],
  ) => Effect.Effect<void, OvhApiError>
}

export const capabilities: ProviderCapabilities = {
  hourlyBilling: true,
  immediateDelete: true,
  scheduledCancellation: false,
  cloudInit: true,
  customImages: true,
  snapshots: true,
  nativeFirewall: true,
  privateNetworking: true,
  floatingIp: true,
  rebuild: true,
}

export const normalizeOvhError = (error: OvhApiError, operation: string): ProviderError => {
  const fields = { provider: 'ovhcloud', operation, message: error.message }
  if (error.status === 401) return new ProviderAuthenticationError(fields)
  if (error.status === 403) return new ProviderAuthorizationError(fields)
  if (error.status === 404) return new ProviderNotFoundError(fields)
  if (error.status === 409) return new ProviderConflictError(fields)
  if (error.status === 422 || error.status === 400) return new ProviderValidationError(fields)
  if (error.status === 429)
    return new ProviderRateLimitError({ ...fields, retryAfterSeconds: error.retryAfterSeconds })
  if (error.code === 'QUOTA_EXCEEDED') return new ProviderQuotaError(fields)
  if (error.status !== undefined && error.status >= 500) return new ProviderTemporaryError(fields)
  return new ProviderUnknownError(fields)
}
const map = <A>(
  operation: string,
  effect: Effect.Effect<A, OvhApiError>,
): Effect.Effect<A, ProviderError> =>
  Effect.mapError(effect, (error) => normalizeOvhError(error, operation))
const metadataRecord = (input: CreateNodeInput): Readonly<Record<string, string>> => {
  const m = managedMetadata(input)
  return {
    'managed-by': m.managedBy,
    'organization-id': m.organizationId,
    'node-id': m.nodeId,
    'operation-id': m.operationId,
    'image-version': m.imageVersion,
  }
}

export const makeOvhPublicCloudProvider = (
  api: OvhOpenStackApi,
  account: ProviderAccountRef,
): ComputeProviderShape => {
  const authorized = <A>(
    organizationId: string,
    operation: string,
    effect: () => Effect.Effect<A, ProviderError>,
  ): Effect.Effect<A, ProviderError> =>
    Effect.andThen(
      authorizeProviderAccount(account, 'ovhcloud', organizationId, operation),
      Effect.suspend(effect),
    )
  const listNodes: ComputeProviderShape['listNodes'] = (input) =>
    authorized(input.organizationId, 'listNodes', () =>
      map(
        'listNodes',
        api.servers({
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
      Effect.flatMap(map(operation, api.getServer(providerNodeId)), (node) =>
        node.metadata.organizationId === organizationId &&
        (expectedNodeId === undefined || node.metadata.nodeId === expectedNodeId)
          ? Effect.succeed(node)
          : Effect.fail(
              new ProviderNotFoundError({
                provider: 'ovhcloud',
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
        Effect.map(map('listRegions', api.regions()), (items) =>
          items.map((r) => ({ id: r.id, displayName: r.name })),
        ),
      ),
    listPlans: (input) =>
      authorized(input.organizationId, 'listPlans', () =>
        Effect.map(map('listPlans', api.flavors(input.regionId)), (items) =>
          items.map((p) => ({
            id: p.id,
            regionId: p.region,
            cpu: p.vcpus,
            memoryMiB: p.ramMiB,
            diskGiB: p.diskGiB,
            ...(p.monthly === undefined ? {} : { estimatedMonthlyCost: p.monthly }),
          })),
        ),
      ),
    listImages: (input) =>
      authorized(input.organizationId, 'listImages', () =>
        map('listImages', api.images(input.regionId)),
      ),
    listNodes,
    createNode: (input) =>
      Effect.andThen(
        authorizeProviderAccount(account, 'ovhcloud', input.organizationId, 'createNode'),
        Effect.suspend(() =>
          createOrAdopt(
            input,
            listNodes,
            (fresh) => map('createNode', api.createServer(fresh, metadataRecord(fresh))),
            { provider: 'ovhcloud' },
          ),
        ),
      ),
    getNode: (input) => owned(input.organizationId, input.providerNodeId, 'getNode'),
    startNode: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'startNode', input.nodeId),
        () => map('startNode', api.action(input.providerNodeId, 'start')),
      ),
    stopNode: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'stopNode', input.nodeId),
        () => map('stopNode', api.action(input.providerNodeId, 'stop')),
      ),
    rebootNode: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'rebootNode', input.nodeId),
        () => map('rebootNode', api.action(input.providerNodeId, 'reboot')),
      ),
    rebuildNode: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'rebuildNode', input.nodeId),
        () =>
          map(
            'rebuildNode',
            api.action(input.providerNodeId, 'rebuild', {
              imageId: input.imageId,
              imageVersion: input.imageVersion,
              userData: input.cloudInit,
            }),
          ),
      ),
    retireNode: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'retireNode', input.nodeId),
        () =>
          Effect.as(map('retireNode', api.deleteServer(input.providerNodeId)), {
            kind: 'deleted',
            billingStopped: true,
          } satisfies RetirementResult),
      ),
    createSnapshot: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'createSnapshot', input.nodeId),
        (node) =>
          Effect.map(
            map(
              'createSnapshot',
              api.createSnapshot(input.providerNodeId, input.name, {
                'managed-by': 'gridora',
                'organization-id': input.organizationId,
                'node-id': node.metadata.nodeId,
              }),
            ),
            (s) => ({ ...s, nodeId: input.providerNodeId }),
          ),
      ),
    deleteSnapshot: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'deleteSnapshot', input.nodeId),
        (node) =>
          Effect.flatMap(map('deleteSnapshot', api.getSnapshot(input.snapshotId)), (snapshot) =>
            snapshot.organizationId === input.organizationId &&
            snapshot.nodeId === node.metadata.nodeId
              ? map('deleteSnapshot', api.deleteSnapshot(input.snapshotId))
              : Effect.fail(
                  new ProviderNotFoundError({
                    provider: 'ovhcloud',
                    operation: 'deleteSnapshot',
                    message: 'snapshot not found for organization and node',
                  }),
                ),
          ),
      ),
    applyFirewall: (input) =>
      Effect.flatMap(
        owned(input.organizationId, input.providerNodeId, 'applyFirewall', input.nodeId),
        () =>
          Effect.as(
            map('applyFirewall', api.replaceSecurityGroupRules(input.providerNodeId, input.rules)),
            { applied: true, mode: 'native', rules: input.rules },
          ),
      ),
  }
}

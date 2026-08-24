import { Effect, Schema } from 'effect'
import { ContaboCredentials, OvhPublicCloudCredentials } from '@gridora/contracts'
import {
  OrphanControlError,
  type OrphanDiscoveryPortShape,
  type OrphanProviderType,
  type OrphanReconciliationRequest,
} from '@gridora/orphan-control'
import type { ListNodesInput, ProviderError, ProviderNode } from '@gridora/provider-sdk'

const MAX_CREDENTIAL_BYTES = 64 * 1024
const MAX_DISCOVERED_NODES = 200

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
)

export interface OrphanDiscoveryAccount {
  readonly id: string
  readonly scope: 'platform' | 'organization'
  /** The tenant allocation used for this discovery run. */
  readonly organizationId: string
  /** Null only for a platform-owned account. */
  readonly accountOrganizationId: string | null
  readonly providerType: OrphanProviderType
  readonly credentialReference: string
  /** Both organization and platform envelopes are revision-fenced at commit time. */
  readonly credentialRevision: number
  readonly status: 'active' | 'disabled' | 'error'
}

export type ReadOnlyListNodes = (
  input: ListNodesInput,
) => Effect.Effect<ReadonlyArray<ProviderNode>, ProviderError>

export interface OrphanProviderDiscoveryDependencies {
  readonly loadAccount: (
    request: OrphanReconciliationRequest,
  ) => Effect.Effect<OrphanDiscoveryAccount, OrphanControlError>
  readonly openCredentials: (
    request: OrphanReconciliationRequest,
    account: OrphanDiscoveryAccount,
  ) => Effect.Effect<Uint8Array, OrphanControlError>
  /** The factory can return only the reviewed read capability. */
  readonly ovhcloud: (
    credentials: typeof OvhPublicCloudCredentials.Type,
    account: OrphanDiscoveryAccount,
  ) => Effect.Effect<ReadOnlyListNodes, ProviderError>
  /** The factory can return only the reviewed read capability. */
  readonly contabo: (
    credentials: typeof ContaboCredentials.Type,
    account: OrphanDiscoveryAccount,
  ) => Effect.Effect<ReadOnlyListNodes, ProviderError>
  readonly now?: () => Date
}

const failure = (
  operation: string,
  code: 'invalid-scope' | 'unbounded-discovery' | 'discovery-failed' = 'discovery-failed',
) => new OrphanControlError({ operation, code, message: 'orphan reconciliation failed' })

const accountIsBound = (
  request: OrphanReconciliationRequest,
  account: OrphanDiscoveryAccount,
): boolean =>
  account.id === request.providerAccountId &&
  account.organizationId === request.organizationId &&
  ((account.scope === 'platform' && account.accountOrganizationId === null) ||
    (account.scope === 'organization' &&
      account.accountOrganizationId === request.organizationId)) &&
  account.providerType === request.providerType &&
  account.status === 'active' &&
  account.credentialReference.length > 0 &&
  Number.isSafeInteger(account.credentialRevision) &&
  account.credentialRevision >= 1

const strictJson = (bytes: Uint8Array): Effect.Effect<unknown, OrphanControlError> =>
  bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_BYTES
    ? Effect.fail(failure('orphan.discovery.credentials'))
    : Effect.try({
        try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
        catch: () => failure('orphan.discovery.credentials'),
      })

const exactEndpoint = (
  value: string,
  allowed: (url: URL) => boolean,
): Effect.Effect<void, OrphanControlError> =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        !allowed(url)
      )
        throw new Error('endpoint rejected')
    },
    catch: () => failure('orphan.discovery.credentials.endpoint'),
  })

const decodeOvh = (bytes: Uint8Array) =>
  Effect.flatMap(strictJson(bytes), (value) =>
    Schema.decodeUnknownEffect(OvhPublicCloudCredentials, { onExcessProperty: 'error' })(
      value,
    ).pipe(
      Effect.mapError(() => failure('orphan.discovery.credentials.ovhcloud')),
      Effect.tap((credentials) =>
        exactEndpoint(
          credentials.authUrl,
          (url) =>
            (url.hostname === 'auth.cloud.ovh.net' || url.hostname === 'auth.cloud.ovh.us') &&
            /^\/v3(?:\.0)?\/?$/.test(url.pathname),
        ),
      ),
    ),
  )

const decodeContabo = (bytes: Uint8Array) =>
  Effect.flatMap(strictJson(bytes), (value) =>
    Schema.decodeUnknownEffect(ContaboCredentials, { onExcessProperty: 'error' })(value).pipe(
      Effect.mapError(() => failure('orphan.discovery.credentials.contabo')),
      Effect.tap((credentials) =>
        Effect.all(
          [
            exactEndpoint(
              credentials.tokenUrl,
              (url) =>
                url.hostname === 'auth.contabo.com' &&
                url.pathname === '/auth/realms/contabo/protocol/openid-connect/token',
            ),
            exactEndpoint(
              credentials.apiBaseUrl,
              (url) => url.hostname === 'api.contabo.com' && /^\/?$/.test(url.pathname),
            ),
          ],
          { discard: true },
        ),
      ),
    ),
  )

const ProviderNodeContract = Schema.Struct({
  id: Identifier,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  state: Schema.Literals([
    'creating',
    'active',
    'stopped',
    'rebuilding',
    'retiring',
    'retired',
    'unknown',
  ]),
  regionId: Identifier,
  planId: Identifier,
  addresses: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(64),
  ),
  metadata: Schema.Struct({
    managedBy: Schema.Literal('gridora'),
    organizationId: Identifier,
    nodeId: Identifier,
    operationId: Identifier,
    imageVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  contract: Schema.optional(
    Schema.Struct({
      periodEndsAt: Schema.String.check(Schema.isMaxLength(128)),
      cancellationDate: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
      billingStopsAt: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    }),
  ),
})

const decodeNodes = (value: unknown) => {
  if (Array.isArray(value) && value.length > MAX_DISCOVERED_NODES)
    return Effect.fail(failure('orphan.discovery.nodes.bound', 'unbounded-discovery'))
  return Schema.decodeUnknownEffect(Schema.Array(ProviderNodeContract), {
    onExcessProperty: 'error',
  })(value).pipe(Effect.mapError(() => failure('orphan.discovery.nodes.decode')))
}

/**
 * Build the only provider-facing port consumed by orphan control. The port can
 * list nodes and cannot express a provider mutation.
 */
export const makeOrphanProviderDiscovery = (
  dependencies: OrphanProviderDiscoveryDependencies,
): OrphanDiscoveryPortShape => ({
  discover: (request) =>
    Effect.gen(function* () {
      const account = yield* dependencies.loadAccount(request)
      if (!accountIsBound(request, account))
        return yield* failure('orphan.discovery.account.scope', 'invalid-scope')

      const nodes = yield* Effect.acquireUseRelease(
        dependencies.openCredentials(request, account),
        (credentialBytes) =>
          Effect.gen(function* () {
            const listNodes =
              account.providerType === 'ovhcloud'
                ? yield* Effect.flatMap(decodeOvh(credentialBytes), (credentials) =>
                    dependencies.ovhcloud(credentials, account),
                  ).pipe(Effect.mapError(() => failure('orphan.discovery.provider.ovhcloud')))
                : yield* Effect.flatMap(decodeContabo(credentialBytes), (credentials) =>
                    dependencies.contabo(credentials, account),
                  ).pipe(Effect.mapError(() => failure('orphan.discovery.provider.contabo')))
            const discovered = yield* listNodes({ organizationId: request.organizationId }).pipe(
              Effect.mapError(() => failure('orphan.discovery.provider.listNodes')),
            )
            return yield* decodeNodes(discovered)
          }),
        (credentialBytes) => Effect.sync(() => credentialBytes.fill(0)),
      )

      const resourceIds = new Set<string>()
      for (const node of nodes) {
        if (resourceIds.has(node.id)) return yield* failure('orphan.discovery.nodes.duplicate')
        resourceIds.add(node.id)
        if (node.metadata.organizationId !== request.organizationId)
          return yield* failure('orphan.discovery.nodes.foreign', 'invalid-scope')
      }

      const observedAt = (dependencies.now ?? (() => new Date()))().toISOString()
      return {
        organizationId: request.organizationId,
        providerAccountId: request.providerAccountId,
        providerType: request.providerType,
        credentialReference: account.credentialReference,
        credentialRevision: account.credentialRevision,
        requestId: request.runId,
        observedAt,
        complete: true,
        truncated: false,
        continuationToken: null,
        resources: nodes.map((node) => ({
          kind: 'node' as const,
          providerResourceId: node.id,
          ownership: {
            managedBy: node.metadata.managedBy,
            organizationId: node.metadata.organizationId,
            nodeId: node.metadata.nodeId,
            operationId: node.metadata.operationId,
            imageVersion: node.metadata.imageVersion,
          },
        })),
        // Absence in a complete list is not proof of deletion.
        removalEvidence: [],
      }
    }),
})

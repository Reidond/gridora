import { Effect, Schema } from 'effect'
import { ContaboCredentials, OvhPublicCloudCredentials } from '@gridora/contracts'
import {
  CorrelationId,
  IdentityId,
  OrganizationContext,
  OrganizationId,
  OrganizationSlug,
} from '@gridora/domain'
import { makePlatformSecretRepositoryD1 } from '@gridora/platform-provider-d1'
import { makePlatformSecretEnvelope } from '@gridora/platform-secret-envelope'
import {
  makeContaboHttpApi,
  makeContaboOAuthHttpClient,
  makeContaboProvider,
} from '@gridora/provider-contabo'
import {
  makeOvhOpenStackHttpApi,
  makeOvhPublicCloudProvider,
} from '@gridora/provider-ovh-public-cloud'
import {
  ProviderAuthenticationError,
  ProviderTemporaryError,
  ProviderTransportError,
  ProviderValidationError,
  type JsonHttpClientShape,
  type ProviderAccountRef,
  type ProviderError,
} from '@gridora/provider-sdk'
import {
  isAllowedContaboApiBaseUrl,
  isAllowedContaboTokenUrl,
  isAllowedOvhAuthUrl,
} from '@gridora/provider-runtime'
import type {
  ProviderNodeLifecycleAdapterResolverShape,
  ProviderNodeLifecycleTarget,
  ProviderRuntimeLifecycleAdapter,
} from '@gridora/provider-node-lifecycle-transports'
import { makeSecretEnvelopeService, type KekPortShape } from '@gridora/secret-envelope'
import { makeSecretEnvelopeRepositoryD1, type SecretD1Database } from '@gridora/secret-envelope-d1'
import type { PlatformProviderD1Database } from '@gridora/platform-provider-d1'
import type { NodeRuntimeLifecycleD1Database } from '@gridora/node-runtime-lifecycle-d1'
import type { LifecycleTerminationD1Database } from '@gridora/lifecycle-termination-d1'

/**
 * This composition root opens one provider client only for the immutable
 * runtime-execution binding.  It never selects a "similar" account, envelope,
 * allocation, or provider instance after the HTTP acceptance has committed.
 */

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const text = (value: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof value[key] === 'string' ? (value[key] as string) : undefined

const integer = (value: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof value[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined

const validation = (provider: 'ovhcloud' | 'contabo', operation: string, message: string) =>
  new ProviderValidationError({ provider, operation, message })

const authentication = (provider: 'ovhcloud' | 'contabo', operation: string) =>
  new ProviderAuthenticationError({
    provider,
    operation,
    message: 'Provider credentials could not be opened for the accepted runtime operation',
  })

const temporary = (provider: 'ovhcloud' | 'contabo', operation: string) =>
  new ProviderTemporaryError({
    provider,
    operation,
    message: 'Provider lifecycle transport is temporarily unavailable',
  })

const exactCredentialSql = `SELECT account.id AS accountId, account.scope AS accountScope,
  account.organization_id AS accountOrganizationId, account.provider_type AS providerType,
  account.status AS accountStatus, account.revision AS accountRevision,
  account.credential_reference AS credentialReference,
  organization.slug AS organizationSlug, operation.actor_id AS actorId,
  operation.correlation_id AS correlationId,
  allocation.revision AS allocationRevision,
  CASE WHEN account.scope = 'platform' THEN platformSecret.revision ELSE tenantSecret.revision END
    AS envelopeRevision
FROM node_runtime_lifecycle_executions execution
JOIN operations operation
  ON operation.organization_id = execution.organization_id AND operation.id = execution.operation_id
JOIN organizations organization ON organization.id = execution.organization_id
JOIN nodes node ON node.organization_id = execution.organization_id AND node.id = execution.node_id
JOIN provider_accounts account ON account.id = execution.provider_account_id
JOIN provider_allocations allocation
  ON allocation.organization_id = execution.organization_id AND allocation.provider_account_id = account.id
LEFT JOIN secret_envelopes tenantSecret
  ON account.scope = 'organization' AND tenantSecret.organization_id = execution.organization_id
 AND tenantSecret.id = account.credential_reference AND tenantSecret.scope_type = 'provider-account'
 AND tenantSecret.scope_id = account.id
LEFT JOIN platform_secret_envelopes platformSecret
  ON account.scope = 'platform' AND platformSecret.id = account.credential_reference
 AND platformSecret.scope_type = 'provider-account' AND platformSecret.scope_id = account.id
WHERE execution.organization_id = ? AND execution.operation_id = ? AND execution.node_id = ?
  AND execution.provider_type = ? AND execution.provider_instance_id = ?
  AND execution.provider_account_id = ? AND execution.provider_account_scope = ?
  AND execution.provider_account_revision = ? AND execution.provider_allocation_revision = ?
  AND execution.provider_credential_reference = ? AND execution.provider_credential_revision = ?
  AND node.provider_instance_id = execution.provider_instance_id
  AND node.provider_account_id = execution.provider_account_id
  AND node.provider_type = execution.provider_type
  AND account.scope = execution.provider_account_scope
  AND account.revision = execution.provider_account_revision
  AND account.credential_reference = execution.provider_credential_reference
  AND account.provider_type = execution.provider_type AND account.status = 'active'
  AND allocation.status = 'active' AND allocation.revision = execution.provider_allocation_revision
  AND (account.scope = 'platform' OR account.organization_id = execution.organization_id)
  AND ((account.scope = 'organization' AND tenantSecret.revision = execution.provider_credential_revision)
    OR (account.scope = 'platform' AND platformSecret.revision = execution.provider_credential_revision))`

const loadExactCredential = (
  database: NodeRuntimeLifecycleD1Database,
  target: ProviderNodeLifecycleTarget,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(exactCredentialSql)
        .bind(
          target.organizationId,
          target.operationId,
          target.nodeId,
          target.provider,
          target.providerNodeId,
          target.credentialBinding.providerAccountId,
          target.credentialBinding.providerAccountScope,
          target.credentialBinding.providerAccountRevision,
          target.credentialBinding.providerAllocationRevision,
          target.credentialBinding.providerCredentialReference,
          target.credentialBinding.providerCredentialRevision,
        )
        .first(),
    catch: () => temporary(target.provider, 'nodeRuntimeLifecycle.credential.read'),
  })

const sameBinding = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
) =>
  [
    'accountId',
    'accountScope',
    'accountOrganizationId',
    'providerType',
    'accountStatus',
    'accountRevision',
    'credentialReference',
    'allocationRevision',
    'envelopeRevision',
    'organizationSlug',
    'actorId',
    'correlationId',
  ].every((field) => before[field] === after[field])

const accountFor = (
  target: ProviderNodeLifecycleTarget,
  row: Readonly<Record<string, unknown>>,
): ProviderAccountRef | undefined => {
  const scope = text(row, 'accountScope')
  if (scope === 'platform')
    return { id: target.credentialBinding.providerAccountId, provider: target.provider, scope }
  if (scope === 'organization')
    return {
      id: target.credentialBinding.providerAccountId,
      provider: target.provider,
      scope,
      organizationId: target.organizationId,
    }
  return undefined
}

const organizationContextFor = (
  target: Pick<ProviderNodeLifecycleTarget, 'organizationId'>,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<OrganizationContext, ProviderError> =>
  Effect.all({
    // A platform account has no tenant organization_id. The accepted target is
    // the only tenant authority for both platform and organization accounts.
    organizationId: Schema.decodeUnknownEffect(OrganizationId)(target.organizationId),
    organizationSlug: Schema.decodeUnknownEffect(OrganizationSlug)(row.organizationSlug),
    identityId: Schema.decodeUnknownEffect(IdentityId)(row.actorId),
    correlationId: Schema.decodeUnknownEffect(CorrelationId)(row.correlationId),
  }).pipe(
    Effect.map((value) => new OrganizationContext({ ...value, role: 'automation' })),
    Effect.mapError(() => temporary('ovhcloud', 'nodeRuntimeLifecycle.credential.context')),
  )

const credentialJson = (
  provider: 'ovhcloud' | 'contabo',
  bytes: Uint8Array,
): Effect.Effect<unknown, ProviderError> =>
  Effect.try({
    try: () => {
      if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024)
        throw new Error('invalid credential envelope length')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    },
    catch: () =>
      validation(
        provider,
        'nodeRuntimeLifecycle.credential.decode',
        'Provider credential is invalid',
      ),
  })

const decodeOvh = (bytes: Uint8Array) =>
  credentialJson('ovhcloud', bytes).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(OvhPublicCloudCredentials, { onExcessProperty: 'error' })(
        value,
      ).pipe(
        Effect.mapError(() =>
          validation(
            'ovhcloud',
            'nodeRuntimeLifecycle.credential.decode',
            'Provider credential is invalid',
          ),
        ),
      ),
    ),
    Effect.filterOrFail(
      (credentials) => isAllowedOvhAuthUrl(credentials.authUrl),
      () =>
        validation(
          'ovhcloud',
          'nodeRuntimeLifecycle.credential.endpoint',
          'OVH authentication endpoint is not allow-listed',
        ),
    ),
  )

const decodeContabo = (bytes: Uint8Array) =>
  credentialJson('contabo', bytes).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ContaboCredentials, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(() =>
          validation(
            'contabo',
            'nodeRuntimeLifecycle.credential.decode',
            'Provider credential is invalid',
          ),
        ),
      ),
    ),
    Effect.filterOrFail(
      (credentials) =>
        isAllowedContaboTokenUrl(credentials.tokenUrl) &&
        isAllowedContaboApiBaseUrl(credentials.apiBaseUrl),
      () =>
        validation(
          'contabo',
          'nodeRuntimeLifecycle.credential.endpoint',
          'Contabo endpoint is not allow-listed',
        ),
    ),
  )

const allowedOvhCatalogEndpoint = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.port === '' &&
  url.username === '' &&
  url.password === '' &&
  url.hostname.endsWith('.cloud.ovh.net') &&
  url.search === '' &&
  url.hash === ''

const jsonField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined

const stringField = (value: unknown, key: string): string | undefined => {
  const item = jsonField(value, key)
  return typeof item === 'string' ? item : undefined
}

const arrayField = (value: unknown, key: string): readonly unknown[] | undefined => {
  const item = jsonField(value, key)
  return Array.isArray(item) ? item : undefined
}

const appendPath = (base: URL, path: string): URL | undefined => {
  if (!path.startsWith('/')) return undefined
  const relative = new URL(path, 'https://gridora.invalid')
  if (
    relative.origin !== 'https://gridora.invalid' ||
    relative.username !== '' ||
    relative.password !== ''
  )
    return undefined
  const result = new URL(base)
  result.pathname = `${base.pathname.replace(/\/$/, '')}${relative.pathname}`
  result.search = relative.search
  result.hash = ''
  return result
}

const fetchJson = (base: URL, headers: Readonly<Record<string, string>>): JsonHttpClientShape => ({
  request: (input) =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = appendPath(base, input.path)
        if (url === undefined) throw new Error('invalid provider path')
        const response = await fetch(url, {
          method: input.method,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            ...headers,
            ...input.headers,
            ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal,
        })
        const bodyText = await response.text()
        if (bodyText.length > 1_048_576) throw new Error('provider response too large')
        let body: unknown = undefined
        if (bodyText.length > 0) {
          try {
            body = JSON.parse(bodyText)
          } catch {
            throw new Error('provider response is not JSON')
          }
        }
        return {
          status: response.status,
          body,
          headers: Object.fromEntries(response.headers.entries()),
        }
      },
      catch: () =>
        new ProviderTransportError({
          message: 'Provider lifecycle transport is unavailable',
          retryable: true,
        }),
    }),
})

const ovhAdapter = (
  credentials: typeof OvhPublicCloudCredentials.Type,
  account: ProviderAccountRef,
): Effect.Effect<ProviderRuntimeLifecycleAdapter, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(new URL('/v3/auth/tokens', credentials.authUrl), {
        method: 'POST',
        redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          auth: {
            identity: {
              methods: ['application_credential'],
              application_credential: {
                id: credentials.applicationCredentialId,
                secret: credentials.applicationCredentialSecret,
              },
            },
          },
        }),
        signal,
      })
      if (response.status !== 201) throw new Error('authentication rejected')
      const token = response.headers.get('x-subject-token')
      const raw = await response.text()
      if (token === null || token.length < 16 || token.length > 16_384 || raw.length > 1_048_576)
        throw new Error('invalid authentication response')
      const payload: unknown = JSON.parse(raw)
      const services = arrayField(jsonField(payload, 'token'), 'catalog') ?? []
      const candidates: URL[] = []
      for (const service of services) {
        if (stringField(service, 'type') !== 'compute') continue
        for (const endpoint of arrayField(service, 'endpoints') ?? []) {
          if (
            stringField(endpoint, 'interface') !== 'public' ||
            stringField(endpoint, 'region') !== credentials.region
          )
            continue
          const rawEndpoint = stringField(endpoint, 'url')
          if (rawEndpoint === undefined) continue
          try {
            const endpointUrl = new URL(rawEndpoint)
            if (
              allowedOvhCatalogEndpoint(endpointUrl) &&
              endpointUrl.pathname.includes(credentials.projectId)
            )
              candidates.push(endpointUrl)
          } catch {
            // A malformed catalog endpoint is never a safe fallback.
          }
        }
      }
      if (candidates.length !== 1) throw new Error('ambiguous compute catalog')
      return { token, compute: candidates[0]! }
    },
    catch: () => authentication('ovhcloud', 'nodeRuntimeLifecycle.authenticate'),
  }).pipe(
    Effect.map(({ token, compute }) => {
      const http = fetchJson(compute, { 'x-auth-token': token })
      const api = makeOvhOpenStackHttpApi(http, {
        regions: [{ id: credentials.region, name: credentials.region }],
        regionId: credentials.region,
        networkHttp: http,
        securityGroupIdForServer: (nodeId) => `gridora-${nodeId}`,
        securityGroupOwnershipDescription: (nodeId) => `gridora:node=${nodeId}`,
      })
      return {
        provider: makeOvhPublicCloudProvider(api, account),
        capabilities: { start: true, stop: true, reboot: true, observe: true },
      }
    }),
  )

const contaboAdapter = (
  credentials: typeof ContaboCredentials.Type,
  account: ProviderAccountRef,
): Effect.Effect<ProviderRuntimeLifecycleAdapter, ProviderError> =>
  makeContaboOAuthHttpClient(credentials).pipe(
    Effect.map((http) => {
      const api = makeContaboHttpApi(http, {
        contractPeriodMonths: 1,
        requestId: () => crypto.randomUUID(),
        cancellation: () => {
          const now = Date.now()
          return {
            cancellationDate: new Date(now + 24 * 60 * 60_000).toISOString(),
            billingStopsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
          }
        },
        secureWipeAndStop: () =>
          Effect.fail({ message: 'Secure wipe is not a node-runtime lifecycle action' }),
        firewallIdForInstance: (nodeId) => `gridora-${nodeId}`,
        firewallOwnershipDescription: (nodeId) => `gridora:node=${nodeId}`,
      })
      return {
        provider: makeContaboProvider(api, false, account),
        capabilities: { start: true, stop: true, reboot: true, observe: true },
      }
    }),
  )

/**
 * The caller gets a provider adapter only after a second exact D1 read proves
 * that account, allocation, envelope, and actor/correlation coordinates did
 * not change while the envelope was being decrypted.
 */
export const makeProviderNodeLifecycleAdapterResolver = (
  database: NodeRuntimeLifecycleD1Database,
  kek: KekPortShape,
): ProviderNodeLifecycleAdapterResolverShape => {
  // Cloudflare's D1 binding has the superset of these read/write methods. The
  // lifecycle package intentionally exposes the narrower read/batch shape, so
  // retain this boundary cast rather than weakening its public database port.
  const tenantSecrets = makeSecretEnvelopeService(
    makeSecretEnvelopeRepositoryD1(database as unknown as SecretD1Database),
    kek,
  )
  const platformSecrets = makePlatformSecretEnvelope(
    makePlatformSecretRepositoryD1(database as unknown as PlatformProviderD1Database),
    kek,
  )
  return {
    openExact: (target) =>
      Effect.gen(function* () {
        const before = record(yield* loadExactCredential(database, target))
        const account = before === undefined ? undefined : accountFor(target, before)
        if (
          before === undefined ||
          account === undefined ||
          text(before, 'accountId') !== target.credentialBinding.providerAccountId ||
          text(before, 'providerType') !== target.provider ||
          text(before, 'accountStatus') !== 'active' ||
          integer(before, 'accountRevision') !== target.credentialBinding.providerAccountRevision ||
          integer(before, 'allocationRevision') !==
            target.credentialBinding.providerAllocationRevision ||
          text(before, 'credentialReference') !==
            target.credentialBinding.providerCredentialReference ||
          integer(before, 'envelopeRevision') !==
            target.credentialBinding.providerCredentialRevision
        )
          return yield* validation(
            target.provider,
            'nodeRuntimeLifecycle.credential.fence',
            'Accepted provider binding is no longer active',
          )

        const open =
          account.scope === 'organization'
            ? tenantSecrets
                .open(yield* organizationContextFor(target, before), {
                  id: target.credentialBinding.providerCredentialReference,
                  scopeType: 'provider-account',
                  scopeId: target.credentialBinding.providerAccountId,
                })
                .pipe(
                  Effect.mapError(() =>
                    authentication(target.provider, 'nodeRuntimeLifecycle.credential.open'),
                  ),
                )
            : platformSecrets
                .open(target.credentialBinding.providerAccountId)
                .pipe(
                  Effect.mapError(() =>
                    authentication(target.provider, 'nodeRuntimeLifecycle.credential.open'),
                  ),
                )

        return yield* Effect.acquireUseRelease(
          open,
          (plain) =>
            Effect.gen(function* () {
              const after = record(yield* loadExactCredential(database, target))
              if (after === undefined || !sameBinding(before, after))
                return yield* validation(
                  target.provider,
                  'nodeRuntimeLifecycle.credential.fence',
                  'Accepted provider binding changed during credential open',
                )
              if (target.provider === 'ovhcloud') {
                const decoded = yield* decodeOvh(plain)
                return yield* ovhAdapter(decoded, account)
              }
              const decoded = yield* decodeContabo(plain)
              return yield* contaboAdapter(decoded, account)
            }),
          (plain) => Effect.sync(() => plain.fill(0)),
        )
      }),
  }
}

/**
 * The destructive lifecycle is intentionally a separate target type. Its
 * frozen coordinates are committed in node_lifecycle_runs, rather than the
 * runtime-lifecycle execution table, and a rebuild also carries the exact
 * promoted provider-image mapping selected at acceptance.
 */
export interface NodeTerminationProviderTarget extends ProviderNodeLifecycleTarget {
  readonly action: 'rebuild-node' | 'retire-node'
  readonly targetImageId?: string
  readonly targetProviderImageId?: string
  readonly targetImageVersion?: string
  readonly targetImageChecksum?: string
}

export interface NodeTerminationProviderAdapterResolverShape {
  readonly openExact: (
    input: NodeTerminationProviderTarget,
  ) => Effect.Effect<ProviderRuntimeLifecycleAdapter, ProviderError>
}

const terminationExactCredentialSql = `SELECT account.id AS accountId, account.scope AS accountScope,
  account.organization_id AS accountOrganizationId, account.provider_type AS providerType,
  account.status AS accountStatus, account.revision AS accountRevision,
  account.credential_reference AS credentialReference,
  organization.slug AS organizationSlug, operation.actor_id AS actorId,
  operation.correlation_id AS correlationId,
  allocation.revision AS allocationRevision,
  CASE WHEN account.scope = 'platform' THEN platformSecret.revision ELSE tenantSecret.revision END
    AS envelopeRevision,
  run.action AS lifecycleAction, run.target_image_id AS targetImageId,
  run.target_provider_image_id AS targetProviderImageId,
  run.target_image_version_snapshot AS targetImageVersion,
  run.target_image_checksum_snapshot AS targetImageChecksum
FROM node_lifecycle_runs run
JOIN operations operation
  ON operation.organization_id = run.organization_id AND operation.id = run.operation_id
JOIN organizations organization ON organization.id = run.organization_id
JOIN nodes node ON node.organization_id = run.organization_id AND node.id = run.node_id
JOIN provider_accounts account ON account.id = run.provider_account_id
JOIN provider_allocations allocation
  ON allocation.organization_id = run.organization_id AND allocation.provider_account_id = account.id
LEFT JOIN secret_envelopes tenantSecret
  ON account.scope = 'organization' AND tenantSecret.organization_id = run.organization_id
 AND tenantSecret.id = account.credential_reference AND tenantSecret.scope_type = 'provider-account'
 AND tenantSecret.scope_id = account.id
LEFT JOIN platform_secret_envelopes platformSecret
  ON account.scope = 'platform' AND platformSecret.id = account.credential_reference
 AND platformSecret.scope_type = 'provider-account' AND platformSecret.scope_id = account.id
WHERE run.organization_id = ? AND run.operation_id = ? AND run.node_id = ? AND run.action = ?
  AND run.provider_type_snapshot = ? AND run.provider_instance_id_snapshot = ?
  AND run.provider_account_id = ? AND run.provider_account_scope = ?
  AND run.provider_account_revision = ? AND run.provider_allocation_revision = ?
  AND run.provider_credential_reference = ? AND run.provider_credential_revision = ?
  AND node.provider_instance_id = run.provider_instance_id_snapshot
  AND node.provider_account_id = run.provider_account_id
  AND node.provider_type = run.provider_type_snapshot
  AND node.pending_lifecycle_operation_id = run.operation_id
  AND account.scope = run.provider_account_scope
  AND account.revision = run.provider_account_revision
  AND account.credential_reference = run.provider_credential_reference
  AND account.provider_type = run.provider_type_snapshot AND account.status = 'active'
  AND allocation.status = 'active' AND allocation.revision = run.provider_allocation_revision
  AND (account.scope = 'platform' OR account.organization_id = run.organization_id)
  AND ((account.scope = 'organization' AND tenantSecret.revision = run.provider_credential_revision)
    OR (account.scope = 'platform' AND platformSecret.revision = run.provider_credential_revision))`

const loadExactTerminationCredential = (
  database: LifecycleTerminationD1Database,
  target: NodeTerminationProviderTarget,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(terminationExactCredentialSql)
        .bind(
          target.organizationId,
          target.operationId,
          target.nodeId,
          target.action,
          target.provider,
          target.providerNodeId,
          target.credentialBinding.providerAccountId,
          target.credentialBinding.providerAccountScope,
          target.credentialBinding.providerAccountRevision,
          target.credentialBinding.providerAllocationRevision,
          target.credentialBinding.providerCredentialReference,
          target.credentialBinding.providerCredentialRevision,
        )
        .first(),
    catch: () => temporary(target.provider, 'nodeTermination.credential.read'),
  })

/**
 * Opens only the credential envelope frozen with rebuild/retire acceptance.
 * A second read after decryption fences both response-loss replay and a
 * concurrent provider-account, allocation, envelope, or node reassignment.
 */
export const makeNodeTerminationProviderAdapterResolver = (
  database: LifecycleTerminationD1Database,
  kek: KekPortShape,
): NodeTerminationProviderAdapterResolverShape => {
  const tenantSecrets = makeSecretEnvelopeService(
    makeSecretEnvelopeRepositoryD1(database as unknown as SecretD1Database),
    kek,
  )
  const platformSecrets = makePlatformSecretEnvelope(
    makePlatformSecretRepositoryD1(database as unknown as PlatformProviderD1Database),
    kek,
  )
  return {
    openExact: (target) =>
      Effect.gen(function* () {
        const before = record(yield* loadExactTerminationCredential(database, target))
        const account = before === undefined ? undefined : accountFor(target, before)
        const imageMatches =
          target.action === 'rebuild-node'
            ? target.targetImageId !== undefined &&
              target.targetProviderImageId !== undefined &&
              target.targetImageVersion !== undefined &&
              target.targetImageChecksum !== undefined &&
              text(before ?? {}, 'targetImageId') === target.targetImageId &&
              text(before ?? {}, 'targetProviderImageId') === target.targetProviderImageId &&
              text(before ?? {}, 'targetImageVersion') === target.targetImageVersion &&
              text(before ?? {}, 'targetImageChecksum') === target.targetImageChecksum
            : text(before ?? {}, 'targetImageId') === undefined &&
              text(before ?? {}, 'targetProviderImageId') === undefined &&
              text(before ?? {}, 'targetImageVersion') === undefined &&
              text(before ?? {}, 'targetImageChecksum') === undefined
        if (
          before === undefined ||
          account === undefined ||
          text(before, 'lifecycleAction') !== target.action ||
          !imageMatches ||
          text(before, 'accountId') !== target.credentialBinding.providerAccountId ||
          text(before, 'providerType') !== target.provider ||
          text(before, 'accountStatus') !== 'active' ||
          integer(before, 'accountRevision') !== target.credentialBinding.providerAccountRevision ||
          integer(before, 'allocationRevision') !==
            target.credentialBinding.providerAllocationRevision ||
          text(before, 'credentialReference') !==
            target.credentialBinding.providerCredentialReference ||
          integer(before, 'envelopeRevision') !==
            target.credentialBinding.providerCredentialRevision
        )
          return yield* validation(
            target.provider,
            'nodeTermination.credential.fence',
            'Accepted destructive provider binding is no longer active',
          )

        const open =
          account.scope === 'organization'
            ? tenantSecrets
                .open(yield* organizationContextFor(target, before), {
                  id: target.credentialBinding.providerCredentialReference,
                  scopeType: 'provider-account',
                  scopeId: target.credentialBinding.providerAccountId,
                })
                .pipe(
                  Effect.mapError(() =>
                    authentication(target.provider, 'nodeTermination.credential.open'),
                  ),
                )
            : platformSecrets
                .open(target.credentialBinding.providerAccountId)
                .pipe(
                  Effect.mapError(() =>
                    authentication(target.provider, 'nodeTermination.credential.open'),
                  ),
                )

        return yield* Effect.acquireUseRelease(
          open,
          (plain) =>
            Effect.gen(function* () {
              const after = record(yield* loadExactTerminationCredential(database, target))
              if (after === undefined || !sameBinding(before, after))
                return yield* validation(
                  target.provider,
                  'nodeTermination.credential.fence',
                  'Accepted destructive provider binding changed during credential open',
                )
              if (
                text(after, 'lifecycleAction') !== target.action ||
                (target.action === 'rebuild-node' &&
                  (text(after, 'targetImageId') !== target.targetImageId ||
                    text(after, 'targetProviderImageId') !== target.targetProviderImageId ||
                    text(after, 'targetImageVersion') !== target.targetImageVersion ||
                    text(after, 'targetImageChecksum') !== target.targetImageChecksum))
              )
                return yield* validation(
                  target.provider,
                  'nodeTermination.credential.fence',
                  'Accepted destructive provider image binding changed during credential open',
                )
              if (target.provider === 'ovhcloud') {
                const decoded = yield* decodeOvh(plain)
                return yield* ovhAdapter(decoded, account)
              }
              const decoded = yield* decodeContabo(plain)
              return yield* contaboAdapter(decoded, account)
            }),
          (plain) => Effect.sync(() => plain.fill(0)),
        )
      }),
  }
}

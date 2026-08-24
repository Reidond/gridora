import { Effect, Schema } from 'effect'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'
import { CorrelationId, IdentityId, OrganizationId, OrganizationSlug } from '@gridora/domain'
import {
  makeHmacRegistrationTokenSecret,
  makeNodeProvisionControl,
  makeWebCryptoNodeProvisionIdentity,
  nodeProvisionPolicyAdmission,
  NodeProvisionWorkflowStartError,
  type NodeProvisionAcceptance,
  type NodeProvisionControlShape,
  type NodeProvisionWorkflowStarterShape,
} from '@gridora/node-provision-control'
import {
  makeNodeProvisionExecutionReservationD1,
  makeNodeProvisionFactsD1,
  makeNodeProvisionRepositoryD1,
} from '@gridora/node-provision-d1'
import {
  makeNodeProvisionExecution,
  nodeBootstrapCloudInit,
  NodeProvisionCredentialError,
  type ExactProviderCredential,
  type NodeProvisionExecutionError,
  type NodeProvisionExecutionResult,
  type ProviderCredentialSecretPortShape,
} from '@gridora/node-provision-execution'
import {
  makeNodeProvisionExecutionRepositoryD1,
  makeProvisionalNodeRegistrationExchangeD1,
} from '@gridora/node-provision-execution-d1'
import { makePlatformSecretRepositoryD1 } from '@gridora/platform-provider-d1'
import { makePlatformSecretEnvelope } from '@gridora/platform-secret-envelope'
import {
  makeContaboCreateTransport,
  makeOvhCreateTransport,
} from '@gridora/provider-create-transports'
import { makeProviderCreateRuntime } from '@gridora/provider-runtime'
import { makeSecretEnvelopeRepositoryD1 } from '@gridora/secret-envelope-d1'
import { makeSecretEnvelopeService, type KekPortShape } from '@gridora/secret-envelope'

interface D1Statement {
  bind(...values: ReadonlyArray<unknown>): D1Statement
  first(): Promise<unknown>
  all(): Promise<{
    readonly results: ReadonlyArray<unknown>
    readonly meta?: { readonly changes?: number }
  }>
  run(): Promise<{ readonly success: boolean; readonly meta?: { readonly changes?: number } }>
}

export interface NodeProvisionRuntimeDatabase {
  prepare(sql: string): D1Statement
  batch(statements: ReadonlyArray<D1Statement>): Promise<
    ReadonlyArray<{
      readonly results: ReadonlyArray<unknown>
      readonly meta?: { readonly changes?: number }
    }>
  >
}

interface ProvisionWorkflowParams {
  readonly operationId: string
  readonly organizationId: string
  readonly resourceId: string
  readonly resourceType: string
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: Readonly<Record<string, unknown>>
}

interface ProvisionWorkflowBinding {
  create(options?: {
    readonly id?: string
    readonly params: ProvisionWorkflowParams
  }): Promise<{ readonly id: string }>
  get(id: string): Promise<{ readonly id: string }>
}

export interface NodeProvisionRuntimeBindings {
  readonly DB: NodeProvisionRuntimeDatabase
  readonly PROVISION_NODE: ProvisionWorkflowBinding
  readonly NODE_REGISTRATION_TOKEN_SECRET: string
  readonly NODE_REGISTRATION_TOKEN_SECRET_PREVIOUS?: string
  readonly NODE_REGISTRATION_TOKEN_KEY_VERSION: string
  readonly NODE_REGISTRATION_TOKEN_PREVIOUS_KEY_VERSION?: string
  readonly CONTROL_PLANE_URL: string
  readonly AGENT_VERSION: string
  readonly AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM: string
  readonly NODE_BOOTSTRAP_TTL_SECONDS: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

/**
 * Shared only by the two operation-bound bootstrap paths. Callers receive the
 * HMAC port, never the configured key material.
 */
export const makeNodeRegistrationTokenSecret = (bindings: NodeProvisionRuntimeBindings) => {
  const activeVersion = Number(bindings.NODE_REGISTRATION_TOKEN_KEY_VERSION)
  if (!Number.isSafeInteger(activeVersion) || activeVersion < 1)
    throw new Error('Node registration token key version is invalid')
  const keys: Record<number, string> = {
    [activeVersion]: bindings.NODE_REGISTRATION_TOKEN_SECRET,
  }
  if (
    bindings.NODE_REGISTRATION_TOKEN_SECRET_PREVIOUS !== undefined ||
    bindings.NODE_REGISTRATION_TOKEN_PREVIOUS_KEY_VERSION !== undefined
  ) {
    const previousVersion = Number(bindings.NODE_REGISTRATION_TOKEN_PREVIOUS_KEY_VERSION)
    if (
      bindings.NODE_REGISTRATION_TOKEN_SECRET_PREVIOUS === undefined ||
      !Number.isSafeInteger(previousVersion) ||
      previousVersion < 1 ||
      previousVersion === activeVersion
    )
      throw new Error('Previous node registration token key is invalid')
    keys[previousVersion] = bindings.NODE_REGISTRATION_TOKEN_SECRET_PREVIOUS
  }
  return makeHmacRegistrationTokenSecret({ activeVersion, keys })
}

const workflowStartRow = (
  database: NodeProvisionRuntimeDatabase,
  acceptance: NodeProvisionAcceptance,
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT operation.actor_id AS actorId, operation.correlation_id AS correlationId,
          operation.idempotency_key AS idempotencyKey, operation.resource_id AS resourceId,
          operation.status AS operationStatus, operation.type AS operationType,
          acceptance.request_fingerprint AS fingerprint,
          workflow.start_record_id AS workflowStartId, workflow.state AS workflowState,
          outbox.event_type AS startEventType, outbox.aggregate_id AS startAggregateId,
          json_extract(outbox.payload_json, '$.operationId') AS eventOperationId,
          json_extract(outbox.payload_json, '$.workflowStartRecordId') AS eventWorkflowStartId,
          json_extract(outbox.payload_json, '$.resourceKind') AS eventResourceKind,
          json_extract(outbox.payload_json, '$.resourceId') AS eventResourceId,
          json_extract(outbox.payload_json, '$.action') AS eventAction
        FROM node_provision_acceptances acceptance
        JOIN operations operation ON operation.organization_id = acceptance.organization_id
          AND operation.id = acceptance.operation_id AND operation.resource_id = acceptance.node_id
        JOIN lifecycle_workflow_starts workflow ON workflow.organization_id = acceptance.organization_id
          AND workflow.operation_id = acceptance.operation_id
          AND workflow.start_record_id = acceptance.workflow_start_record_id
        JOIN outbox outbox ON outbox.organization_id = acceptance.organization_id
          AND outbox.id = acceptance.outbox_event_id
        WHERE acceptance.organization_id = ? AND acceptance.operation_id = ?
          AND acceptance.node_id = ? AND acceptance.fingerprint = ?`)
        .bind(
          acceptance.organizationId,
          acceptance.operationId,
          acceptance.nodeId,
          acceptance.fingerprint,
        )
        .first(),
    catch: () =>
      new NodeProvisionWorkflowStartError({
        operationId: acceptance.operationId,
        message: 'Authoritative Workflow start state is unavailable',
      }),
  })

export const makeNodeProvisionWorkflowStarter = (
  database: NodeProvisionRuntimeDatabase,
  binding: ProvisionWorkflowBinding,
): NodeProvisionWorkflowStarterShape => ({
  start: (acceptance) =>
    Effect.gen(function* () {
      const row = record(yield* workflowStartRow(database, acceptance))
      if (
        row === undefined ||
        text(row.operationType) !== 'provision-node' ||
        text(row.resourceId) !== acceptance.nodeId ||
        text(row.operationStatus) !== 'queued' ||
        text(row.workflowStartId) !== acceptance.workflowStart.id ||
        text(row.workflowState) !== 'pending' ||
        text(row.fingerprint) !== acceptance.fingerprint ||
        text(row.startEventType) !== 'lifecycle.workflow-start.requested' ||
        text(row.startAggregateId) !== acceptance.operationId ||
        text(row.eventOperationId) !== acceptance.operationId ||
        text(row.eventWorkflowStartId) !== acceptance.workflowStart.id ||
        text(row.eventResourceKind) !== 'node' ||
        text(row.eventResourceId) !== acceptance.nodeId ||
        text(row.eventAction) !== 'provision-node' ||
        text(row.actorId) === undefined ||
        text(row.correlationId) === undefined ||
        text(row.idempotencyKey) === undefined
      )
        return yield* new NodeProvisionWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'Authoritative Workflow start state does not match the acceptance',
        })
      const params: ProvisionWorkflowParams = {
        operationId: acceptance.operationId,
        organizationId: acceptance.organizationId,
        resourceId: acceptance.nodeId,
        resourceType: 'node',
        actorId: text(row.actorId)!,
        correlationId: text(row.correlationId)!,
        idempotencyKey: text(row.idempotencyKey)!,
        input: {
          acceptanceFingerprint: acceptance.fingerprint,
          providerType: acceptance.providerType,
          placementMode: acceptance.placementMode,
        },
      }
      const created = yield* Effect.result(
        Effect.tryPromise({
          try: () => binding.create({ id: acceptance.operationId, params }),
          catch: () =>
            new NodeProvisionWorkflowStartError({
              operationId: acceptance.operationId,
              message: 'Workflow create result is ambiguous',
            }),
        }),
      )
      if (created._tag === 'Success') {
        if (created.success.id === acceptance.operationId) return
        return yield* new NodeProvisionWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'Workflow identity does not match the operation',
        })
      }
      const adopted = yield* Effect.tryPromise({
        try: () => binding.get(acceptance.operationId),
        catch: () => created.failure,
      })
      if (adopted.id !== acceptance.operationId)
        return yield* new NodeProvisionWorkflowStartError({
          operationId: acceptance.operationId,
          message: 'Workflow identity does not match the operation',
        })
    }),
})

export const makeNodeProvisionControlRuntime = (
  bindings: NodeProvisionRuntimeBindings,
  auditRequestContext?: AuditRequestContextValue,
): NodeProvisionControlShape =>
  makeNodeProvisionControl({
    repository: makeNodeProvisionRepositoryD1(
      bindings.DB,
      auditRequestContext === undefined ? {} : { auditRequestContext },
    ),
    facts: makeNodeProvisionFactsD1(bindings.DB),
    policy: nodeProvisionPolicyAdmission,
    identities: makeWebCryptoNodeProvisionIdentity(),
    registrationTokens: makeNodeRegistrationTokenSecret(bindings),
    clock: {
      now: Effect.sync(() => {
        const now = new Date()
        return { iso: now.toISOString(), epochMilliseconds: now.getTime() }
      }),
    },
    workflows: makeNodeProvisionWorkflowStarter(bindings.DB, bindings.PROVISION_NODE),
  })

const exactCredentialSql = `SELECT account.id AS accountId, account.scope,
 account.organization_id AS accountOrganizationId, account.provider_type AS providerType,
 account.status, account.revision AS accountRevision, account.credential_reference AS credentialReference,
 organization.slug AS organizationSlug, operation.actor_id AS actorId,
 operation.correlation_id AS correlationId,
 CASE WHEN account.scope = 'platform' THEN platformSecret.revision ELSE tenantSecret.revision END AS envelopeRevision
FROM node_provision_acceptances acceptance
JOIN operations operation ON operation.organization_id = acceptance.organization_id
 AND operation.id = acceptance.operation_id AND operation.resource_id = acceptance.node_id
JOIN organizations organization ON organization.id = acceptance.organization_id
JOIN provider_accounts account ON account.id = acceptance.provider_account_id
 AND account.revision = acceptance.provider_account_revision
 AND account.provider_type = acceptance.provider_type
LEFT JOIN secret_envelopes tenantSecret ON account.scope = 'organization'
 AND tenantSecret.organization_id = acceptance.organization_id
 AND tenantSecret.id = account.credential_reference
 AND tenantSecret.scope_type = 'provider-account' AND tenantSecret.scope_id = account.id
LEFT JOIN platform_secret_envelopes platformSecret ON account.scope = 'platform'
 AND account.organization_id IS NULL AND platformSecret.id = account.credential_reference
 AND platformSecret.scope_type = 'provider-account' AND platformSecret.scope_id = account.id
WHERE acceptance.organization_id = ? AND acceptance.node_id = ? AND acceptance.operation_id = ?
 AND acceptance.provider_account_id = ? AND acceptance.provider_account_revision = ?
 AND acceptance.provider_type = ?
 AND ((account.scope = 'organization' AND account.organization_id = acceptance.organization_id
       AND tenantSecret.revision IS NOT NULL)
   OR (account.scope = 'platform' AND account.organization_id IS NULL
       AND platformSecret.revision IS NOT NULL))`

const readExactCredential = (
  database: NodeProvisionRuntimeDatabase,
  input: Parameters<ProviderCredentialSecretPortShape['openExact']>[0],
) =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(exactCredentialSql)
        .bind(
          input.organizationId,
          input.nodeId,
          input.operationId,
          input.providerAccountId,
          input.expectedAccountRevision,
          input.expectedProviderType,
        )
        .first(),
    catch: () => new NodeProvisionCredentialError({ operation: 'credential.read' }),
  })

const sameCredentialFence = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  [
    'accountId',
    'scope',
    'accountOrganizationId',
    'providerType',
    'status',
    'accountRevision',
    'credentialReference',
    'envelopeRevision',
  ].every((field) => left[field] === right[field])

const decodeContext = (row: Record<string, unknown>) =>
  Effect.all({
    organizationId: Schema.decodeUnknownEffect(OrganizationId)(row.accountOrganizationId),
    organizationSlug: Schema.decodeUnknownEffect(OrganizationSlug)(row.organizationSlug),
    identityId: Schema.decodeUnknownEffect(IdentityId)(row.actorId),
    correlationId: Schema.decodeUnknownEffect(CorrelationId)(row.correlationId),
  }).pipe(
    Effect.mapError(() => new NodeProvisionCredentialError({ operation: 'credential.context' })),
    Effect.map((values) => ({ ...values, role: 'automation' as const })),
  )

export const makeExactProviderCredentialPort = (
  database: NodeProvisionRuntimeDatabase,
  kek: KekPortShape,
): ProviderCredentialSecretPortShape => {
  const tenantSecrets = makeSecretEnvelopeService(makeSecretEnvelopeRepositoryD1(database), kek)
  const platformSecrets = makePlatformSecretEnvelope(makePlatformSecretRepositoryD1(database), kek)
  return {
    openExact: (input) =>
      Effect.gen(function* () {
        const before = record(yield* readExactCredential(database, input))
        if (
          before === undefined ||
          text(before.accountId) !== input.providerAccountId ||
          text(before.providerType) !== input.expectedProviderType ||
          text(before.status) !== 'active' ||
          integer(before.accountRevision) !== input.expectedAccountRevision ||
          integer(before.envelopeRevision) === undefined ||
          text(before.credentialReference) === undefined
        )
          return yield* new NodeProvisionCredentialError({ operation: 'credential.fence' })

        const openCredential =
          text(before.scope) === 'organization'
            ? tenantSecrets
                .open(yield* decodeContext(before), {
                  id: text(before.credentialReference)!,
                  scopeType: 'provider-account',
                  scopeId: input.providerAccountId,
                })
                .pipe(
                  Effect.mapError(
                    () => new NodeProvisionCredentialError({ operation: 'credential.open' }),
                  ),
                )
            : text(before.scope) === 'platform' && before.accountOrganizationId === null
              ? platformSecrets
                  .open(input.providerAccountId)
                  .pipe(
                    Effect.mapError(
                      () => new NodeProvisionCredentialError({ operation: 'credential.open' }),
                    ),
                  )
              : Effect.fail(new NodeProvisionCredentialError({ operation: 'credential.scope' }))

        return yield* Effect.acquireUseRelease(
          openCredential,
          (credentialBytes) =>
            Effect.gen(function* () {
              const after = record(yield* readExactCredential(database, input))
              if (after === undefined || !sameCredentialFence(before, after))
                return yield* new NodeProvisionCredentialError({
                  operation: 'credential.revision-fence',
                })
              return {
                account: {
                  id: input.providerAccountId,
                  providerType: input.expectedProviderType,
                  scope: text(before.scope) as 'organization' | 'platform',
                  organizationId:
                    text(before.scope) === 'organization' ? input.organizationId : null,
                  revision: input.expectedAccountRevision,
                  status: 'active',
                },
                envelopeRevision: integer(before.envelopeRevision)!,
                credentialBytes: credentialBytes.slice(),
              } satisfies ExactProviderCredential
            }),
          (credentialBytes) => Effect.sync(() => credentialBytes.fill(0)),
        )
      }),
  }
}

export const makeNodeBootstrapTrustedConfiguration = (bindings: NodeProvisionRuntimeBindings) => {
  const url = new URL(bindings.CONTROL_PLANE_URL)
  const registrationTtlSeconds = Number(bindings.NODE_BOOTSTRAP_TTL_SECONDS)
  if (!Number.isSafeInteger(registrationTtlSeconds))
    throw new Error('Node bootstrap TTL is invalid')
  return {
    controlPlaneUrl: url.toString(),
    expectedControlPlaneHost: url.hostname,
    allowLoopbackHttp: false,
    agentVersion: bindings.AGENT_VERSION,
    dockerSocket: '/var/run/docker.sock' as const,
    pollWaitSeconds: 20,
    registrationTtlSeconds,
    commandSigningPublicKeyPem: bindings.AGENT_COMMAND_SIGNING_PUBLIC_KEY_PEM,
    providerInstanceDiscovery: {
      mode: 'image-metadata-helper-v1' as const,
      helperUnit: 'gridora-node-bootstrap.service' as const,
    },
  }
}

export const executeNodeProvision = (
  bindings: NodeProvisionRuntimeBindings,
  kek: KekPortShape,
  request: {
    readonly organizationId: string
    readonly operationId: string
    readonly attemptedAt: string
  },
): Effect.Effect<NodeProvisionExecutionResult, NodeProvisionExecutionError> => {
  const repository = makeNodeProvisionExecutionRepositoryD1(bindings.DB)
  return makeNodeProvisionExecution({
    reservations: makeNodeProvisionExecutionReservationD1(bindings.DB),
    credentials: makeExactProviderCredentialPort(bindings.DB, kek),
    registrationTokens: makeNodeRegistrationTokenSecret(bindings),
    cloudInit: nodeBootstrapCloudInit,
    provider: makeProviderCreateRuntime({
      ovhcloud: makeOvhCreateTransport(),
      contabo: makeContaboCreateTransport(),
    }),
    repository,
    clock: {
      now: Effect.sync(() => {
        const now = new Date()
        return { iso: now.toISOString(), epochMilliseconds: now.getTime() }
      }),
    },
    trustedBootstrap: makeNodeBootstrapTrustedConfiguration(bindings),
  }).execute(request)
}

export const makeProvisionalRegistrationExchange = (database: NodeProvisionRuntimeDatabase) =>
  makeProvisionalNodeRegistrationExchangeD1(database)

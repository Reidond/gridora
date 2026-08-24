import { Effect } from 'effect'
import {
  makeProviderRebuildTransport,
  makeProviderRetirementTransport,
} from '@gridora/provider-retirement-transports'
import type { RegistrationTokenSecretShape } from '@gridora/node-provision-control'
import {
  type NodeBootstrapCloudInitShape,
  type NodeBootstrapTrustedConfiguration,
} from '@gridora/node-provision-execution'
import {
  type WorkflowStepEffectObservation,
  type WorkflowStepEffectReceipt,
  type WorkflowStepLease,
} from '@gridora/lifecycle-termination-control'
import {
  makeNodeTerminationD1Repository,
  type LifecycleTerminationD1Database,
} from '@gridora/lifecycle-termination-d1'
import {
  TerminationWorkflowStepError,
  type TerminationWorkflowStepEnvelope,
} from '@gridora/lifecycle-termination-workflow'
import type {
  NodeTerminationProviderAdapterResolverShape,
  NodeTerminationProviderTarget,
} from './provider-node-lifecycle-runtime.js'
import type { NodeTerminationTunnelAdapter } from './node-termination-tunnel-runtime.js'

interface NodeTerminationAuthority {
  readonly nodeId: string
  readonly action: 'drain-node' | 'leave-drain' | 'rebuild-node' | 'retire-node'
  readonly state: string
  readonly providerRetirementState?: string
  readonly providerBillingState?: string
  readonly providerTarget?: NodeTerminationProviderTarget
  readonly tunnel?: { readonly id: string; readonly revision: number }
}

export interface NodeTerminationExecutionDependencies {
  /** Required only for immutable rebuild/retire provider actions. */
  readonly providers?: NodeTerminationProviderAdapterResolverShape
  /** Required only after a provider-confirmed retirement reaches network cleanup. */
  readonly tunnels?: NodeTerminationTunnelAdapter
  /** Required only for a fresh immutable rebuild bootstrap handoff. */
  readonly rebuildBootstrap?: {
    readonly registrationTokens: RegistrationTokenSecretShape
    readonly trusted: NodeBootstrapTrustedConfiguration
    readonly cloudInit: NodeBootstrapCloudInitShape
  }
}

const authorityFailure = (code: string) => new TerminationWorkflowStepError({ code })

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const text = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined => (typeof value?.[key] === 'string' ? (value[key] as string) : undefined)

const integer = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined =>
  typeof value?.[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined

const action = (value: string | undefined): NodeTerminationAuthority['action'] | undefined =>
  value === 'drain-node' ||
  value === 'leave-drain' ||
  value === 'rebuild-node' ||
  value === 'retire-node'
    ? value
    : undefined

const loadAuthority = (
  database: LifecycleTerminationD1Database,
  envelope: TerminationWorkflowStepEnvelope,
): Effect.Effect<NodeTerminationAuthority, TerminationWorkflowStepError> =>
  Effect.tryPromise({
    try: () =>
      database
        .prepare(`SELECT operation.resource_id AS nodeId, lifecycle.action AS action,
          lifecycle.state AS lifecycleState, run.state AS runState,
          run.provider_retirement_state AS providerRetirementState,
          run.billing_state AS providerBillingState,
          run.provider_account_id AS providerAccountId,
          run.provider_account_scope AS providerAccountScope,
          run.provider_account_revision AS providerAccountRevision,
          run.provider_allocation_revision AS providerAllocationRevision,
          run.provider_credential_reference AS providerCredentialReference,
          run.provider_credential_revision AS providerCredentialRevision,
          run.provider_type_snapshot AS providerType,
          run.provider_instance_id_snapshot AS providerInstanceId,
          run.target_provider_image_id AS targetProviderImageId,
          run.target_image_version_snapshot AS targetImageVersion,
          run.target_image_id AS targetImageId,
          run.target_image_checksum_snapshot AS targetImageChecksum,
          tunnel.tunnel_id AS tunnelId, tunnel.revision AS tunnelRevision,
          facts.workflow_type AS workflowType, facts.workflow_instance_id AS workflowInstanceId,
          start.workflow_type AS startWorkflowType, start.workflow_instance_id AS startWorkflowInstanceId
          FROM operations operation
          JOIN destructive_lifecycle_operations lifecycle
            ON lifecycle.organization_id = operation.organization_id
           AND lifecycle.operation_id = operation.id
          JOIN node_lifecycle_runs run
            ON run.organization_id = operation.organization_id AND run.operation_id = operation.id
          JOIN operation_cancellation_facts facts
            ON facts.organization_id = operation.organization_id AND facts.operation_id = operation.id
          JOIN termination_workflow_starts start
            ON start.organization_id = operation.organization_id AND start.operation_id = operation.id
          LEFT JOIN tunnels tunnel
            ON tunnel.organization_id = operation.organization_id AND tunnel.node_id = operation.resource_id
          WHERE operation.organization_id = ? AND operation.id = ? AND operation.resource_type = 'node'`)
        .bind(envelope.organizationId, envelope.operationId)
        .first(),
    catch: () => authorityFailure('node_termination_authority_unavailable'),
  }).pipe(
    Effect.flatMap((raw) => {
      const found = record(raw)
      const nodeId = text(found, 'nodeId')
      const resolvedAction = action(text(found, 'action'))
      const workflowType = text(found, 'workflowType')
      const workflowInstanceId = text(found, 'workflowInstanceId')
      const startWorkflowType = text(found, 'startWorkflowType')
      const startWorkflowInstanceId = text(found, 'startWorkflowInstanceId')
      const runState = text(found, 'runState')
      const providerRetirementState = text(found, 'providerRetirementState')
      const providerBillingState = text(found, 'providerBillingState')
      if (
        nodeId === undefined ||
        resolvedAction === undefined ||
        runState === undefined ||
        workflowType !== envelope.workflowType ||
        workflowInstanceId !== envelope.workflowInstanceId ||
        startWorkflowType !== envelope.workflowType ||
        startWorkflowInstanceId !== envelope.workflowInstanceId ||
        envelope.workflowInstanceId !== envelope.operationId
      )
        return Effect.fail(authorityFailure('node_termination_authority_mismatch'))
      const providerTarget =
        resolvedAction === 'rebuild-node' || resolvedAction === 'retire-node'
          ? (() => {
              const providerAccountId = text(found, 'providerAccountId')
              const providerAccountScope = text(found, 'providerAccountScope')
              const providerAccountRevision = integer(found, 'providerAccountRevision')
              const providerAllocationRevision = integer(found, 'providerAllocationRevision')
              const providerCredentialReference = text(found, 'providerCredentialReference')
              const providerCredentialRevision = integer(found, 'providerCredentialRevision')
              const provider = text(found, 'providerType')
              const providerNodeId = text(found, 'providerInstanceId')
              const targetProviderImageId = text(found, 'targetProviderImageId')
              const targetImageVersion = text(found, 'targetImageVersion')
              const targetImageId = text(found, 'targetImageId')
              const targetImageChecksum = text(found, 'targetImageChecksum')
              if (
                providerAccountId === undefined ||
                (providerAccountScope !== 'platform' && providerAccountScope !== 'organization') ||
                providerAccountRevision === undefined ||
                providerAccountRevision < 1 ||
                providerAllocationRevision === undefined ||
                providerAllocationRevision < 1 ||
                providerCredentialReference === undefined ||
                providerCredentialRevision === undefined ||
                providerCredentialRevision < 1 ||
                (provider !== 'ovhcloud' && provider !== 'contabo') ||
                providerNodeId === undefined ||
                (resolvedAction === 'rebuild-node' &&
                  (targetImageId === undefined ||
                    targetProviderImageId === undefined ||
                    targetImageVersion === undefined ||
                    targetImageChecksum === undefined ||
                    !/^sha256:[a-f0-9]{64}$/.test(targetImageChecksum))) ||
                (resolvedAction === 'retire-node' &&
                  (targetImageId !== undefined ||
                    targetProviderImageId !== undefined ||
                    targetImageVersion !== undefined ||
                    targetImageChecksum !== undefined))
              )
                return undefined
              return {
                provider,
                organizationId: envelope.organizationId,
                operationId: envelope.operationId,
                nodeId,
                providerNodeId,
                action: resolvedAction,
                credentialBinding: {
                  providerAccountId,
                  providerAccountScope,
                  providerAccountRevision,
                  providerAllocationRevision,
                  providerCredentialReference,
                  providerCredentialRevision,
                },
                ...(targetProviderImageId === undefined ? {} : { targetProviderImageId }),
                ...(targetImageVersion === undefined ? {} : { targetImageVersion }),
                ...(targetImageId === undefined ? {} : { targetImageId }),
                ...(targetImageChecksum === undefined ? {} : { targetImageChecksum }),
              } satisfies NodeTerminationProviderTarget
            })()
          : undefined
      if (
        (resolvedAction === 'rebuild-node' || resolvedAction === 'retire-node') &&
        providerTarget === undefined
      )
        return Effect.fail(authorityFailure('node_termination_provider_binding_unavailable'))
      const tunnelId = text(found, 'tunnelId')
      const tunnelRevision = integer(found, 'tunnelRevision')
      const tunnel =
        tunnelId === undefined || tunnelRevision === undefined || tunnelRevision < 1
          ? undefined
          : { id: tunnelId, revision: tunnelRevision }
      return Effect.succeed({
        nodeId,
        action: resolvedAction,
        state: runState,
        ...(providerRetirementState === undefined ? {} : { providerRetirementState }),
        ...(providerBillingState === undefined ? {} : { providerBillingState }),
        ...(providerTarget === undefined ? {} : { providerTarget }),
        ...(tunnel === undefined ? {} : { tunnel }),
      })
    }),
  )

const isLocalDrainStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  (authority.action === 'drain-node' || authority.action === 'leave-drain') &&
  envelope.stepName === 'complete-node-drain' &&
  envelope.ordinal === 0 &&
  envelope.destructive === false
    ? true
    : (authority.action === 'rebuild-node' || authority.action === 'retire-node') &&
      envelope.stepName === 'drain-node' &&
      envelope.ordinal === 0 &&
      envelope.destructive === false

const isProviderPreconditionStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  (authority.action === 'rebuild-node' &&
    envelope.stepName === 'verify-backups' &&
    envelope.ordinal === 1 &&
    envelope.destructive === false) ||
  (authority.action === 'retire-node' &&
    envelope.stepName === 'verify-retention-policy' &&
    envelope.ordinal === 1 &&
    envelope.destructive === false)

const isRetireCredentialStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'retire-node' &&
  envelope.stepName === 'revoke-node-credentials' &&
  envelope.ordinal === 2 &&
  envelope.destructive === false

const isRebuildProviderStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'rebuild-node' &&
  envelope.stepName === 'rebuild-provider-instance' &&
  envelope.ordinal === 2 &&
  envelope.destructive === true

const isRebuildBootstrapStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'rebuild-node' &&
  envelope.stepName === 'bootstrap-node' &&
  envelope.ordinal === 3 &&
  envelope.destructive === false

const isRebuildReadyStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'rebuild-node' &&
  envelope.stepName === 'verify-agent' &&
  envelope.ordinal === 4 &&
  envelope.destructive === false

const isRetireProviderStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'retire-node' &&
  envelope.stepName === 'delete-provider-instance' &&
  envelope.ordinal === 3 &&
  envelope.destructive === true

const isRetireNetworkCleanupStep = (
  envelope: TerminationWorkflowStepEnvelope,
  authority: NodeTerminationAuthority,
): boolean =>
  authority.action === 'retire-node' &&
  envelope.stepName === 'cleanup-networking' &&
  envelope.ordinal === 4 &&
  envelope.destructive === false

const isProviderRetirementTerminal = (authority: NodeTerminationAuthority): boolean =>
  (authority.providerRetirementState === 'deleted-confirmed' ||
    authority.providerRetirementState === 'contract-ended') &&
  authority.providerBillingState === 'stopped'

const retirementInput = (
  authority: NodeTerminationAuthority,
): NodeTerminationProviderTarget | undefined =>
  authority.action === 'retire-node' ? authority.providerTarget : undefined

const rebuildInput = (
  authority: NodeTerminationAuthority,
): NodeTerminationProviderTarget | undefined =>
  authority.action === 'rebuild-node' ? authority.providerTarget : undefined

const rebuildTokenRecordId = (operationId: string) => `node-rebuild-bootstrap:${operationId}`

const now = (): string => new Date().toISOString()

const deliveredTokenBytes = (
  raw: Uint8Array,
): Effect.Effect<Uint8Array, TerminationWorkflowStepError> =>
  Effect.try({
    try: () => {
      if (raw.byteLength !== 32) throw new Error('invalid rebuild token bytes')
      return new TextEncoder().encode(
        Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      )
    },
    catch: () => authorityFailure('node_rebuild_registration_token_invalid'),
  })

const hashDeliveredToken = (
  token: Uint8Array,
): Effect.Effect<string, TerminationWorkflowStepError> =>
  Effect.tryPromise({
    try: async () => {
      if (token.byteLength !== 64) throw new Error('invalid rebuild delivered token')
      return Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            token.buffer.slice(
              token.byteOffset,
              token.byteOffset + token.byteLength,
            ) as ArrayBuffer,
          ),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
    },
    catch: () => authorityFailure('node_rebuild_registration_token_hash_failed'),
  })

const receiptFor = (
  envelope: TerminationWorkflowStepEnvelope,
  lease: WorkflowStepLease,
  state: string,
): Effect.Effect<WorkflowStepEffectReceipt, TerminationWorkflowStepError> =>
  Effect.tryPromise({
    try: async () => {
      const body = JSON.stringify({
        organizationId: envelope.organizationId,
        operationId: envelope.operationId,
        workflowType: envelope.workflowType,
        stepName: envelope.stepName,
        ordinal: envelope.ordinal,
        attempt: lease.attempt,
        state,
      })
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
      return {
        effectId: `termination-step-${envelope.operationId}-${envelope.ordinal}-${lease.attempt}`,
        outcomeFingerprint: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      }
    },
    catch: () => authorityFailure('node_termination_receipt_unavailable'),
  })

export const executeNodeTerminationWorkflowEffect = (
  database: LifecycleTerminationD1Database,
  envelope: TerminationWorkflowStepEnvelope,
  lease: WorkflowStepLease,
  dependencies: NodeTerminationExecutionDependencies = {},
): Effect.Effect<WorkflowStepEffectReceipt, TerminationWorkflowStepError> =>
  Effect.gen(function* () {
    const authority = yield* loadAuthority(database, envelope)
    const repository = makeNodeTerminationD1Repository(database)
    if (isLocalDrainStep(envelope, authority)) {
      const transition = yield* repository
        .completeNodeDrain({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_termination_drain_transition_failed')))
      return yield* receiptFor(envelope, lease, transition.state)
    }
    if (isProviderPreconditionStep(envelope, authority)) {
      // The immutable provider-action claim immediately before the external
      // request rechecks active deployments and required backup evidence in
      // the same D1 state machine. This step records the ordered workflow
      // checkpoint without treating a stale earlier read as side-effect proof.
      return yield* receiptFor(envelope, lease, 'provider-preconditions-pending-claim')
    }
    if (isRetireCredentialStep(envelope, authority)) {
      yield* repository
        .revokeNodeCredentials({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_credential_revoke_failed')))
      return yield* receiptFor(envelope, lease, 'credentials-revoked')
    }
    if (isRebuildProviderStep(envelope, authority)) {
      const target = rebuildInput(authority)
      const bootstrapDependencies = dependencies.rebuildBootstrap
      if (
        target === undefined ||
        dependencies.providers === undefined ||
        bootstrapDependencies === undefined
      )
        return yield* Effect.fail(authorityFailure('node_rebuild_provider_binding_unavailable'))
      if (
        target.targetImageId === undefined ||
        target.targetProviderImageId === undefined ||
        target.targetImageVersion === undefined ||
        target.targetImageChecksum === undefined
      )
        return yield* Effect.fail(authorityFailure('node_rebuild_image_binding_unavailable'))
      const scope = {
        organizationId: envelope.organizationId,
        nodeId: authority.nodeId,
        operationId: envelope.operationId,
        tokenRecordId: rebuildTokenRecordId(envelope.operationId),
      }
      const existing = yield* repository
        .loadNodeRebuildBootstrap({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_bootstrap_load_failed')))
      // The provider mutation is authorized only after the signed destructive
      // Workflow lease has advanced cancellation facts and the D1 state
      // machine has atomically rechecked deployments plus backup evidence.
      // A retry after the claim committed but before bootstrap preparation
      // observes `rebuilding` and must adopt that claim instead of failing or
      // inventing a second provider-action admission.
      if (existing === null && authority.state !== 'rebuilding') {
        const claim = yield* repository
          .claimNodeProviderDestructiveAction({
            organizationId: envelope.organizationId,
            operationId: envelope.operationId,
            nodeId: authority.nodeId,
            now: now(),
          })
          .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_claim_failed')))
        if (claim.disposition === 'cancelled')
          return yield* Effect.fail(
            authorityFailure('node_rebuild_cancelled_before_provider_action'),
          )
        if (claim.disposition !== 'execute')
          return yield* Effect.fail(
            authorityFailure(`node_rebuild_provider_action_${claim.reason ?? 'blocked'}`),
          )
      }
      const timestamp = now()
      const bootstrap =
        existing === null
          ? yield* Effect.gen(function* () {
              const derivation = yield* bootstrapDependencies.registrationTokens
                .hashFor(scope)
                .pipe(
                  Effect.mapError(() =>
                    authorityFailure('node_rebuild_registration_token_derive_failed'),
                  ),
                )
              const raw = yield* bootstrapDependencies.registrationTokens
                .recoverBytes(scope, derivation.keyVersion, derivation.tokenHash)
                .pipe(
                  Effect.mapError(() =>
                    authorityFailure('node_rebuild_registration_token_open_failed'),
                  ),
                )
              return yield* Effect.acquireUseRelease(
                Effect.succeed(raw),
                (rawToken) =>
                  Effect.gen(function* () {
                    const delivered = yield* deliveredTokenBytes(rawToken)
                    return yield* Effect.acquireUseRelease(
                      Effect.succeed(delivered),
                      (deliveredToken) =>
                        Effect.gen(function* () {
                          const tokenHash = yield* hashDeliveredToken(deliveredToken)
                          const expiresAt = new Date(
                            Date.parse(timestamp) +
                              bootstrapDependencies.trusted.registrationTtlSeconds * 1000,
                          ).toISOString()
                          const prepared = yield* repository
                            .prepareNodeRebuildBootstrap({
                              organizationId: envelope.organizationId,
                              operationId: envelope.operationId,
                              nodeId: authority.nodeId,
                              tokenRecordId: scope.tokenRecordId,
                              derivationTokenHash: derivation.tokenHash,
                              tokenHash,
                              keyVersion: derivation.keyVersion,
                              expiresAt,
                              now: timestamp,
                            })
                            .pipe(
                              Effect.mapError(() =>
                                authorityFailure('node_rebuild_bootstrap_prepare_failed'),
                              ),
                            )
                          return prepared
                        }),
                      (bytes) => Effect.sync(() => bytes.fill(0)),
                    )
                  }),
                (bytes) => Effect.sync(() => bytes.fill(0)),
              )
            })
          : existing
      const prepared = bootstrap
      if (
        prepared.providerType !== target.provider ||
        prepared.providerInstanceId !== target.providerNodeId ||
        prepared.imageId !== target.targetImageId ||
        prepared.providerImageId !== target.targetProviderImageId ||
        prepared.imageVersion !== target.targetImageVersion ||
        prepared.imageChecksum !== target.targetImageChecksum
      )
        return yield* Effect.fail(authorityFailure('node_rebuild_bootstrap_authority_mismatch'))
      const adapter = yield* dependencies.providers
        .openExact(target)
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_adapter_unavailable')))
      const transport = makeProviderRebuildTransport({
        ovh: adapter.provider,
        contabo: adapter.provider,
      })
      const providerRequest = {
        provider: target.provider,
        organizationId: target.organizationId,
        operationId: target.operationId,
        nodeId: target.nodeId,
        providerNodeId: target.providerNodeId,
        imageId: prepared.providerImageId,
        imageVersion: prepared.imageVersion,
      } as const
      const observation =
        prepared.disposition === 'prepared'
          ? yield* Effect.acquireUseRelease(
              bootstrapDependencies.registrationTokens
                .recoverBytes(
                  {
                    organizationId: prepared.organizationId,
                    nodeId: prepared.nodeId,
                    operationId: prepared.operationId,
                    tokenRecordId: prepared.tokenRecordId,
                  },
                  prepared.keyVersion,
                  prepared.derivationTokenHash,
                )
                .pipe(
                  Effect.mapError(() =>
                    authorityFailure('node_rebuild_registration_token_open_failed'),
                  ),
                ),
              (rawToken) =>
                Effect.gen(function* () {
                  const delivered = yield* deliveredTokenBytes(rawToken)
                  return yield* Effect.acquireUseRelease(
                    Effect.succeed(delivered),
                    (deliveredToken) =>
                      Effect.acquireUseRelease(
                        bootstrapDependencies.cloudInit
                          .render({
                            reservation: {
                              organizationId: prepared.organizationId,
                              nodeId: prepared.nodeId,
                              operationId: prepared.operationId,
                              providerType: prepared.providerType,
                              imageId: prepared.imageId,
                              imageVersion: prepared.imageVersion,
                              imageChecksum: prepared.imageChecksum,
                              providerImageId: prepared.providerImageId,
                            },
                            registrationTokenBytes: deliveredToken,
                            registrationExpiresAt: prepared.expiresAt,
                            trusted: bootstrapDependencies.trusted,
                          })
                          .pipe(
                            Effect.mapError(() =>
                              authorityFailure('node_rebuild_cloud_init_invalid'),
                            ),
                          ),
                        (cloudInitBytes) =>
                          transport
                            .rebuild({
                              ...providerRequest,
                              cloudInit: new TextDecoder().decode(cloudInitBytes),
                            })
                            .pipe(
                              Effect.mapError(() =>
                                authorityFailure('node_rebuild_provider_action_failed'),
                              ),
                            ),
                        (bytes) => Effect.sync(() => bytes.fill(0)),
                      ),
                    (bytes) => Effect.sync(() => bytes.fill(0)),
                  )
                }),
              (bytes) => Effect.sync(() => bytes.fill(0)),
            )
          : yield* transport
              .observe(providerRequest)
              .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_observe_failed')))
      const recorded = yield* repository
        .recordNodeProviderRebuildObservation({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          observation,
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_receipt_failed')))
      if (recorded.state === 'awaiting-agent' || recorded.state === 'ready')
        return yield* receiptFor(envelope, lease, 'provider-rebuild-active')
      return yield* Effect.fail(
        authorityFailure(
          recorded.state === 'provider-rebuilding'
            ? 'node_rebuild_provider_rebuilding'
            : 'node_rebuild_provider_state_ambiguous',
        ),
      )
    }
    if (isRebuildBootstrapStep(envelope, authority)) {
      const bootstrap = yield* repository
        .loadNodeRebuildBootstrap({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_bootstrap_load_failed')))
      if (bootstrap?.state === 'awaiting-agent' || bootstrap?.state === 'ready')
        return yield* receiptFor(envelope, lease, 'agent-bootstrap-authoritative')
      return yield* Effect.fail(authorityFailure('node_rebuild_provider_rebuilding'))
    }
    if (isRebuildReadyStep(envelope, authority)) {
      const completion = yield* repository
        .completeNodeRebuild({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_agent_readiness_pending')))
      return yield* receiptFor(envelope, lease, completion.state)
    }
    if (isRetireProviderStep(envelope, authority)) {
      const target = retirementInput(authority)
      if (target === undefined || dependencies.providers === undefined)
        return yield* Effect.fail(authorityFailure('node_retirement_provider_binding_unavailable'))

      const useReadOnlyObservation =
        authority.state === 'retiring' ||
        authority.state === 'awaiting-provider-confirmation' ||
        authority.state === 'cancel-scheduled' ||
        authority.state === 'blocked'
      if (!useReadOnlyObservation) {
        const claim = yield* repository
          .claimNodeProviderDestructiveAction({
            organizationId: envelope.organizationId,
            operationId: envelope.operationId,
            nodeId: authority.nodeId,
            now: now(),
          })
          .pipe(Effect.mapError(() => authorityFailure('node_retirement_provider_claim_failed')))
        if (claim.disposition === 'cancelled')
          return yield* Effect.fail(
            authorityFailure('node_retirement_cancelled_before_provider_action'),
          )
        if (claim.disposition !== 'execute')
          return yield* Effect.fail(
            authorityFailure(`node_retirement_provider_action_${claim.reason ?? 'blocked'}`),
          )
      }

      const adapter = yield* dependencies.providers
        .openExact(target)
        .pipe(
          Effect.mapError(() => authorityFailure('node_retirement_provider_adapter_unavailable')),
        )
      // The same exact immutable adapter is deliberately passed to both slots;
      // the transport selects only target.provider and never falls back to a
      // mutable account or a different provider.
      const transport = makeProviderRetirementTransport({
        ovh: adapter.provider,
        contabo: adapter.provider,
      })
      const providerRequest = {
        provider: target.provider,
        organizationId: target.organizationId,
        operationId: target.operationId,
        nodeId: target.nodeId,
        providerNodeId: target.providerNodeId,
      } as const
      const observation = yield* (
        useReadOnlyObservation
          ? transport.observe(providerRequest)
          : transport.retire(providerRequest)
      ).pipe(Effect.mapError(() => authorityFailure('node_retirement_provider_action_failed')))
      yield* repository
        .recordNodeProviderRetirement({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          receipt: transport.asNodeReceipt(observation),
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_provider_receipt_failed')))
      if (observation.state === 'deleted-confirmed' || observation.state === 'contract-ended')
        return yield* receiptFor(envelope, lease, observation.state)
      // Do not emit a workflow effect receipt for a request/schedule/unknown
      // result. The expired-lease observer is read-only and therefore cannot
      // turn a lost provider response into a duplicate paid mutation.
      return yield* Effect.fail(authorityFailure('node_retirement_provider_confirmation_pending'))
    }
    if (isRetireNetworkCleanupStep(envelope, authority)) {
      if (!isProviderRetirementTerminal(authority))
        return yield* Effect.fail(authorityFailure('node_retirement_provider_not_terminal'))
      if (authority.tunnel === undefined || dependencies.tunnels === undefined)
        return yield* Effect.fail(authorityFailure('node_retirement_tunnel_binding_unavailable'))
      yield* dependencies.tunnels
        .deleteExact({
          organizationId: envelope.organizationId,
          nodeId: authority.nodeId,
          tunnelId: authority.tunnel.id,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_tunnel_delete_failed')))
      const timestamp = now()
      yield* repository
        .recordNodeTunnelDeleted({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          tunnelId: authority.tunnel.id,
          expectedTunnelRevision: authority.tunnel.revision,
          now: timestamp,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_tunnel_receipt_failed')))
      yield* repository
        .finalizeNodeRetirement({
          organizationId: envelope.organizationId,
          operationId: envelope.operationId,
          nodeId: authority.nodeId,
          now: timestamp,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_finalize_failed')))
      return yield* receiptFor(envelope, lease, 'retirement-finalized')
    }
    return yield* Effect.fail(authorityFailure('node_termination_step_not_implemented'))
  })

/**
 * A local drain can be observed directly from its authoritative run row. A
 * provider step has no safe inference until its frozen provider binding is
 * available, so an expired lease remains non-executable rather than replayed.
 */
export const observeNodeTerminationWorkflowEffect = (
  database: LifecycleTerminationD1Database,
  input: { readonly envelope: TerminationWorkflowStepEnvelope; readonly lease: WorkflowStepLease },
  dependencies: NodeTerminationExecutionDependencies = {},
): Effect.Effect<WorkflowStepEffectObservation, TerminationWorkflowStepError> =>
  Effect.gen(function* () {
    const authority = yield* loadAuthority(database, input.envelope)
    const repository = makeNodeTerminationD1Repository(database)
    if (isLocalDrainStep(input.envelope, authority)) {
      if (
        authority.state === 'completed' ||
        authority.state === 'drained' ||
        authority.state === 'drained-forced' ||
        authority.state === 'blocked'
      )
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(input.envelope, input.lease, authority.state),
        }
      return { state: 'not-applied' as const }
    }
    if (
      isProviderPreconditionStep(input.envelope, authority) ||
      isRetireCredentialStep(input.envelope, authority)
    )
      return { state: 'not-applied' as const }
    if (isRebuildProviderStep(input.envelope, authority)) {
      const bootstrap = yield* repository
        .loadNodeRebuildBootstrap({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_bootstrap_load_failed')))
      if (bootstrap?.state === 'awaiting-agent' || bootstrap?.state === 'ready')
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(input.envelope, input.lease, 'provider-rebuild-active'),
        }
      const target = rebuildInput(authority)
      if (
        target === undefined ||
        dependencies.providers === undefined ||
        target.targetProviderImageId === undefined ||
        target.targetImageVersion === undefined
      )
        return { state: 'unknown' as const }
      const adapter = yield* dependencies.providers
        .openExact(target)
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_adapter_unavailable')))
      const transport = makeProviderRebuildTransport({
        ovh: adapter.provider,
        contabo: adapter.provider,
      })
      const observation = yield* transport
        .observe({
          provider: target.provider,
          organizationId: target.organizationId,
          operationId: target.operationId,
          nodeId: target.nodeId,
          providerNodeId: target.providerNodeId,
          imageId: target.targetProviderImageId,
          imageVersion: target.targetImageVersion,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_observe_failed')))
      const recorded = yield* repository
        .recordNodeProviderRebuildObservation({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
          observation,
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_provider_receipt_failed')))
      if (recorded.state === 'awaiting-agent' || recorded.state === 'ready')
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(input.envelope, input.lease, 'provider-rebuild-active'),
        }
      return { state: 'unknown' as const }
    }
    if (isRebuildBootstrapStep(input.envelope, authority)) {
      const bootstrap = yield* repository
        .loadNodeRebuildBootstrap({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_rebuild_bootstrap_load_failed')))
      return bootstrap?.state === 'awaiting-agent' || bootstrap?.state === 'ready'
        ? {
            state: 'applied' as const,
            receipt: yield* receiptFor(
              input.envelope,
              input.lease,
              'agent-bootstrap-authoritative',
            ),
          }
        : { state: 'unknown' as const }
    }
    if (isRebuildReadyStep(input.envelope, authority)) {
      if (authority.state !== 'completed') return { state: 'not-applied' as const }
      return {
        state: 'applied' as const,
        receipt: yield* receiptFor(input.envelope, input.lease, 'completed'),
      }
    }
    if (isRetireProviderStep(input.envelope, authority)) {
      if (isProviderRetirementTerminal(authority))
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(
            input.envelope,
            input.lease,
            authority.providerRetirementState!,
          ),
        }
      const target = retirementInput(authority)
      if (target === undefined || dependencies.providers === undefined)
        return { state: 'unknown' as const }
      const adapter = yield* dependencies.providers
        .openExact(target)
        .pipe(
          Effect.mapError(() => authorityFailure('node_retirement_provider_adapter_unavailable')),
        )
      const transport = makeProviderRetirementTransport({
        ovh: adapter.provider,
        contabo: adapter.provider,
      })
      const observation = yield* transport
        .observe({
          provider: target.provider,
          organizationId: target.organizationId,
          operationId: target.operationId,
          nodeId: target.nodeId,
          providerNodeId: target.providerNodeId,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_provider_observe_failed')))
      yield* repository
        .recordNodeProviderRetirement({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
          receipt: transport.asNodeReceipt(observation),
          now: now(),
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_provider_receipt_failed')))
      if (observation.state === 'deleted-confirmed' || observation.state === 'contract-ended')
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(input.envelope, input.lease, observation.state),
        }
      return { state: 'unknown' as const }
    }
    if (isRetireNetworkCleanupStep(input.envelope, authority)) {
      if (authority.state === 'completed')
        return {
          state: 'applied' as const,
          receipt: yield* receiptFor(input.envelope, input.lease, 'retirement-finalized'),
        }
      if (
        !isProviderRetirementTerminal(authority) ||
        authority.tunnel === undefined ||
        dependencies.tunnels === undefined
      )
        return { state: 'unknown' as const }
      const observation = yield* dependencies.tunnels
        .observeExact({
          organizationId: input.envelope.organizationId,
          nodeId: authority.nodeId,
          tunnelId: authority.tunnel.id,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_tunnel_observe_failed')))
      if (observation !== 'deleted') return { state: 'unknown' as const }
      const timestamp = now()
      yield* repository
        .recordNodeTunnelDeleted({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
          tunnelId: authority.tunnel.id,
          expectedTunnelRevision: authority.tunnel.revision,
          now: timestamp,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_tunnel_receipt_failed')))
      yield* repository
        .finalizeNodeRetirement({
          organizationId: input.envelope.organizationId,
          operationId: input.envelope.operationId,
          nodeId: authority.nodeId,
          now: timestamp,
        })
        .pipe(Effect.mapError(() => authorityFailure('node_retirement_finalize_failed')))
      return {
        state: 'applied' as const,
        receipt: yield* receiptFor(input.envelope, input.lease, 'retirement-finalized'),
      }
    }
    return { state: 'unknown' as const }
  })

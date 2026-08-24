import { Effect, Layer, Schema } from 'effect'
import {
  AgentCommand,
  CommandResult,
  canonicalCommandPayload,
  type AgentCommand as AgentCommandType,
  type CommandResult as CommandResultType,
} from '@gridora/agent-protocol'
import {
  BackupControl,
  BackupPersistenceError,
  type BackupControlShape,
  type BackupArtifact as BackupArtifactType,
  type BackupJob,
} from '@gridora/backup-control'
import { makeCloudflareControl, type CloudflareApiShape } from '@gridora/cloudflare-control'
import { makeBackupWorkflowReceiptD1Layer, type BackupD1Database } from '@gridora/backup-d1'
import {
  BackupArchiveAgentLayer,
  BackupRestoreCutoverLayer,
  BackupRestoreObservationLayer,
  BackupUploadPortLayer,
  BackupWorkflowError,
  BackupWorkflowExecutor,
  BackupWorkflowExecutorLive,
  BackupWorkflowSignatureLayer,
  canonicalWorkflowStep,
  type BackupArchiveAgentShape,
  type BackupRestoreCutoverShape,
  type BackupRestoreObservationShape,
  type BackupWorkflowExecutorShape,
  type SignedBackupWorkflowStep,
} from '@gridora/backup-workflow'
import type { NodeCoordinatorDO } from '@gridora/realtime'
import { commandSigner, sha256Hex } from './game-lifecycle-runtime.js'

export interface BackupWorkflowRuntimeBindings {
  readonly database: BackupD1Database
  readonly nodeCoordinator: DurableObjectNamespace<NodeCoordinatorDO>
  readonly signingKey: { readonly get: () => Promise<string> }
  readonly internalSecret: string
  readonly cloudflare?: CloudflareApiShape
  readonly dnsZoneId?: string
}

const workflowFailure = (
  code: ConstructorParameters<typeof BackupWorkflowError>[0]['code'],
  message: string,
) => new BackupWorkflowError({ code, message })

const hmac = (secret: string, value: string) =>
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
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
      )
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => new BackupPersistenceError({ operation: 'backup.workflow.hmac' }),
  })

const exactEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

const signCommand = (
  bindings: BackupWorkflowRuntimeBindings,
  input: Omit<AgentCommandType, 'signature'>,
) =>
  Effect.gen(function* () {
    const pem = yield* Effect.tryPromise({
      try: () => bindings.signingKey.get(),
      catch: () => workflowFailure('persistence-failed', 'agent signing key is unavailable'),
    })
    const signer = yield* commandSigner(pem).pipe(
      Effect.mapError(() => workflowFailure('persistence-failed', 'agent signing key is invalid')),
    )
    const signature = yield* Effect.tryPromise({
      try: () => signer.sign(canonicalCommandPayload({ ...input, signature: '' })),
      catch: () => workflowFailure('persistence-failed', 'agent command could not be signed'),
    })
    return yield* Schema.decodeUnknownEffect(AgentCommand, { onExcessProperty: 'error' })({
      ...input,
      signature,
    }).pipe(
      Effect.mapError(() =>
        workflowFailure('persistence-failed', 'agent command does not match the signed contract'),
      ),
    )
  })

const dispatch = (
  bindings: BackupWorkflowRuntimeBindings,
  input: {
    readonly effectId: string
    readonly organizationId: string
    readonly operationId: string
    readonly nodeId: string
    readonly resourceId: string
    readonly type: 'backup.create' | 'backup.restore'
    readonly pluginId: string
    readonly pluginVersion: string
    readonly payload: unknown
    readonly issuedAt: string
  },
) =>
  Effect.gen(function* () {
    const digest = yield* sha256Hex(
      `${input.organizationId}:${input.operationId}:${input.type}:${input.effectId}`,
    ).pipe(
      Effect.mapError(() =>
        workflowFailure('persistence-failed', 'backup command identity failed'),
      ),
    )
    const commandId = `backupcmd_${digest.slice(0, 48)}`
    const expiresAt = new Date(Date.parse(input.issuedAt) + 24 * 60 * 60_000).toISOString()
    const command = yield* signCommand(bindings, {
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId,
      operationId: input.operationId,
      organizationId: input.organizationId,
      nodeId: input.nodeId,
      resourceId: input.resourceId,
      type: input.type,
      payloadSchemaVersion: 1,
      plugin: { id: input.pluginId, version: input.pluginVersion },
      issuedAt: input.issuedAt,
      expiresAt,
      idempotencyKey: `backupcmd_${digest}`,
      expectedPriorRevision: null,
      payload: input.payload,
    })
    const coordinator = bindings.nodeCoordinator.getByName(
      `${input.organizationId}:${input.nodeId}`,
    )
    yield* Effect.tryPromise({
      try: () => coordinator.enqueue(command),
      catch: () => undefined,
    }).pipe(Effect.ignore)
    const result = yield* Effect.tryPromise({
      try: () =>
        coordinator.waitForCommandResult(input.organizationId, input.nodeId, commandId, 30),
      catch: () => workflowFailure('agent-failed', 'agent result transport failed'),
    })
    if (result === null)
      return yield* workflowFailure(
        'agent-failed',
        'agent command has no durable terminal result yet',
      )
    const decoded = yield* Schema.decodeUnknownEffect(CommandResult, { onExcessProperty: 'error' })(
      result,
    ).pipe(
      Effect.mapError(() =>
        workflowFailure('agent-failed', 'agent returned invalid terminal evidence'),
      ),
    )
    if (
      decoded.commandId !== commandId ||
      decoded.operationId !== input.operationId ||
      decoded.status !== 'succeeded'
    )
      return yield* workflowFailure(
        'agent-failed',
        'agent command did not succeed for the exact backup operation',
      )
    return decoded
  })

const restoreCommandId = (job: BackupJob, effectId: string) =>
  sha256Hex(`${job.organizationId}:${job.operationId}:backup.restore:${effectId}`).pipe(
    Effect.map((digest) => `backupcmd_${digest.slice(0, 48)}`),
  )

const durableRestoreResult = (
  bindings: BackupWorkflowRuntimeBindings,
  job: BackupJob,
  effectId: string,
) =>
  Effect.gen(function* () {
    if (job.targetNodeId === null)
      return yield* workflowFailure('invalid-step', 'restore target node is missing')
    const commandId = yield* restoreCommandId(job, effectId).pipe(
      Effect.mapError(() =>
        workflowFailure('persistence-failed', 'restore command identity failed'),
      ),
    )
    const result = yield* Effect.tryPromise({
      try: () =>
        bindings.nodeCoordinator
          .getByName(`${job.organizationId}:${job.targetNodeId}`)
          .waitForCommandResult(job.organizationId, job.targetNodeId!, commandId, 0),
      catch: () => workflowFailure('agent-failed', 'restore observation transport failed'),
    })
    if (result === null || result.status !== 'succeeded' || result.commandId !== commandId)
      return yield* workflowFailure(
        'restore-failed',
        'restore has no exact durable successful agent result',
      )
    return result as CommandResultType
  })

interface EndpointTransition {
  readonly id: string
  readonly providerRecordId: string
  readonly hostname: string
  readonly recordType: 'A' | 'AAAA'
  readonly sourceOwnerResourceId: string
  readonly sourceContent: string
  readonly sourceRevision: number
  readonly targetOwnerResourceId: string
  readonly targetContent: string
  readonly targetRevision: number
}

interface EndpointEffect {
  readonly effectId: string
  readonly sourceServerId: string
  readonly targetServerId: string
  readonly targetNodeId: string
  readonly targetDeploymentId: string
  readonly expectedCutoverRevision: number
  readonly sourceSnapshotJson: string
  readonly transitionPlanJson: string
  readonly state: 'planned' | 'applied' | 'rolled_back'
  readonly revision: number
  readonly transitions: readonly EndpointTransition[]
}

const directDnsType = (value: string): 'A' | 'AAAA' | undefined => {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return 'A'
  if (/^[0-9a-f:]+$/i.test(value) && value.includes(':')) return 'AAAA'
  return undefined
}

const parseTransitions = (value: string): readonly EndpointTransition[] => {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('endpoint transition plan is not an array')
  return parsed.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      !('providerRecordId' in item) ||
      !('hostname' in item) ||
      !('recordType' in item) ||
      !('sourceOwnerResourceId' in item) ||
      !('sourceContent' in item) ||
      !('sourceRevision' in item) ||
      !('targetOwnerResourceId' in item) ||
      !('targetContent' in item) ||
      !('targetRevision' in item) ||
      typeof item.id !== 'string' ||
      typeof item.providerRecordId !== 'string' ||
      typeof item.hostname !== 'string' ||
      (item.recordType !== 'A' && item.recordType !== 'AAAA') ||
      typeof item.sourceOwnerResourceId !== 'string' ||
      typeof item.sourceContent !== 'string' ||
      typeof item.sourceRevision !== 'number' ||
      typeof item.targetOwnerResourceId !== 'string' ||
      typeof item.targetContent !== 'string' ||
      typeof item.targetRevision !== 'number' ||
      item.sourceRevision < 1 ||
      item.targetRevision !== item.sourceRevision + 1
    )
      throw new Error('endpoint transition plan contains invalid state')
    return item as EndpointTransition
  })
}

const loadEndpointEffect = async (
  database: BackupD1Database,
  organizationId: string,
  jobId: string,
): Promise<EndpointEffect | null> => {
  const row = (await database
    .prepare(`SELECT effect_id AS effectId, source_server_id AS sourceServerId,
      target_server_id AS targetServerId, target_node_id AS targetNodeId,
      target_deployment_id AS targetDeploymentId,
      expected_cutover_revision AS expectedCutoverRevision,
      source_snapshot_json AS sourceSnapshotJson, transition_plan_json AS transitionPlanJson,
      state, revision
    FROM backup_restore_endpoint_effects WHERE organization_id = ? AND job_id = ?`)
    .bind(organizationId, jobId)
    .first()) as Record<string, unknown> | null
  if (row === null) return null
  if (
    typeof row.effectId !== 'string' ||
    typeof row.sourceServerId !== 'string' ||
    typeof row.targetServerId !== 'string' ||
    typeof row.targetNodeId !== 'string' ||
    typeof row.targetDeploymentId !== 'string' ||
    typeof row.expectedCutoverRevision !== 'number' ||
    typeof row.sourceSnapshotJson !== 'string' ||
    typeof row.transitionPlanJson !== 'string' ||
    (row.state !== 'planned' && row.state !== 'applied' && row.state !== 'rolled_back') ||
    typeof row.revision !== 'number'
  )
    throw new Error('endpoint effect is malformed')
  return {
    effectId: row.effectId,
    sourceServerId: row.sourceServerId,
    targetServerId: row.targetServerId,
    targetNodeId: row.targetNodeId,
    targetDeploymentId: row.targetDeploymentId,
    expectedCutoverRevision: row.expectedCutoverRevision,
    sourceSnapshotJson: row.sourceSnapshotJson,
    transitionPlanJson: row.transitionPlanJson,
    state: row.state,
    revision: row.revision,
    transitions: parseTransitions(row.transitionPlanJson),
  }
}

const effectMatches = (
  effect: EndpointEffect,
  input: {
    readonly effectId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  },
) =>
  effect.effectId === input.effectId &&
  effect.sourceServerId === input.sourceServerId &&
  effect.targetServerId === input.targetServerId &&
  effect.targetNodeId === input.targetNodeId

const planEndpointEffect = async (
  bindings: BackupWorkflowRuntimeBindings,
  input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  },
): Promise<EndpointEffect> => {
  const existing = await loadEndpointEffect(bindings.database, input.organizationId, input.jobId)
  if (existing !== null) {
    if (!effectMatches(existing, input)) throw new Error('endpoint effect identity conflicts')
    return existing
  }
  const target = (await bindings.database
    .prepare(`SELECT deployment.id, deployment.node_id AS nodeId,
      deployment.observed_state AS observedState, deployment.desired_revision AS revision
    FROM deployments deployment
    WHERE deployment.organization_id = ? AND deployment.server_id = ? AND deployment.node_id = ?`)
    .bind(input.organizationId, input.targetServerId, input.targetNodeId)
    .first()) as Record<string, unknown> | null
  if (
    target === null ||
    typeof target.id !== 'string' ||
    target.nodeId !== input.targetNodeId ||
    target.observedState !== 'running' ||
    typeof target.revision !== 'number'
  )
    throw new Error('target deployment is not authoritatively running')
  const source = (await bindings.database
    .prepare(`SELECT id, observed_state AS observedState FROM deployments
      WHERE organization_id = ? AND server_id = ?`)
    .bind(input.organizationId, input.sourceServerId)
    .first()) as Record<string, unknown> | null
  if (source === null || typeof source.id !== 'string' || source.observedState !== 'running')
    throw new Error('source deployment is not preserved and running')
  if (input.sourceServerId !== input.targetServerId) {
    const leases = await bindings.database
      .prepare(`SELECT id FROM port_leases WHERE organization_id = ? AND server_id = ?
        AND node_id = ? AND state = 'active' LIMIT 1`)
      .bind(input.organizationId, input.targetServerId, input.targetNodeId)
      .first()
    if (leases === null) throw new Error('target endpoint has no active port lease')
  }
  const targetDns =
    input.sourceServerId === input.targetServerId
      ? { results: [] as ReadonlyArray<unknown> }
      : await bindings.database
          .prepare(`SELECT target FROM dns_records
            WHERE organization_id = ? AND server_id = ? AND state = 'active'
              AND proxy_mode = 'dns_only' ORDER BY id`)
          .bind(input.organizationId, input.targetServerId)
          .all()
  const targetContents = [
    ...new Set(
      targetDns.results.flatMap((row) => {
        if (typeof row !== 'object' || row === null || !('target' in row)) return []
        return typeof row.target === 'string' && directDnsType(row.target) !== undefined
          ? [row.target]
          : []
      }),
    ),
  ]
  const targetContent =
    targetDns.results.length === 1 && targetContents.length === 1 ? targetContents[0] : undefined
  if (
    input.sourceServerId !== input.targetServerId &&
    (targetContent === undefined || directDnsType(targetContent) === undefined)
  )
    throw new Error('target deployment has no unique authoritative endpoint address')
  const rows = await bindings.database
    .prepare(`SELECT id, server_id AS serverId, provider_record_id AS providerRecordId,
      hostname, target, proxy_mode AS proxyMode, state, revision
    FROM dns_records WHERE organization_id = ? AND server_id = ? AND state = 'active'
    ORDER BY id`)
    .bind(input.organizationId, input.sourceServerId)
    .all()
  const sourceRows = rows.results as ReadonlyArray<Record<string, unknown>>
  const transitions: EndpointTransition[] = []
  if (input.sourceServerId !== input.targetServerId) {
    for (const row of sourceRows) {
      const recordType = typeof row.target === 'string' ? directDnsType(row.target) : undefined
      if (
        typeof row.id !== 'string' ||
        typeof row.serverId !== 'string' ||
        typeof row.providerRecordId !== 'string' ||
        row.providerRecordId.length === 0 ||
        typeof row.hostname !== 'string' ||
        typeof row.target !== 'string' ||
        row.proxyMode !== 'dns_only' ||
        row.state !== 'active' ||
        typeof row.revision !== 'number' ||
        recordType === undefined ||
        recordType !== directDnsType(targetContent!)
      )
        throw new Error('source DNS state is not eligible for exact direct-record transfer')
      transitions.push({
        id: row.id,
        providerRecordId: row.providerRecordId,
        hostname: row.hostname,
        recordType,
        sourceOwnerResourceId: input.sourceServerId,
        sourceContent: row.target,
        sourceRevision: row.revision,
        targetOwnerResourceId: input.targetServerId,
        targetContent: targetContent!,
        targetRevision: row.revision + 1,
      })
    }
  }
  const now = new Date().toISOString()
  const sourceSnapshotJson = JSON.stringify(sourceRows)
  const transitionPlanJson = JSON.stringify(transitions)
  try {
    await bindings.database
      .prepare(`INSERT INTO backup_restore_endpoint_effects
        (organization_id, job_id, effect_id, source_server_id, target_server_id,
         target_node_id, target_deployment_id, expected_cutover_revision,
         source_snapshot_json, transition_plan_json, state, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)
        ON CONFLICT(organization_id, job_id) DO NOTHING`)
      .bind(
        input.organizationId,
        input.jobId,
        input.effectId,
        input.sourceServerId,
        input.targetServerId,
        input.targetNodeId,
        target.id,
        target.revision,
        sourceSnapshotJson,
        transitionPlanJson,
        now,
        now,
      )
      .run()
  } catch {
    // Adopt only the exact immutable effect below after a lost D1 response.
  }
  const adopted = await loadEndpointEffect(bindings.database, input.organizationId, input.jobId)
  if (
    adopted === null ||
    !effectMatches(adopted, input) ||
    adopted.targetDeploymentId !== target.id ||
    adopted.expectedCutoverRevision !== target.revision ||
    adopted.sourceSnapshotJson !== sourceSnapshotJson ||
    adopted.transitionPlanJson !== transitionPlanJson ||
    adopted.state !== 'planned'
  )
    throw new Error('endpoint effect could not be durably adopted')
  return adopted
}

const transferProviderRecord = async (
  bindings: BackupWorkflowRuntimeBindings,
  organizationId: string,
  transition: EndpointTransition,
  direction: 'forward' | 'reverse',
) => {
  if (bindings.cloudflare === undefined || bindings.dnsZoneId === undefined)
    throw new Error('Cloudflare DNS transfer binding is unavailable')
  const reverse = direction === 'reverse'
  const result = await Effect.runPromise(
    makeCloudflareControl(bindings.cloudflare).transferDnsRecord({
      organizationId,
      zoneId: bindings.dnsZoneId,
      name: transition.hostname,
      type: transition.recordType,
      expectedOwnerResourceId: reverse
        ? transition.targetOwnerResourceId
        : transition.sourceOwnerResourceId,
      expectedContent: reverse ? transition.targetContent : transition.sourceContent,
      nextOwnerResourceId: reverse
        ? transition.sourceOwnerResourceId
        : transition.targetOwnerResourceId,
      nextContent: reverse ? transition.sourceContent : transition.targetContent,
    }),
  )
  if (result.recordId !== transition.providerRecordId)
    throw new Error('Cloudflare DNS record identity changed during transfer')
  return result
}

const persistProviderReceipt = async (
  database: BackupD1Database,
  input: { readonly organizationId: string; readonly jobId: string; readonly effectId: string },
  transition: EndpointTransition,
  state: 'applied' | 'rolled_back',
  disposition: 'applied' | 'adopted',
) => {
  try {
    await database
      .prepare(`INSERT INTO backup_restore_endpoint_provider_receipts
      (organization_id, job_id, effect_id, record_id, provider_record_id, hostname,
       record_type, source_owner_resource_id, source_content, target_owner_resource_id,
       target_content, state, disposition, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(organization_id, job_id, effect_id, record_id) DO UPDATE SET
        state = excluded.state, disposition = excluded.disposition,
        revision = backup_restore_endpoint_provider_receipts.revision + 1,
        updated_at = excluded.updated_at
      WHERE backup_restore_endpoint_provider_receipts.provider_record_id = excluded.provider_record_id
        AND backup_restore_endpoint_provider_receipts.hostname = excluded.hostname
        AND backup_restore_endpoint_provider_receipts.record_type = excluded.record_type
        AND backup_restore_endpoint_provider_receipts.source_owner_resource_id = excluded.source_owner_resource_id
        AND backup_restore_endpoint_provider_receipts.source_content = excluded.source_content
        AND backup_restore_endpoint_provider_receipts.target_owner_resource_id = excluded.target_owner_resource_id
        AND backup_restore_endpoint_provider_receipts.target_content = excluded.target_content`)
      .bind(
        input.organizationId,
        input.jobId,
        input.effectId,
        transition.id,
        transition.providerRecordId,
        transition.hostname,
        transition.recordType,
        transition.sourceOwnerResourceId,
        transition.sourceContent,
        transition.targetOwnerResourceId,
        transition.targetContent,
        state,
        disposition,
        new Date().toISOString(),
      )
      .run()
  } catch {
    // Re-read and adopt only the exact immutable provider receipt below.
  }
  const exact = (await database
    .prepare(`SELECT provider_record_id AS providerRecordId, hostname,
      record_type AS recordType, source_owner_resource_id AS sourceOwnerResourceId,
      source_content AS sourceContent, target_owner_resource_id AS targetOwnerResourceId,
      target_content AS targetContent, state
    FROM backup_restore_endpoint_provider_receipts
    WHERE organization_id = ? AND job_id = ? AND effect_id = ? AND record_id = ?`)
    .bind(input.organizationId, input.jobId, input.effectId, transition.id)
    .first()) as Record<string, unknown> | null
  if (
    exact?.providerRecordId !== transition.providerRecordId ||
    exact.hostname !== transition.hostname ||
    exact.recordType !== transition.recordType ||
    exact.sourceOwnerResourceId !== transition.sourceOwnerResourceId ||
    exact.sourceContent !== transition.sourceContent ||
    exact.targetOwnerResourceId !== transition.targetOwnerResourceId ||
    exact.targetContent !== transition.targetContent ||
    exact.state !== state
  )
    throw new Error('provider transfer receipt conflicts with the immutable plan')
}

const reverseProviderPlan = async (
  bindings: BackupWorkflowRuntimeBindings,
  input: { readonly organizationId: string; readonly jobId: string; readonly effectId: string },
  transitions: readonly EndpointTransition[],
) => {
  for (const transition of [...transitions].reverse()) {
    const result = await transferProviderRecord(
      bindings,
      input.organizationId,
      transition,
      'reverse',
    )
    await persistProviderReceipt(
      bindings.database,
      input,
      transition,
      'rolled_back',
      result.disposition,
    )
  }
}

const appliedCutoverIsExact = async (
  database: BackupD1Database,
  input: { readonly organizationId: string; readonly jobId: string; readonly effectId: string },
  effect: EndpointEffect,
) => {
  const receipt = (await database
    .prepare(`SELECT effect_id AS effectId, target_deployment_id AS targetDeploymentId,
      target_node_id AS targetNodeId, target_server_id AS targetServerId,
      cutover_revision AS cutoverRevision, state
    FROM backup_restore_endpoint_receipts WHERE organization_id = ? AND job_id = ?`)
    .bind(input.organizationId, input.jobId)
    .first()) as Record<string, unknown> | null
  if (
    receipt?.effectId !== input.effectId ||
    receipt.targetDeploymentId !== effect.targetDeploymentId ||
    receipt.targetNodeId !== effect.targetNodeId ||
    receipt.targetServerId !== effect.targetServerId ||
    receipt.cutoverRevision !== effect.expectedCutoverRevision ||
    receipt.state !== 'applied'
  )
    return false
  for (const transition of effect.transitions) {
    const row = (await database
      .prepare(`SELECT server_id AS serverId, provider_record_id AS providerRecordId,
        hostname, target, state, revision FROM dns_records
      WHERE organization_id = ? AND id = ?`)
      .bind(input.organizationId, transition.id)
      .first()) as Record<string, unknown> | null
    const provider = (await database
      .prepare(`SELECT state FROM backup_restore_endpoint_provider_receipts
      WHERE organization_id = ? AND job_id = ? AND effect_id = ? AND record_id = ?`)
      .bind(input.organizationId, input.jobId, input.effectId, transition.id)
      .first()) as Record<string, unknown> | null
    if (
      row?.serverId !== transition.targetOwnerResourceId ||
      row.providerRecordId !== transition.providerRecordId ||
      row.hostname !== transition.hostname ||
      row.target !== transition.targetContent ||
      row.state !== 'active' ||
      row.revision !== transition.targetRevision ||
      provider?.state !== 'applied'
    )
      return false
  }
  return true
}

export const applyBackupRestoreEndpointCutover = (
  bindings: BackupWorkflowRuntimeBindings,
  input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const effect = await planEndpointEffect(bindings, input)
      if (effect.state === 'rolled_back') throw new Error('endpoint effect is already rolled back')
      if (effect.state === 'applied') {
        if (await appliedCutoverIsExact(bindings.database, input, effect))
          return { cutover: true as const, sourcePreserved: true as const }
        throw new Error('applied endpoint effect no longer matches authoritative state')
      }
      try {
        for (const transition of effect.transitions) {
          const result = await transferProviderRecord(
            bindings,
            input.organizationId,
            transition,
            'forward',
          )
          await persistProviderReceipt(
            bindings.database,
            input,
            transition,
            'applied',
            result.disposition,
          )
        }
        const now = new Date().toISOString()
        const statements = effect.transitions.map((transition) =>
          bindings.database
            .prepare(`UPDATE dns_records SET server_id = ?, target = ?, revision = ?
            WHERE organization_id = ? AND id = ? AND server_id = ?
              AND provider_record_id = ? AND hostname = ? AND target = ?
              AND state = 'active' AND revision = ?`)
            .bind(
              transition.targetOwnerResourceId,
              transition.targetContent,
              transition.targetRevision,
              input.organizationId,
              transition.id,
              transition.sourceOwnerResourceId,
              transition.providerRecordId,
              transition.hostname,
              transition.sourceContent,
              transition.sourceRevision,
            ),
        )
        statements.push(
          bindings.database
            .prepare(`INSERT INTO backup_restore_endpoint_receipts
              (organization_id, job_id, effect_id, source_dns_json, target_dns_json,
               target_deployment_id, target_node_id, state, applied_at, updated_at,
               target_server_id, cutover_revision)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)`)
            .bind(
              input.organizationId,
              input.jobId,
              input.effectId,
              effect.sourceSnapshotJson,
              effect.transitionPlanJson,
              effect.targetDeploymentId,
              effect.targetNodeId,
              now,
              now,
              effect.targetServerId,
              effect.expectedCutoverRevision,
            ),
          bindings.database
            .prepare(`UPDATE backup_restore_endpoint_effects SET state = 'applied',
              revision = revision + 1, updated_at = ?
              WHERE organization_id = ? AND job_id = ? AND effect_id = ?
                AND state = 'planned' AND revision = ?`)
            .bind(now, input.organizationId, input.jobId, input.effectId, effect.revision),
        )
        const results = await bindings.database.batch(statements)
        if (results.some((result) => !result.success || result.meta?.changes !== 1))
          throw new Error('endpoint D1 cutover lost an exact row fence')
        return { cutover: true as const, sourcePreserved: true as const }
      } catch (cause) {
        const reread = await loadEndpointEffect(
          bindings.database,
          input.organizationId,
          input.jobId,
        )
        if (
          reread !== null &&
          reread.state === 'applied' &&
          effectMatches(reread, input) &&
          (await appliedCutoverIsExact(bindings.database, input, reread))
        )
          return { cutover: true as const, sourcePreserved: true as const }
        await reverseProviderPlan(bindings, input, effect.transitions)
        throw cause
      }
    },
    catch: () =>
      workflowFailure(
        'restore-failed',
        'source-preserving endpoint cutover could not be committed',
      ),
  })

const rolledBackCutoverIsExact = async (
  database: BackupD1Database,
  input: { readonly organizationId: string; readonly jobId: string; readonly effectId: string },
  effect: EndpointEffect,
) => {
  const fence = (await database
    .prepare(`SELECT rollback_effect_id AS rollbackEffectId,
      cutover_effect_id AS cutoverEffectId FROM backup_restore_endpoint_rollback_fences
      WHERE organization_id = ? AND job_id = ?`)
    .bind(input.organizationId, input.jobId)
    .first()) as Record<string, unknown> | null
  if (fence?.rollbackEffectId !== input.effectId || fence.cutoverEffectId !== effect.effectId)
    return false
  for (const transition of effect.transitions) {
    const row = (await database
      .prepare(`SELECT server_id AS serverId, provider_record_id AS providerRecordId,
        hostname, target, state, revision FROM dns_records
      WHERE organization_id = ? AND id = ?`)
      .bind(input.organizationId, transition.id)
      .first()) as Record<string, unknown> | null
    const provider = (await database
      .prepare(`SELECT state FROM backup_restore_endpoint_provider_receipts
      WHERE organization_id = ? AND job_id = ? AND effect_id = ? AND record_id = ?`)
      .bind(input.organizationId, input.jobId, effect.effectId, transition.id)
      .first()) as Record<string, unknown> | null
    if (
      row?.serverId !== transition.sourceOwnerResourceId ||
      row.providerRecordId !== transition.providerRecordId ||
      row.hostname !== transition.hostname ||
      row.target !== transition.sourceContent ||
      row.state !== 'active' ||
      (row.revision !== transition.sourceRevision &&
        row.revision !== transition.targetRevision + 1) ||
      provider?.state !== 'rolled_back'
    )
      return false
  }
  return true
}

export const rollbackBackupRestoreEndpointCutover = (
  bindings: BackupWorkflowRuntimeBindings,
  input: {
    readonly effectId: string
    readonly organizationId: string
    readonly jobId: string
    readonly sourceServerId: string
    readonly targetServerId: string
    readonly targetNodeId: string
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const effect = await loadEndpointEffect(bindings.database, input.organizationId, input.jobId)
      if (effect === null) {
        const createdAt = new Date().toISOString()
        let insertSucceeded = false
        try {
          const inserted = await bindings.database
            .prepare(`INSERT INTO backup_restore_pre_cutover_rollbacks
              (organization_id, job_id, rollback_effect_id, source_server_id,
               target_server_id, target_node_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(organization_id, job_id) DO NOTHING`)
            .bind(
              input.organizationId,
              input.jobId,
              input.effectId,
              input.sourceServerId,
              input.targetServerId,
              input.targetNodeId,
              createdAt,
            )
            .run()
          insertSucceeded = inserted.success
        } catch {
          // A lost D1 response is adopted only from the exact immutable row below.
        }
        const exact = (await bindings.database
          .prepare(`SELECT rollback_effect_id AS rollbackEffectId,
            source_server_id AS sourceServerId, target_server_id AS targetServerId,
            target_node_id AS targetNodeId
          FROM backup_restore_pre_cutover_rollbacks
          WHERE organization_id = ? AND job_id = ?`)
          .bind(input.organizationId, input.jobId)
          .first()) as Record<string, unknown> | null
        if (
          (!insertSucceeded && exact === null) ||
          exact?.rollbackEffectId !== input.effectId ||
          exact.sourceServerId !== input.sourceServerId ||
          exact.targetServerId !== input.targetServerId ||
          exact.targetNodeId !== input.targetNodeId
        )
          throw new Error('pre-cutover rollback identity conflicts')
        return { rolledBack: true as const, sourcePreserved: true as const }
      }
      if (
        effect.sourceServerId !== input.sourceServerId ||
        effect.targetServerId !== input.targetServerId ||
        effect.targetNodeId !== input.targetNodeId
      )
        throw new Error('rollback has no exact immutable cutover effect')
      if (await rolledBackCutoverIsExact(bindings.database, input, effect))
        return { rolledBack: true as const, sourcePreserved: true as const }
      const endpoint = (await bindings.database
        .prepare(`SELECT effect_id AS effectId, state, cutover_revision AS cutoverRevision,
          target_server_id AS targetServerId FROM backup_restore_endpoint_receipts
          WHERE organization_id = ? AND job_id = ?`)
        .bind(input.organizationId, input.jobId)
        .first()) as Record<string, unknown> | null
      const cutoverWasApplied = endpoint !== null
      if (
        endpoint !== null &&
        (endpoint.effectId !== effect.effectId ||
          endpoint.cutoverRevision !== effect.expectedCutoverRevision ||
          endpoint.targetServerId !== effect.targetServerId ||
          (endpoint.state !== 'applied' && endpoint.state !== 'rolled_back'))
      )
        throw new Error('rollback endpoint receipt conflicts with the cutover effect')
      const now = new Date().toISOString()
      try {
        await bindings.database
          .prepare(`INSERT INTO backup_restore_endpoint_rollbacks
            (organization_id, job_id, rollback_effect_id, cutover_effect_id,
             expected_cutover_revision, target_server_id, cutover_was_applied,
             state, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)
            ON CONFLICT(organization_id, job_id) DO NOTHING`)
          .bind(
            input.organizationId,
            input.jobId,
            input.effectId,
            effect.effectId,
            effect.expectedCutoverRevision,
            effect.targetServerId,
            cutoverWasApplied ? 1 : 0,
            now,
            now,
          )
          .run()
      } catch {
        // Re-read and adopt only the exact immutable rollback effect below.
      }
      const rollback = (await bindings.database
        .prepare(`SELECT rollback_effect_id AS rollbackEffectId,
          cutover_effect_id AS cutoverEffectId, expected_cutover_revision AS expectedRevision,
          target_server_id AS targetServerId, cutover_was_applied AS cutoverWasApplied,
          state, revision FROM backup_restore_endpoint_rollbacks
          WHERE organization_id = ? AND job_id = ?`)
        .bind(input.organizationId, input.jobId)
        .first()) as Record<string, unknown> | null
      if (
        rollback?.rollbackEffectId !== input.effectId ||
        rollback.cutoverEffectId !== effect.effectId ||
        rollback.expectedRevision !== effect.expectedCutoverRevision ||
        rollback.targetServerId !== effect.targetServerId ||
        rollback.cutoverWasApplied !== (cutoverWasApplied ? 1 : 0) ||
        typeof rollback.revision !== 'number' ||
        rollback.state !== 'planned'
      )
        throw new Error('rollback effect conflicts with the immutable cutover')
      await reverseProviderPlan(
        bindings,
        { organizationId: input.organizationId, jobId: input.jobId, effectId: effect.effectId },
        effect.transitions,
      )
      const updates = cutoverWasApplied
        ? effect.transitions.map((transition) =>
            bindings.database
              .prepare(`UPDATE dns_records SET server_id = ?, target = ?, revision = ?
                WHERE organization_id = ? AND id = ? AND server_id = ?
                  AND provider_record_id = ? AND hostname = ? AND target = ?
                  AND state = 'active' AND revision = ?`)
              .bind(
                transition.sourceOwnerResourceId,
                transition.sourceContent,
                transition.targetRevision + 1,
                input.organizationId,
                transition.id,
                transition.targetOwnerResourceId,
                transition.providerRecordId,
                transition.hostname,
                transition.targetContent,
                transition.targetRevision,
              ),
          )
        : effect.transitions.map((transition) =>
            bindings.database
              .prepare(`UPDATE dns_records SET revision = revision
                WHERE organization_id = ? AND id = ? AND server_id = ?
                  AND provider_record_id = ? AND hostname = ? AND target = ?
                  AND state = 'active' AND revision = ?`)
              .bind(
                input.organizationId,
                transition.id,
                transition.sourceOwnerResourceId,
                transition.providerRecordId,
                transition.hostname,
                transition.sourceContent,
                transition.sourceRevision,
              ),
          )
      if (cutoverWasApplied)
        updates.push(
          bindings.database
            .prepare(`UPDATE backup_restore_endpoint_receipts SET state = 'rolled_back',
              updated_at = ? WHERE organization_id = ? AND job_id = ?
              AND effect_id = ? AND state = 'applied' AND target_server_id = ?
              AND cutover_revision = ?`)
            .bind(
              now,
              input.organizationId,
              input.jobId,
              effect.effectId,
              effect.targetServerId,
              effect.expectedCutoverRevision,
            ),
        )
      updates.push(
        bindings.database
          .prepare(`UPDATE backup_restore_endpoint_effects SET state = 'rolled_back',
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND job_id = ? AND effect_id = ?
              AND state IN ('planned', 'applied') AND revision = ?`)
          .bind(now, input.organizationId, input.jobId, effect.effectId, effect.revision),
        bindings.database
          .prepare(`UPDATE backup_restore_endpoint_rollbacks SET state = 'applied',
            revision = revision + 1, updated_at = ?
            WHERE organization_id = ? AND job_id = ? AND rollback_effect_id = ?
              AND state = 'planned' AND revision = ?`)
          .bind(now, input.organizationId, input.jobId, input.effectId, rollback.revision),
        bindings.database
          .prepare(`INSERT INTO backup_restore_endpoint_rollback_fences
            (organization_id, job_id, rollback_effect_id, cutover_effect_id, applied_at)
            VALUES (?, ?, ?, ?, ?)`)
          .bind(input.organizationId, input.jobId, input.effectId, effect.effectId, now),
      )
      try {
        const results = await bindings.database.batch(updates)
        if (results.some((result) => !result.success || result.meta?.changes !== 1))
          throw new Error('rollback lost an exact provider or D1 row fence')
      } catch (cause) {
        if (await rolledBackCutoverIsExact(bindings.database, input, effect))
          return { rolledBack: true as const, sourcePreserved: true as const }
        throw cause
      }
      return { rolledBack: true as const, sourcePreserved: true as const }
    },
    catch: () =>
      workflowFailure('restore-failed', 'endpoint rollback could not restore exact source state'),
  })

export const makeBackupWorkflowExecutor = (
  bindings: BackupWorkflowRuntimeBindings,
  control: BackupControlShape,
  job: BackupJob,
  artifact: BackupArtifactType,
): Effect.Effect<BackupWorkflowExecutorShape, never> => {
  const restorePayload = (phase: 'stage' | 'validate' | 'commit' | 'rollback' | 'finalize') => ({
    manifest: {
      apiVersion: 'backup.gridora.dev/v1alpha1' as const,
      backupId: artifact.id,
      organizationId: artifact.organizationId,
      serverId: artifact.serverId,
      pluginId: artifact.metadata.pluginId,
      pluginVersion: artifact.metadata.pluginVersion,
      consistency: artifact.metadata.consistency,
      createdAt: artifact.createdAt,
      sha256: artifact.checksum,
      files: artifact.metadata.includes,
      diskBytes: 256 * 1024 ** 3,
    },
    targetServerId: job.targetServerId!,
    phase,
  })
  const runRestorePhase = (
    effectId: string,
    phase: 'stage' | 'validate' | 'commit' | 'rollback' | 'finalize',
  ) => {
    if (job.targetNodeId === null || job.targetServerId === null)
      return Effect.fail(workflowFailure('invalid-step', 'restore target is missing'))
    return dispatch(bindings, {
      effectId,
      organizationId: job.organizationId,
      operationId: job.operationId,
      nodeId: job.targetNodeId,
      resourceId: job.targetServerId,
      type: 'backup.restore',
      pluginId: artifact.metadata.pluginId,
      pluginVersion: artifact.metadata.pluginVersion,
      issuedAt: job.updatedAt,
      payload: restorePayload(phase),
    })
  }
  const agent: BackupArchiveAgentShape = {
    create: (input) =>
      dispatch(bindings, {
        effectId: input.effectId,
        organizationId: input.organizationId,
        operationId: job.operationId,
        nodeId: input.nodeId,
        resourceId: input.serverId,
        type: 'backup.create',
        pluginId: input.metadata.pluginId,
        pluginVersion: input.metadata.pluginVersion,
        issuedAt: job.updatedAt,
        payload: {
          backupId: input.backupId,
          pluginId: input.metadata.pluginId,
          pluginVersion: input.metadata.pluginVersion,
          consistency: input.metadata.consistency,
          files: input.metadata.includes,
          diskBytes: 256 * 1024 ** 3,
        },
      }).pipe(
        Effect.flatMap((result) => {
          const evidence = result.evidence
          return evidence?.kind === 'backup-uploaded' && evidence.backupId === input.backupId
            ? Effect.succeed({
                archivePath: `/var/lib/gridora/servers/${input.serverId}/backups/${input.backupId}.tar.zst`,
                ...evidence,
              })
            : Effect.fail(
                workflowFailure(
                  'upload-failed',
                  'agent result lacks exact verified upload evidence',
                ),
              )
        }),
      ),
    restore: (input) =>
      runRestorePhase(input.effectId, 'stage').pipe(
        Effect.as({ staged: true as const, validation: 'passed' as const }),
      ),
  }
  const cutover: BackupRestoreCutoverShape = {
    validate: (input) =>
      runRestorePhase(input.effectId, 'validate').pipe(Effect.as({ validated: true as const })),
    cutover: (input) =>
      runRestorePhase(input.effectId, 'commit').pipe(
        Effect.flatMap(() => applyBackupRestoreEndpointCutover(bindings, input)),
      ),
    rollback: (input) =>
      rollbackBackupRestoreEndpointCutover(bindings, input).pipe(
        Effect.flatMap(() => runRestorePhase(input.effectId, 'rollback')),
        Effect.as({ rolledBack: true as const, sourcePreserved: true as const }),
      ),
    finalize: (input) =>
      runRestorePhase(input.effectId, 'finalize').pipe(Effect.as({ finalized: true as const })),
  }
  const observation: BackupRestoreObservationShape = {
    observe: (input) =>
      Effect.tryPromise({
        try: () =>
          bindings.database
            .prepare(`SELECT effect_id AS effectId FROM backup_restore_endpoint_receipts
              WHERE organization_id = ? AND job_id = ? AND state = 'applied'
                AND target_server_id = ? AND target_node_id = ?`)
            .bind(input.organizationId, input.jobId, input.targetServerId, input.targetNodeId)
            .first() as Promise<{ readonly effectId: string } | null>,
        catch: () =>
          workflowFailure('persistence-failed', 'restore cutover receipt is unavailable'),
      }).pipe(
        Effect.flatMap((receipt) =>
          receipt === null
            ? Effect.fail(workflowFailure('restore-failed', 'restore cutover receipt is missing'))
            : durableRestoreResult(bindings, job, receipt.effectId),
        ),
        Effect.map((result) => ({
          observed: true as const,
          sourceServerId: input.sourceServerId,
          targetServerId: input.targetServerId,
          targetNodeId: input.targetNodeId,
          observedRevision: result.revision ?? 0,
        })),
      ),
  }
  const signature = BackupWorkflowSignatureLayer({
    verify: (step: SignedBackupWorkflowStep) => {
      const { signature, ...unsigned } = step
      return hmac(bindings.internalSecret, canonicalWorkflowStep(unsigned)).pipe(
        Effect.map((expected) => exactEqual(expected, signature)),
      )
    },
  })
  const layers = {
    agent: BackupArchiveAgentLayer(agent),
    upload: BackupUploadPortLayer({
      upload: () =>
        Effect.fail(workflowFailure('upload-failed', 'detached backup upload steps are disabled')),
    }),
    cutover: BackupRestoreCutoverLayer(cutover),
    observation: BackupRestoreObservationLayer(observation),
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(BackupControl, control),
    layers.agent,
    layers.upload,
    layers.cutover,
    layers.observation,
    makeBackupWorkflowReceiptD1Layer(bindings.database),
    signature,
  )
  return Effect.gen(function* () {
    return yield* BackupWorkflowExecutor
  }).pipe(Effect.provide(BackupWorkflowExecutorLive.pipe(Layer.provide(dependencies))))
}

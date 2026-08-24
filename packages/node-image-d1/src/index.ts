import { Context, Effect, Layer } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
  type AuditEnvelopeV1,
  type AuditRequestContextValue,
  type AuditStateSummary,
} from '@gridora/audit-contracts'
import {
  NodeImageConflictError,
  NodeImagePersistenceError,
  NodeImageRepository,
  type NodeImageAcceptance,
  type NodeImageAtomicInput,
  type NodeImageCommand,
  type NodeImageOperation,
  type NodeImageRepositoryShape,
  type NodeImageWorkflowStart,
} from '@gridora/node-image-control'

export interface NodeImageD1Result {
  readonly success?: boolean
  readonly results: ReadonlyArray<unknown>
  readonly meta?: { readonly changes?: number }
}
export interface NodeImageD1Statement {
  bind(...values: ReadonlyArray<unknown>): NodeImageD1Statement
  first(): Promise<unknown>
  all(): Promise<NodeImageD1Result>
}
export interface NodeImageD1Database {
  prepare(sql: string): NodeImageD1Statement
  /** Statements are one D1 transaction in their listed order. */
  batch(statements: ReadonlyArray<NodeImageD1Statement>): Promise<ReadonlyArray<NodeImageD1Result>>
}

export class NodeImageD1Client extends Context.Service<NodeImageD1Client, NodeImageD1Database>()(
  '@gridora/node-image-d1/NodeImageD1Client',
) {}
export const NodeImageD1ClientLayer = (database: NodeImageD1Database) =>
  Layer.succeed(NodeImageD1Client, database)

export interface NodeImageD1Options {
  readonly registrationId: (operationId: string) => string
  /**
   * The HTTP boundary supplies immutable request provenance.  An image
   * acceptance is a platform mutation, so it must not persist without the
   * complete v1 audit context that fences its durable acceptance operation.
   */
  readonly auditRequestContext?: AuditRequestContextValue
}
const defaults: NodeImageD1Options = {
  registrationId: (operationId) => `image-registration:${operationId}`,
}

const persistence = (operation: string) => new NodeImagePersistenceError({ operation })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => persistence(operation) })
const row = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
const text = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? (value[key] as string) : undefined
const integer = (value: Record<string, unknown>, key: string): number | undefined =>
  typeof value[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined
const nullableText = (value: Record<string, unknown>, key: string): string | null | undefined =>
  value[key] === null ? null : text(value, key)

const action = (value: unknown): NodeImageOperation['action'] | undefined => {
  switch (value) {
    case 'create':
    case 'test':
    case 'configure-scope':
    case 'register-provider':
    case 'promote':
    case 'rollback':
    case 'revoke':
      return value
    default:
      return undefined
  }
}
const operationState = (value: unknown): NodeImageOperation['state'] | undefined => {
  switch (value) {
    case 'queued':
    case 'running':
    case 'waiting-external':
    case 'succeeded':
    case 'failed-terminal':
      return value
    default:
      return undefined
  }
}
const startState = (value: unknown): NodeImageWorkflowStart['state'] | undefined =>
  value === 'pending' || value === 'started' || value === 'adopted' ? value : undefined

const decodeAcceptance = (
  value: unknown,
): Effect.Effect<NodeImageAcceptance, NodeImagePersistenceError> => {
  const found = row(value)
  if (found === undefined) return Effect.fail(persistence('nodeImageD1.replay.decode'))
  const operationId = text(found, 'operationId')
  const operationAction = action(found.action)
  const actorId = text(found, 'actorId')
  const idempotencyKey = text(found, 'idempotencyKey')
  const requestFingerprint = text(found, 'requestFingerprint')
  const opState = operationState(found.operationState)
  const revision = integer(found, 'operationRevision')
  const createdAt = text(found, 'operationCreatedAt')
  const updatedAt = text(found, 'operationUpdatedAt')
  const workflowId = text(found, 'workflowId')
  const workflowOperationId = text(found, 'workflowOperationId')
  const workflowType = text(found, 'workflowType')
  const workflowInstanceId = text(found, 'workflowInstanceId')
  const paramsFingerprint = text(found, 'paramsFingerprint')
  const workflowState = startState(found.workflowState)
  const attempts = integer(found, 'attempts')
  const lastError = nullableText(found, 'lastError')
  const imageId = nullableText(found, 'imageId')
  const scopeId = nullableText(found, 'scopeId')
  if (
    operationId === undefined ||
    operationAction === undefined ||
    actorId === undefined ||
    idempotencyKey === undefined ||
    requestFingerprint === undefined ||
    opState === undefined ||
    revision === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    workflowId === undefined ||
    workflowOperationId !== operationId ||
    workflowType !== 'NodeImageLifecycleWorkflow' ||
    workflowInstanceId !== operationId ||
    paramsFingerprint !== requestFingerprint ||
    workflowState === undefined ||
    attempts === undefined ||
    lastError === undefined ||
    imageId === undefined ||
    scopeId === undefined
  )
    return Effect.fail(persistence('nodeImageD1.replay.decode'))
  return Effect.succeed({
    disposition: 'created',
    operation: {
      id: operationId,
      action: operationAction,
      imageId,
      scopeId,
      actorId,
      idempotencyKey,
      requestFingerprint,
      state: opState,
      revision,
      createdAt,
      updatedAt,
    },
    workflowStart: {
      id: workflowId,
      operationId,
      workflowType: 'NodeImageLifecycleWorkflow',
      workflowInstanceId,
      paramsFingerprint,
      state: workflowState,
      attempts,
      lastError,
    },
  })
}

const replaySql = `SELECT
  operation.id AS operationId,
  operation.action AS action,
  operation.image_id AS imageId,
  operation.scope_id AS scopeId,
  operation.actor_id AS actorId,
  operation.idempotency_key AS idempotencyKey,
  operation.request_fingerprint AS requestFingerprint,
  operation.state AS operationState,
  operation.revision AS operationRevision,
  operation.created_at AS operationCreatedAt,
  operation.updated_at AS operationUpdatedAt,
  workflow.start_record_id AS workflowId,
  workflow.operation_id AS workflowOperationId,
  workflow.workflow_type AS workflowType,
  workflow.workflow_instance_id AS workflowInstanceId,
  workflow.params_fingerprint AS paramsFingerprint,
  workflow.state AS workflowState,
  workflow.attempts AS attempts,
  workflow.last_error AS lastError
FROM platform_node_image_operations operation
JOIN platform_node_image_workflow_starts workflow ON workflow.operation_id = operation.id
WHERE operation.idempotency_key = ?`

const commandCoordinates = (
  command: NodeImageCommand,
): { readonly imageId: string | null; readonly scopeId: string | null } => {
  switch (command.kind) {
    case 'create':
      return { imageId: command.intent.imageId, scopeId: null }
    case 'configure-scope':
      return { imageId: null, scopeId: command.intent.scopeId }
    case 'rollback':
      return { imageId: null, scopeId: command.scopeId }
    default:
      return {
        imageId: command.imageId,
        scopeId: command.kind === 'test' ? null : command.intent.scopeId,
      }
  }
}

const commandJson = (
  command: NodeImageCommand,
  verifiedTestingEvidence: NodeImageAtomicInput['verifiedTestingEvidence'],
  registrationId: string | null,
  resultScopeRevision: number | null,
  resultRegistrationRevision: number | null,
) => {
  const base: Record<string, unknown> = { kind: command.kind, intent: command.intent }
  switch (command.kind) {
    case 'create':
      base.imageId = command.intent.imageId
      break
    case 'configure-scope':
      base.scopeId = command.intent.scopeId
      break
    case 'rollback':
      base.scopeId = command.scopeId
      break
    case 'test':
    case 'register-provider':
    case 'promote':
    case 'revoke':
      base.imageId = command.imageId
      break
  }
  if (registrationId !== null) base.registrationId = registrationId
  // The public test command contains only a CI run ID. These facts arrive
  // only from the trusted evidence verifier and are kept with the exact
  // operation for the signed Workflow step.
  if (command.kind === 'test' && verifiedTestingEvidence !== null)
    base.trustedTestingEvidence = verifiedTestingEvidence
  if (resultScopeRevision !== null) base.resultScopeRevision = resultScopeRevision
  if (resultRegistrationRevision !== null)
    base.resultRegistrationRevision = resultRegistrationRevision
  return JSON.stringify(base)
}

interface ScopeRow {
  readonly id: string
  readonly revision: number
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerAccountId: string
  readonly region: string
  readonly architecture: 'amd64'
  readonly allowStockUbuntuCloudInitFallback: boolean
}
interface RegistrationRow {
  readonly id: string
  readonly revision: number
}
interface ImageAuditRow {
  readonly imageId: string
  readonly state: string
  readonly revision: number
  readonly sourceCommit: string
  readonly architecture: 'amd64'
  readonly artifactDigest: string
  readonly manifestDigest: string
}
interface InitialResourceStatements {
  readonly statements: ReadonlyArray<NodeImageD1Statement>
  readonly registrationId: string | null
  readonly resultScopeRevision: number | null
  readonly resultRegistrationRevision: number | null
}
const decodeScope = (value: unknown): ScopeRow | null => {
  const found = row(value)
  const id = found === undefined ? undefined : text(found, 'id')
  const revision = found === undefined ? undefined : integer(found, 'revision')
  const providerType = found === undefined ? undefined : text(found, 'providerType')
  const providerAccountId = found === undefined ? undefined : text(found, 'providerAccountId')
  const region = found === undefined ? undefined : text(found, 'region')
  const architecture = found === undefined ? undefined : text(found, 'architecture')
  const allowStockUbuntuCloudInitFallback =
    found === undefined ? undefined : integer(found, 'allowStockUbuntuCloudInitFallback')
  return id === undefined ||
    revision === undefined ||
    (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
    providerAccountId === undefined ||
    region === undefined ||
    architecture !== 'amd64' ||
    (allowStockUbuntuCloudInitFallback !== 0 && allowStockUbuntuCloudInitFallback !== 1)
    ? null
    : {
        id,
        revision,
        providerType,
        providerAccountId,
        region,
        architecture,
        allowStockUbuntuCloudInitFallback: allowStockUbuntuCloudInitFallback === 1,
      }
}
const decodeRegistration = (value: unknown): RegistrationRow | null => {
  const found = row(value)
  const id = found === undefined ? undefined : text(found, 'id')
  const revision = found === undefined ? undefined : integer(found, 'revision')
  return id === undefined || revision === undefined ? null : { id, revision }
}
const decodeImageAudit = (value: unknown): ImageAuditRow | null => {
  const found = row(value)
  const imageId = found === undefined ? undefined : text(found, 'imageId')
  const state = found === undefined ? undefined : text(found, 'state')
  const revision = found === undefined ? undefined : integer(found, 'revision')
  const sourceCommit = found === undefined ? undefined : text(found, 'sourceCommit')
  const architecture = found === undefined ? undefined : text(found, 'architecture')
  const artifactDigest = found === undefined ? undefined : text(found, 'artifactDigest')
  const manifestDigest = found === undefined ? undefined : text(found, 'manifestDigest')
  return imageId === undefined ||
    state === undefined ||
    revision === undefined ||
    sourceCommit === undefined ||
    architecture !== 'amd64' ||
    artifactDigest === undefined ||
    manifestDigest === undefined
    ? null
    : { imageId, state, revision, sourceCommit, architecture, artifactDigest, manifestDigest }
}

const scopeSql = `SELECT id, revision, provider_type AS providerType,
  provider_account_id AS providerAccountId, region, architecture,
  allow_stock_ubuntu_cloud_init_fallback AS allowStockUbuntuCloudInitFallback
  FROM node_image_policy_scopes WHERE id = ?`
const registrationSql = `SELECT id, revision FROM node_image_provider_registrations
  WHERE image_id = ? AND scope_id = ?`
const imageAuditSql = `SELECT image_id AS imageId, state, revision, source_commit AS sourceCommit,
  architecture, artifact_digest AS artifactDigest, manifest_digest AS manifestDigest
  FROM node_image_lifecycle_records WHERE image_id = ?`

const conflict = (code: NodeImageConflictError['code']) => new NodeImageConflictError({ code })

const scopeCoordinatesMatch = (
  scope: ScopeRow,
  intent: Extract<NodeImageCommand, { readonly kind: 'configure-scope' }>['intent'],
) =>
  scope.providerType === intent.providerType &&
  scope.providerAccountId === intent.providerAccountId &&
  scope.region === intent.region &&
  scope.architecture === intent.architecture

const initialResourceStatements = (
  database: NodeImageD1Database,
  input: NodeImageAtomicInput,
  scope: ScopeRow | null,
  registration: RegistrationRow | null,
  options: NodeImageD1Options,
): Effect.Effect<InitialResourceStatements, NodeImageConflictError | NodeImagePersistenceError> =>
  Effect.gen(function* () {
    const command = input.command
    if (command.kind === 'create') {
      return {
        statements: [
          database
            .prepare(`INSERT INTO node_images
              (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
              VALUES (?, ?, ?, ?, '{}', 'building', ?, NULL)`)
            .bind(
              command.intent.imageId,
              command.intent.version,
              command.intent.artifactDigest,
              JSON.stringify(command.intent.signature),
              input.now,
            ),
          database
            .prepare(`INSERT INTO node_image_lifecycle_records
              (image_id, source_commit, architecture, artifact_digest, manifest_digest, sbom_digest,
               build_log_digest, signature_evidence_json, scan_evidence_json, smoke_test_evidence_json,
               state, revision, legacy_unattested, created_at, updated_at, promoted_at, deprecated_at, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'building', 1, 0, ?, ?, NULL, NULL, NULL)`)
            .bind(
              command.intent.imageId,
              command.intent.sourceCommit,
              command.intent.architecture,
              command.intent.artifactDigest,
              command.intent.manifestDigest,
              command.intent.sbomDigest,
              command.intent.buildLogDigest,
              JSON.stringify(command.intent.signature),
              input.now,
              input.now,
            ),
        ],
        registrationId: null,
        resultScopeRevision: null,
        resultRegistrationRevision: null,
      }
    }
    if (command.kind === 'configure-scope') {
      const expected = command.intent.expectedScopeRevision
      if (
        (expected === 0 && scope !== null) ||
        (expected > 0 && (scope === null || scope.revision !== expected))
      )
        return yield* conflict('revision_conflict')
      // Scope coordinates are immutable. An update can change only the
      // explicit fallback policy; accepting different account/region data
      // here would persist a forged command for later Workflow execution.
      if (expected > 0 && scope !== null && !scopeCoordinatesMatch(scope, command.intent))
        return yield* conflict('scope_mismatch')
      const resultScopeRevision = expected === 0 ? 1 : expected + 1
      const statement =
        expected === 0
          ? database
              .prepare(`INSERT INTO node_image_policy_scopes
                (id, provider_type, provider_account_id, region, architecture,
                 allow_stock_ubuntu_cloud_init_fallback, promoted_image_id, last_known_good_image_id,
                 revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`)
              .bind(
                command.intent.scopeId,
                command.intent.providerType,
                command.intent.providerAccountId,
                command.intent.region,
                command.intent.architecture,
                command.intent.allowStockUbuntuCloudInitFallback ? 1 : 0,
                input.now,
                input.now,
              )
          : database
              .prepare(`UPDATE node_image_policy_scopes
                SET allow_stock_ubuntu_cloud_init_fallback = ?, revision = ?, updated_at = ?
                WHERE id = ? AND revision = ?`)
              .bind(
                command.intent.allowStockUbuntuCloudInitFallback ? 1 : 0,
                resultScopeRevision,
                input.now,
                command.intent.scopeId,
                expected,
              )
      return {
        statements: [statement],
        registrationId: null,
        resultScopeRevision,
        resultRegistrationRevision: null,
      }
    }
    if (command.kind === 'register-provider') {
      if (scope === null || scope.revision !== command.intent.expectedScopeRevision)
        return yield* conflict('revision_conflict')
      const expected = command.intent.expectedRegistrationRevision
      if (
        (expected === 0 && registration !== null) ||
        (expected > 0 && (registration === null || registration.revision !== expected))
      )
        return yield* conflict('revision_conflict')
      const registrationId = registration?.id ?? options.registrationId(input.identity.operationId)
      const resultRegistrationRevision = expected === 0 ? 1 : expected + 1
      const stock = command.intent.registration.mode === 'stock-ubuntu-cloud-init'
      if (stock && !scope.allowStockUbuntuCloudInitFallback)
        return yield* conflict('fallback_not_allowed')
      const statement =
        expected === 0
          ? database
              .prepare(`INSERT INTO node_image_provider_registrations
                (id, image_id, scope_id, provider_type, provider_account_id, provider_account_revision,
                 credential_reference, region, architecture,
                 mode, provider_image_id, provider_request_id, cloud_init_template_digest, state,
                 degraded_reason, revision, created_at, updated_at)
                SELECT ?, ?, scope.id, scope.provider_type, scope.provider_account_id, account.revision,
                  account.credential_reference, scope.region, scope.architecture, ?, ?, NULL, ?, ?, ?, 1, ?, ?
                FROM node_image_policy_scopes scope
                JOIN provider_accounts account ON account.id = scope.provider_account_id
                WHERE scope.id = ? AND account.scope = 'platform' AND account.organization_id IS NULL
                  AND account.status = 'active' AND account.provider_type = scope.provider_type`)
              .bind(
                registrationId,
                command.imageId,
                command.intent.registration.mode,
                stock ? command.intent.registration.stockImageId : null,
                stock ? command.intent.registration.cloudInitTemplateDigest : null,
                stock ? 'degraded' : 'pending',
                stock ? 'stock-ubuntu-cloud-init' : null,
                input.now,
                input.now,
                command.intent.scopeId,
              )
          : database
              .prepare(`UPDATE node_image_provider_registrations
                SET provider_image_id = ?, provider_request_id = NULL, state = ?, degraded_reason = ?,
                    provider_account_revision = account.revision, credential_reference = account.credential_reference,
                    revision = ?, updated_at = ?
                FROM provider_accounts account
                WHERE node_image_provider_registrations.id = ?
                  AND node_image_provider_registrations.provider_account_id = account.id
                  AND node_image_provider_registrations.provider_type = account.provider_type
                  AND account.scope = 'platform' AND account.organization_id IS NULL AND account.status = 'active'
                  AND node_image_provider_registrations.revision = ?`)
              .bind(
                stock ? command.intent.registration.stockImageId : null,
                stock ? 'degraded' : 'pending',
                stock ? 'stock-ubuntu-cloud-init' : null,
                resultRegistrationRevision,
                input.now,
                registrationId,
                expected,
              )
      return {
        statements: [statement],
        registrationId,
        resultScopeRevision: null,
        resultRegistrationRevision,
      }
    }
    return {
      statements: [],
      registrationId: null,
      resultScopeRevision: null,
      resultRegistrationRevision: null,
    }
  })

const operationInsert = (
  database: NodeImageD1Database,
  input: NodeImageAtomicInput,
  command: string,
) => {
  const coordinates = commandCoordinates(input.command)
  return database
    .prepare(`INSERT INTO platform_node_image_operations
      (id, action, image_id, scope_id, actor_id, actor_administrator_revision, audit_event_id, idempotency_key, request_fingerprint, command_json,
       state, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`)
    .bind(
      input.identity.operationId,
      input.command.kind,
      coordinates.imageId,
      coordinates.scopeId,
      input.command.actor.identityId,
      input.command.actor.administratorRevision,
      input.identity.auditEventId,
      input.command.idempotencyKey,
      input.requestFingerprint,
      command,
      input.now,
      input.now,
    )
}

const absent = (reason: string): AuditStateSummary => ({ state: 'absent', reason })
const captured = (summary: Record<string, unknown>): AuditStateSummary => ({
  state: 'captured',
  summary,
})
const imageSummary = (image: ImageAuditRow): Record<string, unknown> => ({
  imageId: image.imageId,
  state: image.state,
  revision: image.revision,
  sourceCommit: image.sourceCommit,
  architecture: image.architecture,
  artifactDigest: image.artifactDigest,
  manifestDigest: image.manifestDigest,
})
const scopeSummary = (scope: ScopeRow): Record<string, unknown> => ({
  scopeId: scope.id,
  revision: scope.revision,
  providerType: scope.providerType,
  providerAccountId: scope.providerAccountId,
  region: scope.region,
  architecture: scope.architecture,
  allowStockUbuntuCloudInitFallback: scope.allowStockUbuntuCloudInitFallback,
})

const auditCoordinates = (command: NodeImageCommand) => {
  const coordinates = commandCoordinates(command)
  const targetId = coordinates.imageId ?? coordinates.scopeId
  if (targetId === null) throw new Error('node image audit target is missing')
  return {
    targetType: coordinates.imageId === null ? 'node-image-scope' : 'node-image',
    targetId,
    imageId: coordinates.imageId,
    scopeId: coordinates.scopeId,
  }
}

const beforeAuditState = (
  coordinates: ReturnType<typeof auditCoordinates>,
  image: ImageAuditRow | null,
  scope: ScopeRow | null,
): AuditStateSummary =>
  coordinates.imageId === null
    ? scope === null
      ? absent('node image scope did not exist')
      : captured(scopeSummary(scope))
    : image === null
      ? absent('node image did not exist')
      : captured(imageSummary(image))

const afterAuditState = (
  input: NodeImageAtomicInput,
  coordinates: ReturnType<typeof auditCoordinates>,
  image: ImageAuditRow | null,
  scope: ScopeRow | null,
  staged: InitialResourceStatements,
): AuditStateSummary => {
  const operation = { acceptedOperationId: input.identity.operationId, action: input.command.kind }
  if (input.command.kind === 'create')
    return captured({
      imageId: input.command.intent.imageId,
      state: 'building',
      revision: 1,
      sourceCommit: input.command.intent.sourceCommit,
      architecture: input.command.intent.architecture,
      artifactDigest: input.command.intent.artifactDigest,
      manifestDigest: input.command.intent.manifestDigest,
      ...operation,
    })
  if (input.command.kind === 'configure-scope')
    return captured({
      scopeId: input.command.intent.scopeId,
      revision: staged.resultScopeRevision,
      providerType: input.command.intent.providerType,
      providerAccountId: input.command.intent.providerAccountId,
      region: input.command.intent.region,
      architecture: input.command.intent.architecture,
      allowStockUbuntuCloudInitFallback: input.command.intent.allowStockUbuntuCloudInitFallback,
      ...operation,
    })
  if (coordinates.imageId === null)
    return scope === null
      ? absent('node image scope did not exist after acceptance')
      : captured({ ...scopeSummary(scope), ...operation })
  if (image === null) return absent('node image did not exist after acceptance')
  return captured({
    ...imageSummary(image),
    ...(input.command.kind === 'register-provider'
      ? {
          providerRegistration: {
            id: staged.registrationId,
            revision: staged.resultRegistrationRevision,
            mode: input.command.intent.registration.mode,
          },
        }
      : {}),
    ...operation,
  })
}

interface NodeImageAcceptanceAudit {
  readonly envelope: AuditEnvelopeV1
  readonly statements: ReadonlyArray<NodeImageD1Statement>
}

const auditOperationId = (operationId: string) => `node-image-audit:${operationId}`

const auditOperationInsert = (
  database: NodeImageD1Database,
  input: NodeImageAtomicInput,
  envelope: AuditEnvelopeV1,
) =>
  database
    .prepare(`INSERT INTO platform_operations
      (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status, progress,
       idempotency_key, payload_fingerprint, revision, created_at, updated_at)
      VALUES (?, 'platform', ?, ?, ?, ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
    .bind(
      auditOperationId(input.identity.operationId),
      `${envelope.action}.accepted`,
      envelope.target.type,
      envelope.target.id,
      input.command.actor.identityId,
      envelope.request.correlationId,
      `node-image-audit:${input.identity.operationId}`,
      input.requestFingerprint,
      input.now,
      input.now,
    )

const auditInsert = (
  database: NodeImageD1Database,
  auditEventId: string,
  envelope: AuditEnvelopeV1,
) =>
  database
    .prepare(`INSERT INTO global_audit_events
      (id, scope, actor_id, action, target_type, target_id, result, correlation_id, summary_json, created_at)
      VALUES (?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      auditEventId,
      envelope.actor.id,
      envelope.action,
      envelope.target.type,
      envelope.target.id,
      envelope.result,
      envelope.request.correlationId,
      auditEventSummaryJson(envelope),
      envelope.occurredAt,
    )

const acceptanceAudit = (
  database: NodeImageD1Database,
  input: NodeImageAtomicInput,
  request: AuditRequestContextValue,
  scope: ScopeRow | null,
  image: ImageAuditRow | null,
  staged: InitialResourceStatements,
): Effect.Effect<NodeImageAcceptanceAudit, NodeImagePersistenceError> =>
  Effect.gen(function* () {
    const coordinates = auditCoordinates(input.command)
    const envelope = yield* completeAuditEnvelope({
      occurredAt: input.now,
      scope: 'platform',
      organizationId: null,
      actor: { type: 'platform', id: input.command.actor.identityId },
      action: `node-image.${input.command.kind}`,
      target: { type: coordinates.targetType, id: coordinates.targetId },
      before: beforeAuditState(coordinates, image, scope),
      after: afterAuditState(input, coordinates, image, scope, staged),
      operationId: auditOperationId(input.identity.operationId),
      request,
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError(() => persistence('nodeImageD1.accept.audit-envelope')))
    const stage = yield* stageAuditEnvelope(
      'platform',
      input.identity.auditEventId,
      envelope,
      input.now,
    ).pipe(Effect.mapError(() => persistence('nodeImageD1.accept.audit-stage')))
    return {
      envelope,
      statements: [
        auditOperationInsert(database, input, envelope),
        database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
        auditInsert(database, input.identity.auditEventId, envelope),
      ],
    }
  })

const outboxInsert = (database: NodeImageD1Database, input: NodeImageAtomicInput) =>
  database
    .prepare(`INSERT INTO platform_node_image_outbox
      (id, operation_id, event_type, payload_json, publish_state, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)`)
    .bind(
      input.identity.outboxEventId,
      input.identity.operationId,
      `node-image.${input.command.kind}.accepted`,
      JSON.stringify({ operationId: input.identity.operationId, action: input.command.kind }),
      input.now,
    )

const workflowStartInsert = (database: NodeImageD1Database, input: NodeImageAtomicInput) =>
  database
    .prepare(`INSERT INTO platform_node_image_workflow_starts
      (operation_id, start_record_id, workflow_type, workflow_instance_id, params_fingerprint,
       state, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, 'NodeImageLifecycleWorkflow', ?, ?, 'pending', 0, NULL, ?, ?)`)
    .bind(
      input.identity.operationId,
      input.identity.workflowStartRecordId,
      input.identity.operationId,
      input.requestFingerprint,
      input.now,
      input.now,
    )

export const makeNodeImageRepositoryD1 = (
  database: NodeImageD1Database,
  configured: Partial<NodeImageD1Options> = {},
): NodeImageRepositoryShape => {
  const options = { ...defaults, ...configured }
  const findReplay = (idempotencyKey: string, requestFingerprint: string) =>
    attempt('nodeImageD1.replay.read', () =>
      database.prepare(replaySql).bind(idempotencyKey).first(),
    ).pipe(
      Effect.flatMap((value) =>
        value === null || value === undefined
          ? Effect.succeed(null)
          : decodeAcceptance(value).pipe(
              Effect.flatMap((acceptance) =>
                acceptance.operation.requestFingerprint === requestFingerprint
                  ? Effect.succeed(acceptance)
                  : Effect.fail(conflict('idempotency_conflict')),
              ),
            ),
      ),
    )

  const acceptAtomic = (input: NodeImageAtomicInput) =>
    Effect.gen(function* () {
      const existing = yield* findReplay(input.command.idempotencyKey, input.requestFingerprint)
      if (existing !== null) return { ...existing, disposition: 'adopted' as const }
      if (
        options.auditRequestContext === undefined ||
        options.auditRequestContext.correlationId !== input.command.correlationId
      )
        return yield* persistence('nodeImageD1.accept.audit-request-context')
      const scopeId =
        input.command.kind === 'configure-scope'
          ? input.command.intent.scopeId
          : input.command.kind === 'rollback'
            ? input.command.scopeId
            : input.command.kind === 'register-provider' ||
                input.command.kind === 'promote' ||
                input.command.kind === 'revoke'
              ? input.command.intent.scopeId
              : null
      const scope =
        scopeId === null
          ? null
          : decodeScope(
              yield* attempt('nodeImageD1.accept.scope', () =>
                database.prepare(scopeSql).bind(scopeId).first(),
              ),
            )
      const coordinates = commandCoordinates(input.command)
      const image =
        coordinates.imageId === null
          ? null
          : decodeImageAudit(
              yield* attempt('nodeImageD1.accept.image-audit', () =>
                database.prepare(imageAuditSql).bind(coordinates.imageId).first(),
              ),
            )
      const command = input.command
      if (command.kind === 'test' && input.verifiedTestingEvidence === null)
        return yield* persistence('nodeImageD1.accept.trusted-testing-evidence')
      const registration =
        command.kind === 'register-provider'
          ? decodeRegistration(
              yield* attempt('nodeImageD1.accept.registration', () =>
                database
                  .prepare(registrationSql)
                  .bind(command.imageId, command.intent.scopeId)
                  .first(),
              ),
            )
          : null
      const staged = yield* initialResourceStatements(database, input, scope, registration, options)
      const storedCommand = commandJson(
        input.command,
        input.verifiedTestingEvidence,
        staged.registrationId,
        staged.resultScopeRevision,
        staged.resultRegistrationRevision,
      )
      const audit = yield* acceptanceAudit(
        database,
        input,
        options.auditRequestContext,
        scope,
        image,
        staged,
      )
      yield* attempt('nodeImageD1.accept.atomic', () =>
        database.batch([
          ...staged.statements,
          ...audit.statements,
          operationInsert(database, input, storedCommand),
          outboxInsert(database, input),
          workflowStartInsert(database, input),
        ]),
      ).pipe(
        Effect.mapError((error) => {
          if (error instanceof NodeImagePersistenceError) return conflict('revision_conflict')
          return error
        }),
      )
      const accepted = yield* findReplay(input.command.idempotencyKey, input.requestFingerprint)
      if (accepted === null) return yield* persistence('nodeImageD1.accept.read-after-write')
      return accepted
    })

  const updateWorkflow = (operationId: string, started: boolean, message?: string) =>
    attempt(`nodeImageD1.workflow.${started ? 'started' : 'failure'}`, () =>
      database
        .prepare(
          started
            ? `UPDATE platform_node_image_workflow_starts
              SET state = CASE WHEN state = 'pending' THEN 'started' ELSE state END,
                  attempts = attempts + 1, last_error = NULL, updated_at = updated_at
              WHERE operation_id = ?`
            : `UPDATE platform_node_image_workflow_starts
              SET attempts = attempts + 1, last_error = ?, updated_at = updated_at
              WHERE operation_id = ?`,
        )
        .bind(...(started ? [operationId] : [message ?? 'workflow-start-failed', operationId]))
        .all(),
    ).pipe(Effect.asVoid)

  return {
    findReplay,
    acceptAtomic,
    markWorkflowStarted: (operationId) => updateWorkflow(operationId, true),
    recordWorkflowStartFailure: (operationId, message) =>
      updateWorkflow(operationId, false, message),
  }
}

export const NodeImageRepositoryD1Live = (options: Partial<NodeImageD1Options> = {}) =>
  Layer.effect(
    NodeImageRepository,
    Effect.gen(function* () {
      return NodeImageRepository.of(makeNodeImageRepositoryD1(yield* NodeImageD1Client, options))
    }),
  )

/** The fixed data a signed Workflow step must load from D1; no caller selects an image action. */
export interface NodeImageWorkflowReservation {
  readonly operationId: string
  readonly workflowStartRecordId: string
  readonly requestFingerprint: string
  readonly action: NodeImageOperation['action']
  readonly imageId: string | null
  readonly scopeId: string | null
  readonly commandJson: string
}
export interface NodeImageExecutionRepositoryShape {
  readonly loadExact: (input: {
    readonly operationId: string
    readonly workflowStartRecordId: string
    readonly requestFingerprint: string
  }) => Effect.Effect<
    NodeImageWorkflowReservation,
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Claim the one durable step. A duplicate delivery can adopt but cannot create again. */
  readonly claimExact: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly now: string
    readonly claimId: string
    readonly leaseExpiresAt: string
    /** A trusted-clock bound that remains immutable across claim recovery. */
    readonly recoveryDeadlineAtEpochMs: number
  }) => Effect.Effect<NodeImageExecutionClaim, NodeImageConflictError | NodeImagePersistenceError>
  /** Complete a non-provider action, or a policy-authorized stock fallback. */
  readonly completeLocal: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
    readonly now: string
  }) => Effect.Effect<
    { readonly status: 'completed' | 'adopted' },
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Read immutable D1 coordinates for the provider transport; no HTTP body supplies them. */
  readonly registrationWork: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
  }) => Effect.Effect<
    NodeImageProviderRegistrationWork,
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Re-read the active account fence immediately before a credential-bound provider transport opens. */
  readonly preflightProviderRegistration: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
  }) => Effect.Effect<
    NodeImageProviderRegistrationAuthority,
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Persist the exact point after which a provider request might have opened. */
  readonly beginProviderDispatch: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
    readonly now: string
  }) => Effect.Effect<void, NodeImageConflictError | NodeImagePersistenceError>
  /** Release a proven pre-dispatch lease so a transient local dependency can retry create once. */
  readonly releasePreDispatch: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
    readonly now: string
    readonly code: NodeImagePreDispatchRetryCode
  }) => Effect.Effect<
    { readonly status: 'waiting-external' | 'adopted' },
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Persist a single metadata-bound provider result after the durable claim. */
  readonly settleProviderRegistration: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
    readonly now: string
    readonly outcome:
      | {
          readonly kind: 'registered' | 'adopted'
          readonly providerImageId: string
          readonly providerRequestId: string | null
        }
      | {
          readonly kind: 'uncertain'
          readonly nextAttemptNumber: number
          readonly nextAttemptAtEpochMs: number
          readonly recoveryDeadlineAtEpochMs: number
        }
  }) => Effect.Effect<
    { readonly status: 'completed' | 'adopted' | 'waiting-external' },
    NodeImageConflictError | NodeImagePersistenceError
  >
  /** Record a redacted, definitive provider failure and close the exact lease. */
  readonly failTerminal: (input: {
    readonly reservation: NodeImageWorkflowReservation
    readonly claim: NodeImageExecutionClaim
    readonly now: string
    readonly code: NodeImageProviderTerminalFailureCode
  }) => Effect.Effect<
    { readonly status: 'failed-terminal' | 'adopted' },
    NodeImageConflictError | NodeImagePersistenceError
  >
}
export class NodeImageExecutionRepository extends Context.Service<
  NodeImageExecutionRepository,
  NodeImageExecutionRepositoryShape
>()('@gridora/node-image-d1/NodeImageExecutionRepository') {}

export interface NodeImageExecutionClaim {
  readonly disposition: 'execute' | 'adopted' | 'waiting-external' | 'failed-terminal'
  readonly reservation: NodeImageWorkflowReservation
  readonly claimId: string | null
  readonly claimAttempt: number | null
}

export interface NodeImageProviderRegistrationWork {
  readonly registrationId: string
  readonly registrationRevision: number
  readonly mode: 'custom-image' | 'stock-ubuntu-cloud-init'
  readonly registrationState: 'pending' | 'registered' | 'uncertain' | 'degraded' | 'revoked'
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerAccountId: string
  readonly providerAccountRevision: number
  /** Reference only; the resolver opens it within its secret boundary. */
  readonly credentialReference: string
  readonly region: string
  readonly architecture: 'amd64'
  readonly imageId: string
  readonly version: string
  readonly sourceCommit: string
  readonly artifactDigest: string
  readonly providerRequestId: string | null
  readonly adoptionAttempt: number
  readonly adoptionDeadlineAtEpochMs: number
  readonly mustAdoptOnly: boolean
}
export interface NodeImageProviderRegistrationAuthority {
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerAccountId: string
  readonly providerAccountRevision: number
  readonly credentialReference: string
}
export type NodeImageProviderTerminalFailureCode =
  | 'provider_account_unavailable'
  | 'provider_authentication_failed'
  | 'provider_authorization_failed'
  | 'provider_validation_failed'
  | 'provider_quota_exhausted'
  | 'provider_conflict'
  | 'provider_billing_action_required'
  | 'provider_unsupported_capability'
  | 'provider_reconciliation_required'
export type NodeImagePreDispatchRetryCode =
  | 'artifact_locator_unavailable'
  | 'provider_transport_unavailable'

const reservationSql = `SELECT operation.id AS operationId, workflow.start_record_id AS workflowStartRecordId,
 operation.request_fingerprint AS requestFingerprint, operation.action AS action, operation.image_id AS imageId,
 operation.scope_id AS scopeId, operation.command_json AS commandJson
 FROM platform_node_image_operations operation
 JOIN platform_node_image_workflow_starts workflow ON workflow.operation_id = operation.id
 WHERE operation.id = ? AND workflow.start_record_id = ? AND workflow.params_fingerprint = ?
   AND workflow.workflow_instance_id = operation.id AND workflow.workflow_type = 'NodeImageLifecycleWorkflow'
   AND workflow.state IN ('started', 'adopted')`

type NodeImageStepReceiptState = 'running' | 'completed' | 'waiting-external' | 'failed-terminal'
interface NodeImageStepReceipt {
  readonly state: NodeImageStepReceiptState
  readonly revision: number
  readonly claimId: string
  readonly claimAttempt: number
  readonly leaseExpiresAt: string
  readonly recoveryDeadlineAtEpochMs: number
  readonly providerDispatchStarted: boolean
  readonly resultJson: string | null
}
interface NodeImageExecutionScope {
  readonly id: string
  readonly revision: number
  readonly promotedImageId: string | null
  readonly lastKnownGoodImageId: string | null
}
interface NodeImageExecutionImage {
  readonly id: string
  readonly state: 'building' | 'testing' | 'promoted' | 'deprecated' | 'revoked'
  readonly revision: number
}

const receiptState = (value: unknown): NodeImageStepReceiptState | undefined => {
  switch (value) {
    case 'running':
    case 'completed':
    case 'waiting-external':
    case 'failed-terminal':
      return value
    default:
      return undefined
  }
}
const stepReceiptSql = `SELECT state, revision, claim_id AS claimId, claim_attempt AS claimAttempt,
  lease_expires_at AS leaseExpiresAt, recovery_deadline_at_epoch_ms AS recoveryDeadlineAtEpochMs,
  provider_dispatch_started AS providerDispatchStarted, result_json AS resultJson
  FROM platform_node_image_step_receipts WHERE operation_id = ? AND ordinal = 0`
const executionScopeSql = `SELECT id, revision, promoted_image_id AS promotedImageId,
  last_known_good_image_id AS lastKnownGoodImageId FROM node_image_policy_scopes WHERE id = ?`
const executionImageSql = `SELECT image_id AS id, state, revision
  FROM node_image_lifecycle_records WHERE image_id = ?`

const decodeStepReceipt = (value: unknown): NodeImageStepReceipt | null => {
  if (value === null || value === undefined) return null
  const found = row(value)
  const state = found === undefined ? undefined : receiptState(found.state)
  const revision = found === undefined ? undefined : integer(found, 'revision')
  const claimId = found === undefined ? undefined : text(found, 'claimId')
  const claimAttempt = found === undefined ? undefined : integer(found, 'claimAttempt')
  const leaseExpiresAt = found === undefined ? undefined : text(found, 'leaseExpiresAt')
  const recoveryDeadlineAtEpochMs =
    found === undefined ? undefined : integer(found, 'recoveryDeadlineAtEpochMs')
  const providerDispatchStarted =
    found === undefined ? undefined : integer(found, 'providerDispatchStarted')
  const resultJson = found === undefined ? undefined : nullableText(found, 'resultJson')
  return state === undefined ||
    revision === undefined ||
    claimId === undefined ||
    claimAttempt === undefined ||
    leaseExpiresAt === undefined ||
    recoveryDeadlineAtEpochMs === undefined ||
    (providerDispatchStarted !== 0 && providerDispatchStarted !== 1) ||
    resultJson === undefined
    ? null
    : {
        state,
        revision,
        claimId,
        claimAttempt,
        leaseExpiresAt,
        recoveryDeadlineAtEpochMs,
        providerDispatchStarted: providerDispatchStarted === 1,
        resultJson,
      }
}
const decodeExecutionScope = (value: unknown): NodeImageExecutionScope | null => {
  const found = row(value)
  const id = found === undefined ? undefined : text(found, 'id')
  const revision = found === undefined ? undefined : integer(found, 'revision')
  const promotedImageId = found === undefined ? undefined : nullableText(found, 'promotedImageId')
  const lastKnownGoodImageId =
    found === undefined ? undefined : nullableText(found, 'lastKnownGoodImageId')
  return id === undefined ||
    revision === undefined ||
    promotedImageId === undefined ||
    lastKnownGoodImageId === undefined
    ? null
    : { id, revision, promotedImageId, lastKnownGoodImageId }
}
const decodeExecutionImage = (value: unknown): NodeImageExecutionImage | null => {
  const found = row(value)
  const id = found === undefined ? undefined : text(found, 'id')
  const valueState = found === undefined ? undefined : text(found, 'state')
  const revision = found === undefined ? undefined : integer(found, 'revision')
  if (
    id === undefined ||
    revision === undefined ||
    (valueState !== 'building' &&
      valueState !== 'testing' &&
      valueState !== 'promoted' &&
      valueState !== 'deprecated' &&
      valueState !== 'revoked')
  )
    return null
  return { id, state: valueState, revision }
}

const storedIntent = (reservation: NodeImageWorkflowReservation) =>
  Effect.try({
    try: () => {
      const decoded = JSON.parse(reservation.commandJson) as unknown
      if (typeof decoded !== 'object' || decoded === null || !('intent' in decoded))
        throw new Error('intent')
      const intent = (decoded as { readonly intent?: unknown }).intent
      if (typeof intent !== 'object' || intent === null) throw new Error('intent')
      return intent as Readonly<Record<string, unknown>>
    },
    catch: () => persistence('nodeImageD1.execution.command'),
  })
const positiveField = (intent: Readonly<Record<string, unknown>>, key: string) => {
  const value = intent[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
const registrationIdFromCommand = (reservation: NodeImageWorkflowReservation) =>
  Effect.try({
    try: () => {
      const decoded = JSON.parse(reservation.commandJson) as unknown
      if (typeof decoded !== 'object' || decoded === null) throw new Error('command')
      const registrationId = (decoded as { readonly registrationId?: unknown }).registrationId
      if (typeof registrationId !== 'string' || registrationId.length === 0)
        throw new Error('registration')
      return registrationId
    },
    catch: () => persistence('nodeImageD1.execution.registration-id'),
  })

const maximumNodeImageLeaseMilliseconds = 10 * 60 * 1000
const maximumNodeImageRecoveryMilliseconds = 24 * 60 * 60 * 1000
const epochMilliseconds = (value: string): number | null => {
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
const isClaimId = (value: string): boolean => value.length >= 16
const exactRunningClaimSql = `EXISTS (
  SELECT 1 FROM platform_node_image_step_receipts receipt
  WHERE receipt.operation_id = ? AND receipt.ordinal = 0 AND receipt.state = 'running'
    AND receipt.claim_id = ? AND receipt.claim_attempt = ?
)`
const exactRunningClaimValues = (
  reservation: NodeImageWorkflowReservation,
  claim: NodeImageExecutionClaim,
): readonly [string, string | null, number | null] => [
  reservation.operationId,
  claim.claimId,
  claim.claimAttempt,
]
const exactWaitingClaimSql = `EXISTS (
  SELECT 1 FROM platform_node_image_step_receipts receipt
  WHERE receipt.operation_id = ? AND receipt.ordinal = 0 AND receipt.state = 'waiting-external'
    AND receipt.claim_id = ? AND receipt.claim_attempt = ?
)`
const exactWaitingClaimValues = exactRunningClaimValues
const exactRunningClaimRevisionSql = `EXISTS (
  SELECT 1 FROM platform_node_image_step_receipts receipt
  WHERE receipt.operation_id = ? AND receipt.ordinal = 0 AND receipt.state = 'running'
    AND receipt.claim_id = ? AND receipt.claim_attempt = ? AND receipt.revision = ?
)`
const exactRunningClaimRevisionValues = (
  reservation: NodeImageWorkflowReservation,
  claim: NodeImageExecutionClaim,
  receiptRevision: number,
): readonly [string, string | null, number | null, number] => [
  reservation.operationId,
  claim.claimId,
  claim.claimAttempt,
  receiptRevision,
]

const completionStatements = (
  database: NodeImageD1Database,
  reservation: NodeImageWorkflowReservation,
  claim: NodeImageExecutionClaim,
  receiptRevision: number,
  now: string,
  result: Readonly<Record<string, unknown>>,
) => [
  database
    .prepare(`UPDATE platform_node_image_step_receipts
      SET state = 'completed', result_json = ?, revision = ?, updated_at = ?
      WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
        AND claim_id = ? AND claim_attempt = ?`)
    .bind(
      JSON.stringify(result),
      receiptRevision + 1,
      now,
      reservation.operationId,
      receiptRevision,
      claim.claimId,
      claim.claimAttempt,
    ),
  database
    .prepare(`UPDATE platform_node_image_operations
      SET state = 'succeeded', revision = revision + 1, updated_at = ?
      WHERE id = ? AND request_fingerprint = ? AND state IN ('running', 'waiting-external')`)
    .bind(now, reservation.operationId, reservation.requestFingerprint),
]

interface NodeImageTerminalAuditAuthority {
  readonly actorId: string
  readonly correlationId: string
  readonly imageId: string
  readonly imageState: NodeImageExecutionImage['state']
  readonly imageRevision: number
}
const terminalAuditAuthoritySql = `SELECT operation.actor_id AS actorId,
  accepted.correlation_id AS correlationId, operation.image_id AS imageId,
  image.state AS imageState, image.revision AS imageRevision
  FROM platform_node_image_operations operation
  JOIN global_audit_events accepted ON accepted.id = operation.audit_event_id
  JOIN node_image_lifecycle_records image ON image.image_id = operation.image_id
  WHERE operation.id = ? AND operation.action = 'register-provider'
    AND operation.state = 'running' AND operation.request_fingerprint = ?`
const decodeTerminalAuditAuthority = (value: unknown): NodeImageTerminalAuditAuthority | null => {
  const found = row(value)
  const actorId = found === undefined ? undefined : text(found, 'actorId')
  const correlationId = found === undefined ? undefined : text(found, 'correlationId')
  const imageId = found === undefined ? undefined : text(found, 'imageId')
  const imageState = found === undefined ? undefined : text(found, 'imageState')
  const imageRevision = found === undefined ? undefined : integer(found, 'imageRevision')
  if (
    actorId === undefined ||
    correlationId === undefined ||
    imageId === undefined ||
    imageRevision === undefined ||
    (imageState !== 'building' &&
      imageState !== 'testing' &&
      imageState !== 'promoted' &&
      imageState !== 'deprecated' &&
      imageState !== 'revoked')
  )
    return null
  return { actorId, correlationId, imageId, imageState, imageRevision }
}
const terminalAuditOperationId = (operationId: string) =>
  `node-image-terminal-operation:${operationId}`

const terminalAuditStatements = (
  database: NodeImageD1Database,
  reservation: NodeImageWorkflowReservation,
  authority: NodeImageTerminalAuditAuthority,
  auditEventId: string,
  now: string,
  code: NodeImageProviderTerminalFailureCode,
): Effect.Effect<ReadonlyArray<NodeImageD1Statement>, NodeImagePersistenceError> =>
  Effect.gen(function* () {
    const operationId = terminalAuditOperationId(reservation.operationId)
    const envelope = yield* completeAuditEnvelope({
      occurredAt: now,
      scope: 'platform',
      organizationId: null,
      actor: { type: 'platform', id: authority.actorId },
      action: 'node-image.register-provider.failed-terminal',
      target: { type: 'node-image', id: authority.imageId },
      before: captured({
        imageId: authority.imageId,
        state: authority.imageState,
        revision: authority.imageRevision,
      }),
      after: captured({
        imageId: authority.imageId,
        state: authority.imageState,
        revision: authority.imageRevision,
        operationId: reservation.operationId,
        code,
      }),
      operationId,
      request: {
        origin: 'machine',
        requestId: `node-image-workflow:${reservation.operationId}`,
        correlationId: authority.correlationId,
        source: {
          ip: { state: 'not-available', reason: 'machine-workflow-no-client-ip' },
          access: { state: 'not-available', reason: 'machine-workflow-no-access-claim' },
        },
      },
      result: 'failed',
      error: { classification: 'provider', code },
      forced: false,
      breakGlass: false,
    }).pipe(Effect.mapError(() => persistence('nodeImageD1.execution.terminal-audit-envelope')))
    const stage = yield* stageAuditEnvelope('platform', auditEventId, envelope, now).pipe(
      Effect.mapError(() => persistence('nodeImageD1.execution.terminal-audit-stage')),
    )
    return [
      database
        .prepare(`INSERT INTO platform_operations
          (id, scope, type, resource_type, resource_id, actor_id, correlation_id, status, progress,
           idempotency_key, payload_fingerprint, revision, created_at, updated_at)
          VALUES (?, 'platform', 'node-image.register-provider.failed-terminal', 'node-image', ?, ?, ?,
                  'failed', 100, ?, ?, 1, ?, ?)`)
        .bind(
          operationId,
          authority.imageId,
          authority.actorId,
          authority.correlationId,
          `node-image-terminal:${reservation.operationId}`,
          reservation.requestFingerprint,
          now,
          now,
        ),
      database.prepare(auditEnvelopeStageSql).bind(...auditEnvelopeStageBindings(stage)),
      auditInsert(database, auditEventId, envelope),
    ]
  })

export const makeNodeImageExecutionRepositoryD1 = (
  database: NodeImageD1Database,
): NodeImageExecutionRepositoryShape => {
  const loadExact: NodeImageExecutionRepositoryShape['loadExact'] = (input) =>
    attempt('nodeImageD1.execution.load', () =>
      database
        .prepare(reservationSql)
        .bind(input.operationId, input.workflowStartRecordId, input.requestFingerprint)
        .first(),
    ).pipe(
      Effect.flatMap((value) => {
        const found = row(value)
        const operationId = found === undefined ? undefined : text(found, 'operationId')
        const workflowStartRecordId =
          found === undefined ? undefined : text(found, 'workflowStartRecordId')
        const requestFingerprint =
          found === undefined ? undefined : text(found, 'requestFingerprint')
        const valueAction = found === undefined ? undefined : action(found.action)
        const imageId = found === undefined ? undefined : nullableText(found, 'imageId')
        const scopeId = found === undefined ? undefined : nullableText(found, 'scopeId')
        const commandJson = found === undefined ? undefined : text(found, 'commandJson')
        if (
          operationId !== input.operationId ||
          workflowStartRecordId !== input.workflowStartRecordId ||
          requestFingerprint !== input.requestFingerprint ||
          valueAction === undefined ||
          imageId === undefined ||
          scopeId === undefined ||
          commandJson === undefined
        )
          return Effect.fail(conflict('scope_mismatch'))
        return Effect.succeed({
          operationId,
          workflowStartRecordId,
          requestFingerprint,
          action: valueAction,
          imageId,
          scopeId,
          commandJson,
        })
      }),
    )

  const readReceipt = (
    operationId: string,
  ): Effect.Effect<NodeImageStepReceipt | null, NodeImagePersistenceError> =>
    attempt('nodeImageD1.execution.receipt', () =>
      database.prepare(stepReceiptSql).bind(operationId).first(),
    ).pipe(
      Effect.flatMap((value) => {
        const decoded = decodeStepReceipt(value)
        return value === null || value === undefined
          ? Effect.succeed(null)
          : decoded === null
            ? Effect.fail(persistence('nodeImageD1.execution.receipt.decode'))
            : Effect.succeed(decoded)
      }),
    )
  const readScope = (
    scopeId: string,
  ): Effect.Effect<NodeImageExecutionScope, NodeImageConflictError | NodeImagePersistenceError> =>
    attempt('nodeImageD1.execution.scope', () =>
      database.prepare(executionScopeSql).bind(scopeId).first(),
    ).pipe(
      Effect.flatMap((value) => {
        const decoded = decodeExecutionScope(value)
        return decoded === null
          ? Effect.fail(conflict('revision_conflict'))
          : Effect.succeed(decoded)
      }),
    )
  const readImage = (
    imageId: string,
  ): Effect.Effect<NodeImageExecutionImage, NodeImageConflictError | NodeImagePersistenceError> =>
    attempt('nodeImageD1.execution.image', () =>
      database.prepare(executionImageSql).bind(imageId).first(),
    ).pipe(
      Effect.flatMap((value) => {
        const decoded = decodeExecutionImage(value)
        return decoded === null
          ? Effect.fail(conflict('invalid_transition'))
          : Effect.succeed(decoded)
      }),
    )
  const ensureRunning = (
    reservation: NodeImageWorkflowReservation,
    claim: NodeImageExecutionClaim,
  ): Effect.Effect<
    { readonly receipt: NodeImageStepReceipt; readonly adopted: boolean },
    NodeImageConflictError | NodeImagePersistenceError
  > =>
    readReceipt(reservation.operationId).pipe(
      Effect.flatMap((receipt) => {
        if (receipt?.state === 'completed') {
          const result: { readonly receipt: NodeImageStepReceipt; readonly adopted: boolean } = {
            receipt,
            adopted: true,
          }
          return Effect.succeed(result)
        }
        if (receipt?.state !== 'running') return Effect.fail(conflict('invalid_transition'))
        if (
          claim.claimId === null ||
          claim.claimAttempt === null ||
          claim.reservation.operationId !== reservation.operationId ||
          receipt.claimId !== claim.claimId ||
          receipt.claimAttempt !== claim.claimAttempt
        )
          return Effect.fail(conflict('invalid_transition'))
        const result: { readonly receipt: NodeImageStepReceipt; readonly adopted: boolean } = {
          receipt,
          adopted: false,
        }
        return Effect.succeed(result)
      }),
    )
  const complete = (
    reservation: NodeImageWorkflowReservation,
    claim: NodeImageExecutionClaim,
    now: string,
    resources: ReadonlyArray<NodeImageD1Statement>,
    result: Readonly<Record<string, unknown>>,
  ): Effect.Effect<
    { readonly status: 'completed' | 'adopted' },
    NodeImageConflictError | NodeImagePersistenceError
  > =>
    Effect.gen(function* () {
      const current = yield* ensureRunning(reservation, claim)
      if (current.adopted) return { status: 'adopted' as const }
      yield* attempt('nodeImageD1.execution.complete', () =>
        database.batch([
          ...resources,
          ...completionStatements(
            database,
            reservation,
            claim,
            current.receipt.revision,
            now,
            result,
          ),
        ]),
      ).pipe(Effect.mapError(() => conflict('invalid_transition')))
      const after = yield* readReceipt(reservation.operationId)
      if (after?.state !== 'completed') return yield* conflict('invalid_transition')
      return { status: 'completed' as const }
    })

  const claimExact: NodeImageExecutionRepositoryShape['claimExact'] = ({
    reservation,
    now,
    claimId,
    leaseExpiresAt,
    recoveryDeadlineAtEpochMs,
  }) =>
    Effect.gen(function* () {
      const nowEpochMilliseconds = epochMilliseconds(now)
      const leaseEpochMilliseconds = epochMilliseconds(leaseExpiresAt)
      if (
        nowEpochMilliseconds === null ||
        leaseEpochMilliseconds === null ||
        !isClaimId(claimId) ||
        leaseEpochMilliseconds <= nowEpochMilliseconds ||
        leaseEpochMilliseconds > nowEpochMilliseconds + maximumNodeImageLeaseMilliseconds ||
        !Number.isSafeInteger(recoveryDeadlineAtEpochMs) ||
        recoveryDeadlineAtEpochMs <= nowEpochMilliseconds ||
        recoveryDeadlineAtEpochMs > nowEpochMilliseconds + maximumNodeImageRecoveryMilliseconds
      )
        return yield* conflict('invalid_transition')
      const exact = yield* loadExact(reservation)
      const existing = yield* readReceipt(exact.operationId)
      if (existing?.state === 'completed')
        return {
          disposition: 'adopted' as const,
          reservation: exact,
          claimId: null,
          claimAttempt: null,
        }
      if (existing?.state === 'failed-terminal')
        return {
          disposition: 'failed-terminal' as const,
          reservation: exact,
          claimId: null,
          claimAttempt: null,
        }
      if (existing?.state === 'running') {
        const existingLeaseEpochMilliseconds = epochMilliseconds(existing.leaseExpiresAt)
        if (existingLeaseEpochMilliseconds === null)
          return yield* persistence('nodeImageD1.execution.receipt.lease')
        if (existingLeaseEpochMilliseconds > nowEpochMilliseconds)
          return {
            disposition: 'waiting-external' as const,
            reservation: exact,
            claimId: null,
            claimAttempt: null,
          }
        // A lease can only be taken after it expires. The caller may resume a
        // local D1 transition, but provider registration is made adopt-only by
        // its increased claim attempt below.
        yield* attempt('nodeImageD1.execution.recover-expired-claim', () =>
          database.batch([
            database
              .prepare(`UPDATE platform_node_image_step_receipts
                SET claim_id = ?, claim_attempt = ?, lease_expires_at = ?, revision = ?, updated_at = ?
                WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
                  AND claim_id = ? AND claim_attempt = ? AND lease_expires_at <= ?`)
              .bind(
                claimId,
                existing.claimAttempt + 1,
                leaseExpiresAt,
                existing.revision + 1,
                now,
                exact.operationId,
                existing.revision,
                existing.claimId,
                existing.claimAttempt,
                now,
              ),
          ]),
        ).pipe(Effect.mapError(() => conflict('invalid_transition')))
      } else if (existing?.state === 'waiting-external') {
        yield* attempt('nodeImageD1.execution.resume', () =>
          database.batch([
            database
              .prepare(`UPDATE platform_node_image_operations
                SET state = 'running', revision = revision + 1, updated_at = ?
                WHERE id = ? AND request_fingerprint = ? AND state = 'waiting-external'`)
              .bind(now, exact.operationId, exact.requestFingerprint),
            database
              .prepare(`UPDATE platform_node_image_step_receipts
                SET state = 'running', claim_id = ?, claim_attempt = ?, lease_expires_at = ?, revision = ?, updated_at = ?
                WHERE operation_id = ? AND ordinal = 0 AND state = 'waiting-external' AND revision = ?`)
              .bind(
                claimId,
                existing.claimAttempt + 1,
                leaseExpiresAt,
                existing.revision + 1,
                now,
                exact.operationId,
                existing.revision,
              ),
          ]),
        ).pipe(Effect.mapError(() => conflict('invalid_transition')))
      } else {
        yield* attempt('nodeImageD1.execution.claim', () =>
          database.batch([
            database
              .prepare(`UPDATE platform_node_image_operations
                SET state = 'running', revision = revision + 1, updated_at = ?
                WHERE id = ? AND request_fingerprint = ? AND state = 'queued'`)
              .bind(now, exact.operationId, exact.requestFingerprint),
            database
              .prepare(`INSERT INTO platform_node_image_step_receipts
                (operation_id, workflow_instance_id, workflow_type, step_name, ordinal, request_fingerprint,
                 state, claim_id, claim_attempt, lease_expires_at, recovery_deadline_at_epoch_ms,
                 provider_request_id, result_json, revision, created_at, updated_at)
                VALUES (?, ?, 'NodeImageLifecycleWorkflow', 'apply-node-image-lifecycle', 0, ?,
                  'running', ?, 1, ?, ?, NULL, NULL, 1, ?, ?)`)
              .bind(
                exact.operationId,
                exact.operationId,
                exact.requestFingerprint,
                claimId,
                leaseExpiresAt,
                recoveryDeadlineAtEpochMs,
                now,
                now,
              ),
          ]),
        ).pipe(Effect.mapError(() => conflict('invalid_transition')))
      }
      const claimed = yield* readReceipt(exact.operationId)
      if (claimed?.state !== 'running' || claimed.claimId !== claimId || claimed.claimAttempt < 1)
        return {
          disposition: 'waiting-external' as const,
          reservation: exact,
          claimId: null,
          claimAttempt: null,
        }
      return {
        disposition: 'execute' as const,
        reservation: exact,
        claimId,
        claimAttempt: claimed.claimAttempt,
      }
    })

  const registrationWork: NodeImageExecutionRepositoryShape['registrationWork'] = ({
    reservation,
    claim,
  }) =>
    Effect.gen(function* () {
      if (reservation.action !== 'register-provider') return yield* conflict('invalid_transition')
      const running = yield* ensureRunning(reservation, claim)
      if (running.adopted) return yield* conflict('invalid_transition')
      const registrationId = yield* registrationIdFromCommand(reservation)
      const loaded = yield* attempt('nodeImageD1.execution.registration-work', () =>
        database
          .prepare(`SELECT registration.id AS registrationId, registration.mode, registration.state AS registrationState,
            registration.revision AS registrationRevision,
            registration.provider_type AS providerType, registration.provider_account_id AS providerAccountId,
            registration.provider_account_revision AS providerAccountRevision,
            registration.credential_reference AS credentialReference,
            registration.region, registration.architecture, registration.provider_request_id AS providerRequestId,
            image.image_id AS imageId, node_image.version, image.source_commit AS sourceCommit,
            image.artifact_digest AS artifactDigest, receipt.result_json AS resultJson,
            receipt.claim_attempt AS claimAttempt,
            receipt.recovery_deadline_at_epoch_ms AS recoveryDeadlineAtEpochMs,
            receipt.provider_dispatch_started AS providerDispatchStarted
          FROM node_image_provider_registrations registration
          JOIN provider_accounts account ON account.id = registration.provider_account_id
          JOIN node_image_lifecycle_records image ON image.image_id = registration.image_id
          JOIN node_images node_image ON node_image.id = image.image_id
          JOIN platform_node_image_step_receipts receipt ON receipt.operation_id = ? AND receipt.ordinal = 0
          WHERE registration.id = ? AND registration.image_id = ? AND registration.scope_id = ?
            AND account.provider_type = registration.provider_type
            AND account.scope = 'platform' AND account.organization_id IS NULL AND account.status = 'active'
            AND account.revision = registration.provider_account_revision
            AND account.credential_reference = registration.credential_reference`)
          .bind(reservation.operationId, registrationId, reservation.imageId, reservation.scopeId)
          .first(),
      )
      const found = row(loaded)
      const registrationState = found === undefined ? undefined : text(found, 'registrationState')
      const mode = found === undefined ? undefined : text(found, 'mode')
      const providerType = found === undefined ? undefined : text(found, 'providerType')
      const architecture = found === undefined ? undefined : text(found, 'architecture')
      const providerRequestId =
        found === undefined ? undefined : nullableText(found, 'providerRequestId')
      const imageId = found === undefined ? undefined : text(found, 'imageId')
      const version = found === undefined ? undefined : text(found, 'version')
      const sourceCommit = found === undefined ? undefined : text(found, 'sourceCommit')
      const artifactDigest = found === undefined ? undefined : text(found, 'artifactDigest')
      const id = found === undefined ? undefined : text(found, 'registrationId')
      const registrationRevision =
        found === undefined ? undefined : integer(found, 'registrationRevision')
      const providerAccountId = found === undefined ? undefined : text(found, 'providerAccountId')
      const providerAccountRevision =
        found === undefined ? undefined : integer(found, 'providerAccountRevision')
      const credentialReference =
        found === undefined ? undefined : text(found, 'credentialReference')
      const region = found === undefined ? undefined : text(found, 'region')
      const receiptClaimAttempt = found === undefined ? undefined : integer(found, 'claimAttempt')
      const recoveryDeadlineAtEpochMs =
        found === undefined ? undefined : integer(found, 'recoveryDeadlineAtEpochMs')
      const providerDispatchStarted =
        found === undefined ? undefined : integer(found, 'providerDispatchStarted')
      if (
        id === undefined ||
        registrationRevision === undefined ||
        (mode !== 'custom-image' && mode !== 'stock-ubuntu-cloud-init') ||
        (registrationState !== 'pending' &&
          registrationState !== 'registered' &&
          registrationState !== 'uncertain' &&
          registrationState !== 'degraded' &&
          registrationState !== 'revoked') ||
        (providerType !== 'ovhcloud' && providerType !== 'contabo') ||
        providerAccountId === undefined ||
        providerAccountRevision === undefined ||
        credentialReference === undefined ||
        region === undefined ||
        architecture !== 'amd64' ||
        imageId === undefined ||
        version === undefined ||
        sourceCommit === undefined ||
        artifactDigest === undefined ||
        providerRequestId === undefined ||
        receiptClaimAttempt === undefined ||
        recoveryDeadlineAtEpochMs === undefined ||
        recoveryDeadlineAtEpochMs <= 0 ||
        (providerDispatchStarted !== 0 && providerDispatchStarted !== 1)
      )
        return yield* conflict('registration_unavailable')
      const recovery =
        registrationState !== 'uncertain' ||
        found === undefined ||
        typeof found.resultJson !== 'string'
          ? null
          : (() => {
              try {
                const value = JSON.parse(found.resultJson) as Record<string, unknown>
                const attempt = value.nextAttemptNumber
                const nextAttemptAtEpochMs = value.nextAttemptAtEpochMs
                const storedDeadline = value.recoveryDeadlineAtEpochMs
                if (
                  typeof attempt !== 'number' ||
                  !Number.isSafeInteger(attempt) ||
                  attempt < 1 ||
                  typeof nextAttemptAtEpochMs !== 'number' ||
                  !Number.isSafeInteger(nextAttemptAtEpochMs) ||
                  typeof storedDeadline !== 'number' ||
                  !Number.isSafeInteger(storedDeadline) ||
                  storedDeadline !== recoveryDeadlineAtEpochMs ||
                  nextAttemptAtEpochMs > recoveryDeadlineAtEpochMs
                )
                  return 'malformed' as const
                return { attempt, nextAttemptAtEpochMs }
              } catch {
                return 'malformed' as const
              }
            })()
      if (recovery === 'malformed') return yield* conflict('registration_unavailable')
      return {
        registrationId: id,
        registrationRevision,
        mode,
        registrationState,
        providerType,
        providerAccountId,
        providerAccountRevision,
        credentialReference,
        region,
        architecture,
        imageId,
        version,
        sourceCommit,
        artifactDigest,
        providerRequestId,
        adoptionAttempt:
          recovery === null
            ? providerDispatchStarted === 1
              ? Math.max(receiptClaimAttempt - 1, 0)
              : 0
            : recovery.attempt,
        adoptionDeadlineAtEpochMs: recoveryDeadlineAtEpochMs,
        mustAdoptOnly: registrationState === 'uncertain' || providerDispatchStarted === 1,
      }
    })

  const preflightProviderRegistration: NodeImageExecutionRepositoryShape['preflightProviderRegistration'] =
    (input) =>
      registrationWork(input).pipe(
        Effect.map((work) => ({
          providerType: work.providerType,
          providerAccountId: work.providerAccountId,
          providerAccountRevision: work.providerAccountRevision,
          credentialReference: work.credentialReference,
        })),
      )

  const beginProviderDispatch: NodeImageExecutionRepositoryShape['beginProviderDispatch'] = ({
    reservation,
    claim,
    now,
  }) =>
    Effect.gen(function* () {
      if (reservation.action !== 'register-provider') return yield* conflict('invalid_transition')
      const current = yield* ensureRunning(reservation, claim)
      if (current.adopted || current.receipt.providerDispatchStarted) return
      yield* attempt('nodeImageD1.execution.begin-provider-dispatch', () =>
        database.batch([
          database
            .prepare(`UPDATE platform_node_image_step_receipts
              SET provider_dispatch_started = 1, revision = ?, updated_at = ?
              WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
                AND claim_id = ? AND claim_attempt = ? AND provider_dispatch_started = 0`)
            .bind(
              current.receipt.revision + 1,
              now,
              reservation.operationId,
              current.receipt.revision,
              claim.claimId,
              claim.claimAttempt,
            ),
        ]),
      ).pipe(Effect.mapError(() => conflict('registration_unavailable')))
      const after = yield* readReceipt(reservation.operationId)
      if (
        after?.state !== 'running' ||
        after.claimId !== claim.claimId ||
        after.claimAttempt !== claim.claimAttempt ||
        !after.providerDispatchStarted
      )
        return yield* conflict('registration_unavailable')
    })

  const releasePreDispatch: NodeImageExecutionRepositoryShape['releasePreDispatch'] = ({
    reservation,
    claim,
    now,
    code,
  }) =>
    Effect.gen(function* () {
      if (reservation.action !== 'register-provider') return yield* conflict('invalid_transition')
      const current = yield* ensureRunning(reservation, claim)
      if (current.adopted) return { status: 'adopted' as const }
      // A release is valid only before the durable pre-HTTP fence. Once that
      // fence exists, the next worker must discover/adopt instead of create.
      if (current.receipt.providerDispatchStarted) return yield* conflict('invalid_transition')
      yield* attempt('nodeImageD1.execution.release-pre-dispatch', () =>
        database.batch([
          database
            .prepare(`UPDATE platform_node_image_step_receipts
              SET state = 'waiting-external', result_json = ?, revision = ?, updated_at = ?
              WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
                AND claim_id = ? AND claim_attempt = ? AND provider_dispatch_started = 0`)
            .bind(
              JSON.stringify({ kind: 'pre-dispatch-retry', code }),
              current.receipt.revision + 1,
              now,
              reservation.operationId,
              current.receipt.revision,
              claim.claimId,
              claim.claimAttempt,
            ),
          // This is deliberately last. The migration trigger makes it an
          // assertion that the exact receipt transition committed first.
          database
            .prepare(`UPDATE platform_node_image_operations
              SET state = 'waiting-external', revision = revision + 1, updated_at = ?
              WHERE id = ? AND request_fingerprint = ? AND state = 'running' AND ${exactWaitingClaimSql}`)
            .bind(
              now,
              reservation.operationId,
              reservation.requestFingerprint,
              ...exactWaitingClaimValues(reservation, claim),
            ),
        ]),
      ).pipe(Effect.mapError(() => conflict('registration_unavailable')))
      const after = yield* readReceipt(reservation.operationId)
      if (after?.state !== 'waiting-external') return yield* conflict('registration_unavailable')
      return { status: 'waiting-external' as const }
    })

  const completeLocal: NodeImageExecutionRepositoryShape['completeLocal'] = ({
    reservation,
    claim,
    now,
  }) =>
    Effect.gen(function* () {
      switch (reservation.action) {
        case 'create':
        case 'configure-scope':
          return yield* complete(reservation, claim, now, [], { kind: reservation.action })
        case 'test':
          if (reservation.imageId === null) return yield* conflict('invalid_transition')
          return yield* complete(
            reservation,
            claim,
            now,
            [
              database
                .prepare(`UPDATE node_image_lifecycle_records
                  SET state = 'testing', scan_evidence_json = json_extract(?, '$.trustedTestingEvidence.scan'),
                    smoke_test_evidence_json = json_extract(?, '$.trustedTestingEvidence.smokeTest'),
                    revision = revision + 1, updated_at = ?
                  WHERE image_id = ? AND state = 'building'
                    AND revision = json_extract(?, '$.intent.expectedImageRevision')
                    AND ${exactRunningClaimSql}`)
                .bind(
                  reservation.commandJson,
                  reservation.commandJson,
                  now,
                  reservation.imageId,
                  reservation.commandJson,
                  ...exactRunningClaimValues(reservation, claim),
                ),
            ],
            { kind: 'tested' },
          )
        case 'register-provider': {
          const work = yield* registrationWork({ reservation, claim })
          if (
            (work.mode === 'stock-ubuntu-cloud-init' && work.registrationState === 'degraded') ||
            (work.mode === 'custom-image' && work.registrationState === 'registered')
          )
            return yield* complete(reservation, claim, now, [], {
              kind: work.mode === 'custom-image' ? 'registered' : 'degraded',
            })
          return yield* conflict('registration_unavailable')
        }
        case 'promote': {
          if (reservation.imageId === null || reservation.scopeId === null)
            return yield* conflict('invalid_transition')
          const intent = yield* storedIntent(reservation)
          const expectedImageRevision = positiveField(intent, 'expectedImageRevision')
          const expectedScopeRevision = positiveField(intent, 'expectedScopeRevision')
          const scope = yield* readScope(reservation.scopeId)
          const image = yield* readImage(reservation.imageId)
          if (
            expectedImageRevision === null ||
            expectedScopeRevision === null ||
            scope.revision !== expectedScopeRevision ||
            image.revision !== expectedImageRevision ||
            (image.state !== 'testing' && image.state !== 'promoted') ||
            scope.promotedImageId === reservation.imageId
          )
            return yield* conflict('invalid_transition')
          const resources: NodeImageD1Statement[] = []
          if (image.state === 'testing')
            resources.push(
              database
                .prepare(`UPDATE node_image_lifecycle_records
                  SET state = 'promoted', revision = revision + 1, updated_at = ?, promoted_at = ?
                  WHERE image_id = ? AND state = 'testing' AND revision = ?
                    AND ${exactRunningClaimSql}`)
                .bind(
                  now,
                  now,
                  reservation.imageId,
                  expectedImageRevision,
                  ...exactRunningClaimValues(reservation, claim),
                ),
            )
          resources.push(
            database
              .prepare(`UPDATE node_image_policy_scopes
                SET promoted_image_id = ?, last_known_good_image_id = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ? AND ${exactRunningClaimSql}`)
              .bind(
                reservation.imageId,
                scope.promotedImageId ?? reservation.imageId,
                now,
                reservation.scopeId,
                expectedScopeRevision,
                ...exactRunningClaimValues(reservation, claim),
              ),
          )
          if (scope.promotedImageId !== null)
            resources.push(
              database
                .prepare(`UPDATE node_image_lifecycle_records
                  SET state = 'deprecated', revision = revision + 1, updated_at = ?, deprecated_at = ?
                  WHERE image_id = ? AND state = 'promoted'
                    AND NOT EXISTS (SELECT 1 FROM node_image_policy_scopes WHERE promoted_image_id = ?)
                    AND ${exactRunningClaimSql}`)
                .bind(
                  now,
                  now,
                  scope.promotedImageId,
                  scope.promotedImageId,
                  ...exactRunningClaimValues(reservation, claim),
                ),
            )
          return yield* complete(reservation, claim, now, resources, { kind: 'promoted' })
        }
        case 'rollback': {
          if (reservation.scopeId === null) return yield* conflict('invalid_transition')
          const intent = yield* storedIntent(reservation)
          const expectedScopeRevision = positiveField(intent, 'expectedScopeRevision')
          const scope = yield* readScope(reservation.scopeId)
          if (
            expectedScopeRevision === null ||
            scope.revision !== expectedScopeRevision ||
            scope.promotedImageId === null ||
            scope.lastKnownGoodImageId === null ||
            scope.promotedImageId === scope.lastKnownGoodImageId
          )
            return yield* conflict('last_known_good_unavailable')
          const target = yield* readImage(scope.lastKnownGoodImageId)
          if (target.state !== 'deprecated' && target.state !== 'promoted')
            return yield* conflict('last_known_good_unavailable')
          const resources: NodeImageD1Statement[] = []
          if (target.state === 'deprecated')
            resources.push(
              database
                .prepare(`UPDATE node_image_lifecycle_records
                  SET state = 'promoted', revision = revision + 1, updated_at = ?, promoted_at = ?
                  WHERE image_id = ? AND state = 'deprecated' AND revision = ?
                    AND ${exactRunningClaimSql}`)
                .bind(
                  now,
                  now,
                  target.id,
                  target.revision,
                  ...exactRunningClaimValues(reservation, claim),
                ),
            )
          resources.push(
            database
              .prepare(`UPDATE node_image_policy_scopes
                SET promoted_image_id = ?, last_known_good_image_id = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ? AND ${exactRunningClaimSql}`)
              .bind(
                target.id,
                target.id,
                now,
                scope.id,
                expectedScopeRevision,
                ...exactRunningClaimValues(reservation, claim),
              ),
            database
              .prepare(`UPDATE node_image_lifecycle_records
                SET state = 'deprecated', revision = revision + 1, updated_at = ?, deprecated_at = ?
                WHERE image_id = ? AND state = 'promoted'
                  AND NOT EXISTS (SELECT 1 FROM node_image_policy_scopes WHERE promoted_image_id = ?)
                  AND ${exactRunningClaimSql}`)
              .bind(
                now,
                now,
                scope.promotedImageId,
                scope.promotedImageId,
                ...exactRunningClaimValues(reservation, claim),
              ),
          )
          return yield* complete(reservation, claim, now, resources, {
            kind: 'rolled-back',
            imageId: target.id,
          })
        }
        case 'revoke': {
          if (reservation.imageId === null || reservation.scopeId === null)
            return yield* conflict('invalid_transition')
          const intent = yield* storedIntent(reservation)
          const expectedImageRevision = positiveField(intent, 'expectedImageRevision')
          const expectedScopeRevision = positiveField(intent, 'expectedScopeRevision')
          const scope = yield* readScope(reservation.scopeId)
          const image = yield* readImage(reservation.imageId)
          if (
            expectedImageRevision === null ||
            expectedScopeRevision === null ||
            scope.revision !== expectedScopeRevision ||
            image.revision !== expectedImageRevision ||
            (image.state !== 'testing' &&
              image.state !== 'promoted' &&
              image.state !== 'deprecated')
          )
            return yield* conflict('invalid_transition')
          const otherSelected = yield* attempt('nodeImageD1.execution.revoke.selected', () =>
            database
              .prepare(`SELECT count(*) AS count FROM node_image_policy_scopes
                WHERE promoted_image_id = ? AND id <> ?`)
              .bind(reservation.imageId, reservation.scopeId)
              .first(),
          )
          const selectedCount =
            row(otherSelected) === undefined ? undefined : integer(row(otherSelected)!, 'count')
          if (selectedCount === undefined || selectedCount > 0)
            return yield* conflict('image_in_use')
          const resources: NodeImageD1Statement[] = []
          if (scope.promotedImageId === reservation.imageId) {
            if (
              scope.lastKnownGoodImageId === null ||
              scope.lastKnownGoodImageId === reservation.imageId
            )
              return yield* conflict('last_known_good_unavailable')
            const fallback = yield* readImage(scope.lastKnownGoodImageId)
            if (fallback.state === 'deprecated')
              resources.push(
                database
                  .prepare(`UPDATE node_image_lifecycle_records
                    SET state = 'promoted', revision = revision + 1, updated_at = ?, promoted_at = ?
                    WHERE image_id = ? AND state = 'deprecated' AND revision = ?
                      AND ${exactRunningClaimSql}`)
                  .bind(
                    now,
                    now,
                    fallback.id,
                    fallback.revision,
                    ...exactRunningClaimValues(reservation, claim),
                  ),
              )
            resources.push(
              database
                .prepare(`UPDATE node_image_policy_scopes
                  SET promoted_image_id = ?, last_known_good_image_id = ?, revision = revision + 1, updated_at = ?
                  WHERE id = ? AND revision = ? AND ${exactRunningClaimSql}`)
                .bind(
                  scope.lastKnownGoodImageId,
                  scope.lastKnownGoodImageId,
                  now,
                  scope.id,
                  expectedScopeRevision,
                  ...exactRunningClaimValues(reservation, claim),
                ),
            )
          }
          resources.push(
            database
              .prepare(`UPDATE node_image_lifecycle_records
                SET state = 'revoked', revision = revision + 1, updated_at = ?, revoked_at = ?
                WHERE image_id = ? AND revision = ? AND state IN ('testing', 'promoted', 'deprecated')
                  AND ${exactRunningClaimSql}`)
              .bind(
                now,
                now,
                reservation.imageId,
                expectedImageRevision,
                ...exactRunningClaimValues(reservation, claim),
              ),
            database
              .prepare(`UPDATE node_image_provider_registrations
                SET state = 'revoked', revision = revision + 1, updated_at = ?
                WHERE image_id = ? AND state <> 'revoked' AND ${exactRunningClaimSql}`)
              .bind(now, reservation.imageId, ...exactRunningClaimValues(reservation, claim)),
          )
          return yield* complete(reservation, claim, now, resources, { kind: 'revoked' })
        }
      }
    })

  const settleProviderRegistration: NodeImageExecutionRepositoryShape['settleProviderRegistration'] =
    ({ reservation, claim, now, outcome }) =>
      Effect.gen(function* () {
        if (reservation.action !== 'register-provider') return yield* conflict('invalid_transition')
        const current = yield* ensureRunning(reservation, claim)
        if (current.adopted) return { status: 'adopted' as const }
        const work = yield* registrationWork({ reservation, claim })
        if (work.mode !== 'custom-image' || work.registrationState === 'revoked')
          return yield* conflict('registration_unavailable')
        if (outcome.kind === 'uncertain') {
          if (
            !Number.isSafeInteger(outcome.nextAttemptNumber) ||
            outcome.nextAttemptNumber < 1 ||
            !Number.isSafeInteger(outcome.nextAttemptAtEpochMs) ||
            !Number.isSafeInteger(outcome.recoveryDeadlineAtEpochMs) ||
            outcome.nextAttemptAtEpochMs > outcome.recoveryDeadlineAtEpochMs ||
            outcome.recoveryDeadlineAtEpochMs !== current.receipt.recoveryDeadlineAtEpochMs
          )
            return yield* conflict('registration_unavailable')
          // Each visibility poll moves the registration forward. Persist its
          // exact post-CAS revision with the receipt, rather than comparing it
          // to the immutable acceptance revision. A delayed provider listing can
          // therefore have several bounded adopt-only polls without weakening
          // the final registration/receipt/operation atomicity fence.
          const persistedOutcome = {
            ...outcome,
            registrationRevision: work.registrationRevision + 1,
          }
          yield* attempt('nodeImageD1.execution.registration-uncertain', () =>
            database.batch([
              database
                .prepare(`UPDATE node_image_provider_registrations
              SET state = 'uncertain', revision = revision + 1, updated_at = ?
                WHERE id = ? AND state IN ('pending', 'uncertain') AND revision = ?
                  AND ${exactRunningClaimRevisionSql}`)
                .bind(
                  now,
                  work.registrationId,
                  work.registrationRevision,
                  ...exactRunningClaimRevisionValues(reservation, claim, current.receipt.revision),
                ),
              database
                .prepare(`UPDATE platform_node_image_step_receipts
                SET state = 'waiting-external', result_json = ?, revision = ?, updated_at = ?
                WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
                  AND claim_id = ? AND claim_attempt = ?`)
                .bind(
                  JSON.stringify(persistedOutcome),
                  current.receipt.revision + 1,
                  now,
                  reservation.operationId,
                  current.receipt.revision,
                  claim.claimId,
                  claim.claimAttempt,
                ),
              // Last-operation fence: a conditional receipt write can never
              // leave the operation waiting while the receipt remains running.
              database
                .prepare(`UPDATE platform_node_image_operations
              SET state = 'waiting-external', revision = revision + 1, updated_at = ?
                WHERE id = ? AND request_fingerprint = ? AND state = 'running' AND ${exactWaitingClaimSql}`)
                .bind(
                  now,
                  reservation.operationId,
                  reservation.requestFingerprint,
                  ...exactWaitingClaimValues(reservation, claim),
                ),
            ]),
          ).pipe(Effect.mapError(() => conflict('registration_unavailable')))
          return { status: 'waiting-external' as const }
        }
        if (outcome.providerImageId.length === 0) return yield* conflict('registration_unavailable')
        return yield* complete(
          reservation,
          claim,
          now,
          [
            database
              .prepare(`UPDATE node_image_provider_registrations
              SET provider_image_id = ?, provider_request_id = ?, state = 'registered', revision = revision + 1,
                updated_at = ?
              WHERE id = ? AND mode = 'custom-image' AND state IN ('pending', 'uncertain', 'registered')
                AND ${exactRunningClaimSql}`)
              .bind(
                outcome.providerImageId,
                outcome.providerRequestId,
                now,
                work.registrationId,
                ...exactRunningClaimValues(reservation, claim),
              ),
          ],
          {
            kind: outcome.kind,
            providerImageId: outcome.providerImageId,
            providerRequestId: outcome.providerRequestId,
          },
        )
      })

  const failTerminal: NodeImageExecutionRepositoryShape['failTerminal'] = ({
    reservation,
    claim,
    now,
    code,
  }) =>
    Effect.gen(function* () {
      if (reservation.action !== 'register-provider' || reservation.imageId === null)
        return yield* conflict('invalid_transition')
      const current = yield* ensureRunning(reservation, claim)
      if (current.adopted) return { status: 'adopted' as const }
      const auditEventId = `node-image-terminal-audit:${reservation.operationId}`
      const outboxEventId = `node-image-terminal-outbox:${reservation.operationId}`
      const authority = decodeTerminalAuditAuthority(
        yield* attempt('nodeImageD1.execution.terminal-audit-authority', () =>
          database
            .prepare(terminalAuditAuthoritySql)
            .bind(reservation.operationId, reservation.requestFingerprint)
            .first(),
        ),
      )
      if (authority === null) return yield* conflict('registration_unavailable')
      const auditStatements = yield* terminalAuditStatements(
        database,
        reservation,
        authority,
        auditEventId,
        now,
        code,
      )
      const payload = JSON.stringify({ operationId: reservation.operationId, code })
      const result = JSON.stringify({ kind: 'failed-terminal', code })
      yield* attempt('nodeImageD1.execution.fail-terminal', () =>
        database.batch([
          ...auditStatements,
          database
            .prepare(`INSERT INTO platform_node_image_terminal_outbox
              (id, operation_id, audit_event_id, request_fingerprint, claim_id, claim_attempt,
               failure_code, event_type, payload_json, publish_state, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'node-image.register-provider.failed-terminal', ?, 'pending', ?)`)
            .bind(
              outboxEventId,
              reservation.operationId,
              auditEventId,
              reservation.requestFingerprint,
              claim.claimId,
              claim.claimAttempt,
              code,
              payload,
              now,
            ),
          database
            .prepare(`UPDATE platform_node_image_step_receipts
              SET state = 'failed-terminal', result_json = ?, revision = ?, updated_at = ?
              WHERE operation_id = ? AND ordinal = 0 AND state = 'running' AND revision = ?
                AND claim_id = ? AND claim_attempt = ?`)
            .bind(
              result,
              current.receipt.revision + 1,
              now,
              reservation.operationId,
              current.receipt.revision,
              claim.claimId,
              claim.claimAttempt,
            ),
          database
            .prepare(`UPDATE platform_node_image_operations
              SET state = 'failed-terminal', revision = revision + 1, updated_at = ?
              WHERE id = ? AND request_fingerprint = ? AND state = 'running'`)
            .bind(now, reservation.operationId, reservation.requestFingerprint),
        ]),
      ).pipe(Effect.mapError(() => conflict('registration_unavailable')))
      const after = yield* readReceipt(reservation.operationId)
      if (after?.state !== 'failed-terminal') return yield* conflict('registration_unavailable')
      return { status: 'failed-terminal' as const }
    })

  return {
    loadExact,
    claimExact,
    completeLocal,
    registrationWork,
    preflightProviderRegistration,
    beginProviderDispatch,
    releasePreDispatch,
    settleProviderRegistration,
    failTerminal,
  }
}

import { Effect, Schema } from 'effect'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  auditEventSummaryJson,
  completeAuditEnvelope,
  stageAuditEnvelope,
  type AuditRequestContextValue,
} from '@gridora/audit-contracts'
import {
  AgentCommand,
  canonicalCommandPayload,
  decodeTunnelCredentialAgentCommand,
  type TunnelCredentialAgentCommand,
} from '@gridora/agent-protocol'
import { ConflictError, NotFoundError, PersistenceError } from '@gridora/contracts'
import type { D1DatabaseLike } from '@gridora/db-d1'
import {
  sealTunnelCredential,
  type TunnelCredentialInstallPayload,
  type TunnelCredentialRevokePayload,
} from '@gridora/tunnel-credential'

export type TunnelDeliveryAction = 'install' | 'rotate' | 'revoke'

export interface TunnelDeliveryRequest {
  readonly organizationId: string
  readonly nodeId: string
  readonly tunnelId: string
  readonly operationId: string
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly action: TunnelDeliveryAction
  readonly expectedPriorRevision: number
  readonly deliveryId: string
  readonly now: string
  /** Immutable HTTP provenance captured before the provider call begins. */
  readonly auditRequestContext: AuditRequestContextValue
}

export interface TunnelDeliveryReservation {
  readonly disposition: 'created' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly tunnelId: string
  readonly operationId: string
  readonly deliveryId: string
  readonly action: TunnelDeliveryAction
  readonly revision: number
  readonly expectedPriorRevision: number
  readonly state: 'issuing' | 'queued' | 'delivered' | 'acknowledged' | 'revoked' | 'failed'
  readonly installerPublicKey: string
  readonly installerKeyFingerprint: string
  readonly command: TunnelCredentialAgentCommand | null
}

const persistence = (operation: string, cause: unknown) =>
  new PersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })
const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => persistence(operation, cause) })

const requestedAuditOperationId = (request: TunnelDeliveryRequest): string =>
  `audit-operation-request-${request.deliveryId}`

const requestedAuditEventId = (request: TunnelDeliveryRequest): string =>
  `audit-request-${request.deliveryId}`

const deliveryAuditSummary = (
  request: TunnelDeliveryRequest,
  state: 'issuing' | 'queued' | 'delivered' | 'acknowledged' | 'revoked' | 'failed',
) => ({
  action: request.action,
  deliveryId: request.deliveryId,
  nodeId: request.nodeId,
  operationId: request.operationId,
  revision: request.expectedPriorRevision + 1,
  state,
  tunnelId: request.tunnelId,
})

/**
 * The user-visible mutation gets a terminal acceptance operation in the same
 * batch as the durable delivery reservation. The long-running parent remains
 * waiting for the provider/agent, while the audit envelope is truthfully tied
 * to the immutable accepted reservation rather than that nonterminal parent.
 */
const stageRequestedDeliveryAudit = (
  database: D1DatabaseLike,
  request: TunnelDeliveryRequest,
): Effect.Effect<
  {
    readonly operationId: string
    readonly eventId: string
    readonly stageStatement: ReturnType<D1DatabaseLike['prepare']>
    readonly summaryJson: string
  },
  PersistenceError
> =>
  Effect.gen(function* () {
    const operationId = requestedAuditOperationId(request)
    const eventId = requestedAuditEventId(request)
    const after = deliveryAuditSummary(request, 'issuing')
    const envelope = yield* completeAuditEnvelope({
      occurredAt: request.now,
      scope: 'tenant',
      organizationId: request.organizationId,
      actor: { type: 'human', id: request.actorId },
      action: `tunnel.credential.${request.action}.requested`,
      target: { type: 'tunnel', id: request.tunnelId },
      before: { state: 'absent', reason: 'tunnel-credential-delivery-not-yet-reserved' },
      after: { state: 'captured', summary: after },
      operationId,
      request: {
        ...request.auditRequestContext,
        // This is the immutable correlation stored on both operations in the
        // batch. Keep the edge request ID/source evidence intact.
        correlationId: request.correlationId,
      },
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
    }).pipe(
      Effect.mapError((cause) => persistence('tunnel.delivery.request.audit-envelope', cause)),
    )
    const stage = yield* stageAuditEnvelope('tenant', eventId, envelope, request.now).pipe(
      Effect.mapError((cause) => persistence('tunnel.delivery.request.audit-stage', cause)),
    )
    return {
      operationId,
      eventId,
      stageStatement: database
        .prepare(auditEnvelopeStageSql)
        .bind(...auditEnvelopeStageBindings(stage)),
      summaryJson: auditEventSummaryJson(envelope),
    }
  })

const readDelivery = (
  database: D1DatabaseLike,
  organizationId: string,
  idempotencyKey: string,
): Effect.Effect<TunnelDeliveryReservation | null, PersistenceError> =>
  Effect.gen(function* () {
    const row = yield* attempt('tunnel.delivery.read', () =>
      database
        .prepare(`SELECT
    delivery.organization_id AS organizationId, delivery.node_id AS nodeId,
    delivery.tunnel_id AS tunnelId, delivery.operation_id AS operationId,
    delivery.delivery_id AS deliveryId, delivery.action, delivery.revision,
    delivery.expected_prior_revision AS expectedPriorRevision, delivery.state,
    delivery.request_fingerprint AS requestFingerprint, delivery.command_json AS commandJson,
    delivery.installer_key_fingerprint AS reservedInstallerKeyFingerprint,
    delivery.command_fingerprint AS commandFingerprint,
    installer.public_key AS installerPublicKey,
    installer.public_key_fingerprint AS installerKeyFingerprint,
    operation.type AS operationType, operation.resource_type AS operationResourceType,
    operation.resource_id AS operationResourceId, operation.idempotency_key AS operationIdempotencyKey,
    operation.status AS operationStatus
    FROM tunnel_credential_deliveries delivery
    JOIN node_installer_keys installer
      ON installer.organization_id = delivery.organization_id AND installer.node_id = delivery.node_id
    JOIN operations operation
      ON operation.organization_id = delivery.organization_id AND operation.id = delivery.operation_id
    WHERE delivery.organization_id = ? AND delivery.idempotency_key = ?`)
        .bind(organizationId, idempotencyKey)
        .first(),
    )
    if (row === null) return null
    if (typeof row !== 'object')
      return yield* persistence('tunnel.delivery.decode', 'invalid delivery row')
    const value = row as Record<string, unknown>
    const command =
      value.commandJson === null
        ? null
        : yield* Effect.try({
            try: () => JSON.parse(String(value.commandJson)) as unknown,
            catch: (cause) => persistence('tunnel.delivery.decode', cause),
          }).pipe(
            Effect.flatMap((input) => decodeTunnelCredentialAgentCommand(input)),
            Effect.mapError((cause) => persistence('tunnel.delivery.decode', cause)),
          )
    if (
      typeof value.organizationId !== 'string' ||
      typeof value.nodeId !== 'string' ||
      typeof value.tunnelId !== 'string' ||
      typeof value.operationId !== 'string' ||
      typeof value.deliveryId !== 'string' ||
      (value.action !== 'install' && value.action !== 'rotate' && value.action !== 'revoke') ||
      typeof value.revision !== 'number' ||
      typeof value.expectedPriorRevision !== 'number' ||
      (value.state !== 'issuing' &&
        value.state !== 'queued' &&
        value.state !== 'delivered' &&
        value.state !== 'acknowledged' &&
        value.state !== 'revoked' &&
        value.state !== 'failed') ||
      typeof value.installerPublicKey !== 'string' ||
      typeof value.installerKeyFingerprint !== 'string' ||
      value.reservedInstallerKeyFingerprint !== value.installerKeyFingerprint ||
      value.operationType !== `tunnel.credential.${value.action}` ||
      value.operationResourceType !== 'tunnel' ||
      value.operationResourceId !== value.tunnelId ||
      value.operationIdempotencyKey !== idempotencyKey ||
      !(
        (value.state === 'issuing' && value.operationStatus === 'waiting_external') ||
        (value.state === 'queued' && value.operationStatus === 'queued') ||
        (value.state === 'delivered' && value.operationStatus === 'running') ||
        ((value.state === 'acknowledged' || value.state === 'revoked') &&
          value.operationStatus === 'succeeded') ||
        (value.state === 'failed' && value.operationStatus === 'failed_terminal')
      )
    )
      return yield* persistence('tunnel.delivery.decode', 'invalid delivery row')
    const validatedInstallerKey = yield* validateInstallerPublicKey(value.installerPublicKey)
    if (validatedInstallerKey.fingerprint !== value.installerKeyFingerprint)
      return yield* persistence('tunnel.delivery.decode', 'installer key fingerprint mismatch')
    if (
      command === null
        ? value.commandFingerprint !== null
        : value.commandFingerprint !== `sha256:${yield* sha256Hex(String(value.commandJson))}`
    )
      return yield* persistence('tunnel.delivery.decode', 'delivery command fingerprint mismatch')
    if (
      command !== null &&
      (command.commandId !== value.deliveryId ||
        command.operationId !== value.operationId ||
        command.organizationId !== value.organizationId ||
        command.nodeId !== value.nodeId ||
        command.resourceId !== value.tunnelId ||
        command.payload.revision !== value.revision ||
        command.payload.expectedPriorRevision !== value.expectedPriorRevision)
    )
      return yield* persistence('tunnel.delivery.decode', 'delivery command binding mismatch')
    return {
      disposition: 'adopted',
      organizationId: value.organizationId,
      nodeId: value.nodeId,
      tunnelId: value.tunnelId,
      operationId: value.operationId,
      deliveryId: value.deliveryId,
      action: value.action,
      revision: value.revision,
      expectedPriorRevision: value.expectedPriorRevision,
      state: value.state,
      installerPublicKey: value.installerPublicKey,
      installerKeyFingerprint: value.installerKeyFingerprint,
      command,
    }
  })

export const loadTunnelDeliveryById = (
  database: D1DatabaseLike,
  organizationId: string,
  deliveryId: string,
): Effect.Effect<TunnelDeliveryReservation, NotFoundError | PersistenceError> =>
  Effect.gen(function* () {
    const row = yield* attempt('tunnel.delivery.load-id', () =>
      database
        .prepare(
          'SELECT idempotency_key AS idempotencyKey FROM tunnel_credential_deliveries WHERE organization_id = ? AND delivery_id = ?',
        )
        .bind(organizationId, deliveryId)
        .first(),
    )
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof (row as Record<string, unknown>).idempotencyKey !== 'string'
    )
      return yield* new NotFoundError({ resource: 'tunnel credential delivery', id: deliveryId })
    const delivery = yield* readDelivery(
      database,
      organizationId,
      (row as Record<string, unknown>).idempotencyKey as string,
    )
    if (delivery === null)
      return yield* new NotFoundError({ resource: 'tunnel credential delivery', id: deliveryId })
    return delivery
  })

export const reserveTunnelDelivery = (
  database: D1DatabaseLike,
  request: TunnelDeliveryRequest,
): Effect.Effect<TunnelDeliveryReservation, ConflictError | NotFoundError | PersistenceError> =>
  Effect.gen(function* () {
    const replay = yield* readDelivery(database, request.organizationId, request.idempotencyKey)
    if (replay !== null) {
      const row = yield* attempt('tunnel.delivery.replay-fingerprint', () =>
        database
          .prepare(
            'SELECT request_fingerprint AS requestFingerprint FROM tunnel_credential_deliveries WHERE organization_id = ? AND idempotency_key = ?',
          )
          .bind(request.organizationId, request.idempotencyKey)
          .first(),
      )
      if (
        row === null ||
        typeof row !== 'object' ||
        (row as Record<string, unknown>).requestFingerprint !== request.requestFingerprint
      )
        return yield* new ConflictError({
          code: 'idempotency_key_reused',
          message: 'The idempotency key was already used with a different request',
        })
      return replay
    }
    const scope = yield* attempt('tunnel.delivery.scope', () =>
      database
        .prepare(`SELECT
    installer.public_key AS installerPublicKey,
    installer.public_key_fingerprint AS installerKeyFingerprint,
    COALESCE(MAX(delivery.revision), 0) AS currentRevision,
    (SELECT latest.state FROM tunnel_credential_deliveries latest
      WHERE latest.organization_id = tunnel.organization_id AND latest.node_id = tunnel.node_id
        AND latest.tunnel_id = tunnel.tunnel_id ORDER BY latest.revision DESC LIMIT 1) AS currentState
    FROM tunnels tunnel
    JOIN node_installer_keys installer
      ON installer.organization_id = tunnel.organization_id AND installer.node_id = tunnel.node_id
      AND installer.status = 'active'
    LEFT JOIN tunnel_credential_deliveries delivery
      ON delivery.organization_id = tunnel.organization_id AND delivery.node_id = tunnel.node_id
      AND delivery.tunnel_id = tunnel.tunnel_id
    WHERE tunnel.organization_id = ? AND tunnel.node_id = ? AND tunnel.tunnel_id = ?
      AND tunnel.state <> 'deleted'
    GROUP BY installer.public_key, installer.public_key_fingerprint`)
        .bind(request.organizationId, request.nodeId, request.tunnelId)
        .first(),
    )
    if (scope === null)
      return yield* new NotFoundError({ resource: 'tunnel', id: request.tunnelId })
    const scoped = scope as Record<string, unknown>
    if (
      typeof scoped.installerPublicKey !== 'string' ||
      typeof scoped.installerKeyFingerprint !== 'string'
    )
      return yield* persistence('tunnel.delivery.scope', 'invalid installer key metadata')
    const validatedInstallerKey = yield* validateInstallerPublicKey(scoped.installerPublicKey)
    if (validatedInstallerKey.fingerprint !== scoped.installerKeyFingerprint)
      return yield* persistence('tunnel.delivery.scope', 'installer key fingerprint mismatch')
    if (scoped.currentRevision !== request.expectedPriorRevision)
      return yield* new ConflictError({
        code: 'tunnel_credential_revision_conflict',
        message: 'The Tunnel credential revision changed',
      })
    if (
      scoped.currentState === 'issuing' ||
      scoped.currentState === 'queued' ||
      scoped.currentState === 'delivered'
    )
      return yield* new ConflictError({
        code: 'tunnel_credential_delivery_in_progress',
        message: 'A Tunnel credential delivery is already in progress',
      })
    const audit = yield* stageRequestedDeliveryAudit(database, request)
    const inserted = yield* Effect.result(
      attempt('tunnel.delivery.reserve', () =>
        database.batch([
          database
            .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, 'tunnel', ?, ?, 'waiting_external', 20, ?, ?, 1, ?, ?)`)
            .bind(
              request.operationId,
              request.organizationId,
              `tunnel.credential.${request.action}`,
              request.tunnelId,
              request.actorId,
              request.idempotencyKey,
              request.correlationId,
              request.now,
              request.now,
            ),
          database
            .prepare(`INSERT INTO operations
      (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
       idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, 'tunnel', ?, ?, 'succeeded', 100, ?, ?, 1, ?, ?)`)
            .bind(
              audit.operationId,
              request.organizationId,
              `tunnel.credential.${request.action}.requested`,
              request.tunnelId,
              request.actorId,
              `audit:${request.idempotencyKey}:requested`,
              request.correlationId,
              request.now,
              request.now,
            ),
          database
            .prepare(`INSERT INTO tunnel_credential_deliveries
      (organization_id, node_id, tunnel_id, operation_id, delivery_id, idempotency_key,
       request_fingerprint, action, revision, expected_prior_revision, state,
       installer_key_fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issuing', ?, ?, ?)`)
            .bind(
              request.organizationId,
              request.nodeId,
              request.tunnelId,
              request.operationId,
              request.deliveryId,
              request.idempotencyKey,
              request.requestFingerprint,
              request.action,
              request.expectedPriorRevision + 1,
              request.expectedPriorRevision,
              scoped.installerKeyFingerprint,
              request.now,
              request.now,
            ),
          audit.stageStatement,
          database
            .prepare(`INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, result,
       correlation_id, summary_json, created_at)
      VALUES (?, ?, ?, ?, 'tunnel', ?, 'succeeded', ?, ?, ?)`)
            .bind(
              audit.eventId,
              request.organizationId,
              request.actorId,
              `tunnel.credential.${request.action}.requested`,
              request.tunnelId,
              request.correlationId,
              audit.summaryJson,
              request.now,
            ),
        ]),
      ),
    )
    if (inserted._tag === 'Failure') {
      const raced = yield* readDelivery(database, request.organizationId, request.idempotencyKey)
      if (raced !== null) return raced
      return yield* new ConflictError({
        code: 'tunnel_credential_revision_conflict',
        message: 'The Tunnel credential revision changed',
      })
    }
    if (inserted.success.some((result) => !result.success || (result.meta?.changes ?? 0) !== 1))
      return yield* new ConflictError({
        code: 'tunnel_credential_reservation_conflict',
        message: 'The Tunnel credential reservation changed',
      })
    return {
      disposition: 'created',
      organizationId: request.organizationId,
      nodeId: request.nodeId,
      tunnelId: request.tunnelId,
      operationId: request.operationId,
      deliveryId: request.deliveryId,
      action: request.action,
      revision: request.expectedPriorRevision + 1,
      expectedPriorRevision: request.expectedPriorRevision,
      state: 'issuing',
      installerPublicKey: validatedInstallerKey.publicKey,
      installerKeyFingerprint: validatedInstallerKey.fingerprint,
      command: null,
    }
  })

export const finalizeTunnelDelivery = (
  database: D1DatabaseLike,
  request: TunnelDeliveryRequest,
  command: TunnelCredentialAgentCommand,
): Effect.Effect<TunnelDeliveryReservation, ConflictError | PersistenceError> =>
  Effect.gen(function* () {
    const commandJson = JSON.stringify(command)
    const commandFingerprint = yield* sha256Hex(commandJson)
    const results = yield* attempt('tunnel.delivery.finalize', () =>
      database.batch([
        database
          .prepare(`UPDATE tunnel_credential_deliveries SET state = 'queued', command_json = ?,
      command_fingerprint = ?, updated_at = ? WHERE organization_id = ? AND delivery_id = ?
      AND request_fingerprint = ? AND state = 'issuing'`)
          .bind(
            commandJson,
            `sha256:${commandFingerprint}`,
            request.now,
            request.organizationId,
            request.deliveryId,
            request.requestFingerprint,
          ),
        database
          .prepare(`UPDATE operations SET status = 'queued', progress = 40, revision = revision + 1,
      updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'waiting_external'
      AND resource_type = 'tunnel' AND resource_id = ?`)
          .bind(request.now, request.organizationId, request.operationId, request.tunnelId),
        database
          .prepare(`INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id, payload_json,
       publish_state, retry_count, available_at, created_at)
      SELECT ?, organization_id, 'agent.command.sealed', 'tunnel_credential_delivery',
       delivery_id, ?, 'pending', 0, ?, ? FROM tunnel_credential_deliveries
      WHERE organization_id = ? AND delivery_id = ? AND state = 'queued'`)
          .bind(
            `outbox-${request.deliveryId}`,
            commandJson,
            request.now,
            request.now,
            request.organizationId,
            request.deliveryId,
          ),
      ]),
    )
    if (results.some((result) => !result.success || (result.meta?.changes ?? 0) !== 1))
      return yield* new ConflictError({
        code: 'tunnel_delivery_finalize_conflict',
        message: 'The Tunnel credential delivery changed',
      })
    const completed = yield* readDelivery(database, request.organizationId, request.idempotencyKey)
    if (completed === null)
      return yield* persistence('tunnel.delivery.finalize', 'finalized delivery missing')
    return completed
  })

export const markTunnelCommandDelivered = (
  database: D1DatabaseLike,
  organizationId: string,
  command: TunnelCredentialAgentCommand,
  now: string,
): Effect.Effect<'applied' | 'replayed', ConflictError | PersistenceError> =>
  Effect.gen(function* () {
    const result = yield* attempt('tunnel.delivery.mark-delivered', () =>
      database.batch([
        database
          .prepare(`UPDATE tunnel_credential_deliveries
      SET state = 'delivered', updated_at = ? WHERE organization_id = ? AND delivery_id = ?
        AND node_id = ? AND tunnel_id = ? AND operation_id = ? AND revision = ? AND state = 'queued'`)
          .bind(
            now,
            organizationId,
            command.commandId,
            command.nodeId,
            command.resourceId,
            command.operationId,
            command.payload.revision,
          ),
        database
          .prepare(`UPDATE operations SET status = 'running', progress = 60, revision = revision + 1,
      updated_at = ? WHERE organization_id = ? AND id = ? AND resource_id = ? AND status = 'queued'`)
          .bind(now, organizationId, command.operationId, command.resourceId),
      ]),
    )
    if (result.every((entry) => entry.success && (entry.meta?.changes ?? 0) === 1)) return 'applied'
    const row = yield* attempt('tunnel.delivery.mark-delivered.read', () =>
      database
        .prepare(
          'SELECT state FROM tunnel_credential_deliveries WHERE organization_id = ? AND delivery_id = ? AND node_id = ? AND tunnel_id = ?',
        )
        .bind(organizationId, command.commandId, command.nodeId, command.resourceId)
        .first(),
    )
    if (
      row !== null &&
      typeof row === 'object' &&
      ['delivered', 'acknowledged', 'revoked'].includes(
        String((row as Record<string, unknown>).state),
      )
    )
      return 'replayed'
    return yield* new ConflictError({
      code: 'tunnel_delivery_state_conflict',
      message: 'The Tunnel credential delivery changed',
    })
  })

const sha256Hex = (value: string): Effect.Effect<string, PersistenceError> =>
  attempt('tunnel.sha256', async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join(''),
  )

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid public key')
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  const canonical = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  if (canonical !== value) throw new Error('invalid public key')
  return bytes
}

export const validateInstallerPublicKey = (
  publicKey: string,
): Effect.Effect<{ readonly publicKey: string; readonly fingerprint: string }, PersistenceError> =>
  Effect.gen(function* () {
    const [prefix, encoded, extra] = publicKey.split('.')
    if (prefix !== 'rsa-oaep-spki-v1' || encoded === undefined || extra !== undefined)
      return yield* persistence('tunnel.installer-key.validate', 'invalid installer public key')
    const der = yield* Effect.try({
      try: () => decodeBase64Url(encoded),
      catch: (cause) => persistence('tunnel.installer-key.validate', cause),
    })
    try {
      const key = yield* attempt('tunnel.installer-key.validate', () =>
        crypto.subtle.importKey(
          'spki',
          der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
          { name: 'RSA-OAEP', hash: 'SHA-256' },
          false,
          ['encrypt'],
        ),
      )
      const algorithm = key.algorithm as RsaHashedKeyAlgorithm
      if (
        algorithm.name !== 'RSA-OAEP' ||
        algorithm.modulusLength !== 3072 ||
        algorithm.hash.name !== 'SHA-256'
      )
        return yield* persistence('tunnel.installer-key.validate', 'invalid installer public key')
      const digest = yield* attempt('tunnel.installer-key.fingerprint', async () =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
            ),
          ),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join(''),
      )
      return { publicKey, fingerprint: `sha256:${digest}` }
    } finally {
      der.fill(0)
    }
  })

export interface CloudflareTunnelTokenClient {
  readonly issue: (tunnelId: string, rotate: boolean) => Effect.Effect<string, PersistenceError>
  readonly invalidate: (tunnelId: string) => Effect.Effect<void, PersistenceError>
}

export const makeCloudflareTunnelTokenClient = (options: {
  readonly accountId: string | undefined
  readonly apiToken: string | undefined
  readonly expectedTunnelName: string
  readonly fetch: typeof fetch
}): CloudflareTunnelTokenClient => {
  const request = (
    method: 'GET' | 'PATCH' | 'DELETE',
    tunnelId: string,
    suffix = '',
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      if (
        options.accountId === undefined ||
        options.accountId.length === 0 ||
        options.apiToken === undefined ||
        options.apiToken.length < 20
      )
        return yield* persistence(
          'tunnel.cloudflare.binding',
          'Cloudflare Tunnel credentials are unavailable',
        )
      const response = yield* attempt('tunnel.cloudflare.request', () =>
        options.fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId!)}/cfd_tunnel/${encodeURIComponent(tunnelId)}${suffix}`,
          {
            method,
            headers: {
              authorization: `Bearer ${options.apiToken}`,
              'content-type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        ),
      )
      if (!response.ok) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
        return yield* persistence(
          'tunnel.cloudflare.request',
          `Cloudflare Tunnel request failed with ${response.status}`,
        )
      }
      return response
    })
  const verifyOwnedRemote = (tunnelId: string) =>
    Effect.gen(function* () {
      const response = yield* request('GET', tunnelId)
      const value = yield* attempt(
        'tunnel.cloudflare.decode',
        () => response.json() as Promise<unknown>,
      )
      if (
        typeof value !== 'object' ||
        value === null ||
        !('result' in value) ||
        typeof value.result !== 'object' ||
        value.result === null ||
        !('id' in value.result) ||
        value.result.id !== tunnelId ||
        !('config_src' in value.result) ||
        value.result.config_src !== 'cloudflare' ||
        !('name' in value.result) ||
        value.result.name !== options.expectedTunnelName
      )
        return yield* persistence('tunnel.cloudflare.scope', 'Cloudflare Tunnel identity mismatch')
    })
  const rotateSecret = (tunnelId: string) =>
    Effect.gen(function* () {
      yield* verifyOwnedRemote(tunnelId)
      const secret = crypto.getRandomValues(new Uint8Array(32))
      try {
        const encoded = btoa(String.fromCharCode(...secret))
        const response = yield* request('PATCH', tunnelId, '', { tun_secret: encoded })
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
      } finally {
        secret.fill(0)
      }
    })
  return {
    issue: (tunnelId, rotate) =>
      Effect.gen(function* () {
        if (rotate) yield* rotateSecret(tunnelId)
        else yield* verifyOwnedRemote(tunnelId)
        const response = yield* request('GET', tunnelId, '/token')
        const value = yield* attempt(
          'tunnel.cloudflare.token.decode',
          () => response.json() as Promise<unknown>,
        )
        if (
          typeof value !== 'object' ||
          value === null ||
          !('result' in value) ||
          typeof value.result !== 'string' ||
          value.result.length < 32
        )
          return yield* persistence(
            'tunnel.cloudflare.token.decode',
            'Cloudflare Tunnel token response is invalid',
          )
        return value.result
      }),
    invalidate: (tunnelId) =>
      Effect.gen(function* () {
        yield* rotateSecret(tunnelId)
        const response = yield* request('DELETE', tunnelId, '/connections')
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
      }),
  }
}

const importSigningKey = (pem: string) =>
  attempt('tunnel.command.signing-key', async () => {
    const body = pem
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s+/g, '')
    if (body.length === 0) throw new Error('missing signing key')
    const der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
    try {
      return await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
    } finally {
      der.fill(0)
    }
  })

export const createSignedTunnelCommand = (input: {
  readonly reservation: TunnelDeliveryReservation
  readonly credential?: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly signingKeyPem: string
}): Effect.Effect<TunnelCredentialAgentCommand, PersistenceError> =>
  Effect.gen(function* () {
    const scope = input.reservation
    const payload: TunnelCredentialInstallPayload | TunnelCredentialRevokePayload =
      scope.action === 'revoke'
        ? {
            apiVersion: 'tunnel.gridora.dev/v1alpha1',
            action: 'revoke',
            deliveryId: scope.deliveryId,
            organizationId: scope.organizationId,
            nodeId: scope.nodeId,
            tunnelId: scope.tunnelId,
            operationId: scope.operationId,
            revision: scope.revision,
            expectedPriorRevision: scope.expectedPriorRevision,
            expiresAt: input.expiresAt,
          }
        : {
            apiVersion: 'tunnel.gridora.dev/v1alpha1',
            action: 'install',
            deliveryId: scope.deliveryId,
            organizationId: scope.organizationId,
            nodeId: scope.nodeId,
            tunnelId: scope.tunnelId,
            operationId: scope.operationId,
            revision: scope.revision,
            expectedPriorRevision: scope.expectedPriorRevision,
            expiresAt: input.expiresAt,
            sealedCredential: yield* sealTunnelCredential(
              scope.installerPublicKey,
              {
                organizationId: scope.organizationId,
                nodeId: scope.nodeId,
                tunnelId: scope.tunnelId,
                operationId: scope.operationId,
                revision: scope.revision,
              },
              input.credential ?? '',
            ).pipe(Effect.mapError((cause) => persistence('tunnel.command.seal', cause))),
            destination: {
              path: '/var/lib/gridora/tunnel/credential',
              owner: 'root',
              group: 'root',
              mode: '0600',
            },
          }
    const unsigned = yield* Schema.decodeUnknownEffect(AgentCommand)({
      apiVersion: 'agent.gridora.dev/v1alpha1',
      commandId: scope.deliveryId,
      operationId: scope.operationId,
      organizationId: scope.organizationId,
      nodeId: scope.nodeId,
      resourceId: scope.tunnelId,
      type: scope.action === 'revoke' ? 'tunnel.credential.revoke' : 'tunnel.credential.install',
      payloadSchemaVersion: 1,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      idempotencyKey: scope.deliveryId,
      expectedPriorRevision: scope.expectedPriorRevision,
      payload,
      signature: 'unsigned-command-placeholder-00000000',
    }).pipe(Effect.mapError((cause) => persistence('tunnel.command.encode', cause)))
    const key = yield* importSigningKey(input.signingKeyPem)
    const signature = yield* attempt('tunnel.command.sign', async () => {
      const bytes = new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          key,
          new TextEncoder().encode(canonicalCommandPayload(unsigned)),
        ),
      )
      try {
        return btoa(String.fromCharCode(...bytes))
      } finally {
        bytes.fill(0)
      }
    })
    return yield* decodeTunnelCredentialAgentCommand({ ...unsigned, signature }).pipe(
      Effect.mapError((cause) => persistence('tunnel.command.decode', cause)),
    )
  })

import { Effect, Schema } from 'effect'
import { AuditRequestContextValue } from '@gridora/audit-contracts'
import type { OrganizationDeletionAcceptance } from '@gridora/lifecycle-termination-control'
import {
  makeOrganizationDeletionD1Repository,
  makeTerminationD1Repository,
  makeTerminationWorkflowStartD1Repository,
  requireDeletedRetirementReceipt,
} from '@gridora/lifecycle-termination-d1'
import { makeTerminationControl } from '@gridora/lifecycle-termination-control'
import {
  makeGameLifecycleCleanupD1Repository,
  makeGameLifecycleD1Repository,
  type GameLifecyclePlanningD1Repository,
} from '@gridora/game-lifecycle-d1'
import type { BackupControlShape } from '@gridora/backup-control'
import {
  requirePhysicalBackupDeletionReceipt,
  type BackupD1Database,
  type BackupPhysicalDeletionReceipt,
} from '@gridora/backup-d1'
import type { OrganizationContext } from '@gridora/domain'
import type { NativeLifecycleWorkflowBinding } from './lifecycle-runtime.js'
import { startOrAdoptGameLifecycleWorkflow } from './game-lifecycle-routes.js'
import { makeCancellationSignal, type CancellationRuntimeBindings } from './cancellation-runtime.js'
import {
  startRetireNodeWorkflow,
  type NodeTerminationWorkflowBinding,
} from './node-termination-runtime.js'

interface WorkflowPayload {
  readonly organizationId: string
  readonly operationId: string
  readonly resourceId: string
  readonly resourceType: string
  readonly actorId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly input: unknown
}

type Bindings = CancellationRuntimeBindings & {
  readonly DELETE_ORGANIZATION: Pick<Workflow<WorkflowPayload>, 'create' | 'get'>
  readonly RETIRE_NODE: NodeTerminationWorkflowBinding
}

const deletionAuthority = (env: Bindings, organizationId: string, operationId: string) =>
  Effect.tryPromise({
    try: () =>
      env.DB.prepare(`SELECT run.actor_id AS actorId, organization.slug AS organizationSlug,
        run.audit_request_context_json AS auditRequestContext
      FROM organization_deletion_runs run JOIN organizations organization
        ON organization.id = run.organization_id
      WHERE run.organization_id = ? AND run.operation_id = ?`)
        .bind(organizationId, operationId)
        .first<{ actorId: string; organizationSlug: string; auditRequestContext: string }>(),
    catch: () => new Error('organization deletion authority could not be loaded'),
  }).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.fail(new Error('organization deletion authority is unavailable'))
        : Effect.try({
            try: () => JSON.parse(row.auditRequestContext) as unknown,
            catch: () => new Error('organization deletion audit provenance is invalid'),
          }).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(AuditRequestContextValue, {
                onExcessProperty: 'error',
              })(value).pipe(
                Effect.mapError(
                  () => new Error('organization deletion audit provenance is invalid'),
                ),
              ),
            ),
            Effect.map((request) => ({
              actorId: row.actorId,
              organizationSlug: row.organizationSlug,
              request,
            })),
          ),
    ),
  )

const pendingKinds = (
  env: Bindings,
  organizationId: string,
  operationId: string,
  kinds: ReadonlyArray<string>,
) =>
  Effect.tryPromise({
    try: async () => {
      const placeholders = kinds.map(() => '?').join(', ')
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count
        FROM organization_deletion_items
        WHERE organization_id = ? AND operation_id = ?
          AND kind IN (${placeholders}) AND state IN ('pending', 'ambiguous', 'blocked')`)
        .bind(organizationId, operationId, ...kinds)
        .first<{ count: number }>()
      if (row === null || !Number.isSafeInteger(row.count)) throw new Error('invalid inventory')
      return row.count
    },
    catch: () => new Error('organization deletion inventory could not be verified'),
  })

const childIdentity = (
  organizationId: string,
  operationId: string,
  kind: string,
  resourceId: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${organizationId}\n${operationId}\n${kind}\n${resourceId}`),
      )
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      return { operationId: `orgdel-${hex.slice(0, 48)}`, idempotencyKey: `orgdel-${hex}` }
    },
    catch: () => new Error('organization deletion child identity could not be derived'),
  })

const reserveChild = (
  env: Bindings,
  input: {
    readonly organizationId: string
    readonly parentOperationId: string
    readonly kind: 'game-server' | 'node'
    readonly resourceId: string
    readonly childOperationId: string
    readonly idempotencyKey: string
    readonly now: string
  },
) =>
  Effect.tryPromise({
    try: async () => {
      await env.DB.prepare(`INSERT OR IGNORE INTO organization_deletion_child_operations
        (organization_id, parent_operation_id, kind, resource_id, child_operation_id,
         idempotency_key, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'dispatching', ?, ?) `)
        .bind(
          input.organizationId,
          input.parentOperationId,
          input.kind,
          input.resourceId,
          input.childOperationId,
          input.idempotencyKey,
          input.now,
          input.now,
        )
        .run()
      const exact = await env.DB.prepare(`SELECT child_operation_id AS childOperationId,
        idempotency_key AS idempotencyKey, state
        FROM organization_deletion_child_operations
        WHERE organization_id = ? AND parent_operation_id = ? AND kind = ? AND resource_id = ?`)
        .bind(input.organizationId, input.parentOperationId, input.kind, input.resourceId)
        .first<{ childOperationId: string; idempotencyKey: string; state: string }>()
      if (
        exact === null ||
        exact.childOperationId !== input.childOperationId ||
        exact.idempotencyKey !== input.idempotencyKey ||
        (exact.state !== 'dispatching' && exact.state !== 'accepted')
      )
        throw new Error('child receipt mismatch')
    },
    catch: () => new Error(`organization ${input.kind} deletion child could not be reserved`),
  })

const recordAcceptedChild = (
  env: Bindings,
  input: {
    readonly organizationId: string
    readonly parentOperationId: string
    readonly kind: 'game-server' | 'node'
    readonly resourceId: string
    readonly childOperationId: string
    readonly now: string
  },
) =>
  Effect.tryPromise({
    try: async () => {
      await env.DB.prepare(`UPDATE organization_deletion_child_operations
        SET state = 'accepted', updated_at = ?
        WHERE organization_id = ? AND parent_operation_id = ? AND kind = ?
          AND resource_id = ? AND child_operation_id = ? AND state IN ('dispatching', 'accepted')`)
        .bind(
          input.now,
          input.organizationId,
          input.parentOperationId,
          input.kind,
          input.resourceId,
          input.childOperationId,
        )
        .run()
      const exact = await env.DB.prepare(`SELECT state FROM organization_deletion_child_operations
        WHERE organization_id = ? AND parent_operation_id = ? AND kind = ?
          AND resource_id = ? AND child_operation_id = ?`)
        .bind(
          input.organizationId,
          input.parentOperationId,
          input.kind,
          input.resourceId,
          input.childOperationId,
        )
        .first<{ state: string }>()
      if (exact?.state !== 'accepted') throw new Error('child acceptance mismatch')
    },
    catch: () =>
      new Error(`organization ${input.kind} deletion child receipt could not be recorded`),
  })

const recordSucceededChild = (
  env: Bindings,
  input: {
    readonly organizationId: string
    readonly parentOperationId: string
    readonly kind: 'game-server' | 'node'
    readonly resourceId: string
    readonly childOperationId: string
    readonly now: string
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const updated = await env.DB.prepare(`UPDATE organization_deletion_child_operations
        SET state = 'succeeded', updated_at = ?
        WHERE organization_id = ? AND parent_operation_id = ? AND kind = ?
          AND resource_id = ? AND child_operation_id = ?
          AND state IN ('accepted', 'succeeded')`)
        .bind(
          input.now,
          input.organizationId,
          input.parentOperationId,
          input.kind,
          input.resourceId,
          input.childOperationId,
        )
        .run()
      const exact = await env.DB.prepare(`SELECT child_operation_id AS childOperationId, state
        FROM organization_deletion_child_operations
        WHERE organization_id = ? AND parent_operation_id = ? AND kind = ?
          AND resource_id = ?`)
        .bind(input.organizationId, input.parentOperationId, input.kind, input.resourceId)
        .first<{ readonly childOperationId: string; readonly state: string }>()
      if (
        !updated.success ||
        updated.meta?.changes !== 1 ||
        exact?.childOperationId !== input.childOperationId ||
        exact.state !== 'succeeded'
      )
        throw new Error('child terminal receipt mismatch')
    },
    catch: () => new Error(`organization ${input.kind} terminal child could not be recorded`),
  })

const waiting = (
  now: string,
  recoveryDeadlineAt: string,
  nextAttemptAt = new Date(Date.parse(now) + 30_000).toISOString(),
) => ({
  status: 'waiting' as const,
  retryMode: 'adopt_only' as const,
  nextAttemptAt,
  recoveryDeadlineAt,
})

export const hasTerminalGameDeletionReceipt = (
  read: () => Effect.Effect<unknown, unknown>,
): Effect.Effect<boolean> =>
  Effect.result(read()).pipe(Effect.map((result) => result._tag === 'Success'))

export const hasTerminalNodeRetirementReceipt = (
  read: () => Effect.Effect<unknown, unknown>,
): Effect.Effect<boolean> =>
  Effect.result(read()).pipe(Effect.map((result) => result._tag === 'Success'))

export const hasTerminalBackupDeletionReceipt = (
  read: () => Effect.Effect<unknown, unknown>,
): Effect.Effect<boolean> =>
  Effect.result(read()).pipe(Effect.map((result) => result._tag === 'Success'))

export const organizationBackupRetentionDecision = (
  expiresAt: string | null,
  now: string,
):
  | { readonly state: 'ambiguous' }
  | {
      readonly state: 'waiting'
      readonly nextAttemptAt: string
      readonly recoveryDeadlineAt: string
    }
  | { readonly state: 'deletable' } => {
  const nowEpoch = Date.parse(now)
  const expiryEpoch = expiresAt === null ? Number.NaN : Date.parse(expiresAt)
  if (Number.isNaN(nowEpoch) || Number.isNaN(expiryEpoch)) return { state: 'ambiguous' }
  if (expiryEpoch <= nowEpoch) return { state: 'deletable' }
  return {
    state: 'waiting',
    nextAttemptAt: new Date(expiryEpoch).toISOString(),
    recoveryDeadlineAt: new Date(expiryEpoch + 24 * 60 * 60_000).toISOString(),
  }
}

export interface OrganizationDeletionBackupCandidate {
  readonly backupId: string
  readonly revision: number
  readonly state: string
  readonly expiresAt: string | null
  readonly abandonedCleanupReady: boolean
  /** Exact required backup created by this organization's child delete operation. */
  readonly mandatoryDeletionBackup: boolean
}

type OrganizationBackupCleanupResult =
  | { readonly state: 'ambiguous' }
  | {
      readonly state: 'waiting'
      readonly nextAttemptAt: string
      readonly recoveryDeadlineAt: string
    }
  | {
      readonly state: 'deleted'
      readonly receipt: BackupPhysicalDeletionReceipt
    }

/**
 * Exact backup cleanup used by organization deletion. Failed and cancelled
 * partial uploads are immediately eligible only when D1 reports their exact
 * terminal create owner; usable backups continue to honor retention time.
 */
export const cleanupOrganizationDeletionBackup = (
  database: BackupD1Database,
  backupControl: BackupControlShape,
  context: OrganizationContext,
  candidate: OrganizationDeletionBackupCandidate,
  now: string,
): Effect.Effect<OrganizationBackupCleanupResult, unknown> =>
  Effect.gen(function* () {
    const recoveryDeadlineAt = new Date(Date.parse(now) + 31 * 24 * 60 * 60_000).toISOString()
    if (candidate.state === 'creating' || candidate.state === 'failed') {
      if (!candidate.abandonedCleanupReady)
        return {
          state: 'waiting' as const,
          nextAttemptAt: new Date(Date.parse(now) + 30_000).toISOString(),
          recoveryDeadlineAt,
        }
    } else if (candidate.state !== 'deleted') {
      if (candidate.state !== 'available' && candidate.state !== 'expired')
        return {
          state: 'waiting' as const,
          nextAttemptAt: new Date(Date.parse(now) + 30_000).toISOString(),
          recoveryDeadlineAt,
        }
      if (!candidate.mandatoryDeletionBackup) {
        const retention = organizationBackupRetentionDecision(candidate.expiresAt, now)
        if (retention.state !== 'deletable') return retention
      }
    }
    if (candidate.state !== 'deleted') {
      const deletion = yield* Effect.result(
        backupControl.delete(context, candidate.backupId, candidate.revision),
      )
      if (deletion._tag === 'Failure')
        return {
          state: 'waiting' as const,
          nextAttemptAt: new Date(Date.parse(now) + 30_000).toISOString(),
          recoveryDeadlineAt,
        }
    }
    const receipt = yield* Effect.result(
      requirePhysicalBackupDeletionReceipt(database, {
        organizationId: context.organizationId,
        backupId: candidate.backupId,
      }),
    )
    return receipt._tag === 'Failure'
      ? {
          state: 'waiting' as const,
          nextAttemptAt: new Date(Date.parse(now) + 30_000).toISOString(),
          recoveryDeadlineAt,
        }
      : { state: 'deleted' as const, receipt: receipt.success }
  })

/**
 * Executes only cleanup that has authoritative local evidence. Child game/node
 * resources must first reach their own terminal deletion receipts; this parent
 * never rewrites them or treats dispatch as physical deletion.
 */
export const executeOrganizationDeletionStep = (
  env: Bindings,
  game: {
    readonly planning: GameLifecyclePlanningD1Repository
    readonly deletionWorkflow: NativeLifecycleWorkflowBinding
    readonly backup: BackupControlShape
  },
  input: {
    readonly organizationId: string
    readonly operationId: string
    readonly resourceId: string
    readonly stepName: string
    readonly now: string
  },
) =>
  Effect.gen(function* () {
    if (input.resourceId !== input.organizationId)
      return yield* Effect.fail(new Error('organization deletion resource identity is mismatched'))
    const repository = makeOrganizationDeletionD1Repository(env.DB)
    const command = {
      organizationId: input.organizationId,
      operationId: input.operationId,
      now: input.now,
    }
    switch (input.stepName) {
      case 'mark-deleting':
        yield* repository.inventory(command)
        break
      case 'drain-deployments': {
        const authority = yield* deletionAuthority(env, input.organizationId, input.operationId)
        const recoveryDeadlineAt = new Date(
          Date.parse(input.now) + 31 * 24 * 60 * 60_000,
        ).toISOString()
        const servers = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT item.resource_id AS serverId,
              server.desired_revision AS desiredRevision, server.observed_state AS observedState
            FROM organization_deletion_items item JOIN game_servers server
              ON server.organization_id = item.organization_id AND server.id = item.resource_id
            WHERE item.organization_id = ? AND item.operation_id = ? AND item.kind = 'game-server'
              AND item.state IN ('pending', 'ambiguous', 'blocked') ORDER BY item.resource_id`)
              .bind(input.organizationId, input.operationId)
              .all<{ serverId: string; desiredRevision: number; observedState: string }>(),
          catch: () => new Error('organization server deletion inventory could not be loaded'),
        })
        let dispatched = false
        for (const server of servers.results) {
          const identity = yield* childIdentity(
            input.organizationId,
            input.operationId,
            'game-server',
            server.serverId,
          )
          if (server.observedState === 'deleted') {
            const hasDnsReceipt = yield* hasTerminalGameDeletionReceipt(() =>
              makeGameLifecycleCleanupD1Repository(env.DB).requireDeletedDnsReceipt(
                input.organizationId,
                server.serverId,
                identity.operationId,
              ),
            )
            if (!hasDnsReceipt) return waiting(input.now, recoveryDeadlineAt)
            yield* repository.markItemResolved({
              ...command,
              kind: 'game-server',
              resourceId: server.serverId,
              disposition: 'resolved',
              evidence: { observedState: 'deleted', observedAt: input.now },
            })
            yield* recordSucceededChild(env, {
              organizationId: input.organizationId,
              parentOperationId: input.operationId,
              kind: 'game-server',
              resourceId: server.serverId,
              childOperationId: identity.operationId,
              now: input.now,
            })
            continue
          }
          yield* reserveChild(env, {
            organizationId: input.organizationId,
            parentOperationId: input.operationId,
            kind: 'game-server',
            resourceId: server.serverId,
            childOperationId: identity.operationId,
            idempotencyKey: identity.idempotencyKey,
            now: input.now,
          })
          const accepted = yield* makeGameLifecycleD1Repository(env.DB, {
            operationId: () => identity.operationId,
            now: () => input.now,
          }).mutate({
            organizationId: input.organizationId,
            actorId: authority.actorId,
            auditRequestContext: authority.request,
            auditActorType: 'human',
            idempotencyKey: identity.idempotencyKey,
            correlationId: authority.request.correlationId,
            serverId: server.serverId,
            expectedRevision: server.desiredRevision,
            intent: { action: 'delete', backupPolicy: 'required' },
          })
          yield* recordAcceptedChild(env, {
            organizationId: input.organizationId,
            parentOperationId: input.operationId,
            kind: 'game-server',
            resourceId: server.serverId,
            childOperationId: accepted.operation.operationId,
            now: input.now,
          })
          const facts = yield* game.planning.readPlanningFacts(input.organizationId)
          yield* startOrAdoptGameLifecycleWorkflow(
            game.planning,
            facts.catalog,
            game.deletionWorkflow,
            accepted,
          )
          dispatched = true
        }
        const deployments = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT item.resource_id AS deploymentId,
              deployment.observed_state AS observedState
            FROM organization_deletion_items item JOIN deployments deployment
              ON deployment.organization_id = item.organization_id AND deployment.id = item.resource_id
            WHERE item.organization_id = ? AND item.operation_id = ? AND item.kind = 'deployment'
              AND item.state IN ('pending', 'ambiguous', 'blocked') ORDER BY item.resource_id`)
              .bind(input.organizationId, input.operationId)
              .all<{ deploymentId: string; observedState: string }>(),
          catch: () => new Error('organization deployment inventory could not be loaded'),
        })
        for (const deployment of deployments.results)
          if (deployment.observedState === 'deleted')
            yield* repository.markItemResolved({
              ...command,
              kind: 'deployment',
              resourceId: deployment.deploymentId,
              disposition: 'resolved',
              evidence: { observedState: 'deleted', observedAt: input.now },
            })
        if (dispatched) return waiting(input.now, recoveryDeadlineAt)
        // A required backup is created by the child game deletion after the
        // first organization snapshot. Refresh only after every server child
        // has exact terminal evidence, before deciding that backup cleanup is
        // complete.
        yield* repository.inventory(command)
        const backups = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT item.resource_id AS backupId, backup.revision,
              backup.state, backup.expires_at AS expiresAt,
              EXISTS (
                SELECT 1
                FROM backup_jobs source_job
                JOIN operations source_operation
                  ON source_operation.organization_id = source_job.organization_id
                 AND source_operation.id = source_job.operation_id
                WHERE source_job.organization_id = backup.organization_id
                  AND source_job.backup_id = backup.id
                  AND source_job.mode = 'create'
                  AND (
                    (backup.state = 'creating' AND source_job.state = 'cancelled'
                      AND source_operation.status = 'cancelled')
                    OR
                    (backup.state = 'failed'
                      AND source_job.state IN ('failed', 'failed_terminal')
                      AND source_operation.status = source_job.state)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM backup_jobs active_create
                    WHERE active_create.organization_id = backup.organization_id
                      AND active_create.backup_id = backup.id
                      AND active_create.mode = 'create'
                      AND active_create.state IN (
                        'reserved', 'running', 'waiting_external', 'cancelling'
                      )
                  )
              ) AS abandonedCleanupReady,
              EXISTS (
                SELECT 1
                FROM organization_deletion_runs deletion_run
                JOIN organization_deletion_child_operations child
                  ON child.organization_id = deletion_run.organization_id
                 AND child.parent_operation_id = deletion_run.operation_id
                 AND child.kind = 'game-server'
                 AND child.resource_id = backup.server_id
                 AND child.state = 'succeeded'
                JOIN backup_jobs required_backup
                  ON required_backup.organization_id = child.organization_id
                 AND required_backup.idempotency_key =
                   'game-lifecycle:' || child.child_operation_id || ':backup'
                 AND required_backup.mode = 'create'
                 AND required_backup.state = 'succeeded'
                 AND required_backup.source_server_id = child.resource_id
                 AND required_backup.backup_id = backup.id
                WHERE deletion_run.organization_id = item.organization_id
                  AND deletion_run.operation_id = item.operation_id
                  AND deletion_run.backup_policy = 'delete-after-retention'
              ) AS mandatoryDeletionBackup
            FROM organization_deletion_items item JOIN backups backup
              ON backup.organization_id = item.organization_id AND backup.id = item.resource_id
            WHERE item.organization_id = ? AND item.operation_id = ? AND item.kind = 'backup'
              AND item.state IN ('pending', 'ambiguous', 'blocked') ORDER BY item.resource_id`)
              .bind(input.organizationId, input.operationId)
              .all<{
                backupId: string
                revision: number
                state: string
                expiresAt: string | null
                abandonedCleanupReady: number
                mandatoryDeletionBackup: number
              }>(),
          catch: () => new Error('organization backup deletion inventory could not be loaded'),
        })
        for (const backup of backups.results) {
          const cleanup = yield* cleanupOrganizationDeletionBackup(
            env.DB,
            game.backup,
            {
              organizationId: input.organizationId,
              organizationSlug: authority.organizationSlug,
              identityId: authority.actorId,
              role: 'owner',
              correlationId: authority.request.correlationId,
              auditRequestContext: authority.request,
            } as OrganizationContext & { readonly auditRequestContext: AuditRequestContextValue },
            {
              ...backup,
              abandonedCleanupReady: backup.abandonedCleanupReady === 1,
              mandatoryDeletionBackup: backup.mandatoryDeletionBackup === 1,
            },
            input.now,
          )
          if (cleanup.state === 'ambiguous') {
            yield* repository.markItemResolved({
              ...command,
              kind: 'backup',
              resourceId: backup.backupId,
              disposition: 'ambiguous',
              evidence: {
                reason: 'bounded-retention-expiry-unavailable',
                configuredPolicy: 'delete-after-retention',
              },
            })
            return waiting(input.now, recoveryDeadlineAt)
          }
          if (cleanup.state === 'waiting')
            return waiting(input.now, cleanup.recoveryDeadlineAt, cleanup.nextAttemptAt)
          yield* repository.markItemResolved({
            ...command,
            kind: 'backup',
            resourceId: backup.backupId,
            disposition: 'resolved',
            evidence: {
              state: 'deleted',
              deletedAt: cleanup.receipt.completedAt,
              physicalDeletionOperationId: cleanup.receipt.operationId,
              physicalDeletionClaimId: cleanup.receipt.claimId,
              deletedPrefix: cleanup.receipt.r2Key,
              deletedObjects: cleanup.receipt.deletedObjects,
              alreadyAbsent: cleanup.receipt.alreadyAbsent,
            },
          })
        }
        // Close the discovery/cleanup loop again. INSERT OR IGNORE makes a
        // response-loss retry adopt the same inventory, while any child
        // backup committed during this pass keeps the step waiting.
        yield* repository.inventory(command)
        const pending = yield* pendingKinds(env, input.organizationId, input.operationId, [
          'game-server',
          'deployment',
          'backup',
        ])
        if (pending !== 0) return waiting(input.now, recoveryDeadlineAt)
        break
      }
      case 'retire-nodes': {
        const nodes = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT item.resource_id AS nodeId,
              node.desired_revision AS desiredRevision, node.observed_state AS observedState
            FROM organization_deletion_items item JOIN nodes node
              ON node.organization_id = item.organization_id AND node.id = item.resource_id
            WHERE item.organization_id = ? AND item.operation_id = ? AND item.kind = 'node'
              AND item.state IN ('pending', 'ambiguous', 'blocked') ORDER BY item.resource_id`)
              .bind(input.organizationId, input.operationId)
              .all<{ nodeId: string; desiredRevision: number; observedState: string }>(),
          catch: () => new Error('organization node deletion inventory could not be loaded'),
        })
        const authority =
          nodes.results.length === 0
            ? undefined
            : yield* deletionAuthority(env, input.organizationId, input.operationId)
        let dispatched = false
        for (const node of nodes.results) {
          const identity = yield* childIdentity(
            input.organizationId,
            input.operationId,
            'node',
            node.nodeId,
          )
          if (node.observedState === 'deleted') {
            const hasRetirementReceipt = yield* hasTerminalNodeRetirementReceipt(() =>
              requireDeletedRetirementReceipt(env.DB, {
                organizationId: input.organizationId,
                nodeId: node.nodeId,
                childOperationId: identity.operationId,
              }),
            )
            if (!hasRetirementReceipt)
              return waiting(
                input.now,
                new Date(Date.parse(input.now) + 24 * 60 * 60_000).toISOString(),
              )
            yield* repository.markItemResolved({
              ...command,
              kind: 'node',
              resourceId: node.nodeId,
              disposition: 'resolved',
              evidence: { observedState: 'deleted', observedAt: input.now },
            })
            yield* recordSucceededChild(env, {
              organizationId: input.organizationId,
              parentOperationId: input.operationId,
              kind: 'node',
              resourceId: node.nodeId,
              childOperationId: identity.operationId,
              now: input.now,
            })
            continue
          }
          if (authority === undefined)
            return yield* Effect.fail(new Error('organization deletion node authority is missing'))
          yield* reserveChild(env, {
            organizationId: input.organizationId,
            parentOperationId: input.operationId,
            kind: 'node',
            resourceId: node.nodeId,
            childOperationId: identity.operationId,
            idempotencyKey: identity.idempotencyKey,
            now: input.now,
          })
          const termination = makeTerminationControl(
            makeTerminationD1Repository(env.DB, {
              auditRequestContext: authority.request,
              operationId: () => identity.operationId,
              now: () => input.now,
            }),
            makeCancellationSignal(env),
          )
          const acceptance = yield* termination.beginNodeLifecycle({
            organizationId: input.organizationId,
            actorId: authority.actorId,
            role: 'owner',
            correlationId: authority.request.correlationId,
            idempotencyKey: identity.idempotencyKey,
            action: 'retire-node',
            nodeId: node.nodeId,
            expectedNodeRevision: node.desiredRevision,
            force: false,
            backupPolicy: 'required',
            organizationDeletionOperationId: input.operationId,
          })
          yield* recordAcceptedChild(env, {
            organizationId: input.organizationId,
            parentOperationId: input.operationId,
            kind: 'node',
            resourceId: node.nodeId,
            childOperationId: acceptance.operation.id,
            now: input.now,
          })
          const started = yield* Effect.result(
            startRetireNodeWorkflow(env.DB, env.RETIRE_NODE, acceptance),
          )
          if (started._tag === 'Failure')
            return waiting(
              input.now,
              new Date(Date.parse(input.now) + 24 * 60 * 60_000).toISOString(),
            )
          dispatched = true
        }
        if (dispatched)
          return waiting(
            input.now,
            new Date(Date.parse(input.now) + 24 * 60 * 60_000).toISOString(),
          )
        break
      }
      case 'revoke-credentials':
        yield* repository.revokeOrganizationCredentials(command)
        break
      case 'delete-dns-and-tunnels': {
        const deleted = yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`SELECT item.kind, item.resource_id AS resourceId
            FROM organization_deletion_items item
            WHERE item.organization_id = ? AND item.operation_id = ?
              AND item.state IN ('pending', 'ambiguous', 'blocked')
              AND ((item.kind = 'dns-record' AND EXISTS (
                SELECT 1 FROM dns_records record
                WHERE record.organization_id = item.organization_id
                  AND record.id = item.resource_id AND record.state = 'deleted'
              )) OR (item.kind = 'tunnel' AND EXISTS (
                SELECT 1 FROM tunnels tunnel
                WHERE tunnel.organization_id = item.organization_id
                  AND tunnel.node_id = item.resource_id AND tunnel.state = 'deleted'
              )))
            ORDER BY item.kind, item.resource_id LIMIT 100`)
              .bind(input.organizationId, input.operationId)
              .all<{ kind: 'dns-record' | 'tunnel'; resourceId: string }>(),
          catch: () => new Error('organization network cleanup evidence could not be loaded'),
        })
        for (const item of deleted.results)
          yield* repository.markItemResolved({
            ...command,
            kind: item.kind,
            resourceId: item.resourceId,
            disposition: 'resolved',
            evidence: { state: 'deleted', observedAt: input.now },
          })
        const pending = yield* pendingKinds(env, input.organizationId, input.operationId, [
          'dns-record',
          'tunnel',
        ])
        if (pending !== 0)
          return waiting(
            input.now,
            new Date(Date.parse(input.now) + 24 * 60 * 60_000).toISOString(),
          )
        yield* repository.releaseOrganizationReservations(command)
        break
      }
      case 'finalize-deletion': {
        const inventory = yield* repository.inventory(command)
        if (inventory.unresolvedResources !== 0 || inventory.unresolvedPaidResources !== 0)
          return waiting(
            input.now,
            new Date(Date.parse(input.now) + 31 * 24 * 60 * 60_000).toISOString(),
          )
        yield* repository.prepareTombstone(command)
        yield* repository.tombstone({
          ...command,
          retentionUntil: new Date(Date.parse(input.now) + 30 * 24 * 60 * 60_000).toISOString(),
        })
        break
      }
      default:
        return yield* Effect.fail(new Error('organization deletion step is unsupported'))
    }
    return { status: 'completed' as const }
  })

const workflowParams = (
  acceptance: OrganizationDeletionAcceptance,
  actorId: string,
  correlationId: string,
  idempotencyKey: string,
): WorkflowPayload => ({
  organizationId: acceptance.operation.organizationId,
  operationId: acceptance.operation.id,
  resourceId: acceptance.operation.organizationId,
  resourceType: 'organization',
  actorId,
  correlationId,
  idempotencyKey,
  input: {
    workflowStartRecordId: acceptance.workflowStart.id,
    requestFingerprint: acceptance.workflowStart.paramsFingerprint,
    requestedSlug: acceptance.requestedSlug,
  },
})

/** Starts or adopts only the Workflow identity committed by the acceptance batch. */
export const startOrganizationDeletionWorkflow = (
  env: Bindings,
  acceptance: OrganizationDeletionAcceptance,
  actorId: string,
  correlationId: string,
  idempotencyKey: string,
): Effect.Effect<'started' | 'adopted', Error> =>
  Effect.gen(function* () {
    if (
      acceptance.workflowStart.workflowType !== 'DeleteOrganizationWorkflow' ||
      acceptance.workflowStart.workflowInstanceId !== acceptance.operation.id ||
      acceptance.workflowStart.operationId !== acceptance.operation.id
    )
      return yield* Effect.fail(
        new Error('organization deletion Workflow acceptance is mismatched'),
      )
    const repository = makeTerminationWorkflowStartD1Repository(env.DB)
    const mark = (state: 'started' | 'adopted') =>
      repository
        .markStartedOrAdopted({
          organizationId: acceptance.operation.organizationId,
          operationId: acceptance.operation.id,
          startRecordId: acceptance.workflowStart.id,
          state,
          now: new Date().toISOString(),
        })
        .pipe(
          Effect.mapError(() => new Error('organization deletion Workflow start evidence failed')),
        )
    const params = workflowParams(acceptance, actorId, correlationId, idempotencyKey)
    const created = yield* Effect.result(
      Effect.tryPromise({
        try: () => env.DELETE_ORGANIZATION.create({ id: acceptance.operation.id, params }),
        catch: () => new Error('organization deletion Workflow create response unavailable'),
      }),
    )
    if (created._tag === 'Success' && created.success.id === acceptance.operation.id) {
      yield* mark('started')
      return 'started' as const
    }
    const adopted = yield* Effect.result(
      Effect.tryPromise({
        try: () => env.DELETE_ORGANIZATION.get(acceptance.operation.id),
        catch: () => new Error('organization deletion Workflow adoption unavailable'),
      }),
    )
    if (adopted._tag === 'Success' && adopted.success.id === acceptance.operation.id) {
      yield* mark('adopted')
      return 'adopted' as const
    }
    yield* repository
      .recordStartFailure({
        organizationId: acceptance.operation.organizationId,
        operationId: acceptance.operation.id,
        startRecordId: acceptance.workflowStart.id,
        code: 'workflow_start_pending_reconciliation',
        now: new Date().toISOString(),
      })
      .pipe(Effect.ignore)
    return yield* Effect.fail(new Error('organization deletion Workflow start remains pending'))
  })

export const beginOrganizationDeletion = (
  env: Bindings,
  request: AuditRequestContextValue,
  command: Parameters<ReturnType<typeof makeTerminationControl>['beginOrganizationDeletion']>[0],
) => {
  const control = makeTerminationControl(
    makeTerminationD1Repository(env.DB, { auditRequestContext: request }),
    makeCancellationSignal(env),
  )
  return control
    .beginOrganizationDeletion(command)
    .pipe(
      Effect.tap((acceptance) =>
        startOrganizationDeletionWorkflow(
          env,
          acceptance,
          command.actorId,
          command.correlationId,
          command.idempotencyKey,
        ),
      ),
    )
}

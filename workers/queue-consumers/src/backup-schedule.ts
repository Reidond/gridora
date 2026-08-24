import { Effect } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'

type Database = Pick<D1Database, 'prepare' | 'batch'>

export interface BackupScheduleTask {
  readonly organizationId: string
  readonly scheduleId: string
  readonly serverId: string
  readonly scheduledFor: string
  readonly scheduleRevision: number
  readonly retentionDays: number
  readonly claimId: string
  readonly actorId: string
}

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${key}`)
  return value
}

const integer = (row: Record<string, unknown>, key: string): number => {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`invalid ${key}`)
  return value
}

/**
 * Claims only exact due rows, advances the schedule in the same D1 batch, and
 * reclaims an expired delivery without creating another scheduled instant.
 */
export const claimDueBackupSchedules = async (
  database: Database,
  scheduledAt: string,
  limit = 25,
): Promise<ReadonlyArray<BackupScheduleTask>> => {
  const due = await database
    .prepare(`SELECT backup_schedules.organization_id AS organizationId,
      backup_schedules.id AS scheduleId, backup_schedules.server_id AS serverId,
      backup_schedules.next_run_at AS scheduledFor, backup_schedules.revision AS scheduleRevision,
      backup_schedules.retention_days AS retentionDays
    FROM backup_schedules JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = backup_schedules.organization_id
    JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
    JOIN organization_memberships membership ON membership.organization_id = scheduler.organization_id
      AND membership.identity_id = scheduler.identity_id AND membership.role = 'automation' AND membership.status = 'active'
    WHERE backup_schedules.enabled = 1 AND backup_schedules.next_run_at <= ?
      AND EXISTS (SELECT 1 FROM organizations organization
        WHERE organization.id = backup_schedules.organization_id AND organization.status = 'active')
    ORDER BY backup_schedules.next_run_at, backup_schedules.organization_id, backup_schedules.id LIMIT ?`)
    .bind(scheduledAt, limit)
    .all()
  const candidates = [...due.results]
  const retry = await database
    .prepare(`SELECT dispatch.organization_id AS organizationId,
      dispatch.schedule_id AS scheduleId, dispatch.server_id AS serverId,
      dispatch.scheduled_for AS scheduledFor, dispatch.schedule_revision AS scheduleRevision,
      schedule.retention_days AS retentionDays
    FROM backup_schedule_dispatches dispatch
    JOIN backup_schedules schedule ON schedule.organization_id = dispatch.organization_id
      AND schedule.id = dispatch.schedule_id
    JOIN policy_reconciliation_scheduler_identities scheduler ON scheduler.organization_id = dispatch.organization_id
    JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
    JOIN organization_memberships membership ON membership.organization_id = scheduler.organization_id
      AND membership.identity_id = scheduler.identity_id AND membership.role = 'automation' AND membership.status = 'active'
    WHERE dispatch.state = 'retrying'
       OR (dispatch.state = 'dispatching' AND dispatch.lease_expires_at <= ?)
    ORDER BY dispatch.updated_at LIMIT ?`)
    .bind(scheduledAt, Math.max(0, limit - candidates.length))
    .all()
  candidates.push(...retry.results)

  const claimed: BackupScheduleTask[] = []
  for (const raw of candidates.slice(0, limit)) {
    const row = raw as Record<string, unknown>
    const organizationId = text(row, 'organizationId')
    const scheduleId = text(row, 'scheduleId')
    const serverId = text(row, 'serverId')
    const scheduledFor = text(row, 'scheduledFor')
    const scheduleRevision = integer(row, 'scheduleRevision')
    const retentionDays = integer(row, 'retentionDays')
    const claimId = crypto.randomUUID()
    const actorRow = (await database
      .prepare(`SELECT scheduler.identity_id AS actorId
      FROM policy_reconciliation_scheduler_identities scheduler
      JOIN identities actor ON actor.id = scheduler.identity_id AND actor.status = 'active'
      JOIN organization_memberships membership ON membership.organization_id = scheduler.organization_id
        AND membership.identity_id = scheduler.identity_id AND membership.role = 'automation' AND membership.status = 'active'
      WHERE scheduler.organization_id = ?`)
      .bind(organizationId)
      .first()) as Record<string, unknown> | null
    if (actorRow === null) continue
    const actorId = text(actorRow, 'actorId')
    const leaseExpiresAt = new Date(Date.parse(scheduledAt) + 5 * 60_000).toISOString()
    await database.batch([
      database
        .prepare(`INSERT OR IGNORE INTO backup_schedule_dispatches
        (organization_id, schedule_id, scheduled_for, schedule_revision, server_id, state,
         attempts, claim_id, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'claimed', 0, NULL, NULL, ?, ?)`)
        .bind(
          organizationId,
          scheduleId,
          scheduledFor,
          scheduleRevision,
          serverId,
          scheduledAt,
          scheduledAt,
        ),
      database
        .prepare(`UPDATE backup_schedules
        SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_run_at, '+' || interval_minutes || ' minutes'), updated_at = ?
        WHERE organization_id = ? AND id = ? AND revision = ? AND next_run_at = ?`)
        .bind(scheduledAt, organizationId, scheduleId, scheduleRevision, scheduledFor),
      database
        .prepare(`UPDATE backup_schedule_dispatches
        SET state = 'dispatching', attempts = attempts + 1, claim_id = ?, lease_expires_at = ?,
            last_error_code = NULL, updated_at = ?
        WHERE organization_id = ? AND schedule_id = ? AND scheduled_for = ?
          AND (state IN ('claimed', 'retrying') OR (state = 'dispatching' AND lease_expires_at <= ?))`)
        .bind(
          claimId,
          leaseExpiresAt,
          scheduledAt,
          organizationId,
          scheduleId,
          scheduledFor,
          scheduledAt,
        ),
    ])
    const owned = await database
      .prepare(`SELECT 1 AS owned FROM backup_schedule_dispatches
      WHERE organization_id = ? AND schedule_id = ? AND scheduled_for = ?
        AND state = 'dispatching' AND claim_id = ?`)
      .bind(organizationId, scheduleId, scheduledFor, claimId)
      .first()
    if (owned !== null)
      claimed.push({
        organizationId,
        scheduleId,
        serverId,
        scheduledFor,
        scheduleRevision,
        retentionDays,
        claimId,
        actorId,
      })
  }
  return claimed
}

export const dispatchScheduledBackups = async (
  env: {
    readonly DB: Database
    readonly APPLICATION: Fetcher
    readonly INTERNAL_SERVICE_SECRET: string
  },
  scheduledAt: number,
): Promise<number> => {
  const now = new Date(scheduledAt).toISOString()
  const tasks = await claimDueBackupSchedules(env.DB, now)
  await Promise.all(
    tasks.map(async (task) => {
      const body = JSON.stringify(task)
      const path = '/v1/internal/scheduled-backups/dispatch'
      const authentication = await Effect.runPromise(
        signInternalRequest(body, env.INTERNAL_SERVICE_SECRET, Date.now(), crypto.randomUUID(), {
          method: 'POST',
          path,
          organizationId: task.organizationId,
        }),
      )
      try {
        const response = await env.APPLICATION.fetch(`https://gridora.internal${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gridora-organization-id': task.organizationId,
            ...authentication,
          },
          body,
        })
        if (!response.ok) throw new Error(`scheduled backup rejected with ${response.status}`)
        const result = (await response.json()) as { backupJobId?: unknown; operationId?: unknown }
        if (typeof result.backupJobId !== 'string' || typeof result.operationId !== 'string')
          throw new Error('scheduled backup receipt is invalid')
        await env.DB.prepare(`UPDATE backup_schedule_dispatches
        SET state = 'accepted', claim_id = NULL, lease_expires_at = NULL,
            backup_job_id = ?, operation_id = ?, updated_at = ?
        WHERE organization_id = ? AND schedule_id = ? AND scheduled_for = ?
          AND state = 'dispatching' AND claim_id = ?`)
          .bind(
            result.backupJobId,
            result.operationId,
            new Date().toISOString(),
            task.organizationId,
            task.scheduleId,
            task.scheduledFor,
            task.claimId,
          )
          .run()
      } catch {
        await env.DB.prepare(`UPDATE backup_schedule_dispatches
        SET state = CASE WHEN attempts >= 8 THEN 'terminal' ELSE 'retrying' END,
            claim_id = NULL, lease_expires_at = NULL, last_error_code = 'dispatch-unavailable', updated_at = ?
        WHERE organization_id = ? AND schedule_id = ? AND scheduled_for = ?
          AND state = 'dispatching' AND claim_id = ?`)
          .bind(
            new Date().toISOString(),
            task.organizationId,
            task.scheduleId,
            task.scheduledFor,
            task.claimId,
          )
          .run()
      }
    }),
  )
  const retentionPath = '/v1/internal/scheduled-backups/retention'
  const retentionBody = '{}'
  const retentionAuth = await Effect.runPromise(
    signInternalRequest(
      retentionBody,
      env.INTERNAL_SERVICE_SECRET,
      Date.now(),
      crypto.randomUUID(),
      { method: 'POST', path: retentionPath },
    ),
  )
  const retention = await env.APPLICATION.fetch(`https://gridora.internal${retentionPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...retentionAuth },
    body: retentionBody,
  })
  if (!retention.ok) throw new Error(`backup retention rejected with ${retention.status}`)
  await retention.body?.cancel()
  return tasks.length
}

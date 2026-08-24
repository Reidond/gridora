import { Effect } from 'effect'
import { signInternalRequest } from '@gridora/auth-cloudflare-access'

type Database = Pick<D1Database, 'prepare' | 'batch'>

export interface GameServerScheduleTask {
  readonly organizationId: string
  readonly scheduleId: string
  readonly draftId: string
  readonly scheduledFor: string
  readonly scheduleRevision: number
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`invalid ${key}`)
  return value
}

/** Claims an exact one-shot schedule. Expired deliveries reuse the same row,
 * draft, scheduled instant, and deterministic apply idempotency key. */
export const claimDueGameServerSchedules = async (
  database: Database,
  scheduledAt: string,
  limit = 25,
): Promise<ReadonlyArray<GameServerScheduleTask>> => {
  const candidates = await database
    .prepare(`SELECT schedule.organization_id AS organizationId,
      schedule.id AS scheduleId, schedule.draft_id AS draftId,
      schedule.scheduled_for AS scheduledFor, schedule.revision AS scheduleRevision,
      scheduler.identity_id AS actorId
    FROM game_server_draft_schedules schedule
    JOIN game_server_drafts draft
      ON draft.organization_id = schedule.organization_id AND draft.id = schedule.draft_id
    JOIN organizations organization
      ON organization.id = schedule.organization_id AND organization.status = 'active'
    JOIN policy_reconciliation_scheduler_identities scheduler
      ON scheduler.organization_id = schedule.organization_id
    JOIN identities actor
      ON actor.id = scheduler.identity_id AND actor.status = 'active'
    JOIN organization_memberships membership
      ON membership.organization_id = scheduler.organization_id
     AND membership.identity_id = scheduler.identity_id
     AND membership.role = 'automation' AND membership.status = 'active'
    WHERE draft.state = 'scheduled'
      AND (
        (schedule.state = 'scheduled' AND schedule.scheduled_for <= ?)
        OR schedule.state = 'retrying'
        OR (schedule.state = 'dispatching' AND schedule.lease_expires_at <= ?)
      )
    ORDER BY schedule.scheduled_for, schedule.organization_id, schedule.id
    LIMIT ?`)
    .bind(scheduledAt, scheduledAt, limit)
    .all()

  const tasks: GameServerScheduleTask[] = []
  for (const raw of candidates.results) {
    const row = raw as Record<string, unknown>
    const organizationId = text(row, 'organizationId')
    const scheduleId = text(row, 'scheduleId')
    const draftId = text(row, 'draftId')
    const scheduledFor = text(row, 'scheduledFor')
    const scheduleRevision = integer(row, 'scheduleRevision')
    const actorId = text(row, 'actorId')
    const claimId = crypto.randomUUID()
    const leaseExpiresAt = new Date(Date.parse(scheduledAt) + 5 * 60_000).toISOString()
    await database.batch([
      database
        .prepare(`UPDATE game_server_draft_schedules
        SET state = 'dispatching', revision = revision + 1, attempts = attempts + 1,
            claim_id = ?, lease_expires_at = ?, last_error_code = NULL, updated_at = ?
        WHERE organization_id = ? AND id = ? AND revision = ?
          AND attempts < 8
          AND ((state IN ('scheduled', 'retrying'))
            OR (state = 'dispatching' AND lease_expires_at <= ?))`)
        .bind(
          claimId,
          leaseExpiresAt,
          scheduledAt,
          organizationId,
          scheduleId,
          scheduleRevision,
          scheduledAt,
        ),
    ])
    const owned = await database
      .prepare(`SELECT revision FROM game_server_draft_schedules
      WHERE organization_id = ? AND id = ? AND state = 'dispatching' AND claim_id = ?`)
      .bind(organizationId, scheduleId, claimId)
      .first<Record<string, unknown>>()
    if (owned !== null)
      tasks.push({
        organizationId,
        scheduleId,
        draftId,
        scheduledFor,
        scheduleRevision: integer(owned, 'revision'),
        claimId,
        actorId,
      })
  }
  return tasks
}

export const dispatchScheduledGameServers = async (
  env: {
    readonly DB: Database
    readonly APPLICATION: Fetcher
    readonly INTERNAL_SERVICE_SECRET: string
  },
  scheduledAt: number,
): Promise<number> => {
  const tasks = await claimDueGameServerSchedules(env.DB, new Date(scheduledAt).toISOString())
  await Promise.all(
    tasks.map(async (task) => {
      const path = '/v1/internal/game-server-schedules/dispatch'
      const body = JSON.stringify(task)
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
        if (!response.ok) throw new Error(`scheduled game server rejected with ${response.status}`)
        const result = (await response.json()) as { targetOperationId?: unknown }
        if (typeof result.targetOperationId !== 'string' || result.targetOperationId.length === 0)
          throw new Error('scheduled game server receipt is invalid')
        const now = new Date().toISOString()
        await env.DB.batch([
          env.DB.prepare(`UPDATE game_server_draft_schedules
          SET state = 'accepted', revision = revision + 1, target_operation_id = ?,
              claim_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE organization_id = ? AND id = ? AND state = 'dispatching'
            AND claim_id = ? AND revision = ?`).bind(
            result.targetOperationId,
            now,
            task.organizationId,
            task.scheduleId,
            task.claimId,
            task.scheduleRevision,
          ),
          env.DB.prepare(`UPDATE game_server_drafts
          SET state = 'materialized', revision = revision + 1, updated_at = ?
          WHERE organization_id = ? AND id = ? AND state = 'scheduled'
            AND EXISTS (SELECT 1 FROM game_server_draft_schedules schedule
              WHERE schedule.organization_id = game_server_drafts.organization_id
                AND schedule.draft_id = game_server_drafts.id
                AND schedule.id = ? AND schedule.state = 'accepted'
                AND schedule.target_operation_id = ?)`).bind(
            now,
            task.organizationId,
            task.draftId,
            task.scheduleId,
            result.targetOperationId,
          ),
        ])
      } catch {
        await env.DB.prepare(`UPDATE game_server_draft_schedules
        SET state = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'retrying' END,
            revision = revision + 1, claim_id = NULL, lease_expires_at = NULL,
            last_error_code = 'dispatch-unavailable', updated_at = ?
        WHERE organization_id = ? AND id = ? AND state = 'dispatching'
          AND claim_id = ? AND revision = ?`)
          .bind(
            new Date().toISOString(),
            task.organizationId,
            task.scheduleId,
            task.claimId,
            task.scheduleRevision,
          )
          .run()
      }
    }),
  )
  return tasks.length
}

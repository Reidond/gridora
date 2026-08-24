/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { describe, expect, inject, it } from 'vitest'

interface ClaimedOutboxRow {
  readonly id: string
  readonly publishState: string
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly leaseUntil: string
}

const claim = async (
  workerId: string,
  leaseToken: string,
  limit: number,
  now: string,
  leaseUntil: string,
): Promise<ReadonlyArray<ClaimedOutboxRow>> => {
  const result = await env.DB.prepare(
    `UPDATE outbox
     SET publish_state = 'publishing', lease_owner = ?, lease_token = ?, lease_until = ?
     WHERE id IN (
       SELECT id FROM outbox
       WHERE ((publish_state IN ('pending', 'failed') AND available_at <= ?)
         OR (publish_state = 'publishing' AND lease_until <= ?))
       ORDER BY created_at, id LIMIT ?
     )
     RETURNING id, publish_state AS publishState, lease_owner AS leaseOwner,
       lease_token AS leaseToken, lease_until AS leaseUntil`,
  )
    .bind(workerId, leaseToken, leaseUntil, now, now, limit)
    .all<ClaimedOutboxRow>()
  return result.results
}

describe('D1 outbox leases in the Workers runtime', () => {
  it('reclaims expired leases, fences stale owners, and never reclaims terminal failures', async () => {
    await applyD1Migrations(env.DB, [...inject('gridoraD1Migrations')])

    const now = '2026-08-23T12:00:00Z'
    const firstLeaseUntil = '2026-08-23T12:01:00Z'
    const beforeExpiry = '2026-08-23T12:00:30Z'
    const afterExpiry = '2026-08-23T12:02:00Z'
    const secondLeaseUntil = '2026-08-23T12:03:00Z'
    const muchLater = '2026-08-23T13:00:00Z'

    await env.DB.prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES (?, ?, ?, 'active', 'UTC', 'eu', 'complete', 1, 1, ?)`)
      .bind('organization-a', 'Organization A', 'organization-a', now)
      .run()
    await env.DB.prepare(`INSERT INTO outbox
      (id, organization_id, event_type, aggregate_type, aggregate_id,
       payload_json, publish_state, retry_count, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, '{}', 'pending', 0, ?, ?)`)
      .bind(
        'event-a',
        'organization-a',
        'organization.invitation.created',
        'invitation',
        'invitation-a',
        now,
        now,
      )
      .run()

    const firstClaim = await claim('worker-a', 'lease-a', 10, now, firstLeaseUntil)
    expect(firstClaim).toEqual([
      {
        id: 'event-a',
        publishState: 'publishing',
        leaseOwner: 'worker-a',
        leaseToken: 'lease-a',
        leaseUntil: firstLeaseUntil,
      },
    ])

    const earlyClaim = await claim('worker-b', 'lease-b', 10, beforeExpiry, secondLeaseUntil)
    expect(earlyClaim).toEqual([])

    const reclaimed = await claim('worker-b', 'lease-b', 10, afterExpiry, secondLeaseUntil)
    expect(reclaimed.map(({ id }) => id)).toEqual(['event-a'])

    const staleUpdate = await env.DB.prepare(
      `UPDATE outbox SET publish_state = 'failed_terminal', retry_count = retry_count + 1,
         lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE id = ? AND publish_state = 'publishing'
         AND lease_owner = ? AND lease_token = ?`,
    )
      .bind('event-a', 'worker-a', 'lease-a')
      .run()
    expect(staleUpdate.meta.changes).toBe(0)

    const ownedUpdate = await env.DB.prepare(
      `UPDATE outbox SET publish_state = 'failed_terminal', retry_count = retry_count + 1,
         lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE id = ? AND publish_state = 'publishing'
         AND lease_owner = ? AND lease_token = ?`,
    )
      .bind('event-a', 'worker-b', 'lease-b')
      .run()
    expect(ownedUpdate.meta.changes).toBe(1)

    const afterTerminalFailure = await claim('worker-c', 'lease-c', 10, muchLater, muchLater)
    expect(afterTerminalFailure).toEqual([])

    const persisted = await env.DB.prepare(`SELECT publish_state AS state,
      retry_count AS retryCount, lease_owner AS leaseOwner,
      lease_token AS leaseToken, lease_until AS leaseUntil
      FROM outbox WHERE id = ?`)
      .bind('event-a')
      .first()
    expect(persisted).toEqual({
      state: 'failed_terminal',
      retryCount: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
    })
  })
})

/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { EventEnvelope, OrganizationEventsDO } from '../../workers/realtime/src/index.js'

const event = (organizationId: string, data: Readonly<Record<string, unknown>>): EventEnvelope => ({
  id: 'shared-event-id',
  organizationId,
  type: 'organization.membership.revoked',
  resourceId: 'identity-a',
  occurredAt: '2026-08-23T12:00:00Z',
  data,
})

describe('organization event Durable Objects in the Workers runtime', () => {
  it('partitions durable state and replay detection by organization', async () => {
    const namespace = env.ORGANIZATION_EVENTS as DurableObjectNamespace<OrganizationEventsDO>
    const organizationA = namespace.getByName('organization-a:events')
    const organizationB = namespace.getByName('organization-b:events')

    await organizationA.initialize('organization-a')
    await organizationB.initialize('organization-b')

    expect(await organizationA.publish(event('organization-a', { tenant: 'a' }))).toBe(true)
    expect(await organizationA.publish(event('organization-a', { tenant: 'a' }))).toBe(false)
    expect(await organizationB.publish(event('organization-b', { tenant: 'b' }))).toBe(true)

    await evictDurableObject(organizationA)
    expect(await organizationA.publish(event('organization-a', { tenant: 'a' }))).toBe(false)

    const stateA = await runInDurableObject(organizationA, async (_instance, durableState) => ({
      identity: await durableState.storage.get<{
        readonly organizationId: string
        readonly resourceId: string
      }>('identity'),
      events: durableState.storage.sql
        .exec<{ readonly event_id: string; readonly body: string }>(
          'SELECT event_id, body FROM recent_events ORDER BY sequence',
        )
        .toArray(),
    }))
    const stateB = await runInDurableObject(organizationB, async (_instance, durableState) => ({
      identity: await durableState.storage.get<{
        readonly organizationId: string
        readonly resourceId: string
      }>('identity'),
      events: durableState.storage.sql
        .exec<{ readonly event_id: string; readonly body: string }>(
          'SELECT event_id, body FROM recent_events ORDER BY sequence',
        )
        .toArray(),
    }))

    expect(stateA.identity).toEqual({
      organizationId: 'organization-a',
      resourceId: 'organization-a',
    })
    expect(stateB.identity).toEqual({
      organizationId: 'organization-b',
      resourceId: 'organization-b',
    })
    expect(stateA.events).toHaveLength(1)
    expect(stateB.events).toHaveLength(1)
    expect(JSON.parse(stateA.events[0]?.body ?? '{}')).toMatchObject({
      organizationId: 'organization-a',
      data: { tenant: 'a' },
    })
    expect(JSON.parse(stateB.events[0]?.body ?? '{}')).toMatchObject({
      organizationId: 'organization-b',
      data: { tenant: 'b' },
    })
  })
})

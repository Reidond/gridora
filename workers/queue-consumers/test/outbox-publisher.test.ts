import { describe, expect, it } from 'vitest'
import { OutboxEvent } from '@gridora/contracts'
import { Effect, Schema } from 'effect'
import {
  TerminalOutboxFailure,
  deliverAuditExportOutboxEvent,
  deliverClaimedOutboxEvent,
  deliverGenericOutboxEvent,
  drainOutbox,
  handleOutboxWakeup,
  publishOutboxEvent,
  toAuditExportQueueEvent,
  toGenericOutboxQueueEvent,
  type QueueEnv,
} from '../src/index.js'
import { AuditExportEvent, auditPartitionKey } from '../src/audit-export.js'

type TenantAuditExportEvent = Extract<AuditExportEvent, { readonly scope: 'tenant' }>

const outboxEvent = async (
  overrides: Partial<Record<keyof OutboxEvent, unknown>> = {},
): Promise<OutboxEvent> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(OutboxEvent)({
      id: 'event_1',
      organizationId: 'org_1',
      eventType: 'organization.membership.revoked',
      aggregateType: 'organization_membership',
      aggregateId: 'identity_1',
      payload: JSON.stringify({ principalId: 'identity_1' }),
      publishState: 'publishing',
      retryCount: 0,
      availableAt: '2026-08-23T00:00:00.000Z',
      createdAt: '2026-08-23T00:00:00.000Z',
      ...overrides,
    }),
  )

const auditPayload = (
  overrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): TenantAuditExportEvent =>
  Schema.decodeUnknownSync(AuditExportEvent)({
    version: 1,
    scope: 'tenant',
    id: 'audit-provider-create-a',
    organizationId: 'org-a',
    partitionKey: auditPartitionKey('org-a'),
    exportRequestId: 'audit-export-00000000000000000001',
    admittedAt: '2001-01-01T00:00:00.000Z',
    envelope: {
      version: 1,
      captureStatus: 'complete',
      occurredAt: '2001-01-01T00:00:00.000Z',
      scope: 'tenant',
      organizationId: 'org-a',
      actor: { type: 'human', id: 'identity-a' },
      request: { id: 'request-a', correlationId: 'correlation-a' },
      action: 'provider.node.create',
      target: { type: 'node', id: 'node-a' },
      before: { state: 'absent', reason: 'node-did-not-exist' },
      after: { state: 'captured', summary: { state: 'provisioning', region: 'eu-west' } },
      operationId: 'operation-a',
      source: {
        origin: 'http',
        ip: { state: 'captured', value: '203.0.113.7' },
        access: {
          state: 'captured',
          value: {
            subject: 'access-subject-a',
            identityId: 'identity-a',
            issuer: 'https://access.example.test',
            email: 'operator@example.test',
          },
        },
      },
      result: 'succeeded',
      error: { classification: 'none', code: null },
      forced: false,
      breakGlass: false,
      ...envelopeOverrides,
    },
    ...overrides,
  }) as TenantAuditExportEvent

const auditOutboxEvent = async (
  payload: TenantAuditExportEvent = auditPayload(),
  overrides: Partial<Record<keyof OutboxEvent, unknown>> = {},
): Promise<OutboxEvent> =>
  outboxEvent({
    id: 'audit-export-00000000000000000001',
    organizationId: payload.organizationId,
    eventType: 'audit.export.requested',
    aggregateType: 'audit_event',
    aggregateId: 'audit-event-00000000000000000001',
    payload: JSON.stringify(payload),
    availableAt: payload.envelope.occurredAt,
    createdAt: payload.envelope.occurredAt,
    ...overrides,
  })

describe('leased outbox publisher', () => {
  it('replays safely after a crash between publish and mark-delivered', async () => {
    const event = await outboxEvent()
    const downstream = new Set<string>()
    let crash = true
    const publish = async (claimed: OutboxEvent) => {
      downstream.add(claimed.id)
    }
    const markDelivered = async () => {
      if (crash) {
        crash = false
        throw new Error('crash after publish')
      }
    }
    await expect(
      deliverClaimedOutboxEvent(event, publish, markDelivered, async () => undefined),
    ).rejects.toThrow('crash')
    await expect(
      deliverClaimedOutboxEvent(event, publish, markDelivered, async () => undefined),
    ).resolves.toBeUndefined()
    expect([...downstream]).toEqual(['event_1'])
  })

  it('marks a rejected generic delivery failed without marking it delivered', async () => {
    const event = await outboxEvent({ eventType: 'organization.membership.role.updated' })
    const transitions: Array<string> = []
    await expect(
      deliverClaimedOutboxEvent(
        event,
        async () => {
          transitions.push('publish')
          throw new Error('Application rejected queue event with 501')
        },
        async () => {
          transitions.push('delivered')
        },
        async () => {
          transitions.push('failed')
        },
      ),
    ).rejects.toThrow('501')
    expect(transitions).toEqual(['publish', 'failed'])
  })

  it('terminalizes a permanent invitation rejection after remediation without marking it delivered', async () => {
    const event = await outboxEvent({ eventType: 'organization.invitation.created' })
    const transitions: Array<string> = []
    await expect(
      deliverClaimedOutboxEvent(
        event,
        async () => {
          transitions.push('publish')
          transitions.push('remediation:persisted')
          throw new TerminalOutboxFailure('E_RECIPIENT_SUPPRESSED')
        },
        async () => {
          transitions.push('delivered')
        },
        async (_claimed, disposition) => {
          transitions.push(`failed:${disposition}`)
        },
      ),
    ).rejects.toMatchObject({ code: 'E_RECIPIENT_SUPPRESSED' })
    expect(transitions).toEqual(['publish', 'remediation:persisted', 'failed:terminal'])
  })

  it('keeps a permanent invitation rejection retryable until remediation persistence succeeds', async () => {
    const event = await outboxEvent({ eventType: 'organization.invitation.created' })
    const transitions: Array<string> = []
    await expect(
      deliverClaimedOutboxEvent(
        event,
        async () => {
          transitions.push('publish')
          throw new Error('remediation storage unavailable')
        },
        async () => {
          transitions.push('delivered')
        },
        async (_claimed, disposition) => {
          transitions.push(`failed:${disposition}`)
        },
      ),
    ).rejects.toThrow('remediation storage unavailable')
    expect(transitions).toEqual(['publish', 'failed:retryable'])
  })

  it('publishes self-leave through the immediate membership revocation channel', async () => {
    const calls: unknown[] = []
    const event = await outboxEvent({ eventType: 'organization.membership.left' })
    const env = {
      // A committed membership revoke now also scans epoch-scoped live-log
      // streams. This fixture deliberately has no stream rows, but supplies
      // the production D1 boundary so the revocation path remains exercised.
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => ({
              results: query.includes('live_log_membership_authorizations')
                ? [{ authorizationGeneration: 2, membershipRevision: 2, state: 'revoked' }]
                : [],
            }),
          }),
        }),
      },
      ORGANIZATION_EVENTS: {
        getByName: (name: string) => ({
          initialize: async (organizationId: string) => {
            calls.push(['initialize', name, organizationId])
          },
          publish: async (published: unknown) => {
            calls.push(['publish', published])
            return true
          },
        }),
      },
    } as unknown as QueueEnv
    await publishOutboxEvent(env, event)
    expect(calls).toEqual([
      ['initialize', 'org_1:events', 'org_1'],
      [
        'publish',
        {
          id: 'event_1',
          organizationId: 'org_1',
          type: 'organization.membership.left',
          resourceId: 'identity_1',
          occurredAt: '2026-08-23T00:00:00.000Z',
          data: { principalId: 'identity_1' },
        },
      ],
    ])
  })

  it('closes epoch-scoped live logs for a committed role revision, including a current deployment without archive history', async () => {
    const calls: unknown[] = []
    const event = await outboxEvent({
      eventType: 'organization.membership.role.updated',
      payload: JSON.stringify({
        identityId: 'identity_1',
        beforeRole: 'viewer',
        afterRole: 'operator',
      }),
    })
    const env = {
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => ({
              results: query.includes('live_log_membership_authorizations')
                ? [{ authorizationGeneration: 7, membershipRevision: 4, state: 'active' }]
                : [{ serverId: 'server-a', streamEpoch: 'deployment-a' }],
            }),
          }),
        }),
      },
      ORGANIZATION_EVENTS: {
        getByName: () => ({
          initialize: async () => undefined,
          publish: async () => true,
        }),
      },
      LIVE_LOG_STREAM: {
        getByName: (name: string) => ({
          synchronizePrincipalAuthorization: async (
            organizationId: string,
            serverId: string,
            streamEpoch: string,
            principalId: string,
            membershipRevision: number,
            authorizationGeneration: number,
            state: string,
          ) => {
            calls.push([
              name,
              organizationId,
              serverId,
              streamEpoch,
              principalId,
              membershipRevision,
              authorizationGeneration,
              state,
            ])
          },
        }),
      },
    } as unknown as QueueEnv
    await publishOutboxEvent(env, event)
    expect(calls).toEqual([
      [
        'org_1:logs:server-a:deployment-a',
        'org_1',
        'server-a',
        'deployment-a',
        'identity_1',
        4,
        7,
        'active',
      ],
    ])
  })

  it('synchronizes every known live-log epoch only after the organization-status outbox event', async () => {
    const calls: unknown[] = []
    const event = await outboxEvent({
      eventType: 'organization.live-log.authorization.changed',
      aggregateType: 'organization',
      aggregateId: 'org_1',
      payload: JSON.stringify({ organizationId: 'org_1', status: 'suspended' }),
    })
    const env = {
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => ({
              results: query.includes('live_log_organization_authorizations')
                ? [{ authorizationGeneration: 3, state: 'suspended' }]
                : [{ serverId: 'server-a', streamEpoch: 'deployment-a' }],
            }),
          }),
        }),
      },
      LIVE_LOG_STREAM: {
        getByName: (name: string) => ({
          synchronizeOrganizationAuthorization: async (
            organizationId: string,
            serverId: string,
            streamEpoch: string,
            authorizationGeneration: number,
            state: string,
          ) => {
            calls.push([
              name,
              organizationId,
              serverId,
              streamEpoch,
              authorizationGeneration,
              state,
            ])
          },
        }),
      },
    } as unknown as QueueEnv
    await publishOutboxEvent(env, event)
    expect(calls).toEqual([
      ['org_1:logs:server-a:deployment-a', 'org_1', 'server-a', 'deployment-a', 3, 'suspended'],
    ])
  })
})

describe('strict audit export producer', () => {
  it('sends the exact authoritative tenant event, including an old audit timestamp', async () => {
    const payload = auditPayload()
    const event = await auditOutboxEvent(payload)
    const sent: AuditExportEvent[] = []
    await deliverAuditExportOutboxEvent(event, async (message) => {
      sent.push(message)
    })
    expect(sent).toEqual([payload])
    expect(
      Object.keys(
        sent[0]?.envelope.after.state === 'captured' ? sent[0].envelope.after.summary : {},
      ),
    ).toEqual(['region', 'state'])
    await expect(toAuditExportQueueEvent(event)).resolves.toEqual(payload)
  })

  it('marks a failed Queue send retryable and replays the same event before delivery', async () => {
    const event = await auditOutboxEvent()
    const attempts: AuditExportEvent[] = []
    const transitions: string[] = []
    let failSend = true
    const publish = (claimed: OutboxEvent) =>
      deliverAuditExportOutboxEvent(claimed, async (message) => {
        attempts.push(message)
        if (failSend) {
          failSend = false
          throw new Error('simulated Queue response loss')
        }
      })
    const delivered = async () => {
      transitions.push('delivered')
    }
    const failed = async (_claimed: OutboxEvent, disposition: 'retryable' | 'terminal') => {
      transitions.push(`failed:${disposition}`)
    }

    await expect(deliverClaimedOutboxEvent(event, publish, delivered, failed)).rejects.toThrow(
      'simulated Queue response loss',
    )
    await expect(
      deliverClaimedOutboxEvent(event, publish, delivered, failed),
    ).resolves.toBeUndefined()
    expect(attempts).toEqual([auditPayload(), auditPayload()])
    expect(transitions).toEqual(['failed:retryable', 'delivered'])
  })

  it('terminally rejects cross-tenant and malformed audit outbox rows before Queue send', async () => {
    const crossTenant = await auditOutboxEvent(auditPayload(), { organizationId: 'org-b' })
    const malformed = await auditOutboxEvent(auditPayload(), {
      aggregateId: 'audit-event-00000000000000000002',
    })
    const swappedPayload = await auditOutboxEvent(
      auditPayload({ exportRequestId: 'audit-export-00000000000000000002' }),
    )
    let sends = 0
    const sentBodies: string[] = []
    for (const candidate of [crossTenant, malformed, swappedPayload]) {
      const dispositions: string[] = []
      await expect(
        deliverClaimedOutboxEvent(
          candidate,
          (claimed) =>
            deliverAuditExportOutboxEvent(claimed, async () => {
              sends += 1
              sentBodies.push(JSON.stringify(claimed))
            }),
          async () => {
            dispositions.push('delivered')
          },
          async (_claimed, disposition) => {
            dispositions.push(disposition)
          },
        ),
      ).rejects.toMatchObject({ code: 'E_AUDIT_EXPORT_CONTRACT' })
      expect(dispositions).toEqual(['terminal'])
    }
    expect(sends).toBe(0)
    expect(sentBodies).toEqual([])
  })
})

describe('immediate outbox wakeup', () => {
  it('acks every wakeup only after the publisher succeeds', async () => {
    const actions: Array<string> = []
    const messages = [1, 2].map((attempts) => ({
      attempts,
      ack: () => {
        actions.push(`ack:${attempts}`)
      },
      retry: ({ delaySeconds }: { delaySeconds: number }) => {
        actions.push(`retry:${delaySeconds}`)
      },
    }))
    await expect(
      handleOutboxWakeup(messages, async () => {
        actions.push('publish')
      }),
    ).resolves.toBe('ack')
    expect(actions).toEqual(['publish', 'ack:1', 'ack:2'])
  })

  it('retries every wakeup with bounded exponential delay when publishing fails', async () => {
    const actions: Array<string> = []
    const messages = [1, 10].map((attempts) => ({
      attempts,
      ack: () => {
        actions.push(`ack:${attempts}`)
      },
      retry: ({ delaySeconds }: { delaySeconds: number }) => {
        actions.push(`retry:${delaySeconds}`)
      },
    }))
    await expect(
      handleOutboxWakeup(messages, async () => {
        throw new Error('D1 unavailable')
      }),
    ).resolves.toBe('retry')
    expect(actions).toEqual(['retry:2', 'retry:60'])
  })

  it('drains successive full claim pages so a trailing revocation is not delayed', async () => {
    const pageCounts = [50, 50, 1]
    let pages = 0
    await expect(
      drainOutbox(async () => {
        const count = pageCounts[pages]
        pages += 1
        if (count === undefined) throw new Error('unexpected extra page')
        return count
      }),
    ).resolves.toBe(101)
    expect(pages).toBe(3)
  })
})

describe('generic gridora-outbox delivery', () => {
  it('preserves event identity and binds the tenant partition to the aggregate', async () => {
    const event = await outboxEvent({
      eventType: 'organization.membership.role.updated',
      payload: JSON.stringify({ beforeRole: 'viewer', afterRole: 'operator' }),
    })
    const queueEvent = await toGenericOutboxQueueEvent(event)
    expect(queueEvent).toEqual({
      id: 'event_1',
      organizationId: 'org_1',
      partitionKey: 'org_1:organization_membership:identity_1',
      type: 'organization.membership.role.updated',
      occurredAt: '2026-08-23T00:00:00.000Z',
      payload: { beforeRole: 'viewer', afterRole: 'operator' },
    })
  })

  it('delivers only through the signed internal gridora-outbox application path', async () => {
    const event = await outboxEvent({ eventType: 'organization.membership.role.updated' })
    const calls: Array<{ queue: string; eventId: string }> = []
    await deliverGenericOutboxEvent(event, async (queue, queueEvent) => {
      calls.push({ queue, eventId: queueEvent.id })
    })
    expect(calls).toEqual([{ queue: 'gridora-outbox', eventId: 'event_1' }])
  })

  it('rejects a non-object payload before attempting delivery', async () => {
    const event = await outboxEvent({ payload: JSON.stringify('not-an-object') })
    let delivered = false
    await expect(
      deliverGenericOutboxEvent(event, async () => {
        delivered = true
      }),
    ).rejects.toBeDefined()
    expect(delivered).toBe(false)
  })
})

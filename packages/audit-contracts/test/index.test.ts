import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_ENVELOPE_LIMITS,
  canonicalAuditJson,
  decodeAuditEnvelope,
  isAuditIpAddress,
  platformAuditPartitionKey,
  redactAuditValue,
  stageAuditEnvelope,
  tenantAuditPartitionKey,
} from '../src/index.js'

const tenantEnvelope = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  captureStatus: 'complete',
  occurredAt: '2026-08-23T12:00:00.000Z',
  scope: 'tenant',
  organizationId: 'org-a',
  actor: { type: 'human', id: 'identity-a' },
  request: { id: 'request-a', correlationId: 'correlation-a' },
  action: 'server.update',
  target: { type: 'game-server', id: 'server-a' },
  before: { state: 'captured', summary: { state: 'stopped' } },
  after: { state: 'captured', summary: { state: 'running' } },
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
  ...overrides,
})

describe('audit envelope contract', () => {
  it('requires an explicit, internally consistent version-one audit envelope', async () => {
    await expect(Effect.runPromise(decodeAuditEnvelope(tenantEnvelope()))).resolves.toMatchObject({
      version: 1,
      scope: 'tenant',
      organizationId: 'org-a',
    })
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(
          tenantEnvelope({ result: 'failed', error: { classification: 'none', code: null } }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'result-mismatch' })
    await expect(
      Effect.runPromise(decodeAuditEnvelope(tenantEnvelope({ organizationId: null }))),
    ).rejects.toMatchObject({ code: 'scope-mismatch' })
  })

  it('redacts secret-shaped values recursively before validation or storage', () => {
    const canaries = [
      'gridora-audit-client-secret-canary',
      'gridora-audit-steam-guard-canary',
      'gridora-audit-rcon-canary',
    ]
    const redacted = redactAuditValue({
      visible: 'yes',
      nested: {
        apiToken: 'gridora-audit-canary',
        apiTokenDigest: 'hidden',
        passwordHash: 'hidden',
        credentialVersion: 'hidden',
        items: [{ password: 'hidden' }],
        clientSecret: canaries[0],
        Steam_GuardCode: canaries[1],
        deep: [{ ＲｃｏｎＰａｓｓｗｏｒｄ: canaries[2] }],
      },
    }) as Record<string, unknown>
    expect(redacted).toEqual({
      visible: 'yes',
      nested: {
        apiToken: '[REDACTED]',
        apiTokenDigest: '[REDACTED]',
        passwordHash: '[REDACTED]',
        credentialVersion: '[REDACTED]',
        items: [{ password: '[REDACTED]' }],
        clientSecret: '[REDACTED]',
        Steam_GuardCode: '[REDACTED]',
        deep: [{ ＲｃｏｎＰａｓｓｗｏｒｄ: '[REDACTED]' }],
      },
    })
    const persisted = JSON.stringify(redacted)
    for (const canary of canaries) expect(persisted).not.toContain(canary)
  })

  it('decodes every v1 actor and result literal without a first-literal fallback', async () => {
    const cases = [
      { actor: 'human', result: 'succeeded', classification: 'none' },
      { actor: 'automation', result: 'denied', classification: 'authorization' },
      { actor: 'machine', result: 'failed', classification: 'provider' },
      { actor: 'system', result: 'failed', classification: 'transport' },
      { actor: 'platform', result: 'denied', classification: 'policy' },
    ] as const
    for (const current of cases) {
      await expect(
        Effect.runPromise(
          decodeAuditEnvelope(
            tenantEnvelope({
              actor: { type: current.actor, id: 'identity-a' },
              result: current.result,
              error: {
                classification: current.classification,
                code: current.classification === 'none' ? null : 'test-classification',
              },
            }),
          ),
        ),
      ).resolves.toMatchObject({ actor: { type: current.actor }, result: current.result })
    }
  })

  it('creates an exact tenant staging row and rejects scope confusion', async () => {
    const stage = await Effect.runPromise(
      stageAuditEnvelope('tenant', 'audit-a', tenantEnvelope(), '2026-08-23T12:00:00.000Z'),
    )
    expect(stage).toMatchObject({
      eventTable: 'tenant',
      eventId: 'audit-a',
      organizationId: 'org-a',
    })
    await expect(
      Effect.runPromise(
        stageAuditEnvelope('platform', 'audit-a', tenantEnvelope(), '2026-08-23T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'scope-mismatch' })
    expect(tenantAuditPartitionKey('org-a')).toBe('org-a:audit')
    expect(platformAuditPartitionKey).toBe('platform:audit')
  })

  it('binds HTTP Access evidence to the resolved human and keeps non-HTTP origins honest', async () => {
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(
          tenantEnvelope({
            source: {
              ...tenantEnvelope().source,
              access: {
                state: 'captured',
                value: {
                  subject: 'access-subject-a',
                  identityId: 'identity-other',
                  issuer: 'https://access.example.test',
                  email: 'operator@example.test',
                },
              },
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'source-mismatch' })
    await expect(
      Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          'audit-access-spoof',
          tenantEnvelope({
            source: {
              ...tenantEnvelope().source,
              access: {
                state: 'captured',
                value: {
                  subject: 'access-subject-a',
                  identityId: 'identity-other',
                  issuer: 'https://access.example.test',
                  email: 'operator@example.test',
                },
              },
            },
          }),
          '2026-08-23T12:00:00.000Z',
        ),
      ),
    ).rejects.toMatchObject({ code: 'source-mismatch' })
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(
          tenantEnvelope({
            source: {
              origin: 'machine',
              ip: { state: 'captured', value: '203.0.113.7' },
              access: {
                state: 'captured',
                value: { subject: null, identityId: null, issuer: null, email: null },
              },
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'source-mismatch' })
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(
          tenantEnvelope({
            source: {
              origin: 'scheduler',
              ip: { state: 'captured', value: '203.0.113.7' },
              access: { state: 'not-available', reason: 'no-http-request' },
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'source-mismatch' })
  })

  it('uses the staging timestamp as the deterministic future-skew admission bound', async () => {
    await expect(
      Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          'audit-boundary',
          tenantEnvelope({ occurredAt: '2026-08-23T12:05:00.000Z' }),
          '2026-08-23T12:00:00.000Z',
        ),
      ),
    ).resolves.toMatchObject({ eventId: 'audit-boundary' })
    await expect(
      Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          'audit-too-far',
          tenantEnvelope({ occurredAt: '2026-08-23T12:05:00.001Z' }),
          '2026-08-23T12:00:00.000Z',
        ),
      ),
    ).rejects.toMatchObject({ code: 'timestamp-policy' })
  })

  it('accepts only semantic IP evidence and real UTC timestamps', async () => {
    for (const value of ['203.0.113.7', '2001:db8::7', '::ffff:192.0.2.8']) {
      expect(isAuditIpAddress(value)).toBe(true)
    }
    for (const value of ['face', ':::', '999.1.1.1', '2001:db8::g']) {
      expect(isAuditIpAddress(value)).toBe(false)
    }
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(
          tenantEnvelope({
            source: { ...tenantEnvelope().source, ip: { state: 'captured', value: 'face' } },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-envelope' })
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(tenantEnvelope({ occurredAt: '2026-02-30T12:00:00.000Z' })),
      ),
    ).rejects.toMatchObject({ code: 'invalid-envelope' })
    await expect(
      Effect.runPromise(
        decodeAuditEnvelope(tenantEnvelope({ occurredAt: '2024-02-29T12:00:00.000Z' })),
      ),
    ).resolves.toMatchObject({ occurredAt: '2024-02-29T12:00:00.000Z' })
  })

  it('applies the canonical source, scalar, and structural budgets before staging', async () => {
    await expect(
      Effect.runPromise(
        canonicalAuditJson({
          detail: 'x'.repeat(AUDIT_ENVELOPE_LIMITS.maximumScalarCharacters + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'size-limit' })
    await expect(
      Effect.runPromise(
        canonicalAuditJson({
          items: Array.from({ length: AUDIT_ENVELOPE_LIMITS.maximumArrayItems + 1 }, () => 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'size-limit' })
    await expect(
      Effect.runPromise(
        canonicalAuditJson({
          one: {
            two: {
              three: {
                four: {
                  five: {
                    six: {
                      seven: { eight: { nine: { ten: { eleven: { twelve: { thirteen: 1 } } } } } },
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'size-limit' })
  })
})

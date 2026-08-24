import { Effect, Layer, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditRequestContext } from '@gridora/audit-contracts'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  IdempotencyKey,
  IsoDateTime,
  OrganizationContext,
} from '@gridora/domain'
import {
  AutomationCredentialIssuerLayer,
  AutomationIdentity,
  AutomationIdentityAuthorizationError,
  AutomationIdentityClockLayer,
  AutomationIdentityControl,
  AutomationIdentityControlLive,
  AutomationIdentityIdGeneratorLayer,
  AutomationIdentityRepositoryLayer,
  type AutomationCredentialIssue,
  type AutomationIdentityRepositoryShape,
} from '../src/index.js'

const now = Schema.decodeUnknownSync(IsoDateTime)('2026-08-23T12:00:00.000Z')
const expiresAt = Schema.decodeUnknownSync(IsoDateTime)('2026-08-24T12:00:00.000Z')
const identityId = Schema.decodeUnknownSync(AutomationIdentityId)(
  'automation_identity_aaaaaaaaaaaaaaaa',
)
const credentialId = Schema.decodeUnknownSync(AutomationCredentialId)(
  'automation_credential_aaaaaaaaaaaaaaaa',
)
const idempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)('automation-create-0001')
const fingerprint = 'a'.repeat(64)
const rawCredential =
  'grda.v1.automation_client_aaaaaaaaaaaaaaaa.automation_credential_aaaaaaaaaaaaaaaa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const auditRequestContext = {
  origin: 'http' as const,
  requestId: 'request-automation-control-test',
  correlationId: 'correlation-automation-control-test',
  source: {
    ip: { state: 'captured' as const, value: '203.0.113.10' },
    access: {
      state: 'captured' as const,
      value: {
        subject: 'owner-a',
        identityId: 'owner-a',
        issuer: 'https://access.test',
        email: null,
      },
    },
  },
}

const human = (role: 'owner' | 'administrator' | 'operator' | 'automation') =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId: 'org-a',
    organizationSlug: 'organization-a',
    identityId: `${role}-a`,
    role,
    correlationId: 'correlation-automation-control-test',
  })

const baseIdentity = Schema.decodeUnknownSync(AutomationIdentity)({
  organizationId: 'org-a',
  id: identityId,
  name: 'Release CI',
  clientId: 'automation_client_aaaaaaaaaaaaaaaa',
  scopes: ['servers.manage'],
  capabilities: ['servers.manage'],
  status: 'active',
  expiresAt,
  credentialVersion: 1,
  lastUsedAt: null,
  createdBy: 'owner-a',
  createdAt: now,
  revokedAt: null,
  revision: 1,
})

describe('automation identity control', () => {
  let replay: { readonly identity: typeof baseIdentity; readonly replayed: boolean } | null
  let createCalls: ReadonlyArray<Record<string, unknown>>
  let rotateCalls: ReadonlyArray<Record<string, unknown>>
  let issued: ReadonlyArray<{ readonly clientId: string; readonly credentialId: string }>

  const repository: AutomationIdentityRepositoryShape = {
    get: () => Effect.succeed(baseIdentity),
    findReplay: () => Effect.succeed(replay),
    create: (input) =>
      Effect.sync(() => {
        createCalls = [...createCalls, input as unknown as Record<string, unknown>]
        return { identity: baseIdentity, replayed: false }
      }),
    rotate: (input) =>
      Effect.sync(() => {
        rotateCalls = [...rotateCalls, input as unknown as Record<string, unknown>]
        return {
          identity: Schema.decodeUnknownSync(AutomationIdentity)({
            ...baseIdentity,
            expiresAt: input.expiresAt,
            credentialVersion: 2,
            revision: 2,
          }),
          replayed: false,
        }
      }),
    revoke: () => Effect.succeed({ identity: baseIdentity, replayed: false }),
    list: () => Effect.succeed([baseIdentity]),
  }

  const layer = () =>
    AutomationIdentityControlLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          AutomationIdentityRepositoryLayer(repository),
          AutomationIdentityClockLayer({ now: Effect.succeed(now) }),
          AutomationIdentityIdGeneratorLayer({
            automationIdentityId: Effect.succeed(identityId),
            credentialId: Effect.succeed(credentialId),
            clientId: Effect.succeed('automation_client_aaaaaaaaaaaaaaaa'),
            operationId: Effect.succeed('automation_identity_operation_aaaaaaaa'),
            auditEventId: Effect.succeed('audit_automation_identity_aaaaaaaa'),
            outboxEventId: Effect.succeed('outbox_automation_identity_aaaaaaaa'),
          }),
          AutomationCredentialIssuerLayer({
            issue: (input) =>
              Effect.sync(() => {
                issued = [...issued, input]
                return {
                  credential: rawCredential,
                  credentialHash: 'b'.repeat(64),
                } satisfies AutomationCredentialIssue
              }),
          }),
        ),
      ),
    )

  const run = <A, E>(
    effect: Effect.Effect<A, E, AutomationIdentityControl | AuditRequestContext>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(AuditRequestContext, auditRequestContext),
        Effect.provide(layer()),
      ),
    )

  beforeEach(() => {
    replay = null
    createCalls = []
    rotateCalls = []
    issued = []
  })

  it('lets an Owner issue a high-entropy credential once and gives the repository only a verifier', async () => {
    const result = await run(
      Effect.flatMap(AutomationIdentityControl, (control) =>
        control.create(human('owner'), {
          input: { name: 'Release CI', scopes: ['servers.manage'], expiresAt },
          idempotencyKey,
          requestFingerprint: fingerprint,
        }),
      ),
    )
    expect(result).toMatchObject({
      identity: { id: identityId },
      replayed: false,
      credential: rawCredential,
    })
    expect(issued).toEqual([{ clientId: baseIdentity.clientId, credentialId }])
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toMatchObject({ credentialHash: 'b'.repeat(64) })
    expect(JSON.stringify(createCalls)).not.toContain(rawCredential)
  })

  it('does not issue or return a credential after a response-loss replay', async () => {
    replay = { identity: baseIdentity, replayed: true }
    const result = await run(
      Effect.flatMap(AutomationIdentityControl, (control) =>
        control.create(human('administrator'), {
          input: { name: 'Release CI', scopes: ['servers.manage'], expiresAt },
          idempotencyKey,
          requestFingerprint: fingerprint,
        }),
      ),
    )
    expect(result).toEqual({ identity: baseIdentity, replayed: true })
    expect(issued).toHaveLength(0)
    expect(createCalls).toHaveLength(0)
  })

  it('uses the persisted client selector on rotate and rejects non-human management roles', async () => {
    const rotated = await run(
      Effect.flatMap(AutomationIdentityControl, (control) =>
        control.rotate(human('administrator'), {
          automationIdentityId: identityId,
          expectedRevision: 1,
          input: { expiresAt },
          idempotencyKey: 'automation-rotate-0001',
          requestFingerprint: fingerprint,
        }),
      ),
    )
    expect(rotated).toMatchObject({ replayed: false, credential: rawCredential })
    expect(issued).toEqual([{ clientId: baseIdentity.clientId, credentialId }])
    expect(rotateCalls).toHaveLength(1)

    await expect(
      run(
        Effect.flatMap(AutomationIdentityControl, (control) =>
          control.create(human('automation'), {
            input: { name: 'Denied', scopes: ['servers.manage'], expiresAt },
            idempotencyKey: 'automation-denied-0001',
            requestFingerprint: fingerprint,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AutomationIdentityAuthorizationError)
    expect(createCalls).toHaveLength(0)
  })
})

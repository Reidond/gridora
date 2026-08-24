import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import { PlatformActor } from '@gridora/platform-authority'
import { AuthorizationError } from '@gridora/contracts'
import {
  PlatformProviderAccount,
  type PlatformMutation,
  type PlatformProviderControlShape,
} from '@gridora/platform-provider-control'
import { registerPlatformProviderRoutes } from '../src/platform-provider-routes.js'

type Env = { Bindings: {} }
const runtime = makeWorkerEffectRuntime(Layer.empty)
const actor = new PlatformActor({
  identityId: 'identity-admin',
  accessSubject: 'access-admin',
  correlationId: 'correlation-test',
  administratorRevision: 1,
})
let calls = 0
const fingerprints: Array<string> = []
const acceptedOperations: Array<
  Pick<
    PlatformMutation,
    'operationId' | 'operationIdempotencyKey' | 'auditEventId' | 'requestFingerprint'
  >
> = []
let observedCredentials: Uint8Array | undefined
const account = (revision = 1) =>
  new PlatformProviderAccount({
    id: 'platform-ovh',
    scope: 'platform',
    organizationId: null,
    providerType: 'ovhcloud',
    credentialReference: 'platform-provider-platform-ovh',
    credentialRevision: revision,
    status: 'active',
    revision,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
  })
const control: PlatformProviderControlShape = {
  add: (input) => {
    calls++
    fingerprints.push(input.requestFingerprint)
    acceptedOperations.push({
      operationId: input.operationId,
      operationIdempotencyKey: input.operationIdempotencyKey,
      auditEventId: input.auditEventId,
      requestFingerprint: input.requestFingerprint,
    })
    observedCredentials = input.credentials
    expect(input.credentials.byteLength).toBeGreaterThan(0)
    return Effect.succeed(account())
  },
  validate: () => Effect.succeed(account(2)),
  disable: () => Effect.succeed(account(2)),
  rotate: () => Effect.succeed(account(2)),
  remove: () => Effect.succeed(account(2)),
  putAllocation: () => Effect.die('not used'),
}
let app: Hono<Env>
beforeEach(() => {
  calls = 0
  fingerprints.length = 0
  acceptedOperations.length = 0
  observedCredentials = undefined
  app = new Hono<Env>()
  registerPlatformProviderRoutes(app, {
    runtimeFor: () => runtime,
    authorizePlatformAdministrator: (context) =>
      context.req.header('x-admin') === 'yes'
        ? Effect.succeed(actor)
        : Effect.fail(
            new AuthorizationError({
              code: 'role_required',
              message: 'Platform Administrator is required',
            }),
          ),
    control: () => Effect.succeed(control),
  })
})
afterAll(() => runtime.dispose())
describe('platform provider routes', () => {
  it('requires the independent platform authorization boundary', async () => {
    const response = await app.request(
      'https://api.test/v1/platform/provider-accounts?id=platform-ovh',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'platform-create' },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          credentialsBase64: btoa('canary-secret'),
        }),
      },
      {},
    )
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
  })
  it('dispatches strict input without returning credentials', async () => {
    const response = await app.request(
      'https://api.test/v1/platform/provider-accounts?id=platform-ovh',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'platform-create',
          'x-admin': 'yes',
        },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          credentialsBase64: btoa('canary-secret'),
        }),
      },
      {},
    )
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain('canary-secret')
    expect(text).not.toContain(btoa('canary-secret'))
    expect(calls).toBe(1)
    expect(observedCredentials?.every((byte) => byte === 0)).toBe(true)
  })
  it('rejects excess credential fields before dispatch', async () => {
    const response = await app.request(
      'https://api.test/v1/platform/provider-accounts?id=platform-ovh',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'platform-create',
          'x-admin': 'yes',
        },
        body: JSON.stringify({
          providerType: 'ovhcloud',
          credentialsBase64: btoa('canary-secret'),
          organizationId: 'org-a',
        }),
      },
      {},
    )
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })
  it('binds credential bytes into the idempotency fingerprint', async () => {
    for (const canary of ['first-secret', 'second-secret'])
      await app.request(
        'https://api.test/v1/platform/provider-accounts?id=platform-ovh',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'same-key',
            'x-admin': 'yes',
          },
          body: JSON.stringify({
            providerType: 'ovhcloud',
            credentialsBase64: btoa(canary),
          }),
        },
        {},
      )
    expect(fingerprints).toHaveLength(2)
    expect(fingerprints[0]).not.toBe(fingerprints[1])
    expect(fingerprints.join('')).not.toContain('secret')
    expect(acceptedOperations[0]).toMatchObject({
      operationIdempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      operationId: expect.stringMatching(/^platform-operation-[a-f0-9]{40}$/),
      auditEventId: expect.stringMatching(/^platform-audit-[a-f0-9]{40}$/),
    })
    expect(acceptedOperations[0]?.operationIdempotencyKey).toBe(
      acceptedOperations[1]?.operationIdempotencyKey,
    )
    expect(acceptedOperations[0]?.operationId).not.toBe(acceptedOperations[1]?.operationId)
    expect(acceptedOperations[0]?.auditEventId).not.toBe(acceptedOperations[1]?.auditEventId)
  })
  it('derives the exact same terminal operation and audit receipt for an exact HTTP replay', async () => {
    const request = () =>
      app.request(
        'https://api.test/v1/platform/provider-accounts?id=platform-ovh',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'same-replay-key',
            'x-admin': 'yes',
          },
          body: JSON.stringify({
            providerType: 'ovhcloud',
            credentialsBase64: btoa('replay-secret'),
          }),
        },
        {},
      )
    expect((await request()).status).toBe(201)
    expect((await request()).status).toBe(201)
    expect(acceptedOperations).toHaveLength(2)
    expect(acceptedOperations[1]).toEqual(acceptedOperations[0])
    expect(JSON.stringify(acceptedOperations)).not.toContain('replay-secret')
  })
})

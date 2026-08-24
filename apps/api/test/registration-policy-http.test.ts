/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations as registeredMigrations } from '@gridora/migrations'
import { app, type ApiBindings } from '../src/index.js'

class Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: ReadonlyArray<unknown> = [],
  ) {}
  bind(...values: ReadonlyArray<unknown>): Statement {
    return new Statement(this.database, this.sql, values)
  }
  async first(): Promise<unknown> {
    return (
      this.database.prepare(this.sql).get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
    )
  }
  async all(): Promise<{ results: ReadonlyArray<unknown> }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as ReadonlyArray<SQLInputValue>)),
    }
  }
  runSync(): { success: true; meta: { changes: number } } {
    const result = this.database
      .prepare(this.sql)
      .run(...(this.values as ReadonlyArray<SQLInputValue>))
    return { success: true, meta: { changes: Number(result.changes) } }
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync()
  }
}

const b64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const json = (value: unknown): string => b64(new TextEncoder().encode(JSON.stringify(value)))

describe('registration policy HTTP boundary', () => {
  let database: DatabaseSync
  let env: ApiBindings
  let privateKey: CryptoKey
  let intent: {
    readonly intent: 'sign-in' | 'sign-up' | 'accept-invitation'
    readonly returnTo: string
    readonly invitationTokenHash?: string
    readonly displayName?: string
  }
  const assertion = async (subject: string, email: string): Promise<string> => {
    const header = json({ alg: 'RS256', typ: 'JWT', kid: 'registration-key' })
    const payload = json({
      iss: 'https://team.cloudflareaccess.com',
      aud: ['gridora-api'],
      sub: subject,
      email,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    )
    return `${header}.${payload}.${b64(new Uint8Array(signature))}`
  }
  const complete = async (subject: string, email: string) =>
    app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': await assertion(subject, email),
          'content-type': 'application/json',
          'idempotency-key': `state-${subject}`,
          'x-gridora-auth-state': `state-${subject}`,
          cookie: `__Host-gridora_auth_intent=${'a'.repeat(64)}`,
        },
        body: JSON.stringify({}),
      },
      env,
    )

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    for (const { file: name } of registeredMigrations.filter(({ id }) => id <= 38)) {
      database.exec(
        readFileSync(
          fileURLToPath(new URL(`../../../packages/migrations/sql/${name}`, import.meta.url)),
          'utf8',
        ),
      )
    }
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    privateKey = pair.privateKey
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    vi.stubGlobal('fetch', async () =>
      Response.json({ keys: [{ ...jwk, kid: 'registration-key', alg: 'RS256', use: 'sig' }] }),
    )
    intent = { intent: 'sign-up', returnTo: '/', displayName: 'New User' }
    const db = {
      prepare: (sql: string) => new Statement(database, sql),
      batch: async (statements: ReadonlyArray<Statement>) => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const results = statements.map((statement) => statement.runSync())
          database.exec('COMMIT')
          return results
        } catch (cause) {
          database.exec('ROLLBACK')
          throw cause
        }
      },
    }
    env = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'gridora-api',
      REGISTRATION_MODE: 'open',
      INVITATION_TOKEN_SECRET: 'test-invitation-secret-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => b64(new Uint8Array(32).fill(17)) },
      DB: db,
      AUTH_INTENT_STATE: {
        getByName: () => ({ consume: async () => intent }),
      },
    } as unknown as ApiBindings
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  it('allows open public sign-up and records a deduplicated platform policy decision', async () => {
    const response = await complete('new-subject', 'new@example.com')
    expect(response.status, await response.clone().text()).toBe(200)
    const firstBody = await response.json()
    const replay = await complete('new-subject', 'new@example.com')
    expect(replay.status, await replay.clone().text()).toBe(200)
    await expect(replay.json()).resolves.toEqual(firstBody)
    expect(
      database
        .prepare("SELECT count(*) AS count FROM identities WHERE access_subject = 'new-subject'")
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          'SELECT intent, mode, identity_known AS identityKnown, outcome, reason FROM registration_policy_decisions',
        )
        .get(),
    ).toEqual({
      intent: 'public-sign-up',
      mode: 'open',
      identityKnown: 0,
      outcome: 'allow-create',
      reason: 'open_registration',
    })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM platform_operations WHERE type = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM global_audit_events WHERE action = 'identity.sign-up'",
        )
        .get(),
    ).toEqual({ count: 1 })
  })

  it.each(['invitation-only', 'closed'] as const)(
    'denies unknown public sign-up in %s mode without creating an identity',
    async (mode) => {
      env.REGISTRATION_MODE = mode
      const response = await complete(`new-${mode}`, `${mode}@example.com`)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        code: 'REGISTRATION_NOT_AVAILABLE',
        detail: 'Registration is not available',
      })
      expect(database.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({
        count: 0,
      })
    },
  )

  it('denies unknown sign-in even when public registration is open', async () => {
    intent = { intent: 'sign-in', returnTo: '/' }
    const response = await complete('unknown-sign-in', 'unknown@example.com')
    expect(response.status).toBe(403)
    expect(database.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT reason FROM registration_policy_decisions').get()).toEqual({
      reason: 'unknown_sign_in',
    })
  })

  it('fails closed when the server registration mode is invalid', async () => {
    env.REGISTRATION_MODE = 'invalid-mode'
    const response = await complete('invalid-policy', 'invalid-policy@example.com')
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'REGISTRATION_POLICY_UNAVAILABLE',
      retryable: true,
    })
    expect(database.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
  })

  it('allows a valid email-bound invitation in closed mode and keeps identity creation atomic with acceptance', async () => {
    env.REGISTRATION_MODE = 'closed'
    const now = new Date().toISOString()
    const expires = new Date(Date.now() + 60_000).toISOString()
    database.exec(`
      INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner','owner-subject','owner@example.com','Owner','active','${now}','${now}');
      INSERT INTO organizations (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at)
        VALUES ('org-a','A','organization-a','active','UTC','eu','complete',1,1,'${now}');
      INSERT INTO organization_memberships (organization_id,identity_id,role,status,joined_at,revision)
        VALUES ('org-a','owner','owner','active','${now}',1);
      INSERT INTO organization_invitations
        (id,organization_id,email,role,token_hash,expires_at,inviter_id,status,created_at,revision)
        VALUES ('invite-a','org-a','invitee@example.com','operator','${'b'.repeat(64)}','${expires}','owner','pending','${now}',1);
    `)
    intent = {
      intent: 'accept-invitation',
      returnTo: '/',
      invitationTokenHash: 'b'.repeat(64),
      displayName: 'Invitee',
    }
    const response = await complete('invitee-subject', 'invitee@example.com')
    expect(response.status, await response.clone().text()).toBe(200)
    const replay = await complete('invitee-subject', 'invitee@example.com')
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM organization_memberships m JOIN identities i ON i.id = m.identity_id WHERE i.access_subject = 'invitee-subject'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database.prepare('SELECT outcome, reason FROM registration_policy_decisions').get(),
    ).toEqual({ outcome: 'allow-create', reason: 'valid_invitation' })
  })

  it('returns the same non-disclosing denial for an invalid invitation', async () => {
    env.REGISTRATION_MODE = 'closed'
    intent = {
      intent: 'accept-invitation',
      returnTo: '/',
      invitationTokenHash: 'c'.repeat(64),
      displayName: 'Unknown Invitee',
    }
    const response = await complete('invalid-invite', 'invitee@example.com')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'REGISTRATION_NOT_AVAILABLE',
      detail: 'Registration is not available',
    })
    expect(database.prepare('SELECT count(*) AS count FROM identities').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT reason FROM registration_policy_decisions').get()).toEqual({
      reason: 'invalid_invitation',
    })
  })

  it.each([
    {
      email: 'someone-else@example.com',
      expiresOffset: 60_000,
      reason: 'invitation_binding_mismatch',
    },
    { email: 'invitee@example.com', expiresOffset: -60_000, reason: 'expired_invitation' },
  ])(
    'denies a non-valid invitation binding without creating the invitee identity',
    async ({ email, expiresOffset, reason }) => {
      env.REGISTRATION_MODE = 'closed'
      const now = new Date().toISOString()
      const expires = new Date(Date.now() + expiresOffset).toISOString()
      database.exec(`
      INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
        VALUES ('owner','owner-subject','owner@example.com','Owner','active','${now}','${now}');
      INSERT INTO organizations (id,name,slug,status,timezone,default_region,onboarding_step,policy_revision,revision,created_at)
        VALUES ('org-a','A','organization-a','active','UTC','eu','complete',1,1,'${now}');
      INSERT INTO organization_memberships (organization_id,identity_id,role,status,joined_at,revision)
        VALUES ('org-a','owner','owner','active','${now}',1);
      INSERT INTO organization_invitations
        (id,organization_id,email,role,token_hash,expires_at,inviter_id,status,created_at,revision)
        VALUES ('invite-a','org-a','${email}','operator','${'d'.repeat(64)}','${expires}','owner','pending','${now}',1);
    `)
      intent = {
        intent: 'accept-invitation',
        returnTo: '/',
        invitationTokenHash: 'd'.repeat(64),
        displayName: 'Invitee',
      }
      const response = await complete('invitee-subject', 'invitee@example.com')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        code: 'REGISTRATION_NOT_AVAILABLE',
        detail: 'Registration is not available',
      })
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM identities WHERE access_subject = 'invitee-subject'",
          )
          .get(),
      ).toEqual({ count: 0 })
      expect(database.prepare('SELECT reason FROM registration_policy_decisions').get()).toEqual({
        reason,
      })
    },
  )
})

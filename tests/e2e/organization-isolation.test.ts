/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditEnvelopeStageBindings,
  auditEnvelopeStageSql,
  stageAuditEnvelope,
} from '../../packages/audit-contracts/src/index.js'
import { app, type ApiBindings } from '../../apps/api/src/index.js'

class D1StatementAdapter {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: ReadonlyArray<unknown> = [],
  ) {}

  bind(...values: ReadonlyArray<unknown>): D1StatementAdapter {
    return new D1StatementAdapter(this.database, this.sql, values)
  }

  async first(): Promise<unknown> {
    return this.database.prepare(this.sql).get(...this.sqlValues()) ?? null
  }

  async all(): Promise<{ readonly results: ReadonlyArray<unknown> }> {
    return { results: this.database.prepare(this.sql).all(...this.sqlValues()) }
  }

  async run(): Promise<{ readonly success: true; readonly meta: { readonly changes: number } }> {
    return this.runSync()
  }

  runSync(): { readonly success: true; readonly meta: { readonly changes: number } } {
    const result = this.database.prepare(this.sql).run(...this.sqlValues())
    return { success: true, meta: { changes: Number(result.changes) } }
  }

  private sqlValues(): ReadonlyArray<SQLInputValue> {
    return this.values as ReadonlyArray<SQLInputValue>
  }
}

class AuthenticationIntentFixture {
  private readonly intents = new Map<
    string,
    { readonly intent: string; readonly returnTo: string; readonly invitationTokenHash: string }
  >()

  add(state: string, invitationTokenHash: string): void {
    this.intents.set(state, {
      intent: 'accept-invitation',
      returnTo: '/invitations/accept',
      invitationTokenHash,
    })
  }

  readonly namespace = {
    getByName: (state: string) => ({
      consume: async () => {
        const intent = this.intents.get(state) ?? null
        this.intents.delete(state)
        return intent
      },
    }),
  }
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const jsonPart = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)))

const timestamp = '2026-08-23T12:00:00.000Z'
const cookieVerifier = 'v'.repeat(64)

describe('multi-organization HTTP and D1 acceptance', () => {
  let database: DatabaseSync
  let env: ApiBindings
  let ownerAssertion: string
  let signAssertion: (subject: string, email: string) => Promise<string>
  let authenticationIntents: AuthenticationIntentFixture

  beforeEach(async () => {
    database = new DatabaseSync(':memory:')
    const migrationsDirectory = fileURLToPath(
      new URL('../../packages/migrations/sql/', import.meta.url),
    )
    for (const migration of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      database.exec(readFileSync(`${migrationsDirectory}/${migration}`, 'utf8'))
    }

    database.exec(`
      INSERT INTO identities (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES
        ('identity-owner', 'subject-owner', 'owner@example.test', 'Shared Owner', 'active', '${timestamp}', '${timestamp}'),
        ('identity-member', 'subject-member', 'member@example.test', 'Alpha Member', 'active', '${timestamp}', '${timestamp}');

      INSERT INTO organizations
        (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
      VALUES
        ('org-alpha', 'Alpha', 'alpha', 'active', 'UTC', 'eu-alpha', 'complete', 1, 1, '${timestamp}'),
        ('org-beta', 'Beta', 'beta', 'active', 'UTC', 'us-beta', 'complete', 1, 1, '${timestamp}');

      INSERT INTO organization_memberships
        (organization_id, identity_id, role, status, joined_at, invited_by, revision)
      VALUES
        ('org-alpha', 'identity-owner', 'owner', 'active', '${timestamp}', NULL, 1),
        ('org-beta', 'identity-owner', 'owner', 'active', '${timestamp}', NULL, 1),
        ('org-alpha', 'identity-member', 'operator', 'active', '${timestamp}', 'identity-owner', 1);

      INSERT INTO provider_accounts
        (id, scope, organization_id, provider_type, credential_reference, status, revision, created_at, updated_at)
      VALUES
        ('account-alpha', 'organization', 'org-alpha', 'ovhcloud', 'secret-alpha', 'active', 1, '${timestamp}', '${timestamp}'),
        ('account-beta', 'organization', 'org-beta', 'contabo', 'secret-beta', 'active', 1, '${timestamp}', '${timestamp}');

      INSERT INTO provider_allocations
        (organization_id, provider_account_id, allowed_regions_json, allowed_plans_json, max_active_nodes, status, revision)
      VALUES
        ('org-alpha', 'account-alpha', '["eu-alpha"]', '["alpha-plan"]', 3, 'active', 1),
        ('org-beta', 'account-beta', '["us-beta"]', '["beta-plan"]', 4, 'active', 1);

      INSERT INTO node_images
        (id, version, checksum, signature, provider_mappings_json, status, created_at, promoted_at)
      VALUES ('image-stable', '1.0.0', 'sha256-image', 'signature-image', '{}', 'promoted', '${timestamp}', '${timestamp}');

      INSERT INTO nodes
        (organization_id, id, provider_account_id, provider_instance_id, provider_type, region, plan, image_id,
         placement_mode, desired_state, observed_state, desired_revision, observed_revision, created_at, updated_at)
      VALUES
        ('org-alpha', 'node-shared', 'account-alpha', 'provider-alpha-shared', 'ovhcloud', 'eu-alpha', 'alpha-plan',
         'image-stable', 'shared', 'ready', 'ready', 1, 1, '${timestamp}', '${timestamp}'),
        ('org-beta', 'node-shared', 'account-beta', 'provider-beta-shared', 'contabo', 'us-beta', 'beta-plan',
         'image-stable', 'dedicated', 'ready', 'ready', 1, 1, '${timestamp}', '${timestamp}'),
        ('org-beta', 'node-beta-only', 'account-beta', 'provider-beta-only', 'contabo', 'us-beta', 'beta-plan',
         'image-stable', 'shared', 'ready', 'ready', 1, 1, '${timestamp}', '${timestamp}');

      INSERT INTO game_plugins
        (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('arma-reforger', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1);

      INSERT INTO game_servers
        (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
         placement_policy_json, domain, desired_revision, observed_revision, active_config_revision, created_at, updated_at)
      VALUES
        ('org-alpha', 'server-shared', 'Alpha Server', 'arma-reforger', '1.0.0', 'running', 'running',
         '{"region":"eu-alpha"}', 'alpha.example.test', 1, 1, 1, '${timestamp}', '${timestamp}'),
        ('org-beta', 'server-shared', 'Beta Server', 'arma-reforger', '1.0.0', 'stopped', 'stopped',
         '{"region":"us-beta"}', 'beta.example.test', 1, 1, 1, '${timestamp}', '${timestamp}');

      INSERT INTO operations
        (id, organization_id, type, resource_type, resource_id, actor_id, status, progress,
         idempotency_key, correlation_id, revision, created_at, updated_at)
      VALUES
        ('operation-audit-alpha', 'org-alpha', 'fixture.alpha', 'game_server', 'server-shared', 'identity-owner',
         'succeeded', 100, 'fixture-audit-alpha', 'correlation-alpha', 1, '${timestamp}', '${timestamp}'),
        ('operation-audit-beta', 'org-beta', 'fixture.beta', 'game_server', 'server-shared', 'identity-owner',
         'succeeded', 100, 'fixture-audit-beta', 'correlation-beta', 1, '${timestamp}', '${timestamp}');

      INSERT INTO organization_invitations
        (id, organization_id, email, role, token_hash, expires_at, inviter_id, status, created_at, revision)
      VALUES
        ('invitation-accept', 'org-alpha', 'invitee@example.test', 'viewer', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         '2099-01-01T00:00:00.000Z', 'identity-owner', 'pending', '${timestamp}', 1),
        ('invitation-mismatch', 'org-beta', 'expected@example.test', 'operator', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         '2099-01-01T00:00:00.000Z', 'identity-owner', 'pending', '${timestamp}', 1);
    `)

    const seedCompleteAudit = async (
      id: string,
      organizationId: string,
      action: string,
      correlationId: string,
      operationId: string,
      tenant: string,
    ): Promise<void> => {
      const stage = await Effect.runPromise(
        stageAuditEnvelope(
          'tenant',
          id,
          {
            version: 1,
            captureStatus: 'complete',
            occurredAt: timestamp,
            scope: 'tenant',
            organizationId,
            actor: { type: 'human', id: 'identity-owner' },
            request: { id: `request-${tenant}`, correlationId },
            action,
            target: { type: 'game_server', id: 'server-shared' },
            before: { state: 'absent', reason: 'fixture-state-before' },
            after: { state: 'captured', summary: { tenant } },
            operationId,
            source: {
              origin: 'http',
              ip: { state: 'captured', value: '203.0.113.17' },
              access: {
                state: 'captured',
                value: {
                  subject: 'subject-owner',
                  identityId: 'identity-owner',
                  issuer: 'https://gridora-e2e.cloudflareaccess.com',
                  email: 'owner@example.test',
                },
              },
            },
            result: 'succeeded',
            error: { classification: 'none', code: null },
            forced: false,
            breakGlass: false,
          },
          timestamp,
        ),
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(auditEnvelopeStageSql).run(...auditEnvelopeStageBindings(stage))
        database
          .prepare(`INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id, result,
             correlation_id, summary_json, created_at)
            VALUES (?, ?, 'identity-owner', ?, 'game_server', 'server-shared', 'succeeded', ?, ?, ?)`)
          .run(id, organizationId, action, correlationId, JSON.stringify({ tenant }), timestamp)
        database.exec('COMMIT')
      } catch (cause) {
        database.exec('ROLLBACK')
        throw cause
      }
    }
    await seedCompleteAudit(
      'audit-alpha',
      'org-alpha',
      'fixture.alpha',
      'correlation-alpha',
      'operation-audit-alpha',
      'alpha',
    )
    await seedCompleteAudit(
      'audit-beta',
      'org-beta',
      'fixture.beta',
      'correlation-beta',
      'operation-audit-beta',
      'beta',
    )

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    vi.stubGlobal('fetch', async () =>
      Response.json({
        keys: [{ ...publicJwk, kid: 'e2e-key', alg: 'RS256', use: 'sig' }],
      }),
    )
    const issuer = 'https://gridora-e2e.cloudflareaccess.com'
    signAssertion = async (subject, email) => {
      const header = jsonPart({ alg: 'RS256', typ: 'JWT', kid: 'e2e-key' })
      const payload = jsonPart({
        iss: issuer,
        aud: ['gridora-e2e-api'],
        sub: subject,
        email,
        exp: Math.floor(Date.now() / 1_000) + 300,
      })
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      )
      return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
    }
    ownerAssertion = await signAssertion('subject-owner', 'owner@example.test')

    const d1 = {
      prepare: (sql: string) => new D1StatementAdapter(database, sql),
      batch: async (statements: ReadonlyArray<D1StatementAdapter>) => {
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
    authenticationIntents = new AuthenticationIntentFixture()
    env = {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: 'gridora-e2e-api',
      REGISTRATION_MODE: 'invitation-only',
      INVITATION_TOKEN_SECRET: 'e2e-invitation-secret-with-at-least-32-bytes',
      INVITATION_TOKEN_KEY_VERSION: 'v1',
      PROVIDER_KEK_ACTIVE_VERSION: '1',
      PROVIDER_KEK_V1: { get: async () => base64Url(new Uint8Array(32).fill(17)) },
      DB: d1,
      AUTH_INTENT_STATE: authenticationIntents.namespace,
      NOTIFICATION_REMEDIATION: {
        get: async () => null,
        list: async () => ({ objects: [], truncated: false }),
      },
    } as unknown as ApiBindings
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    database.close()
  })

  const authorizedHeaders = (): Record<string, string> => ({
    'cf-access-jwt-assertion': ownerAssertion,
  })

  it('bootstraps one identity into two selectable organization contexts', async () => {
    const bootstrap = await app.request(
      'http://api.gridora.test/v1/auth/bootstrap',
      { headers: authorizedHeaders() },
      env,
    )
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(200)
    await expect(bootstrap.json()).resolves.toMatchObject({
      authenticated: true,
      identityId: 'identity-owner',
      next: 'dashboard',
      organizations: [
        { organization: { id: 'org-alpha', slug: 'alpha' }, role: 'owner' },
        { organization: { id: 'org-beta', slug: 'beta' }, role: 'owner' },
      ],
    })

    for (const [slug, id, region] of [
      ['alpha', 'org-alpha', 'eu-alpha'],
      ['beta', 'org-beta', 'us-beta'],
    ] as const) {
      const selected = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}`,
        { headers: authorizedHeaders() },
        env,
      )
      expect(selected.status, await selected.clone().text()).toBe(200)
      await expect(selected.json()).resolves.toMatchObject({ id, slug, defaultRegion: region })
    }
  })

  it('audits organization switching, adopts response loss, and denies a cross-tenant switch', async () => {
    const memberAssertion = await signAssertion('subject-member', 'member@example.test')
    const requestSwitch = (organization: string, key: string) =>
      app.request(
        `http://api.gridora.test/v1/organizations/${organization}/actions/switch`,
        {
          method: 'POST',
          headers: {
            'cf-access-jwt-assertion': memberAssertion,
            'idempotency-key': key,
          },
        },
        env,
      )
    const first = await requestSwitch('alpha', 'member-switch-alpha')
    expect(first.status, await first.clone().text()).toBe(200)
    const completed = (await first.json()) as { operationId: string }
    const replay = await requestSwitch('alpha', 'member-switch-alpha')
    expect(replay.status, await replay.clone().text()).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      operationId: completed.operationId,
      resourceId: 'org-alpha',
      status: 'succeeded',
    })
    const denied = await requestSwitch('beta', 'member-switch-beta')
    expect(denied.status).toBe(403)
    expect(
      database
        .prepare(
          "SELECT last_organization_id AS organizationId, revision FROM identity_preferences WHERE identity_id = 'identity-member'",
        )
        .get(),
    ).toEqual({ organizationId: 'org-alpha', revision: 1 })
    expect(
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM operations WHERE type = 'identity.organization.switch' AND actor_id = 'identity-member') AS operations, (SELECT COUNT(*) FROM audit_events WHERE action = 'identity.organization.switch' AND actor_id = 'identity-member') AS audits, (SELECT COUNT(*) FROM outbox WHERE event_type = 'identity.organization.switched' AND aggregate_id = 'identity-member') AS outbox",
        )
        .get(),
    ).toEqual({ operations: 1, audits: 1, outbox: 1 })
  })

  it('reports the current Access-owned session without local session or token state', async () => {
    const response = await app.request(
      'http://api.gridora.test/v1/me/session',
      { headers: authorizedHeaders() },
      env,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      provider: 'cloudflare-access',
      identity: { id: 'identity-owner', email: 'owner@example.test' },
      subject: 'subject-owner',
      management: {
        authority: 'cloudflare-access',
        localSessionStorage: false,
        canEnumerateOtherSessions: false,
        signOutPath: '/cdn-cgi/access/logout',
      },
    })
  })

  it('isolates same resource IDs and rejects client-selected provider fields without effects', async () => {
    for (const [slug, organizationId, region, serverName, auditAction] of [
      ['alpha', 'org-alpha', 'eu-alpha', 'Alpha Server', 'fixture.alpha'],
      ['beta', 'org-beta', 'us-beta', 'Beta Server', 'fixture.beta'],
    ] as const) {
      const node = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/nodes/node-shared`,
        { headers: authorizedHeaders() },
        env,
      )
      expect(node.status, await node.clone().text()).toBe(200)
      await expect(node.json()).resolves.toMatchObject({
        id: 'node-shared',
        organizationId,
        region,
      })

      const server = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/game-servers/server-shared`,
        { headers: authorizedHeaders() },
        env,
      )
      expect(server.status, await server.clone().text()).toBe(200)
      await expect(server.json()).resolves.toMatchObject({
        id: 'server-shared',
        organizationId,
        name: serverName,
      })

      const audits = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/audit-events`,
        { headers: authorizedHeaders() },
        env,
      )
      expect(audits.status, await audits.clone().text()).toBe(200)
      const auditBody = (await audits.json()) as {
        readonly items: ReadonlyArray<{ readonly action: string; readonly organizationId: string }>
      }
      expect(auditBody.items).toEqual([
        expect.objectContaining({ action: auditAction, organizationId }),
      ])
    }

    const foreignOnly = await app.request(
      'http://api.gridora.test/v1/organizations/alpha/nodes/node-beta-only',
      { headers: authorizedHeaders() },
      env,
    )
    expect(foreignOnly.status).toBe(404)
    await expect(foreignOnly.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })

    for (const slug of ['alpha', 'beta']) {
      const mutation = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/nodes`,
        {
          method: 'POST',
          headers: {
            ...authorizedHeaders(),
            'content-type': 'application/json',
            'idempotency-key': `legacy-client-selected-${slug}`,
          },
          body: JSON.stringify({ providerAccountId: `account-${slug}`, region: `${slug}-region` }),
        },
        env,
      )
      expect(mutation.status).toBe(400)
      await expect(mutation.json()).resolves.toMatchObject({
        code: 'REQUEST_VALIDATION_FAILED',
        retryable: false,
      })
    }
    // The fixture itself has two durable operations because its audited seed
    // facts must now meet the v1 exact-operation fence.
    expect(database.prepare('SELECT count(*) AS count FROM operations').get()).toEqual({ count: 2 })
    expect(
      database
        .prepare("SELECT count(*) AS count FROM outbox WHERE event_type = 'operation.queued'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('accepts an invitation once and rejects replay and email mismatch without side effects', async () => {
    authenticationIntents.add('state-accept', 'a'.repeat(64))
    const inviteeAssertion = await signAssertion('subject-invitee', 'invitee@example.test')
    const accept = await app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': inviteeAssertion,
          'content-type': 'application/json',
          'x-gridora-auth-state': 'state-accept',
          'idempotency-key': 'state-accept-invitation',
          cookie: `__Host-gridora_auth_intent=${cookieVerifier}`,
        },
        body: '{}',
      },
      env,
    )
    expect(
      accept.status,
      `${await accept.clone().text()} ${JSON.stringify(
        database
          .prepare("SELECT * FROM registration_policy_decisions WHERE decision_id = 'state-accept'")
          .get(),
      )}`,
    ).toBe(200)
    await expect(accept.json()).resolves.toMatchObject({
      intent: 'accept-invitation',
      next: 'dashboard',
      membership: { organizationId: 'org-alpha', role: 'viewer', status: 'active' },
    })

    authenticationIntents.add('state-replay', 'a'.repeat(64))
    const replay = await app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': inviteeAssertion,
          'content-type': 'application/json',
          'x-gridora-auth-state': 'state-replay',
          'idempotency-key': 'state-replay-invitation',
          cookie: `__Host-gridora_auth_intent=${cookieVerifier}`,
        },
        body: '{}',
      },
      env,
    )
    expect(replay.status).toBe(403)
    await expect(replay.json()).resolves.toMatchObject({ code: 'REGISTRATION_NOT_AVAILABLE' })

    authenticationIntents.add('state-mismatch', 'b'.repeat(64))
    const mismatchAssertion = await signAssertion('subject-wrong-email', 'wrong@example.test')
    const mismatch = await app.request(
      'http://api.gridora.test/v1/auth/complete',
      {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': mismatchAssertion,
          'content-type': 'application/json',
          'x-gridora-auth-state': 'state-mismatch',
          'idempotency-key': 'state-mismatch-invitation',
          cookie: `__Host-gridora_auth_intent=${cookieVerifier}`,
        },
        body: '{}',
      },
      env,
    )
    expect(mismatch.status).toBe(403)
    await expect(mismatch.json()).resolves.toMatchObject({ code: 'REGISTRATION_NOT_AVAILABLE' })

    expect(
      database
        .prepare(`SELECT status, accepted_by AS acceptedBy, revision
      FROM organization_invitations WHERE id = 'invitation-accept'`)
        .get(),
    ).toMatchObject({
      status: 'accepted',
      revision: 2,
    })
    expect(
      database
        .prepare(`SELECT status, accepted_by AS acceptedBy, revision
      FROM organization_invitations WHERE id = 'invitation-mismatch'`)
        .get(),
    ).toEqual({
      status: 'pending',
      acceptedBy: null,
      revision: 1,
    })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM identities
      WHERE access_subject IN ('subject-invitee', 'subject-wrong-email')`)
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM outbox
      WHERE event_type = 'organization.invitation.accepted' AND aggregate_id = 'invitation-accept'`)
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events
      WHERE action = 'organization.invitation.accept' AND target_id = 'invitation-accept'`)
        .get(),
    ).toEqual({ count: 1 })
  })

  it('protects the final Owner from demotion and removal in each organization', async () => {
    for (const slug of ['alpha', 'beta']) {
      const demote = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/members/identity-owner`,
        {
          method: 'PATCH',
          headers: {
            ...authorizedHeaders(),
            'content-type': 'application/json',
            'idempotency-key': `demote-final-owner-${slug}`,
          },
          body: JSON.stringify({
            identityId: 'identity-owner',
            role: 'administrator',
            expectedRevision: 1,
          }),
        },
        env,
      )
      expect(demote.status).toBe(409)
      await expect(demote.json()).resolves.toMatchObject({ code: 'CONFLICT' })

      const remove = await app.request(
        `http://api.gridora.test/v1/organizations/${slug}/members/identity-owner`,
        {
          method: 'DELETE',
          headers: {
            ...authorizedHeaders(),
            'content-type': 'application/json',
            'idempotency-key': `remove-final-owner-${slug}`,
          },
          body: JSON.stringify({ expectedRevision: 1 }),
        },
        env,
      )
      expect(remove.status).toBe(409)
      await expect(remove.json()).resolves.toMatchObject({ code: 'CONFLICT' })
    }

    expect(
      database
        .prepare(`SELECT organization_id AS organizationId, role, status, revision
      FROM organization_memberships WHERE identity_id = 'identity-owner' ORDER BY organization_id`)
        .all(),
    ).toEqual([
      { organizationId: 'org-alpha', role: 'owner', status: 'active', revision: 1 },
      { organizationId: 'org-beta', role: 'owner', status: 'active', revision: 1 },
    ])
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM outbox
      WHERE event_type IN ('organization.membership.updated', 'organization.membership.revoked')`)
        .get(),
    ).toEqual({ count: 0 })
  })

  it('transfers ownership atomically and protects the new final Owner', async () => {
    const transfer = await app.request(
      'http://api.gridora.test/v1/organizations/alpha/actions/transfer-ownership',
      {
        method: 'POST',
        headers: {
          ...authorizedHeaders(),
          'content-type': 'application/json',
          'idempotency-key': 'transfer-ownership-alpha',
        },
        body: JSON.stringify({ targetIdentityId: 'identity-member' }),
      },
      env,
    )
    expect(transfer.status, await transfer.clone().text()).toBe(200)
    expect(
      database
        .prepare(`SELECT identity_id AS identityId, role, revision
      FROM organization_memberships
      WHERE organization_id = 'org-alpha' AND role <> 'automation'
      ORDER BY identity_id`)
        .all(),
    ).toEqual([
      { identityId: 'identity-member', role: 'owner', revision: 2 },
      { identityId: 'identity-owner', role: 'administrator', revision: 2 },
    ])
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM outbox
      WHERE organization_id = 'org-alpha' AND event_type = 'organization.ownership.transferred'`)
        .get(),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare(`SELECT count(*) AS count FROM audit_events
      WHERE organization_id = 'org-alpha' AND action = 'organization.ownership.transfer'`)
        .get(),
    ).toEqual({ count: 1 })

    const newOwnerAssertion = await signAssertion('subject-member', 'member@example.test')
    const newOwnerHeaders = {
      'cf-access-jwt-assertion': newOwnerAssertion,
      'content-type': 'application/json',
    }
    const demote = await app.request(
      'http://api.gridora.test/v1/organizations/alpha/members/identity-member',
      {
        method: 'PATCH',
        headers: { ...newOwnerHeaders, 'idempotency-key': 'demote-new-final-owner' },
        body: JSON.stringify({
          identityId: 'identity-member',
          role: 'administrator',
          expectedRevision: 2,
        }),
      },
      env,
    )
    expect(demote.status).toBe(409)
    await expect(demote.json()).resolves.toMatchObject({ code: 'CONFLICT' })

    const remove = await app.request(
      'http://api.gridora.test/v1/organizations/alpha/members/identity-member',
      {
        method: 'DELETE',
        headers: { ...newOwnerHeaders, 'idempotency-key': 'remove-new-final-owner' },
        body: JSON.stringify({ expectedRevision: 2 }),
      },
      env,
    )
    expect(remove.status).toBe(409)
    await expect(remove.json()).resolves.toMatchObject({ code: 'CONFLICT' })
    expect(
      database
        .prepare(`SELECT role, status, revision FROM organization_memberships
      WHERE organization_id = 'org-alpha' AND identity_id = 'identity-member'`)
        .get(),
    ).toEqual({
      role: 'owner',
      status: 'active',
      revision: 2,
    })
  })
})

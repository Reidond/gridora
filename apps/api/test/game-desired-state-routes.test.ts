import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorizationError } from '@gridora/contracts'
import { OrganizationContext, roleRank, type OrganizationRole } from '@gridora/domain'
import {
  GameDesiredStateControl,
  GameDesiredStateControlLive,
  GameDesiredStateRepository,
  makeGameDesiredStateRepositoryD1,
  type GameDesiredStateD1Database,
  type GameDesiredStateD1Statement,
} from '@gridora/game-desired-state-control'
import { makeWorkerEffectRuntime } from '@gridora/http-hono-effect'
import {
  registerGameDesiredStateRoutes,
  type GameDesiredStateRouteMinimumRole,
} from '../src/game-desired-state-routes.js'

const sqlDirectory = fileURLToPath(new URL('../../../packages/migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
] as const
const now = '2026-08-23T17:30:00.000Z'

class SqliteStatement implements GameDesiredStateD1Statement {
  private values: ReadonlyArray<unknown> = []
  constructor(private readonly statement: StatementSync) {}
  bind(...values: ReadonlyArray<unknown>): GameDesiredStateD1Statement {
    this.values = values
    return this
  }
  async first(): Promise<unknown> {
    return this.statement.get(...(this.values as ReadonlyArray<SQLInputValue>)) ?? null
  }
}
class SqliteD1 implements GameDesiredStateD1Database {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): GameDesiredStateD1Statement {
    return new SqliteStatement(this.database.prepare(sql))
  }
}

type TestEnv = { Bindings: { DB: SqliteD1 } }
let database: DatabaseSync
let d1: SqliteD1
let app: Hono<TestEnv>
let runtime: ReturnType<typeof makeWorkerEffectRuntime<GameDesiredStateControl>>

const seed = () => {
  for (const [organizationId, slug, identityId, role] of [
    ['org-a', 'organization-a', 'operator-a', 'operator'],
    ['org-a', 'organization-a', 'viewer-a', 'viewer'],
    ['org-b', 'organization-b', 'operator-b', 'operator'],
  ] as const) {
    database
      .prepare(
        `INSERT OR IGNORE INTO identities
         (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(identityId, `access-${identityId}`, `${identityId}@example.test`, identityId, now, now)
    database
      .prepare(
        `INSERT OR IGNORE INTO organizations
         (id, name, slug, status, timezone, default_region, onboarding_step,
          policy_revision, revision, created_at)
         VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`,
      )
      .run(organizationId, organizationId, slug, now)
    database
      .prepare(
        `INSERT INTO organization_memberships
         (organization_id, identity_id, role, status, joined_at, revision)
         VALUES (?, ?, ?, 'active', ?, 1)`,
      )
      .run(organizationId, identityId, role, now)
  }
  database
    .prepare(
      `INSERT INTO game_plugins
       (id, version, api_version, status, capability_manifest_json, config_schema_version)
       VALUES ('arma-reforger', '0.1.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, desired_revision, observed_revision, active_config_revision,
        created_at, updated_at)
       VALUES ('org-a', 'server-a', 'Server A', 'arma-reforger', '0.1.0', 'stopped',
        'stopped', '{}', 1, 0, 1, ?, ?)`,
    )
    .run(now, now)
  database
    .prepare(
      `INSERT INTO game_server_config_revisions
       (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
       VALUES ('org-a', 'server-a', 1, 1, ?, 'operator-a', ?)`,
    )
    .run(
      JSON.stringify({
        name: 'Server A',
        scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
        maxPlayers: 32,
        passwordSecretRef: 'http-secret-canary',
        visible: true,
        crossPlatform: true,
      }),
      now,
    )
  database
    .prepare(
      `INSERT INTO mod_sets
       (organization_id, server_id, schema_version, desired_revision, resolved_revision,
        desired_json, resolved_json, revision)
       VALUES ('org-a', 'server-a', 1, 2, 1, ?, ?, 2)`,
    )
    .run(
      JSON.stringify([
        {
          source: 'reforger.armaplatform.com',
          id: '5A54BB9103829754',
          loadOrder: 1,
        },
      ]),
      JSON.stringify([
        {
          source: 'reforger.armaplatform.com',
          id: '5A54BB9103829754',
          version: '1.0.0',
          loadOrder: 1,
        },
      ]),
    )
}

const authorize = (context: HonoContext<TestEnv>, minimumRole: GameDesiredStateRouteMinimumRole) =>
  Effect.gen(function* () {
    const identityId = context.req.header('x-test-identity') ?? ''
    const organization = context.req.param('organization') ?? ''
    const membership = database
      .prepare(
        `SELECT organization.id AS organizationId, organization.slug AS organizationSlug,
         membership.role AS role
         FROM organizations AS organization
         JOIN organization_memberships AS membership
           ON membership.organization_id = organization.id
         WHERE (organization.id = ? OR organization.slug = ?)
           AND membership.identity_id = ?
           AND organization.status = 'active' AND membership.status = 'active'`,
      )
      .get(organization, organization, identityId) as
      | { organizationId: string; organizationSlug: string; role: OrganizationRole }
      | undefined
    if (membership === undefined || roleRank[membership.role] < roleRank[minimumRole])
      return yield* new AuthorizationError({
        code: 'role_required',
        message: `${minimumRole} role is required`,
      })
    return Schema.decodeUnknownSync(OrganizationContext)({
      ...membership,
      identityId,
      correlationId: 'desired-state-http-test',
    })
  })

const request = (path: string, identityId: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-test-identity', identityId)
  return app.request(`https://api.gridora.test${path}`, { ...init, headers }, { DB: d1 })
}

describe('game desired-state routes', () => {
  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of migrations)
      database.exec(readFileSync(`${sqlDirectory}${migration}`, 'utf8'))
    seed()
    d1 = new SqliteD1(database)
    const repository = makeGameDesiredStateRepositoryD1(d1)
    runtime = makeWorkerEffectRuntime(
      GameDesiredStateControlLive.pipe(
        Layer.provide(Layer.succeed(GameDesiredStateRepository, repository)),
      ),
    )
    app = new Hono<TestEnv>()
    registerGameDesiredStateRoutes(app, {
      runtimeFor: () => runtime,
      authorize,
      control: () => GameDesiredStateControl,
    })
  })
  afterEach(() => database.close())
  afterAll(() => runtime?.dispose())

  it('allows a Viewer to read a redacted tenant configuration without writes', async () => {
    const before = database.prepare('SELECT total_changes() AS count').get()
    const response = await request(
      '/v1/organizations/organization-a/game-servers/server-a/config',
      'viewer-a',
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('http-secret-canary')
    expect(text).toContain('[redacted]')
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(before)
  })

  it('allows a Viewer to read tenant-scoped desired and resolved mods', async () => {
    const response = await request(
      '/v1/organizations/organization-a/game-servers/server-a/mods',
      'viewer-a',
    )
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      organizationId: 'org-a',
      serverId: 'server-a',
      desiredRevision: 2,
      resolvedRevision: 1,
      state: 'pending',
      desiredMods: [{ source: 'reforger.armaplatform.com', id: '5A54BB9103829754', loadOrder: 1 }],
      resolvedMods: [
        {
          source: 'reforger.armaplatform.com',
          id: '5A54BB9103829754',
          version: '1.0.0',
          loadOrder: 1,
        },
      ],
      readOnly: true,
    })
  })

  it('requires an Operator for plans and does not cross tenant boundaries', async () => {
    const planPath = '/v1/organizations/organization-a/game-servers/server-a/mods/plan'
    const body = JSON.stringify({
      schemaVersion: 1,
      expectedConfigRevision: 1,
      expectedModRevision: 0,
      desiredMods: [],
    })
    expect((await request(planPath, 'viewer-a', { method: 'POST', body })).status).toBe(403)
    expect((await request(planPath, 'operator-b', { method: 'POST', body })).status).toBe(403)
  })

  it('rejects excess client plugin selection at the HTTP boundary', async () => {
    const response = await request(
      '/v1/organizations/organization-a/game-servers/server-a/mods/plan',
      'operator-a',
      {
        method: 'POST',
        body: JSON.stringify({
          schemaVersion: 1,
          expectedConfigRevision: 1,
          expectedModRevision: 0,
          desiredMods: [],
          pluginVersion: 'client-choice',
        }),
      },
    )
    expect(response.status).toBe(400)
  })
})

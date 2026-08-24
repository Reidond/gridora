import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesiredStateCapabilityError,
  DesiredStateNotFoundError,
  DesiredStatePluginUnavailableError,
  DesiredStateRevisionConflictError,
  DesiredStateValidationError,
  GameConfigPreviewResponse,
  GameDesiredStateRepository,
  GameModsPlanResponse,
  makeGameDesiredStateControl,
  makeGameDesiredStateRepositoryD1,
  type GameDesiredStateControlShape,
  type GameDesiredStateD1Database,
  type GameDesiredStateD1Statement,
} from '../src/index.js'

const migrationDirectory = fileURLToPath(new URL('../../migrations/sql/', import.meta.url))
const migrations = [
  '0001_identity_organizations.sql',
  '0002_operations_outbox.sql',
  '0003_mvp_inventory.sql',
] as const
const now = '2026-08-23T17:00:00.000Z'

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

let database: DatabaseSync
let control: GameDesiredStateControlShape

const changes = () =>
  (database.prepare('SELECT total_changes() AS count').get() as { count: number }).count

const seedOrganization = (organizationId: string) => {
  const identityId = `identity-${organizationId}`
  database
    .prepare(
      `INSERT INTO identities
       (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      identityId,
      `access-${organizationId}`,
      `${organizationId}@example.test`,
      organizationId,
      now,
      now,
    )
  database
    .prepare(
      `INSERT INTO organizations
       (id, name, slug, status, timezone, default_region, onboarding_step, policy_revision, revision, created_at)
       VALUES (?, ?, ?, 'active', 'UTC', 'eu-west', 'complete', 1, 1, ?)`,
    )
    .run(organizationId, organizationId, organizationId, now)
  return identityId
}

const ensurePlugin = (pluginId: string, version = '0.1.0') => {
  database
    .prepare(
      `INSERT OR IGNORE INTO game_plugins
       (id, version, api_version, status, capability_manifest_json, config_schema_version)
       VALUES (?, ?, 'gridora.plugin/v1alpha1', 'available', '{}', 1)`,
    )
    .run(pluginId, version)
}

const seedServer = (input: {
  organizationId: string
  serverId: string
  actorId: string
  pluginId?: string
  pluginVersion?: string
  config?: Record<string, unknown>
  desiredMods?: ReadonlyArray<Record<string, unknown>>
}) => {
  const pluginId = input.pluginId ?? 'arma-reforger'
  const pluginVersion = input.pluginVersion ?? '0.1.0'
  ensurePlugin(pluginId, pluginVersion)
  database
    .prepare(
      `INSERT INTO game_servers
       (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
        placement_policy_json, desired_revision, observed_revision, active_config_revision,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'stopped', 'stopped', '{}', 1, 0, 1, ?, ?)`,
    )
    .run(input.organizationId, input.serverId, input.serverId, pluginId, pluginVersion, now, now)
  database
    .prepare(
      `INSERT INTO game_server_config_revisions
       (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
       VALUES (?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.serverId,
      JSON.stringify(
        input.config ?? {
          name: 'Tenant server',
          scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
          maxPlayers: 32,
          passwordSecretRef: 'secret-canary-never-return',
          visible: true,
          crossPlatform: true,
        },
      ),
      input.actorId,
      now,
    )
  if (input.desiredMods !== undefined)
    database
      .prepare(
        `INSERT INTO mod_sets
         (organization_id, server_id, schema_version, desired_revision, resolved_revision,
          desired_json, resolved_json, revision)
         VALUES (?, ?, 1, 1, 0, ?, '[]', 1)`,
      )
      .run(input.organizationId, input.serverId, JSON.stringify(input.desiredMods))
}

beforeEach(async () => {
  database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of migrations)
    database.exec(readFileSync(`${migrationDirectory}${migration}`, 'utf8'))
  const repository = makeGameDesiredStateRepositoryD1(new SqliteD1(database))
  control = await Effect.runPromise(
    makeGameDesiredStateControl.pipe(
      Effect.provide(Layer.succeed(GameDesiredStateRepository, repository)),
    ),
  )
})

describe('game desired-state control', () => {
  it('reads the latest tenant config and redacts secret references without writes', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({ organizationId: 'org-one', serverId: 'server-one', actorId })
    database
      .prepare(
        `INSERT INTO game_server_config_revisions
         (organization_id, server_id, revision, schema_version, config_json, actor_id, created_at)
         VALUES ('org-one', 'server-one', 2, 1, ?, ?, ?)`,
      )
      .run(
        JSON.stringify({
          name: 'Latest server',
          scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
          maxPlayers: 64,
          passwordSecretRef: 'newer-secret-canary',
          visible: true,
          crossPlatform: true,
        }),
        actorId,
        now,
      )
    const before = changes()
    const result = await Effect.runPromise(control.getConfig('org-one', 'server-one'))
    const serialized = JSON.stringify(result)
    expect(result).toMatchObject({ revision: 2, activeRevision: 1, readOnly: true })
    expect(serialized).not.toContain('newer-secret-canary')
    expect(serialized).not.toContain('secret-canary-never-return')
    expect(serialized).toContain('[redacted]')
    expect(changes()).toBe(before)
  })

  it('uses the built-in plugin through generic config validation, normalization, and planning', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({ organizationId: 'org-one', serverId: 'server-one', actorId })
    const before = changes()
    const result = await Effect.runPromise(
      control.previewConfig('org-one', 'server-one', {
        schemaVersion: 1,
        expectedConfigRevision: 1,
        config: {
          name: 'Changed server',
          scenarioId: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf',
          maxPlayers: 48,
          passwordSecretRef: 'preview-secret-canary',
          visible: true,
          crossPlatform: true,
        },
      }),
    )
    const serialized = JSON.stringify(result)
    const wire = JSON.parse(serialized) as unknown
    expect(
      Schema.decodeUnknownSync(GameConfigPreviewResponse, { onExcessProperty: 'error' })(wire),
    ).toEqual(wire)
    expect(result).toMatchObject({ outcome: 'change', sideEffects: false })
    expect(serialized).toContain('render-server-json')
    expect(serialized).not.toContain('preview-secret-canary')
    expect(serialized).not.toContain('secret-canary-never-return')
    expect(changes()).toBe(before)
  })

  it('plans generic Arma mods offline and reports unresolved external metadata', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({ organizationId: 'org-one', serverId: 'server-one', actorId })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const before = changes()
    const result = await Effect.runPromise(
      control.planMods('org-one', 'server-one', {
        schemaVersion: 1,
        expectedConfigRevision: 1,
        expectedModRevision: 0,
        desiredMods: [
          {
            source: 'reforger.armaplatform.com',
            id: '5A54BB9103829754',
            loadOrder: 2,
          },
        ],
      }),
    )
    const serialized = JSON.stringify(result)
    const wire = JSON.parse(serialized) as unknown
    expect(
      Schema.decodeUnknownSync(GameModsPlanResponse, { onExcessProperty: 'error' })(wire),
    ).toEqual(wire)
    expect(serialized).not.toContain('secret-canary-never-return')
    expect(result).toMatchObject({
      externalMetadata: {
        status: 'unresolved',
        reason: 'external_dependency_metadata_unavailable',
      },
      networkFetches: 0,
      sideEffects: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(changes()).toBe(before)
    fetchSpy.mockRestore()
  })

  it('reads desired and resolved mods with observation-driven state', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({
      organizationId: 'org-one',
      serverId: 'server-one',
      actorId,
      desiredMods: [{ source: 'reforger.armaplatform.com', id: '5A54BB9103829754', loadOrder: 1 }],
    })
    const result = await Effect.runPromise(control.getMods('org-one', 'server-one'))
    expect(result).toMatchObject({
      desiredRevision: 1,
      resolvedRevision: 0,
      state: 'pending',
      desiredMods: [{ source: 'reforger.armaplatform.com', id: '5A54BB9103829754', loadOrder: 1 }],
      resolvedMods: [],
      readOnly: true,
    })
    database
      .prepare(
        `UPDATE mod_sets SET resolved_revision = desired_revision,
         resolved_json = desired_json WHERE organization_id = 'org-one' AND server_id = 'server-one'`,
      )
      .run()
    const resolved = await Effect.runPromise(control.getMods('org-one', 'server-one'))
    expect(resolved).toMatchObject({ state: 'resolved', resolvedRevision: 1 })
    database
      .prepare(
        `UPDATE game_servers SET reconciliation_error = 'provider-secret-must-not-leak',
         observed_state = 'failed' WHERE organization_id = 'org-one' AND id = 'server-one'`,
      )
      .run()
    const failed = await Effect.runPromise(control.getMods('org-one', 'server-one'))
    expect(failed).toMatchObject({ state: 'failed', error: 'authoritative_observation_failed' })
    expect(JSON.stringify(failed)).not.toContain('provider-secret-must-not-leak')
  })

  it('fails the mods capability for the second built-in plugin', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({
      organizationId: 'org-one',
      serverId: 'valheim-one',
      actorId,
      pluginId: 'valheim',
      config: {
        name: 'Valheim server',
        world: 'World',
        passwordSecretRef: 'valheim-secret-canary',
        public: true,
      },
    })
    const exit = await Effect.runPromiseExit(
      control.planMods('org-one', 'valheim-one', {
        schemaVersion: 1,
        expectedConfigRevision: 1,
        expectedModRevision: 0,
        desiredMods: [],
      }),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure')
      expect(String(exit.cause)).toContain(DesiredStateCapabilityError.name)
  })

  it('does not reveal a server through another organization', async () => {
    const actorOne = seedOrganization('org-one')
    seedOrganization('org-two')
    seedServer({ organizationId: 'org-one', serverId: 'server-one', actorId: actorOne })
    const exit = await Effect.runPromiseExit(control.getConfig('org-two', 'server-one'))
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure')
      expect(String(exit.cause)).toContain(DesiredStateNotFoundError.name)
  })

  it('rejects unknown authoritative plugin versions and stale or excess inputs', async () => {
    const actorId = seedOrganization('org-one')
    seedServer({
      organizationId: 'org-one',
      serverId: 'unknown-one',
      actorId,
      pluginId: 'arma-reforger',
      pluginVersion: '9.9.9',
    })
    const unknown = await Effect.runPromiseExit(control.getConfig('org-one', 'unknown-one'))
    expect(unknown._tag).toBe('Failure')
    if (unknown._tag === 'Failure')
      expect(String(unknown.cause)).toContain(DesiredStatePluginUnavailableError.name)

    seedServer({ organizationId: 'org-one', serverId: 'server-one', actorId })
    const stale = await Effect.runPromiseExit(
      control.previewConfig('org-one', 'server-one', {
        schemaVersion: 1,
        expectedConfigRevision: 2,
        config: {},
      }),
    )
    expect(stale._tag).toBe('Failure')
    if (stale._tag === 'Failure')
      expect(String(stale.cause)).toContain(DesiredStateRevisionConflictError.name)

    const excess = await Effect.runPromiseExit(
      control.planMods('org-one', 'server-one', {
        schemaVersion: 1,
        expectedConfigRevision: 1,
        expectedModRevision: 0,
        desiredMods: [],
        pluginId: 'arma-reforger',
      }),
    )
    expect(excess._tag).toBe('Failure')
    if (excess._tag === 'Failure')
      expect(String(excess.cause)).toContain(DesiredStateValidationError.name)
  })
})

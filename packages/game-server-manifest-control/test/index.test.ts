import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  canonicalGameServerManifest,
  commercialReviewTokenFromManifestInput,
  defaultGameServerManifestPolicies,
  manifestFromDesiredSpec,
  manifestToGameCreateIntent,
  manifestToServerApplyIntent,
  normalizeGameServerManifest,
  planExistingGameServerManifest,
  type GameServerDesiredSpec,
  type GameServerManifest,
  type GameServerManifestInput,
} from '../src/index.js'

const desired: GameServerDesiredSpec = {
  schemaVersion: 1,
  plugin: { id: 'arma-reforger', version: '1.2.3' },
  placement: { mode: 'shared', nodeId: 'node-a' },
  resources: {
    cpuMillis: 2_000,
    ramBytes: 4 * 1024 * 1024 * 1024,
    diskBytes: 40 * 1024 * 1024 * 1024,
  },
  endpoint: { domain: 'frontline.example.test' },
  updatePolicy: defaultGameServerManifestPolicies.updatePolicy,
  backupPolicy: defaultGameServerManifestPolicies.backupPolicy,
  config: { scenarioId: 'scenario-a' },
  mods: [{ id: 'mod-a', source: 'workshop', requestedVersion: '1.0.0', loadOrder: 0 }],
  steamCredentialRef: 'steam-a',
}

const manifest = (): GameServerManifest =>
  manifestFromDesiredSpec({
    organization: 'org-a',
    serverId: 'server-a',
    name: 'Frontline',
    spec: desired,
  })

const state = () => ({
  serverId: 'server-a',
  name: 'Frontline',
  desiredRevision: 7,
  configRevision: 3,
  modRevision: 4,
  spec: desired,
})

describe('game server manifest control', () => {
  it('normalizes explicit defaults and drops the one-time commercial proof', async () => {
    const input: GameServerManifestInput = {
      apiVersion: 'games.gridora.example/v1alpha1',
      kind: 'GameServer',
      metadata: { name: 'Frontline', organization: 'org-a' },
      spec: {
        plugin: { id: 'arma-reforger', version: 'client-hint-only' },
        placement: { mode: 'auto' },
        resources: desired.resources,
        billing: {
          nonHourlyCommitmentConfirmed: true,
          commercialReviewToken: 'a'.repeat(64),
        },
        endpoint: { hostname: 'FRONTLINE.EXAMPLE.TEST' },
        config: desired.config,
        mods: desired.mods,
      },
    }

    const normalized = await Effect.runPromise(normalizeGameServerManifest(input))
    expect(normalized.spec).toMatchObject({
      endpoint: { domain: 'frontline.example.test' },
      updatePolicy: defaultGameServerManifestPolicies.updatePolicy,
      backupPolicy: defaultGameServerManifestPolicies.backupPolicy,
    })
    expect(canonicalGameServerManifest(normalized)).not.toContain('commercialReviewToken')
    expect(commercialReviewTokenFromManifestInput(input)).toBe('a'.repeat(64))
    expect(manifestToServerApplyIntent(normalized)).not.toHaveProperty('commercialReviewToken')
    expect(
      manifestToServerApplyIntent(normalized, commercialReviewTokenFromManifestInput(input)),
    ).toHaveProperty('commercialReviewToken', 'a'.repeat(64))
    expect(manifestToGameCreateIntent(normalized).placement).toEqual({ mode: 'shared' })
  })

  it('round-trips authoritative desired state as an exact no-op', () => {
    const exported = manifest()
    expect(exported).not.toHaveProperty('spec.billing')
    expect(planExistingGameServerManifest(state(), exported)).toEqual({
      kind: 'no-op',
      serverId: 'server-a',
      desiredRevision: 7,
    })
  })

  it.each([
    [
      'config',
      (current: GameServerManifest): GameServerManifest => ({
        ...current,
        spec: { ...current.spec, config: { scenarioId: 'scenario-b' } },
      }),
      'apply-config',
    ],
    [
      'mods',
      (current: GameServerManifest): GameServerManifest => ({
        ...current,
        spec: {
          ...current.spec,
          mods: [{ id: 'mod-b', source: 'workshop', requestedVersion: '2.0.0', loadOrder: 0 }],
        },
      }),
      'sync-mods',
    ],
    [
      'placement',
      (current: GameServerManifest): GameServerManifest => ({
        ...current,
        spec: { ...current.spec, placement: { mode: 'dedicated', nodeId: 'node-b' } },
      }),
      'move',
    ],
    [
      'policies',
      (current: GameServerManifest): GameServerManifest => ({
        ...current,
        spec: {
          ...current.spec,
          updatePolicy: { mode: 'automatic', backupBeforeUpdate: false },
        },
      }),
      'update-policies',
    ],
  ] as const)('plans one %s mutation without composing side effects', (_name, change, kind) => {
    const requested = change(manifest())
    expect(planExistingGameServerManifest(state(), requested)).toMatchObject({ kind })
  })

  it('rejects multiple mutations and authority-changing fields before side effects', () => {
    const current = manifest()
    const requested: GameServerManifest = {
      ...current,
      spec: {
        ...current.spec,
        config: { scenarioId: 'scenario-b' },
        mods: [{ id: 'mod-b', source: 'workshop', requestedVersion: '2.0.0', loadOrder: 0 }],
        plugin: { id: 'other-game', version: '9.9.9' },
      },
    }
    const plan = planExistingGameServerManifest(state(), requested)
    expect(plan.kind).toBe('unsupported-plan')
    if (plan.kind !== 'unsupported-plan') throw new Error('expected an unsupported plan')
    expect(plan.unsupported.map((delta) => delta.path)).toEqual(['spec.plugin', 'spec'])
  })

  it('requires an explicit organization-owned node for existing-server moves', () => {
    const current = manifest()
    const requested: GameServerManifest = {
      ...current,
      spec: { ...current.spec, placement: { mode: 'auto' } },
    }
    expect(planExistingGameServerManifest(state(), requested)).toMatchObject({
      kind: 'unsupported-plan',
      unsupported: [{ path: 'spec.placement' }],
    })
  })
})

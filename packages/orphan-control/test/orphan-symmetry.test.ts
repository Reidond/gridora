import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  OrphanSymmetryClockLayer,
  OrphanSymmetryControl,
  OrphanSymmetryControlLive,
  OrphanSymmetryDiscoveryLayer,
  OrphanSymmetryRepositoryLayer,
  compareOrphanSymmetry,
  type OrphanSymmetryAuthorityResource,
  type OrphanSymmetryDiscoveryPage,
  type OrphanSymmetryObservedResource,
  type OrphanSymmetryPlan,
} from '../src/index.js'

const first = `sha256:${'1'.repeat(64)}`
const second = `sha256:${'2'.repeat(64)}`
const request = {
  organizationId: 'org-a',
  actorId: 'orphan-scheduler-a',
  runId: 'symmetry-run-a',
  idempotencyKey: 'symmetry-idempotency-a',
}
const authority = (
  kind: OrphanSymmetryAuthorityResource['kind'],
  resourceKey: string,
  overrides: Partial<OrphanSymmetryAuthorityResource> = {},
): OrphanSymmetryAuthorityResource => ({
  organizationId: 'org-a',
  kind,
  resourceKey,
  resourceId: `${kind}-a`,
  nodeId: kind === 'backup-object' || kind === 'dns-record' ? null : 'node-a',
  fingerprint: first,
  state: 'expected',
  ...overrides,
})
const observed = (
  kind: OrphanSymmetryObservedResource['kind'],
  resourceKey: string,
  overrides: Partial<OrphanSymmetryObservedResource> = {},
): OrphanSymmetryObservedResource => ({
  organizationId: 'org-a',
  kind,
  resourceKey,
  resourceId: `${kind}-observed-a`,
  nodeId: kind === 'backup-object' || kind === 'dns-record' ? null : 'node-a',
  fingerprint: first,
  ownerScope: 'tenant',
  observedAt: '2026-08-24T10:00:00.000Z',
  ...overrides,
})

describe('non-destructive orphan symmetry matrix', () => {
  it('produces high-severity actionable evidence across container, port, DNS, Tunnel, and R2', async () => {
    const findings = await Effect.runPromise(
      compareOrphanSymmetry(
        'org-a',
        [
          authority('deployment-container', 'node-a:server-a'),
          authority('port-lease', 'node-a:udp:2001'),
          authority('dns-record', 'server-a.example.test', { state: 'receipt-missing' }),
          authority('tunnel-authority', 'node-a'),
          authority('backup-object', 'organizations/org-a/servers/server-a/backups/backup-a'),
        ],
        [
          observed('port-lease', 'node-a:udp:2001', { ownerScope: 'foreign' }),
          observed('port-lease', 'node-a:udp:2001', { resourceId: 'port-observed-b' }),
          observed('dns-record', 'server-a.example.test'),
          observed('tunnel-authority', 'node-a', { fingerprint: second }),
          observed('backup-object', 'organizations/org-a/servers/server-a/backups/unknown'),
        ],
      ),
    )

    expect(findings.every(({ severity }) => severity === 'high')).toBe(true)
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'deployment-container',
          reason: 'missing-observed',
          recommendation: 'inspect-agent-container-inventory',
        }),
        expect.objectContaining({ kind: 'port-lease', reason: 'duplicate-observed' }),
        expect.objectContaining({ kind: 'port-lease', reason: 'foreign-observed' }),
        expect.objectContaining({ kind: 'dns-record', reason: 'receipt-missing' }),
        expect.objectContaining({ kind: 'tunnel-authority', reason: 'fingerprint-mismatch' }),
        expect.objectContaining({ kind: 'backup-object', reason: 'missing-observed' }),
        expect.objectContaining({ kind: 'backup-object', reason: 'unmanaged-observed' }),
      ]),
    )
    expect(JSON.stringify(findings)).not.toContain('delete')
  })

  it('uses bounded cursor pages and persists one deterministic plan', async () => {
    const pages: ReadonlyArray<OrphanSymmetryDiscoveryPage> = [
      {
        organizationId: 'org-a',
        runId: request.runId,
        cursor: null,
        nextCursor: 'page-2',
        complete: false,
        resources: [observed('deployment-container', 'node-a:server-a')],
      },
      {
        organizationId: 'org-a',
        runId: request.runId,
        cursor: 'page-2',
        nextCursor: null,
        complete: true,
        resources: [observed('backup-object', 'organizations/org-a/servers/a/backups/a')],
      },
    ]
    let calls = 0
    let applied: OrphanSymmetryPlan | undefined
    const dependencies = Layer.mergeAll(
      OrphanSymmetryDiscoveryLayer({
        discoverPage: (_request, cursor) => {
          const page = pages[cursor === null ? 0 : 1]
          calls += 1
          return page === undefined
            ? Effect.fail(new Error('unexpected page') as never)
            : Effect.succeed(page)
        },
      }),
      OrphanSymmetryRepositoryLayer({
        findReplay: () => Effect.succeed(null),
        authoritative: () =>
          Effect.succeed([
            authority('deployment-container', 'node-a:server-a'),
            authority('backup-object', 'organizations/org-a/servers/a/backups/a'),
          ]),
        applyAtomic: (plan) => {
          applied = plan
          return Effect.succeed({
            organizationId: plan.organizationId,
            runId: plan.runId,
            discoveryFingerprint: plan.discoveryFingerprint,
            opened: plan.findings.length,
            updated: 0,
            resolved: 0,
            unchanged: 0,
            replayed: false,
          })
        },
      }),
      OrphanSymmetryClockLayer(new Date('2026-08-24T10:01:00.000Z')),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* OrphanSymmetryControl).reconcile(request)
      }).pipe(Effect.provide(OrphanSymmetryControlLive.pipe(Layer.provide(dependencies)))),
    )

    expect(calls).toBe(2)
    expect(result.opened).toBe(0)
    expect(applied?.findings).toEqual([])
    expect(applied?.authorityFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(applied?.discoveryFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('adopts a committed replay before any discovery call', async () => {
    let discoveryCalls = 0
    const replay = {
      organizationId: 'org-a',
      runId: request.runId,
      discoveryFingerprint: first,
      opened: 1,
      updated: 0,
      resolved: 0,
      unchanged: 0,
      replayed: true,
    } as const
    const dependencies = Layer.mergeAll(
      OrphanSymmetryDiscoveryLayer({
        discoverPage: () => {
          discoveryCalls += 1
          return Effect.die('discovery must not run')
        },
      }),
      OrphanSymmetryRepositoryLayer({
        findReplay: () => Effect.succeed(replay),
        authoritative: () => Effect.die('authority must not run'),
        applyAtomic: () => Effect.die('apply must not run'),
      }),
      OrphanSymmetryClockLayer(new Date('2026-08-24T10:01:00.000Z')),
    )
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* OrphanSymmetryControl).reconcile(request)
        }).pipe(Effect.provide(OrphanSymmetryControlLive.pipe(Layer.provide(dependencies)))),
      ),
    ).resolves.toEqual(replay)
    expect(discoveryCalls).toBe(0)
  })

  it('rejects a foreign tenant page and a cursor cycle', async () => {
    const run = (page: OrphanSymmetryDiscoveryPage) => {
      const dependencies = Layer.mergeAll(
        OrphanSymmetryDiscoveryLayer({ discoverPage: () => Effect.succeed(page) }),
        OrphanSymmetryRepositoryLayer({
          findReplay: () => Effect.succeed(null),
          authoritative: () => Effect.succeed([]),
          applyAtomic: () => Effect.die('must not persist'),
        }),
        OrphanSymmetryClockLayer(new Date('2026-08-24T10:01:00.000Z')),
      )
      return Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* OrphanSymmetryControl).reconcile(request)
        }).pipe(Effect.provide(OrphanSymmetryControlLive.pipe(Layer.provide(dependencies)))),
      )
    }
    await expect(
      run({
        organizationId: 'org-b',
        runId: request.runId,
        cursor: null,
        nextCursor: null,
        complete: true,
        resources: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
    await expect(
      run({
        organizationId: 'org-a',
        runId: request.runId,
        cursor: null,
        nextCursor: 'same-page',
        complete: false,
        resources: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid-scope' })
  })
})

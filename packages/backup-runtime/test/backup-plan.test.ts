import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  BackupArchive,
  BackupExecutor,
  BackupExecutorLive,
  createRestorePlan,
  validateArchiveEntries,
} from '../src/index.js'

const manifest = {
  apiVersion: 'backup.gridora.dev/v1alpha1',
  backupId: 'backup-1',
  organizationId: 'org-1',
  serverId: 'server-1',
  pluginId: 'arma-reforger',
  pluginVersion: '1.0.0',
  consistency: 'crash-consistent',
  createdAt: '2026-08-23T00:00:00Z',
  sha256: `sha256:${'a'.repeat(64)}`,
  files: ['config', 'data'],
  diskBytes: 1024 * 1024,
} as const

describe('restore planning', () => {
  it('stages and checksum-validates before atomic cutover', () => {
    expect(
      createRestorePlan(manifest, {
        organizationId: 'org-1',
        sourceServerId: 'server-1',
        targetServerId: 'server-2',
      }),
    ).toMatchObject({
      mode: 'restore',
      expectedSha256: manifest.sha256,
      atomicTarget: '/var/lib/gridora/servers/server-2',
    })
  })
  it.each(['.', '..'])('rejects the traversal ID %s', (unsafeId) => {
    expect(() =>
      createRestorePlan(manifest, {
        organizationId: 'org-1',
        sourceServerId: 'server-1',
        targetServerId: unsafeId,
      }),
    ).toThrow(/path-safe/)
  })
  it('binds a restore to the expected organization and source server', () => {
    expect(() =>
      createRestorePlan(manifest, {
        organizationId: 'org-2',
        sourceServerId: 'server-1',
        targetServerId: 'server-2',
      }),
    ).toThrow(/expected organization/)
    expect(() =>
      createRestorePlan(manifest, {
        organizationId: 'org-1',
        sourceServerId: 'server-9',
        targetServerId: 'server-2',
      }),
    ).toThrow(/expected organization/)
  })
  it('rejects traversal paths', () => {
    expect(() => validateArchiveEntries(['data/world.db', '../etc/shadow'])).toThrow(
      /unsafe archive/,
    )
  })
  it('checks the signed digest before staged extraction and atomic commit', async () => {
    const events: string[] = []
    const archive = Layer.succeed(BackupArchive, {
      create: () =>
        Effect.succeed({ archivePath: '/tmp/backup.tar.zst', bytes: 1, sha256: manifest.sha256 }),
      checksum: () =>
        Effect.sync(() => {
          events.push('checksum')
          return manifest.sha256
        }),
      enumerate: () => Effect.succeed([{ path: 'data/world.db', kind: 'file' }]),
      extractToStaging: () =>
        Effect.sync(() => {
          events.push('extract')
        }),
      commitRestore: () =>
        Effect.sync(() => {
          events.push('commit')
        }),
      rollbackRestore: () => Effect.void,
      finalizeRestore: () => Effect.sync(() => events.push('finalize')),
      release: () => Effect.void,
    })
    const plan = createRestorePlan(manifest, {
      organizationId: 'org-1',
      sourceServerId: 'server-1',
      targetServerId: 'server-2',
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* BackupExecutor
        yield* executor.restore(plan)
      }).pipe(Effect.provide(BackupExecutorLive.pipe(Layer.provide(archive)))),
    )
    expect(events).toEqual(['checksum', 'extract', 'commit', 'finalize'])
  })
  it.each([
    { entries: [{ path: '../etc/shadow', kind: 'file' }] },
    { entries: [{ path: '/etc/shadow', kind: 'file' }] },
    {
      entries: [
        { path: 'data/link', kind: 'symlink' },
        { path: 'data/link/child', kind: 'file' },
      ],
    },
    { entries: [{ path: 'data/world', kind: 'hardlink' }] },
  ] as const)('rejects malicious typed archive inventory %#', async ({ entries }) => {
    const archive = Layer.succeed(BackupArchive, {
      create: () =>
        Effect.succeed({ archivePath: '/tmp/backup.tar.zst', bytes: 1, sha256: manifest.sha256 }),
      checksum: () => Effect.succeed(manifest.sha256),
      enumerate: () => Effect.succeed(entries),
      extractToStaging: () => Effect.void,
      commitRestore: () => Effect.void,
      rollbackRestore: () => Effect.void,
      finalizeRestore: () => Effect.void,
      release: () => Effect.void,
    })
    const plan = createRestorePlan(manifest, {
      organizationId: 'org-1',
      sourceServerId: 'server-1',
      targetServerId: 'server-2',
    })
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* BackupExecutor).restore(plan)
        }).pipe(Effect.provide(BackupExecutorLive.pipe(Layer.provide(archive)))),
      ),
    ).rejects.toBeDefined()
  })
})

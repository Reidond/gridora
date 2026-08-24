import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import type { OrganizationContext } from '@gridora/domain'
import {
  BackupControl,
  BackupPersistenceError,
  makeBackupControlLayer,
  type BackupArtifact,
  type BackupDeletionClaim,
  type BackupRepositoryShape,
} from '../src/index.js'

const now = '2026-08-24T00:00:00.000Z'
const context = {
  organizationId: 'org-a',
  organizationSlug: 'organization-a',
  identityId: 'retention-actor-a',
  role: 'automation',
  correlationId: 'retention-correlation-a',
} as unknown as OrganizationContext

const artifact = (r2Key: string): BackupArtifact => ({
  organizationId: 'org-a',
  id: 'backup-a',
  serverId: 'server-a',
  r2Key,
  checksum: `sha256:${'a'.repeat(64)}`,
  encryptionVersion: 1,
  metadata: {
    pluginId: 'arma-reforger',
    pluginVersion: '1.0.0',
    gameBuild: 'build-a',
    configRevision: 1,
    modSetRevision: 0,
    desiredRevision: 1,
    nodeId: 'node-a',
    consistency: 'plugin-quiesced',
    includes: ['config'],
    containsGameBinaries: false,
  },
  state: 'expired',
  revision: 3,
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: '2026-08-23T00:00:00.000Z',
})

const claim = (value: BackupArtifact): BackupDeletionClaim => ({
  claimId: 'backup-retention-claim-a',
  operationId: 'backup-retention-claim-a',
  backupId: value.id,
  organizationId: value.organizationId,
  serverId: value.serverId,
  r2Key: value.r2Key,
  artifact: value,
  state: 'deleting',
})

describe('physical backup retention control', () => {
  it('retries an exact claimed prefix after an R2 failure and commits its receipt', async () => {
    const value = artifact('organizations/org-a/servers/server-a/backups/backup-a')
    const deletionClaim = claim(value)
    let removeAttempts = 0
    let failures = 0
    const completions: unknown[] = []
    const repository = {
      expire: () => Effect.succeed([]),
      claimRetentionDeletes: () => Effect.succeed([{ context, claim: deletionClaim }]),
      recordDeleteFailure: () => Effect.sync(() => void (failures += 1)),
      completeDelete: (input: unknown) =>
        Effect.sync(() => {
          completions.push(input)
          return { ...value, state: 'deleted' as const, revision: value.revision + 1 }
        }),
    } as unknown as BackupRepositoryShape
    const control = Effect.runSync(
      Effect.service(BackupControl).pipe(
        Effect.provide(
          makeBackupControlLayer({
            repository,
            clock: { now: Effect.succeed(now) },
            plugin: { validateRestore: () => Effect.void },
            facts: {} as never,
            deletion: {
              remove: () => {
                removeAttempts += 1
                return removeAttempts === 1
                  ? Effect.fail(new BackupPersistenceError({ operation: 'test.r2' }))
                  : Effect.succeed({
                      deletedObjects: 0,
                      alreadyAbsent: true,
                      deletedPrefix: value.r2Key,
                    })
              },
            },
          }),
        ),
      ),
    )

    expect((await Effect.runPromise(Effect.result(control.expire(now, 10))))._tag).toBe('Failure')
    expect(failures).toBe(1)
    await expect(Effect.runPromise(control.expire(now, 10))).resolves.toMatchObject([
      { id: 'backup-a', state: 'deleted' },
    ])
    expect(removeAttempts).toBe(2)
    expect(completions).toEqual([
      expect.objectContaining({
        claimId: deletionClaim.claimId,
        expectedArtifactRevision: value.revision,
        deletedPrefix: value.r2Key,
        deletedObjects: 0,
        alreadyAbsent: true,
      }),
    ])
  })

  it('rejects a foreign-prefix catalog row before calling R2', async () => {
    const value = artifact('organizations/org-a/servers/server-a/backups/backup-foreign')
    let removeAttempts = 0
    const repository = {
      expire: () => Effect.succeed([]),
      claimRetentionDeletes: () => Effect.succeed([{ context, claim: claim(value) }]),
    } as unknown as BackupRepositoryShape
    const control = Effect.runSync(
      Effect.service(BackupControl).pipe(
        Effect.provide(
          makeBackupControlLayer({
            repository,
            clock: { now: Effect.succeed(now) },
            plugin: { validateRestore: () => Effect.void },
            facts: {} as never,
            deletion: {
              remove: () => {
                removeAttempts += 1
                return Effect.succeed({
                  deletedObjects: 1,
                  alreadyAbsent: false,
                  deletedPrefix: value.r2Key,
                })
              },
            },
          }),
        ),
      ),
    )
    const result = await Effect.runPromise(Effect.result(control.expire(now, 10)))
    expect(result._tag).toBe('Failure')
    expect(removeAttempts).toBe(0)
  })
})

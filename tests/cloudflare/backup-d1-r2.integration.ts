/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, inject, it } from 'vitest'
import { BackupDataKeyPortLive, BackupKeyRandomLayer } from '../../packages/backup-key/src/index.js'
import { makeBackupKeyRepositoryD1Layer } from '../../packages/backup-key-d1/src/index.js'
import {
  BackupR2BucketLayer,
  BackupR2Error,
  BackupR2Transport,
  BackupR2TransportLive,
  makeCloudflareBackupR2Bucket,
} from '../../packages/backup-r2/src/index.js'
import { OrganizationContext } from '../../packages/domain/src/index.js'
import {
  KekPort,
  SecretKekError,
  type KekPortShape,
} from '../../packages/secret-envelope/src/index.js'

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17))
      controller.enqueue(bytes.slice(17, 60_000))
      controller.enqueue(bytes.slice(60_000, 120_000))
      controller.enqueue(bytes.slice(120_000))
      controller.close()
    },
  })
const collect = async (body: ReadableStream<Uint8Array>) => {
  const response = await new Response(body).arrayBuffer()
  return new Uint8Array(response)
}
const sha256 = async (bytes: Uint8Array) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)))
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const localKek = (): KekPortShape => {
  const root = new Uint8Array(32).fill(91)
  const key = (usages: KeyUsage[]) =>
    Effect.tryPromise({
      try: () => crypto.subtle.importKey('raw', buffer(root), 'AES-GCM', false, usages),
      catch: () => new SecretKekError({ operation: 'workerd.kek', message: 'KEK failed' }),
    })
  return {
    activeKeyVersion: Effect.succeed(1),
    wrap: (version, plaintext, aad) =>
      Effect.gen(function* () {
        if (version !== 1)
          return yield* new SecretKekError({ operation: 'workerd.wrap', message: 'KEK failed' })
        const imported = yield* key(['encrypt'])
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad) },
              imported,
              buffer(plaintext),
            ),
          catch: () => new SecretKekError({ operation: 'workerd.wrap', message: 'KEK failed' }),
        })
        const wrapped = new Uint8Array(12 + ciphertext.byteLength)
        wrapped.set(iv)
        wrapped.set(new Uint8Array(ciphertext), 12)
        return wrapped
      }),
    unwrap: (version, wrapped, aad) =>
      Effect.gen(function* () {
        if (version !== 1 || wrapped.byteLength <= 12)
          return yield* new SecretKekError({ operation: 'workerd.unwrap', message: 'KEK failed' })
        const imported = yield* key(['decrypt'])
        return yield* Effect.tryPromise({
          try: async () =>
            new Uint8Array(
              await crypto.subtle.decrypt(
                {
                  name: 'AES-GCM',
                  iv: buffer(wrapped.slice(0, 12)),
                  additionalData: buffer(aad),
                },
                imported,
                buffer(wrapped.slice(12)),
              ),
            ),
          catch: () => new SecretKekError({ operation: 'workerd.unwrap', message: 'KEK failed' }),
        })
      }),
  }
}

const seed = async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO identities
      (id, access_subject, email, display_name, status, signed_up_at, last_login_at)
      VALUES ('owner-a', 'access-owner-a', 'owner@example.com', 'Owner', 'active', 'now', 'now')`),
    env.DB.prepare(`INSERT INTO organizations
      (id, name, slug, status, timezone, default_region, onboarding_step,
       policy_revision, revision, created_at)
      VALUES ('org-a', 'Organization A', 'organization-a', 'active', 'UTC', 'eu',
       'complete', 1, 1, 'now')`),
    env.DB.prepare(`INSERT INTO game_plugins
      (id, version, api_version, status, capability_manifest_json, config_schema_version)
      VALUES ('test-game', '1.0.0', 'gridora.plugin/v1alpha1', 'available', '{}', 1)`),
    env.DB.prepare(`INSERT INTO game_servers
      (organization_id, id, name, plugin_id, plugin_version, desired_state, observed_state,
       placement_policy_json, created_at, updated_at)
      VALUES ('org-a', 'server-a', 'Server A', 'test-game', '1.0.0', 'stopped', 'stopped',
       '{}', 'now', 'now')`),
    env.DB.prepare(`INSERT INTO backups
      (organization_id, id, server_id, r2_key, checksum, encryption_version,
       metadata_json, state, created_at)
      VALUES ('org-a', 'backup-a', 'server-a',
       'organizations/org-a/servers/server-a/backups/backup-a/manifest.json',
       'sha256:pending', 1, '{}', 'creating', 'now')`),
  ])
}

const organizationContext = (organizationId: string) =>
  Schema.decodeUnknownSync(OrganizationContext)({
    organizationId,
    organizationSlug: organizationId === 'org-a' ? 'organization-a' : 'organization-b',
    identityId: organizationId === 'org-a' ? 'owner-a' : 'owner-b',
    role: 'owner',
    correlationId: `correlation-${organizationId}`,
  })

describe('backup composition in the Workers runtime', () => {
  it('round-trips authenticated bytes through actual D1 and R2 bindings', async () => {
    await applyD1Migrations(env.DB, [...inject('gridoraD1Migrations')])
    await seed()

    const dataKeys = BackupDataKeyPortLive.pipe(
      Layer.provide(makeBackupKeyRepositoryD1Layer(env.DB)),
      Layer.provide(Layer.succeed(KekPort, localKek())),
      Layer.provide(BackupKeyRandomLayer()),
    )
    const bucket = makeCloudflareBackupR2Bucket(env.BACKUPS)
    const transportLayer = BackupR2TransportLive.pipe(
      Layer.provide(BackupR2BucketLayer(bucket)),
      Layer.provide(dataKeys),
    )
    const payload = new TextEncoder().encode(`workerd-backup-${'state-block-'.repeat(12_000)}`)
    const checksum = await sha256(payload)

    const manifest = await Effect.runPromise(
      Effect.flatMap(BackupR2Transport, (transport) =>
        transport.upload(organizationContext('org-a'), {
          backupId: 'backup-a',
          serverId: 'server-a',
          operationId: 'operation-a',
          jobId: 'job-a',
          uploadSessionId: 'upload-session-a',
          uploadLeaseId: 'upload-lease-a',
          uploadGeneration: 1,
          createdAt: '2026-08-23T12:00:00Z',
          includes: ['config', 'data', 'mods', 'state'],
          containsGameBinaries: false,
          compressedBytes: payload.byteLength,
          compressedSha256: checksum,
          maximumCompressedBytes: 1024 * 1024,
          maximumChunkBytes: 64 * 1024,
          publicationGuard: () => Effect.void,
          publishObject: (publication) =>
            Effect.tryPromise({
              try: () =>
                bucket.put(publication.key, publication.value, {
                  customMetadata: publication.customMetadata,
                  onlyIfAbsent: true,
                }),
              catch: () =>
                new BackupR2Error({
                  code: 'transport-failed',
                  operation: 'test.backup.publish',
                  message: 'test publication failed',
                }),
            }),
          stream: stream(payload),
        }),
      ).pipe(Effect.provide(transportLayer)),
    )
    expect(manifest.plaintext.sha256).toBe(checksum)
    expect(manifest.chunks.length).toBeGreaterThan(1)

    const keyRow = await env.DB.prepare(`SELECT organization_id, server_id, backup_id,
      key_version, wrapped_data_key FROM backup_wrapped_keys`).first<{
      organization_id: string
      server_id: string
      backup_id: string
      key_version: number
      wrapped_data_key: string
    }>()
    expect(keyRow).toMatchObject({
      organization_id: 'org-a',
      server_id: 'server-a',
      backup_id: 'backup-a',
      key_version: 1,
    })
    expect(JSON.stringify(keyRow)).not.toContain([...new Uint8Array(32)].join(','))

    const storedManifest = await env.BACKUPS.head(
      'organizations/org-a/servers/server-a/backups/backup-a/manifest.json',
    )
    expect(storedManifest?.customMetadata).toMatchObject({
      'gridora-managed-by': 'gridora',
      'gridora-organization-id': 'org-a',
      'gridora-server-id': 'server-a',
      'gridora-backup-id': 'backup-a',
    })

    const restored = await Effect.runPromise(
      Effect.flatMap(BackupR2Transport, (transport) =>
        transport.restore(organizationContext('org-a'), {
          backupId: 'backup-a',
          serverId: 'server-a',
          maximumRestoreBytes: 1024 * 1024,
        }),
      ).pipe(Effect.provide(transportLayer)),
    )
    expect(await collect(restored.stream)).toEqual(payload)

    const crossTenant = await Effect.runPromise(
      Effect.flatMap(BackupR2Transport, (transport) =>
        Effect.result(
          transport.restore(organizationContext('org-b'), {
            backupId: 'backup-a',
            serverId: 'server-a',
            maximumRestoreBytes: 1024 * 1024,
          }),
        ),
      ).pipe(Effect.provide(transportLayer)),
    )
    expect(crossTenant).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BackupR2Error', code: 'not-found' },
    })
  })
})

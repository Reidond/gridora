import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const generator = resolve(process.cwd(), 'infra/images/create-image-promotion-manifest')
const coordinates = {
  GRIDORA_IMAGE_VERSION: '2026.08.23',
  GRIDORA_IMAGE_NAME: 'gridora-node-2026.08.23-amd64.qcow2',
  GRIDORA_IMAGE_SHA256: 'a'.repeat(64),
  GRIDORA_SOURCE_COMMIT: 'b'.repeat(40),
  GRIDORA_BUILD_IDENTITY_MANIFEST_SHA256: `sha256:${'c'.repeat(64)}`,
  GRIDORA_BUILD_IDENTITY_SIGNATURE_SHA256: `sha256:${'d'.repeat(64)}`,
  GRIDORA_BUILD_IDENTITY_PUBLIC_KEY_SHA256: `sha256:${'e'.repeat(64)}`,
  GRIDORA_ROOTFS_ARCHIVE_SHA256: `sha256:${'f'.repeat(64)}`,
  GRIDORA_ROOTFS_EVIDENCE_SHA256: `sha256:${'0'.repeat(64)}`,
  GRIDORA_SBOM_SHA256: `sha256:${'1'.repeat(64)}`,
}

describe('image promotion manifest', () => {
  it('emits the exact canonical Ed25519 build-identity signature contract', async () => {
    const { stdout } = await execute(generator, [], { env: { ...process.env, ...coordinates } })
    const manifest = JSON.parse(stdout) as Record<string, unknown>

    expect(manifest.signature).toEqual({
      schemaVersion: 1,
      algorithm: 'ed25519',
      buildIdentityManifestSha256: coordinates.GRIDORA_BUILD_IDENTITY_MANIFEST_SHA256,
      buildIdentitySignatureSha256: coordinates.GRIDORA_BUILD_IDENTITY_SIGNATURE_SHA256,
      buildIdentityPublicKeySha256: coordinates.GRIDORA_BUILD_IDENTITY_PUBLIC_KEY_SHA256,
    })
    expect(Object.keys(manifest.signature as object).sort()).toEqual([
      'algorithm',
      'buildIdentityManifestSha256',
      'buildIdentityPublicKeySha256',
      'buildIdentitySignatureSha256',
      'schemaVersion',
    ])
  })

  it('binds a non-empty rootfs inventory and SBOM to the promoted QCOW2 digest', async () => {
    const { stdout } = await execute(generator, [], { env: { ...process.env, ...coordinates } })
    const manifest = JSON.parse(stdout) as {
      evidence: Record<string, unknown>
    }

    expect(manifest.evidence).toMatchObject({
      rootfsArchive: `${coordinates.GRIDORA_IMAGE_NAME}.rootfs.tar`,
      rootfsEvidence: `${coordinates.GRIDORA_IMAGE_NAME}.rootfs-evidence.json`,
      integrity: {
        rootfsArchiveSha256: coordinates.GRIDORA_ROOTFS_ARCHIVE_SHA256,
        rootfsEvidenceSha256: coordinates.GRIDORA_ROOTFS_EVIDENCE_SHA256,
        sbomSha256: coordinates.GRIDORA_SBOM_SHA256,
      },
    })
  })

  it('rejects malformed or missing digest coordinates', async () => {
    await expect(
      execute(generator, [], {
        env: { ...process.env, ...coordinates, GRIDORA_BUILD_IDENTITY_SIGNATURE_SHA256: 'bad' },
      }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
  })
})

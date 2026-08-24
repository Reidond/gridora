import { Effect } from 'effect'
import {
  NodeImageValidationError,
  makeNodeImageControl,
  makeTrustedNodeImageEvidenceVerifier,
  makeWebCryptoNodeImageIdentity,
  type NodeImageControlShape,
  type TrustedNodeImageEvidenceSourceShape,
} from '@gridora/node-image-control'
import {
  makeNodeImageExecutionRepositoryD1,
  makeNodeImageRepositoryD1,
  type NodeImageD1Database,
} from '@gridora/node-image-d1'
import {
  NodeImageExecutionError,
  makeNodeImageExecution,
  type NodeImageExecutionShape,
} from '@gridora/node-image-execution'
import {
  makeNodeImageWorkflowStarter,
  type NodeImageWorkflowBinding,
} from '@gridora/node-image-workflow'
import type { AuditRequestContextValue } from '@gridora/audit-contracts'

export interface NodeImageArtifactBucket {
  get(key: string): Promise<R2ObjectBody | null>
}

export type NodeImageRuntimeDatabase = NodeImageD1Database

const maxEvidenceBytes = 512 * 1024
const safeSegment = (value: string): string => encodeURIComponent(value)
const prefix = (imageId: string, artifactDigest: string) =>
  `node-images/${safeSegment(imageId)}/${safeSegment(artifactDigest)}`

const validation = (code: string, message: string) =>
  new NodeImageValidationError({ code, message })

const bytes = (bucket: NodeImageArtifactBucket, key: string) =>
  Effect.tryPromise({
    try: async () => {
      const object = await bucket.get(key)
      if (object === null || (object.size !== undefined && object.size > maxEvidenceBytes))
        throw new Error('not-found-or-too-large')
      const value = new Uint8Array(await object.arrayBuffer())
      if (value.byteLength === 0 || value.byteLength > maxEvidenceBytes)
        throw new Error('invalid-size')
      return value
    },
    catch: () => validation('evidence_unavailable', 'Trusted node image evidence is unavailable'),
  })

const string = (value: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof value?.[key] === 'string' ? (value[key] as string) : undefined
const integer = (value: Record<string, unknown> | undefined, key: string): number | undefined =>
  typeof value?.[key] === 'number' && Number.isSafeInteger(value[key])
    ? (value[key] as number)
    : undefined

/**
 * Build and test evidence live at deterministic immutable R2 keys.  A key is
 * never taken from the HTTP request beyond already-validated image/digest
 * coordinates, and the trust root is a Worker variable rather than an R2
 * object or a caller value.
 */
export const makeR2TrustedNodeImageEvidenceSource = (input: {
  readonly bucket: NodeImageArtifactBucket
  readonly database: NodeImageRuntimeDatabase
}): TrustedNodeImageEvidenceSourceShape => ({
  loadBuild: ({ imageId, artifactDigest }) => {
    const base = prefix(imageId, artifactDigest)
    return Effect.all({
      manifestBytes: bytes(input.bucket, `${base}/build.manifest.json`),
      detachedSignature: bytes(input.bucket, `${base}/build.manifest.sig`),
      publicKey: bytes(input.bucket, `${base}/signing-key.ed25519`),
    })
  },
  loadTesting: ({ imageId, expectedImageRevision, testRunId }) =>
    Effect.gen(function* () {
      const loaded = yield* Effect.tryPromise({
        try: () =>
          input.database
            .prepare(`SELECT image_id AS imageId, revision, source_commit AS sourceCommit,
              architecture, artifact_digest AS artifactDigest, manifest_digest AS manifestDigest
              FROM node_image_lifecycle_records WHERE image_id = ? AND revision = ?`)
            .bind(imageId, expectedImageRevision)
            .first(),
        catch: () =>
          validation('trusted_test_evidence_unavailable', 'Trusted test evidence is unavailable'),
      })
      const row =
        typeof loaded === 'object' && loaded !== null
          ? (loaded as Record<string, unknown>)
          : undefined
      const foundImageId = string(row, 'imageId')
      const revision = integer(row, 'revision')
      const sourceCommit = string(row, 'sourceCommit')
      const architecture = string(row, 'architecture')
      const artifactDigest = string(row, 'artifactDigest')
      const manifestDigest = string(row, 'manifestDigest')
      if (
        foundImageId !== imageId ||
        revision !== expectedImageRevision ||
        sourceCommit === undefined ||
        architecture !== 'amd64' ||
        artifactDigest === undefined ||
        manifestDigest === undefined
      )
        return yield* validation(
          'trusted_test_evidence_mismatch',
          'Trusted node image build coordinates are unavailable',
        )
      const base = prefix(imageId, artifactDigest)
      const evidence = yield* Effect.all({
        reportBytes: bytes(input.bucket, `${base}/tests/${safeSegment(testRunId)}.json`),
        detachedSignature: bytes(input.bucket, `${base}/tests/${safeSegment(testRunId)}.sig`),
        publicKey: bytes(input.bucket, `${base}/signing-key.ed25519`),
      })
      return {
        build: {
          imageId,
          revision,
          sourceCommit,
          architecture: 'amd64' as const,
          artifactDigest,
          manifestDigest,
        },
        ...evidence,
      }
    }),
})

const trustedKeyDigests = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^sha256:[a-f0-9]{64}$/.test(entry)),
  )

/** Empty or malformed trust configuration fails closed at image build/test acceptance. */
export const makeNodeImageControlRuntime = (input: {
  readonly database: NodeImageRuntimeDatabase
  readonly artifacts: NodeImageArtifactBucket
  readonly trustedPublicKeyDigests: string
  readonly workflow: NodeImageWorkflowBinding
  readonly auditRequestContext: AuditRequestContextValue
}): NodeImageControlShape =>
  makeNodeImageControl({
    repository: makeNodeImageRepositoryD1(input.database, {
      auditRequestContext: input.auditRequestContext,
    }),
    workflows: makeNodeImageWorkflowStarter(input.workflow),
    clock: { now: Effect.sync(() => new Date().toISOString()) },
    identities: makeWebCryptoNodeImageIdentity(),
    evidence: makeTrustedNodeImageEvidenceVerifier(
      makeR2TrustedNodeImageEvidenceSource({ bucket: input.artifacts, database: input.database }),
      { trustedPublicKeyDigests: trustedKeyDigests(input.trustedPublicKeyDigests) },
    ),
  })

/**
 * Local lifecycle transitions are executable without provider credentials.
 * Custom provider-image registration remains fail-closed until the exact
 * production provider adapter is supplied; it can never issue a paid request
 * from a placeholder artifact URL.
 */
export const makeNodeImageExecutionRuntime = (
  database: NodeImageD1Database,
): NodeImageExecutionShape =>
  makeNodeImageExecution({
    repository: makeNodeImageExecutionRepositoryD1(database),
    artifacts: {
      locate: () =>
        Effect.fail(new NodeImageExecutionError({ code: 'artifact_locator_unavailable' })),
    },
    providers: {
      resolve: () =>
        Effect.fail(new NodeImageExecutionError({ code: 'provider_transport_unavailable' })),
    },
    clock: {
      now: Effect.sync(() => {
        const epochMilliseconds = Date.now()
        return { iso: new Date(epochMilliseconds).toISOString(), epochMilliseconds }
      }),
    },
  })

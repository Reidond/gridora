import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { PlatformActor } from '@gridora/platform-authority'
import {
  NodeImageValidationError,
  makeNodeImageControl,
  makeTrustedNodeImageEvidenceVerifier,
  makeWebCryptoNodeImageIdentity,
  type CreateNodeImageIntent,
  type ImageScanEvidence,
  type ImageTestEvidence,
  type NodeImageAcceptance,
  type NodeImageCommand,
  type NodeImageRepositoryShape,
  type TrustedNodeImageEvidenceSourceShape,
} from '../src/index.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const sourceCommit = 'a'.repeat(40)
const now = '2026-08-23T12:00:00.000Z'
const actor = new PlatformActor({
  identityId: 'platform-admin',
  accessSubject: 'access-platform-admin',
  correlationId: 'correlation-node-image',
  administratorRevision: 1,
})
const intent: CreateNodeImageIntent = {
  schemaVersion: 1,
  imageId: 'node-image-20260823',
  version: '2026.08.23.1',
  sourceCommit,
  architecture: 'amd64',
  artifactDigest: digest('a'),
  manifestDigest: digest('b'),
  sbomDigest: digest('c'),
  buildLogDigest: digest('d'),
  signature: {
    schemaVersion: 1,
    algorithm: 'ed25519',
    manifestDigest: digest('b'),
    detachedSignatureDigest: digest('e'),
    publicKeyDigest: digest('f'),
  },
}

const arrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
const hash = async (value: Uint8Array) => {
  const output = await crypto.subtle.digest('SHA-256', arrayBuffer(value))
  return `sha256:${[...new Uint8Array(output)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

const signed = async (payload: unknown) => {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const body = bytes(payload)
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, body),
  )
  return { body, publicKey, signature, publicKeyDigest: await hash(publicKey) }
}

const buildManifest = () => ({
  schemaVersion: 1,
  imageId: intent.imageId,
  version: intent.version,
  sourceCommit: intent.sourceCommit,
  architecture: intent.architecture,
  artifactDigest: intent.artifactDigest,
  sbomDigest: intent.sbomDigest,
  buildLogDigest: intent.buildLogDigest,
})
const scan: ImageScanEvidence = {
  schemaVersion: 1,
  scanner: 'trivy',
  reportDigest: digest('1'),
  scannedAt: now,
  result: 'passed',
}
const smokeTest: ImageTestEvidence = {
  schemaVersion: 1,
  testRunId: 'ci-test-run-20260823',
  reportDigest: digest('2'),
  completedAt: now,
  result: 'passed',
}
const testManifest = (overrides: Partial<Record<string, unknown>> = {}) => ({
  schemaVersion: 1,
  imageId: intent.imageId,
  testRunId: smokeTest.testRunId,
  sourceCommit: intent.sourceCommit,
  architecture: intent.architecture,
  artifactDigest: intent.artifactDigest,
  manifestDigest: intent.manifestDigest,
  scan,
  smokeTest,
  ...overrides,
})

describe('node image trusted evidence', () => {
  it('requires a configured CI signer instead of accepting a caller-selected signing key', async () => {
    const trusted = await signed(buildManifest())
    const attacker = await signed(buildManifest())
    const trustedIntent: CreateNodeImageIntent = {
      ...intent,
      manifestDigest: await hash(attacker.body),
      signature: {
        ...intent.signature,
        manifestDigest: await hash(attacker.body),
        detachedSignatureDigest: await hash(attacker.signature),
        publicKeyDigest: attacker.publicKeyDigest,
      },
    }
    const source: TrustedNodeImageEvidenceSourceShape = {
      loadBuild: () =>
        Effect.succeed({
          manifestBytes: attacker.body,
          detachedSignature: attacker.signature,
          publicKey: attacker.publicKey,
        }),
      loadTesting: () => Effect.die('not used'),
    }
    const verifier = makeTrustedNodeImageEvidenceVerifier(source, {
      trustedPublicKeyDigests: new Set([trusted.publicKeyDigest]),
    })
    await expect(Effect.runPromise(verifier.verifyBuild(trustedIntent))).rejects.toMatchObject({
      _tag: 'NodeImageValidationError',
      code: 'evidence_signer_untrusted',
    })
  })

  it('accepts only a signed test report bound to the authoritative immutable build', async () => {
    const testReport = await signed(testManifest())
    const source: TrustedNodeImageEvidenceSourceShape = {
      loadBuild: () => Effect.die('not used'),
      loadTesting: () =>
        Effect.succeed({
          build: {
            imageId: intent.imageId,
            revision: 1,
            sourceCommit: intent.sourceCommit,
            architecture: intent.architecture,
            artifactDigest: intent.artifactDigest,
            manifestDigest: intent.manifestDigest,
          },
          reportBytes: testReport.body,
          detachedSignature: testReport.signature,
          publicKey: testReport.publicKey,
        }),
    }
    const verifier = makeTrustedNodeImageEvidenceVerifier(source, {
      trustedPublicKeyDigests: new Set([testReport.publicKeyDigest]),
    })
    await expect(
      Effect.runPromise(
        verifier.verifyTesting({
          imageId: intent.imageId,
          intent: { schemaVersion: 1, expectedImageRevision: 1, testRunId: smokeTest.testRunId },
        }),
      ),
    ).resolves.toEqual({ scan, smokeTest })

    const forgedReport = await signed(testManifest({ artifactDigest: digest('9') }))
    const forgedVerifier = makeTrustedNodeImageEvidenceVerifier(
      {
        ...source,
        loadTesting: () =>
          Effect.succeed({
            build: {
              imageId: intent.imageId,
              revision: 1,
              sourceCommit: intent.sourceCommit,
              architecture: intent.architecture,
              artifactDigest: intent.artifactDigest,
              manifestDigest: intent.manifestDigest,
            },
            reportBytes: forgedReport.body,
            detachedSignature: forgedReport.signature,
            publicKey: forgedReport.publicKey,
          }),
      },
      { trustedPublicKeyDigests: new Set([forgedReport.publicKeyDigest]) },
    )
    await expect(
      Effect.runPromise(
        forgedVerifier.verifyTesting({
          imageId: intent.imageId,
          intent: { schemaVersion: 1, expectedImageRevision: 1, testRunId: smokeTest.testRunId },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: 'NodeImageValidationError',
      code: 'trusted_test_evidence_mismatch',
    })
  })
})

const replayAcceptance: NodeImageAcceptance = {
  disposition: 'created',
  operation: {
    id: 'image-op-replay',
    action: 'create',
    imageId: intent.imageId,
    scopeId: null,
    actorId: actor.identityId,
    idempotencyKey: 'node-image-replay-0001',
    requestFingerprint: 'a'.repeat(64),
    state: 'succeeded',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  },
  workflowStart: {
    id: 'image-workflow-start:replay',
    operationId: 'image-op-replay',
    workflowType: 'NodeImageLifecycleWorkflow',
    workflowInstanceId: 'image-op-replay',
    paramsFingerprint: 'a'.repeat(64),
    state: 'started',
    attempts: 1,
    lastError: null,
  },
}

describe('node image control replay', () => {
  it('adopts an exact durable acceptance before reading CI/R2 evidence', async () => {
    let evidenceReads = 0
    const repository: NodeImageRepositoryShape = {
      findReplay: (_key, fingerprint) =>
        Effect.succeed({
          ...replayAcceptance,
          operation: { ...replayAcceptance.operation, requestFingerprint: fingerprint },
          workflowStart: { ...replayAcceptance.workflowStart, paramsFingerprint: fingerprint },
        }),
      acceptAtomic: () => Effect.die('new acceptance must not execute for an exact replay'),
      markWorkflowStarted: () => Effect.void,
      recordWorkflowStartFailure: () => Effect.void,
    }
    const control = makeNodeImageControl({
      repository,
      workflows: { start: () => Effect.die('started replay must not start again') },
      clock: { now: Effect.succeed(now) },
      identities: makeWebCryptoNodeImageIdentity(),
      evidence: {
        verifyBuild: () => {
          evidenceReads += 1
          return Effect.fail(
            new NodeImageValidationError({
              code: 'evidence_store_unavailable',
              message: 'CI retention or signer rotation is unavailable',
            }),
          )
        },
        verifyTesting: () => Effect.die('not used'),
      },
    })
    const command: NodeImageCommand = {
      actor,
      idempotencyKey: 'node-image-replay-0001',
      correlationId: actor.correlationId,
      kind: 'create',
      intent,
    }
    await expect(Effect.runPromise(control.submit(command))).resolves.toEqual({
      disposition: 'adopted',
      operationId: replayAcceptance.operation.id,
      workflowState: 'started',
    })
    expect(evidenceReads).toBe(0)
  })
})

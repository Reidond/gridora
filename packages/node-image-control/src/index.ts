import { Context, Effect, Layer, Schema } from 'effect'
import type { PlatformActor } from '@gridora/platform-authority'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const IdempotencyKey = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const ExpectedRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)

export const NodeImageState = Schema.Literals([
  'building',
  'testing',
  'promoted',
  'deprecated',
  'revoked',
])
export type NodeImageState = typeof NodeImageState.Type
export const ProviderRegistrationState = Schema.Literals([
  'pending',
  'registered',
  'uncertain',
  'degraded',
  'revoked',
])
export type ProviderRegistrationState = typeof ProviderRegistrationState.Type
export const ProviderRegistrationMode = Schema.Literals(['custom-image', 'stock-ubuntu-cloud-init'])
export type ProviderRegistrationMode = typeof ProviderRegistrationMode.Type

/** A signed build identity is required before an image can leave `building`. */
export const ImageSignatureEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  algorithm: Schema.Literal('ed25519'),
  manifestDigest: Digest,
  detachedSignatureDigest: Digest,
  publicKeyDigest: Digest,
})
export type ImageSignatureEvidence = typeof ImageSignatureEvidence.Type

export const ImageScanEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scanner: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  reportDigest: Digest,
  scannedAt: Timestamp,
  result: Schema.Literal('passed'),
})
export type ImageScanEvidence = typeof ImageScanEvidence.Type

export const ImageTestEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  testRunId: Identifier,
  reportDigest: Digest,
  completedAt: Timestamp,
  result: Schema.Literal('passed'),
})
export type ImageTestEvidence = typeof ImageTestEvidence.Type

/** Immutable fields emitted by the pinned Packer build. Public callers cannot select a state. */
export const CreateNodeImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  imageId: Identifier,
  version: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sourceCommit: SourceCommit,
  architecture: Schema.Literal('amd64'),
  artifactDigest: Digest,
  manifestDigest: Digest,
  sbomDigest: Digest,
  buildLogDigest: Digest,
  signature: ImageSignatureEvidence,
})
export type CreateNodeImageIntent = typeof CreateNodeImageIntent.Type

export const TestNodeImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedImageRevision: Revision,
  /** CI-issued identifier; scan and smoke evidence are loaded from a trusted store. */
  testRunId: Identifier,
})
export type TestNodeImageIntent = typeof TestNodeImageIntent.Type

/** A scope is one provider-account, region, and CPU architecture policy boundary. */
export const ConfigureImageScopeIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeId: Identifier,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  providerAccountId: Identifier,
  region: Identifier,
  architecture: Schema.Literal('amd64'),
  allowStockUbuntuCloudInitFallback: Schema.Boolean,
  expectedScopeRevision: ExpectedRevision,
})
export type ConfigureImageScopeIntent = typeof ConfigureImageScopeIntent.Type

export const CustomImageRegistrationIntent = Schema.Struct({
  mode: Schema.Literal('custom-image'),
})
export const StockUbuntuCloudInitRegistrationIntent = Schema.Struct({
  mode: Schema.Literal('stock-ubuntu-cloud-init'),
  stockImageId: Identifier,
  cloudInitTemplateDigest: Digest,
})
export const RegisterProviderImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeId: Identifier,
  expectedImageRevision: Revision,
  expectedScopeRevision: Revision,
  expectedRegistrationRevision: ExpectedRevision,
  registration: Schema.Union([
    CustomImageRegistrationIntent,
    StockUbuntuCloudInitRegistrationIntent,
  ]),
})
export type RegisterProviderImageIntent = typeof RegisterProviderImageIntent.Type

export const PromoteNodeImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeId: Identifier,
  expectedImageRevision: Revision,
  expectedScopeRevision: Revision,
})
export type PromoteNodeImageIntent = typeof PromoteNodeImageIntent.Type

export const RollbackNodeImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  expectedScopeRevision: Revision,
})
export type RollbackNodeImageIntent = typeof RollbackNodeImageIntent.Type

export const RevokeNodeImageIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scopeId: Identifier,
  expectedImageRevision: Revision,
  expectedScopeRevision: Revision,
})
export type RevokeNodeImageIntent = typeof RevokeNodeImageIntent.Type

export class NodeImage extends Schema.Class<NodeImage>('NodeImage')({
  id: Identifier,
  version: Schema.String,
  sourceCommit: Schema.String,
  architecture: Schema.Literal('amd64'),
  artifactDigest: Digest,
  manifestDigest: Digest,
  sbomDigest: Digest,
  buildLogDigest: Digest,
  signature: Schema.Unknown,
  scan: Schema.NullOr(Schema.Unknown),
  smokeTest: Schema.NullOr(Schema.Unknown),
  state: NodeImageState,
  revision: Revision,
  legacyUnattested: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  promotedAt: Schema.NullOr(Timestamp),
  deprecatedAt: Schema.NullOr(Timestamp),
  revokedAt: Schema.NullOr(Timestamp),
}) {}

export class NodeImagePolicyScope extends Schema.Class<NodeImagePolicyScope>(
  'NodeImagePolicyScope',
)({
  id: Identifier,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  providerAccountId: Identifier,
  region: Identifier,
  architecture: Schema.Literal('amd64'),
  allowStockUbuntuCloudInitFallback: Schema.Boolean,
  promotedImageId: Schema.NullOr(Identifier),
  lastKnownGoodImageId: Schema.NullOr(Identifier),
  revision: Revision,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class ProviderImageRegistration extends Schema.Class<ProviderImageRegistration>(
  'ProviderImageRegistration',
)({
  id: Identifier,
  imageId: Identifier,
  scopeId: Identifier,
  providerType: Schema.Literals(['ovhcloud', 'contabo']),
  providerAccountId: Identifier,
  region: Identifier,
  architecture: Schema.Literal('amd64'),
  mode: ProviderRegistrationMode,
  providerImageId: Schema.NullOr(Identifier),
  providerRequestId: Schema.NullOr(Identifier),
  cloudInitTemplateDigest: Schema.NullOr(Digest),
  state: ProviderRegistrationState,
  degradedReason: Schema.NullOr(Schema.Literal('stock-ubuntu-cloud-init')),
  revision: Revision,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export const NodeImageAction = Schema.Literals([
  'create',
  'test',
  'configure-scope',
  'register-provider',
  'promote',
  'rollback',
  'revoke',
])
export type NodeImageAction = typeof NodeImageAction.Type

export interface NodeImageCommandBase {
  readonly actor: PlatformActor
  readonly idempotencyKey: string
  readonly correlationId: string
}
export type NodeImageCommand =
  | (NodeImageCommandBase & { readonly kind: 'create'; readonly intent: CreateNodeImageIntent })
  | (NodeImageCommandBase & {
      readonly kind: 'test'
      readonly imageId: string
      readonly intent: TestNodeImageIntent
    })
  | (NodeImageCommandBase & {
      readonly kind: 'configure-scope'
      readonly intent: ConfigureImageScopeIntent
    })
  | (NodeImageCommandBase & {
      readonly kind: 'register-provider'
      readonly imageId: string
      readonly intent: RegisterProviderImageIntent
    })
  | (NodeImageCommandBase & {
      readonly kind: 'promote'
      readonly imageId: string
      readonly intent: PromoteNodeImageIntent
    })
  | (NodeImageCommandBase & {
      readonly kind: 'rollback'
      readonly scopeId: string
      readonly intent: RollbackNodeImageIntent
    })
  | (NodeImageCommandBase & {
      readonly kind: 'revoke'
      readonly imageId: string
      readonly intent: RevokeNodeImageIntent
    })

export class NodeImageValidationError extends Schema.TaggedError<NodeImageValidationError>()(
  'NodeImageValidationError',
  { code: Schema.String, message: Schema.String },
) {}
export class NodeImageConflictError extends Schema.TaggedError<NodeImageConflictError>()(
  'NodeImageConflictError',
  {
    code: Schema.Literals([
      'idempotency_conflict',
      'revision_conflict',
      'invalid_transition',
      'registration_unavailable',
      'fallback_not_allowed',
      'last_known_good_unavailable',
      'image_in_use',
      'scope_mismatch',
    ]),
  },
) {}
export class NodeImagePersistenceError extends Schema.TaggedError<NodeImagePersistenceError>()(
  'NodeImagePersistenceError',
  { operation: Schema.String },
) {}
export class NodeImageWorkflowStartError extends Schema.TaggedError<NodeImageWorkflowStartError>()(
  'NodeImageWorkflowStartError',
  { operationId: Identifier, message: Schema.String },
) {}

export type NodeImageControlError =
  | NodeImageValidationError
  | NodeImageConflictError
  | NodeImagePersistenceError

export interface NodeImageOperation {
  readonly id: string
  readonly action: NodeImageAction
  readonly imageId: string | null
  readonly scopeId: string | null
  readonly actorId: string
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly state: 'queued' | 'running' | 'waiting-external' | 'succeeded' | 'failed-terminal'
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}
export interface NodeImageWorkflowStart {
  readonly id: string
  readonly operationId: string
  readonly workflowType: 'NodeImageLifecycleWorkflow'
  readonly workflowInstanceId: string
  readonly paramsFingerprint: string
  readonly state: 'pending' | 'started' | 'adopted'
  readonly attempts: number
  readonly lastError: string | null
}
export interface NodeImageAcceptance {
  readonly disposition: 'created' | 'adopted'
  readonly operation: NodeImageOperation
  readonly workflowStart: NodeImageWorkflowStart
}
export interface NodeImageIdentity {
  readonly operationId: string
  readonly workflowStartRecordId: string
  readonly auditEventId: string
  readonly outboxEventId: string
}
export interface NodeImageAtomicInput {
  readonly command: NodeImageCommand
  readonly identity: NodeImageIdentity
  readonly requestFingerprint: string
  /** The verifier resolves these facts from CI/R2 rather than trusting an HTTP body. */
  readonly verifiedTestingEvidence: {
    readonly scan: ImageScanEvidence
    readonly smokeTest: ImageTestEvidence
  } | null
  readonly now: string
}

export interface NodeImageRepositoryShape {
  readonly findReplay: (
    idempotencyKey: string,
    requestFingerprint: string,
  ) => Effect.Effect<NodeImageAcceptance | null, NodeImageConflictError | NodeImagePersistenceError>
  /** This transaction creates the operation, global audit, platform outbox, and pending Workflow start. */
  readonly acceptAtomic: (
    input: NodeImageAtomicInput,
  ) => Effect.Effect<NodeImageAcceptance, NodeImageConflictError | NodeImagePersistenceError>
  readonly markWorkflowStarted: (
    operationId: string,
  ) => Effect.Effect<void, NodeImagePersistenceError>
  readonly recordWorkflowStartFailure: (
    operationId: string,
    message: string,
  ) => Effect.Effect<void, NodeImagePersistenceError>
}
export class NodeImageRepository extends Context.Service<
  NodeImageRepository,
  NodeImageRepositoryShape
>()('@gridora/node-image-control/NodeImageRepository') {}
export const NodeImageRepositoryLayer = (repository: NodeImageRepositoryShape) =>
  Layer.succeed(NodeImageRepository, repository)

export interface NodeImageWorkflowStarterShape {
  readonly start: (
    acceptance: NodeImageAcceptance,
  ) => Effect.Effect<void, NodeImageWorkflowStartError>
}
export class NodeImageWorkflowStarter extends Context.Service<
  NodeImageWorkflowStarter,
  NodeImageWorkflowStarterShape
>()('@gridora/node-image-control/NodeImageWorkflowStarter') {}
export const NodeImageWorkflowStarterLayer = (starter: NodeImageWorkflowStarterShape) =>
  Layer.succeed(NodeImageWorkflowStarter, starter)

export interface NodeImageClockShape {
  readonly now: Effect.Effect<string>
}
export class NodeImageClock extends Context.Service<NodeImageClock, NodeImageClockShape>()(
  '@gridora/node-image-control/NodeImageClock',
) {}
export const NodeImageClockLayer = (clock: NodeImageClockShape) =>
  Layer.succeed(NodeImageClock, clock)

export interface NodeImageIdentityPortShape {
  readonly fingerprint: (
    command: NodeImageCommand,
  ) => Effect.Effect<string, NodeImageValidationError>
  readonly derive: (
    command: NodeImageCommand,
    requestFingerprint: string,
  ) => Effect.Effect<NodeImageIdentity, NodeImageValidationError>
}
export class NodeImageIdentityPort extends Context.Service<
  NodeImageIdentityPort,
  NodeImageIdentityPortShape
>()('@gridora/node-image-control/NodeImageIdentityPort') {}
export const NodeImageIdentityPortLayer = (identity: NodeImageIdentityPortShape) =>
  Layer.succeed(NodeImageIdentityPort, identity)

/**
 * A platform request carries only references and expected digests. This port
 * resolves immutable CI/R2 evidence and verifies its signature before control
 * persistence. It prevents a caller from self-asserting `passed` evidence.
 */
export interface NodeImageEvidenceVerifierShape {
  readonly verifyBuild: (
    intent: CreateNodeImageIntent,
  ) => Effect.Effect<void, NodeImageValidationError>
  readonly verifyTesting: (input: {
    readonly imageId: string
    readonly intent: TestNodeImageIntent
  }) => Effect.Effect<
    { readonly scan: ImageScanEvidence; readonly smokeTest: ImageTestEvidence },
    NodeImageValidationError
  >
}
export class NodeImageEvidenceVerifier extends Context.Service<
  NodeImageEvidenceVerifier,
  NodeImageEvidenceVerifierShape
>()('@gridora/node-image-control/NodeImageEvidenceVerifier') {}
export const NodeImageEvidenceVerifierLayer = (verifier: NodeImageEvidenceVerifierShape) =>
  Layer.succeed(NodeImageEvidenceVerifier, verifier)

export interface TrustedNodeImageEvidenceSourceShape {
  /**
   * This source is an internal CI/R2 reader. It must resolve artifacts by the
   * supplied immutable coordinates and must not read an HTTP request body.
   */
  readonly loadBuild: (input: {
    readonly imageId: string
    readonly artifactDigest: string
    readonly manifestDigest: string
  }) => Effect.Effect<
    {
      readonly manifestBytes: Uint8Array
      readonly detachedSignature: Uint8Array
      readonly publicKey: Uint8Array
    },
    NodeImageValidationError
  >
  /**
   * The reader loads the persisted build coordinates first, then the CI-signed
   * scan and smoke report for that exact build. The caller supplies no result
   * value and no signer identity.
   */
  readonly loadTesting: (input: {
    readonly imageId: string
    readonly expectedImageRevision: number
    readonly testRunId: string
  }) => Effect.Effect<
    {
      readonly build: {
        readonly imageId: string
        readonly revision: number
        readonly sourceCommit: string
        readonly architecture: 'amd64'
        readonly artifactDigest: string
        readonly manifestDigest: string
      }
      readonly reportBytes: Uint8Array
      readonly detachedSignature: Uint8Array
      readonly publicKey: Uint8Array
    },
    NodeImageValidationError
  >
}

/**
 * Signing keys are configured by platform deployment. They are not supplied by
 * an image request, an R2 object, or a provider response.
 */
export interface NodeImageEvidenceTrustPolicy {
  readonly trustedPublicKeyDigests: ReadonlySet<string>
}
const withSha256Prefix = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () =>
      `sha256:${Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')}`,
    catch: () =>
      new NodeImageValidationError({
        code: 'evidence_verification_failed',
        message: 'Node image evidence digest verification failed',
      }),
  })
const exactJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))

const SignedBuildManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  imageId: Identifier,
  version: Schema.String,
  sourceCommit: SourceCommit,
  architecture: Schema.Literal('amd64'),
  artifactDigest: Digest,
  sbomDigest: Digest,
  buildLogDigest: Digest,
})

const TrustedBuildCoordinates = Schema.Struct({
  imageId: Identifier,
  revision: Revision,
  sourceCommit: SourceCommit,
  architecture: Schema.Literal('amd64'),
  artifactDigest: Digest,
  manifestDigest: Digest,
})

const SignedTestingManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  imageId: Identifier,
  testRunId: Identifier,
  sourceCommit: SourceCommit,
  architecture: Schema.Literal('amd64'),
  artifactDigest: Digest,
  manifestDigest: Digest,
  scan: ImageScanEvidence,
  smokeTest: ImageTestEvidence,
})

const verifyEd25519 = (input: {
  readonly publicKey: Uint8Array
  readonly detachedSignature: Uint8Array
  readonly content: Uint8Array
}) =>
  Effect.tryPromise({
    try: async () =>
      crypto.subtle.verify(
        { name: 'Ed25519' },
        await crypto.subtle.importKey('raw', buffer(input.publicKey), { name: 'Ed25519' }, false, [
          'verify',
        ]),
        buffer(input.detachedSignature),
        buffer(input.content),
      ),
    catch: () =>
      new NodeImageValidationError({
        code: 'evidence_signature_invalid',
        message: 'Node image evidence signature verification failed',
      }),
  })

const decodeSignedManifest = <A>(schema: Schema.Codec<A, unknown, never>, bytes: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    catch: () =>
      new NodeImageValidationError({
        code: 'evidence_manifest_invalid',
        message: 'Node image signed evidence is invalid',
      }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
        Effect.mapError(
          () =>
            new NodeImageValidationError({
              code: 'evidence_manifest_invalid',
              message: 'Node image signed evidence is invalid',
            }),
        ),
      ),
    ),
  )

/** WebCrypto verifier for evidence returned by an authenticated internal CI/R2 reader. */
export const makeTrustedNodeImageEvidenceVerifier = (
  source: TrustedNodeImageEvidenceSourceShape,
  trust: NodeImageEvidenceTrustPolicy,
): NodeImageEvidenceVerifierShape => ({
  verifyBuild: (intent) =>
    Effect.gen(function* () {
      const loaded = yield* source.loadBuild({
        imageId: intent.imageId,
        artifactDigest: intent.artifactDigest,
        manifestDigest: intent.manifestDigest,
      })
      const [manifestDigest, signatureDigest, publicKeyDigest] = yield* Effect.all([
        withSha256Prefix(loaded.manifestBytes),
        withSha256Prefix(loaded.detachedSignature),
        withSha256Prefix(loaded.publicKey),
      ])
      if (
        manifestDigest !== intent.manifestDigest ||
        signatureDigest !== intent.signature.detachedSignatureDigest ||
        publicKeyDigest !== intent.signature.publicKeyDigest ||
        intent.signature.manifestDigest !== intent.manifestDigest
      )
        return yield* new NodeImageValidationError({
          code: 'evidence_digest_mismatch',
          message: 'Node image signature evidence does not match the trusted artifacts',
        })
      if (!trust.trustedPublicKeyDigests.has(publicKeyDigest))
        return yield* new NodeImageValidationError({
          code: 'evidence_signer_untrusted',
          message: 'Node image evidence was not signed by a configured CI key',
        })
      const verified = yield* verifyEd25519({
        publicKey: loaded.publicKey,
        detachedSignature: loaded.detachedSignature,
        content: loaded.manifestBytes,
      })
      if (!verified)
        return yield* new NodeImageValidationError({
          code: 'evidence_signature_invalid',
          message: 'Node image signature verification failed',
        })
      const manifest = yield* decodeSignedManifest(SignedBuildManifest, loaded.manifestBytes)
      if (
        !exactJson(manifest, {
          schemaVersion: 1,
          imageId: intent.imageId,
          version: intent.version,
          sourceCommit: intent.sourceCommit,
          architecture: intent.architecture,
          artifactDigest: intent.artifactDigest,
          sbomDigest: intent.sbomDigest,
          buildLogDigest: intent.buildLogDigest,
        })
      )
        return yield* new NodeImageValidationError({
          code: 'evidence_manifest_mismatch',
          message: 'Node image signed manifest does not match immutable build coordinates',
        })
    }),
  verifyTesting: ({ imageId, intent }) =>
    Effect.gen(function* () {
      const loaded = yield* source.loadTesting({
        imageId,
        expectedImageRevision: intent.expectedImageRevision,
        testRunId: intent.testRunId,
      })
      const build = yield* Schema.decodeUnknownEffect(TrustedBuildCoordinates, {
        onExcessProperty: 'error',
      })(loaded.build).pipe(
        Effect.mapError(
          () =>
            new NodeImageValidationError({
              code: 'trusted_test_evidence_mismatch',
              message: 'Trusted node image build coordinates are invalid',
            }),
        ),
      )
      const publicKeyDigest = yield* withSha256Prefix(loaded.publicKey)
      if (!trust.trustedPublicKeyDigests.has(publicKeyDigest))
        return yield* new NodeImageValidationError({
          code: 'evidence_signer_untrusted',
          message: 'Node image test evidence was not signed by a configured CI key',
        })
      const verified = yield* verifyEd25519({
        publicKey: loaded.publicKey,
        detachedSignature: loaded.detachedSignature,
        content: loaded.reportBytes,
      })
      if (!verified)
        return yield* new NodeImageValidationError({
          code: 'evidence_signature_invalid',
          message: 'Node image test evidence signature verification failed',
        })
      const report = yield* decodeSignedManifest(SignedTestingManifest, loaded.reportBytes)
      const exactBuild = {
        imageId: build.imageId,
        sourceCommit: build.sourceCommit,
        architecture: build.architecture,
        artifactDigest: build.artifactDigest,
        manifestDigest: build.manifestDigest,
      }
      const exactReport = {
        imageId: report.imageId,
        sourceCommit: report.sourceCommit,
        architecture: report.architecture,
        artifactDigest: report.artifactDigest,
        manifestDigest: report.manifestDigest,
      }
      if (
        build.imageId !== imageId ||
        build.revision !== intent.expectedImageRevision ||
        report.testRunId !== intent.testRunId ||
        report.smokeTest.testRunId !== intent.testRunId ||
        !exactJson(exactBuild, exactReport) ||
        report.scan.result !== 'passed' ||
        report.smokeTest.result !== 'passed'
      )
        return yield* new NodeImageValidationError({
          code: 'trusted_test_evidence_mismatch',
          message: 'Trusted node image test evidence does not match immutable build coordinates',
        })
      return { scan: report.scan, smokeTest: report.smokeTest }
    }),
})

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  return value
}

const commandBody = (command: NodeImageCommand): Record<string, unknown> => {
  switch (command.kind) {
    case 'create':
      return { kind: command.kind, imageId: command.intent.imageId, intent: command.intent }
    case 'configure-scope':
      return { kind: command.kind, scopeId: command.intent.scopeId, intent: command.intent }
    case 'rollback':
      return { kind: command.kind, scopeId: command.scopeId, intent: command.intent }
    default:
      return { kind: command.kind, imageId: command.imageId, intent: command.intent }
  }
}

export const canonicalNodeImageCommand = (command: NodeImageCommand): string =>
  JSON.stringify(
    canonicalValue({
      actorId: command.actor.identityId,
      ...commandBody(command),
    }),
  )

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const sha256 = (value: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', buffer(new TextEncoder().encode(value))),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    catch: () =>
      new NodeImageValidationError({
        code: 'fingerprint_unavailable',
        message: 'Node image command fingerprinting is unavailable',
      }),
  })

export const makeWebCryptoNodeImageIdentity = (): NodeImageIdentityPortShape => ({
  fingerprint: (command) => sha256(canonicalNodeImageCommand(command)),
  derive: (command, requestFingerprint) =>
    sha256(
      `gridora:node-image:v1:${command.actor.identityId}:${command.idempotencyKey}:${requestFingerprint}`,
    ).pipe(
      Effect.map((scope) => ({
        operationId: `image-op_${scope.slice(0, 24)}`,
        workflowStartRecordId: `image-workflow-start:${scope.slice(0, 24)}`,
        auditEventId: `audit-image_${scope.slice(0, 24)}`,
        outboxEventId: `outbox-image_${scope.slice(0, 24)}`,
      })),
    ),
})

const commandContract = Schema.Struct({
  actor: Schema.Struct({
    identityId: Identifier,
    accessSubject: Schema.String,
    correlationId: Identifier,
    administratorRevision: Revision,
  }),
  idempotencyKey: IdempotencyKey,
  correlationId: Identifier,
})

const validateCommand = (
  command: NodeImageCommand,
): Effect.Effect<void, NodeImageValidationError> =>
  Schema.decodeUnknownEffect(commandContract, { onExcessProperty: 'error' })({
    actor: command.actor,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
  }).pipe(
    Effect.asVoid,
    Effect.flatMap(() => {
      switch (command.kind) {
        case 'create':
          return Schema.decodeUnknownEffect(CreateNodeImageIntent, { onExcessProperty: 'error' })(
            command.intent,
          ).pipe(Effect.asVoid)
        case 'test':
          return Schema.decodeUnknownEffect(TestNodeImageIntent, { onExcessProperty: 'error' })(
            command.intent,
          ).pipe(Effect.asVoid)
        case 'configure-scope':
          return Schema.decodeUnknownEffect(ConfigureImageScopeIntent, {
            onExcessProperty: 'error',
          })(command.intent).pipe(Effect.asVoid)
        case 'register-provider':
          return Schema.decodeUnknownEffect(RegisterProviderImageIntent, {
            onExcessProperty: 'error',
          })(command.intent).pipe(Effect.asVoid)
        case 'promote':
          return Schema.decodeUnknownEffect(PromoteNodeImageIntent, {
            onExcessProperty: 'error',
          })(command.intent).pipe(Effect.asVoid)
        case 'rollback':
          return Schema.decodeUnknownEffect(RollbackNodeImageIntent, {
            onExcessProperty: 'error',
          })(command.intent).pipe(Effect.asVoid)
        case 'revoke':
          return Schema.decodeUnknownEffect(RevokeNodeImageIntent, {
            onExcessProperty: 'error',
          })(command.intent).pipe(Effect.asVoid)
      }
    }),
    Effect.mapError(
      () =>
        new NodeImageValidationError({
          code: 'invalid_node_image_command',
          message: 'Node image command does not match the platform contract',
        }),
    ),
  )

const startAccepted = (
  repository: NodeImageRepositoryShape,
  workflows: NodeImageWorkflowStarterShape,
  acceptance: NodeImageAcceptance,
): Effect.Effect<boolean, never> =>
  acceptance.workflowStart.state === 'started' || acceptance.workflowStart.state === 'adopted'
    ? Effect.succeed(true)
    : workflows.start(acceptance).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            repository.recordWorkflowStartFailure(acceptance.operation.id, error.message).pipe(
              Effect.catch(() => Effect.void),
              Effect.as(false),
            ),
          onSuccess: () =>
            repository
              .markWorkflowStarted(acceptance.operation.id)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
        }),
      )

export interface NodeImageControlShape {
  readonly submit: (command: NodeImageCommand) => Effect.Effect<
    {
      readonly disposition: 'created' | 'adopted'
      readonly operationId: string
      readonly workflowState: 'started' | 'pending-reconciliation'
    },
    NodeImageControlError
  >
}
export class NodeImageControl extends Context.Service<NodeImageControl, NodeImageControlShape>()(
  '@gridora/node-image-control/NodeImageControl',
) {}

export const makeNodeImageControl = (dependencies: {
  readonly repository: NodeImageRepositoryShape
  readonly workflows: NodeImageWorkflowStarterShape
  readonly clock: NodeImageClockShape
  readonly identities: NodeImageIdentityPortShape
  readonly evidence: NodeImageEvidenceVerifierShape
}): NodeImageControlShape => ({
  submit: (
    command,
  ): Effect.Effect<
    {
      readonly disposition: 'created' | 'adopted'
      readonly operationId: string
      readonly workflowState: 'started' | 'pending-reconciliation'
    },
    NodeImageControlError
  > =>
    Effect.gen(function* () {
      yield* validateCommand(command)
      const requestFingerprint = yield* dependencies.identities.fingerprint(command)
      const replay = yield* dependencies.repository.findReplay(
        command.idempotencyKey,
        requestFingerprint,
      )
      const acceptance =
        replay === null
          ? yield* Effect.gen(function* () {
              // An exact durable acceptance wins over later CI/R2 retention
              // or key-rotation changes. Evidence is required only before a
              // new acceptance can be persisted.
              const verifiedTestingEvidence =
                command.kind === 'create'
                  ? (yield* dependencies.evidence.verifyBuild(command.intent), null)
                  : command.kind === 'test'
                    ? yield* dependencies.evidence.verifyTesting({
                        imageId: command.imageId,
                        intent: command.intent,
                      })
                    : null
              return yield* dependencies.repository.acceptAtomic({
                command,
                identity: yield* dependencies.identities.derive(command, requestFingerprint),
                requestFingerprint,
                verifiedTestingEvidence,
                now: yield* dependencies.clock.now,
              })
            })
          : { ...replay, disposition: 'adopted' as const }
      const started = yield* startAccepted(
        dependencies.repository,
        dependencies.workflows,
        acceptance,
      )
      return {
        disposition: acceptance.disposition,
        operationId: acceptance.operation.id,
        workflowState: started ? 'started' : 'pending-reconciliation',
      }
    }),
})

export const NodeImageControlLive = Layer.effect(
  NodeImageControl,
  Effect.gen(function* () {
    return NodeImageControl.of(
      makeNodeImageControl({
        repository: yield* NodeImageRepository,
        workflows: yield* NodeImageWorkflowStarter,
        clock: yield* NodeImageClock,
        identities: yield* NodeImageIdentityPort,
        evidence: yield* NodeImageEvidenceVerifier,
      }),
    )
  }),
)

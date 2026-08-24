import { Context, Effect, Layer, Schema } from 'effect'
import {
  NodeProvisionExecutionReservationPort,
  RegistrationTokenSecret,
  type NodeProvisionExecutionReservation,
  type NodeProvisionExecutionReservationPortShape,
  type RegistrationTokenSecretShape,
} from '@gridora/node-provision-control'
import {
  ProviderCreateRuntime,
  type AuthoritativeProviderAccount,
  type ProviderCreateRuntimeShape,
} from '@gridora/provider-runtime'
import {
  ProviderCreateUncertainError,
  type ProviderError,
  type ProviderNode,
} from '@gridora/provider-sdk'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

/** Authenticated Workflow input. No public create endpoint accepts this contract. */
export const NodeProvisionExecutionRequest = Schema.Struct({
  organizationId: Identifier,
  operationId: Identifier,
  attemptedAt: Timestamp,
})
export type NodeProvisionExecutionRequest = typeof NodeProvisionExecutionRequest.Type

export interface NodeProvisionExecutionResult {
  readonly disposition: 'completed' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerInstanceId: string
  readonly providerState:
    | 'creating'
    | 'active'
    | 'stopped'
    | 'rebuilding'
    | 'retiring'
    | 'retired'
    | 'unknown'
  /** Provider creation is not node readiness. Agent, Tunnel, image, and runtime observations decide ready. */
  readonly state: 'waiting-for-agent'
}

export class NodeProvisionExecutionValidationError extends Schema.TaggedError<NodeProvisionExecutionValidationError>()(
  'NodeProvisionExecutionValidationError',
  { code: Schema.String },
) {}
export class NodeProvisionCredentialError extends Schema.TaggedError<NodeProvisionCredentialError>()(
  'NodeProvisionCredentialError',
  { operation: Schema.String },
) {}
export class NodeProvisionExecutionPersistenceError extends Schema.TaggedError<NodeProvisionExecutionPersistenceError>()(
  'NodeProvisionExecutionPersistenceError',
  { operation: Schema.String },
) {}
export class NodeProvisionExecutionConflictError extends Schema.TaggedError<NodeProvisionExecutionConflictError>()(
  'NodeProvisionExecutionConflictError',
  { operation: Schema.String },
) {}

export type NodeProvisionExecutionError =
  | NodeProvisionExecutionValidationError
  | NodeProvisionCredentialError
  | NodeProvisionExecutionPersistenceError
  | NodeProvisionExecutionConflictError
  | ProviderError

export interface ExactProviderCredential {
  readonly account: AuthoritativeProviderAccount
  /** Exact SecretEnvelope revision opened by the implementation. */
  readonly envelopeRevision: number
  /** Ownership transfers to the caller, which clears this buffer in all exits. */
  readonly credentialBytes: Uint8Array
}

/**
 * Composition must tenant-read account metadata and its envelope, open that exact envelope, then
 * re-read the same account/envelope revisions before returning. It must never return plaintext in
 * an error, log, audit record, or queue payload.
 */
export interface ProviderCredentialSecretPortShape {
  readonly openExact: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly operationId: string
    readonly providerAccountId: string
    readonly expectedAccountRevision: number
    readonly expectedProviderType: 'ovhcloud' | 'contabo'
  }) => Effect.Effect<ExactProviderCredential, NodeProvisionCredentialError>
}
export class ProviderCredentialSecretPort extends Context.Service<
  ProviderCredentialSecretPort,
  ProviderCredentialSecretPortShape
>()('@gridora/node-provision-execution/ProviderCredentialSecretPort') {}
export const ProviderCredentialSecretPortLayer = (port: ProviderCredentialSecretPortShape) =>
  Layer.succeed(ProviderCredentialSecretPort, port)

export type ProviderCreateMode = 'create_or_adopt' | 'adopt_only'

export interface NodeProvisionExecutionCompletionInput {
  readonly reservation: NodeProvisionExecutionReservation
  readonly account: AuthoritativeProviderAccount
  readonly envelopeRevision: number
  readonly providerNode: ProviderNode
  /** SHA-256 of the exact UTF-8 token written to cloud-init. Never the token itself. */
  readonly deliveredTokenHash: string
  readonly completedAt: string
}

export interface NodeProvisionExecutionPreparation {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerAccountId: string
  readonly providerAccountRevision: number
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly envelopeRevision: number
  readonly derivationTokenHash: string
  readonly deliveredTokenHash: string
  readonly bootstrapExpiresAt: string
  readonly state: 'active'
}

export interface NodeProvisionExecutionFailureInput {
  readonly reservation: NodeProvisionExecutionReservation
  readonly attemptedAt: string
  readonly category: string
  readonly retryable: boolean
  readonly attemptNumber: number
}

export interface NodeProvisionExecutionRepositoryShape {
  readonly findCompletion: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<NodeProvisionExecutionResult | null, NodeProvisionExecutionPersistenceError>
  readonly findPreparation: (
    organizationId: string,
    operationId: string,
  ) => Effect.Effect<
    NodeProvisionExecutionPreparation | null,
    NodeProvisionExecutionPersistenceError
  >
  /** Queued may claim create-or-adopt once. Every later nonterminal state is adopt-only. */
  readonly beginAttempt: (input: {
    readonly reservation: NodeProvisionExecutionReservation
    readonly account: AuthoritativeProviderAccount
    readonly envelopeRevision: number
    readonly derivationTokenHash: string
    readonly deliveredTokenHash: string
    readonly bootstrapExpiresAt: string
    readonly attemptedAt: string
  }) => Effect.Effect<
    { readonly mode: ProviderCreateMode; readonly attemptNumber: number },
    NodeProvisionExecutionPersistenceError | NodeProvisionExecutionConflictError
  >
  readonly completeAtomic: (
    input: NodeProvisionExecutionCompletionInput,
  ) => Effect.Effect<
    NodeProvisionExecutionResult,
    NodeProvisionExecutionPersistenceError | NodeProvisionExecutionConflictError
  >
  readonly recordFailureAtomic: (
    input: NodeProvisionExecutionFailureInput,
  ) => Effect.Effect<void, NodeProvisionExecutionPersistenceError>
}
export class NodeProvisionExecutionRepository extends Context.Service<
  NodeProvisionExecutionRepository,
  NodeProvisionExecutionRepositoryShape
>()('@gridora/node-provision-execution/NodeProvisionExecutionRepository') {}
export const NodeProvisionExecutionRepositoryLayer = (
  repository: NodeProvisionExecutionRepositoryShape,
) => Layer.succeed(NodeProvisionExecutionRepository, repository)

export interface ProvisionalNodeRegistrationBindingResult {
  readonly disposition: 'bound' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly providerInstanceId: string
  readonly expiresAt: string
}

/**
 * Internal registration-exchange seam. The caller hashes the presented token and supplies the
 * instance ID obtained by the image helper from an allow-listed provider metadata endpoint.
 */
export interface ProvisionalNodeRegistrationBindingPortShape {
  readonly bindFirst: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly deliveredTokenHash: string
    readonly providerInstanceId: string
    readonly boundAt: string
  }) => Effect.Effect<
    ProvisionalNodeRegistrationBindingResult,
    NodeProvisionExecutionPersistenceError | NodeProvisionExecutionConflictError
  >
}
export class ProvisionalNodeRegistrationBindingPort extends Context.Service<
  ProvisionalNodeRegistrationBindingPort,
  ProvisionalNodeRegistrationBindingPortShape
>()('@gridora/node-provision-execution/ProvisionalNodeRegistrationBindingPort') {}
export const ProvisionalNodeRegistrationBindingPortLayer = (
  port: ProvisionalNodeRegistrationBindingPortShape,
) => Layer.succeed(ProvisionalNodeRegistrationBindingPort, port)

/**
 * Atomically exchanges the operation-bound bootstrap token when a VM reaches the
 * API before the provider create response. Binding the provider identity and
 * consuming the token must be one D1 transaction: a sequential `bindFirst` /
 * generic registration exchange can leave a booted VM with an unusable token.
 *
 * `null` is deliberately reserved for a token that is not a provisional
 * node-provision token. The API may then use the legacy registration exchange;
 * any provisional mismatch, expiry, replay collision, or fence failure is an
 * error and must never fall through to that legacy path.
 */
export interface ProvisionalNodeRegistrationExchangeResult {
  readonly disposition: 'bound' | 'adopted'
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerInstanceId: string
  readonly credentialId: string
  readonly credentialVersion: number
  readonly sessionVersion: number
}

export interface ProvisionalNodeRegistrationExchangePortShape {
  readonly exchange: (input: {
    readonly organizationId: string
    readonly nodeId: string
    readonly deliveredTokenHash: string
    readonly providerInstanceId: string
    readonly credentialId: string
    readonly credentialHash: string
    readonly agentVersion: string
    readonly installerPublicKey: string
    readonly installerPublicKeyFingerprint: string
    /** Trusted control-plane time, never a VM-supplied timestamp. */
    readonly now: string
  }) => Effect.Effect<
    ProvisionalNodeRegistrationExchangeResult | null,
    NodeProvisionExecutionPersistenceError | NodeProvisionExecutionConflictError
  >
}
export class ProvisionalNodeRegistrationExchangePort extends Context.Service<
  ProvisionalNodeRegistrationExchangePort,
  ProvisionalNodeRegistrationExchangePortShape
>()('@gridora/node-provision-execution/ProvisionalNodeRegistrationExchangePort') {}
export const ProvisionalNodeRegistrationExchangePortLayer = (
  port: ProvisionalNodeRegistrationExchangePortShape,
) => Layer.succeed(ProvisionalNodeRegistrationExchangePort, port)

/**
 * The image helper consumes only these immutable, non-secret reservation facts.
 * Provisioning and rebuild workflows both use the same signed image handoff, but
 * a rebuild must never impersonate a node-provision acceptance just to render
 * cloud-init.
 */
export interface NodeBootstrapReservation {
  readonly organizationId: string
  readonly nodeId: string
  readonly operationId: string
  readonly providerType: 'ovhcloud' | 'contabo'
  readonly imageId: string
  readonly imageVersion: string
  readonly imageChecksum: string
  readonly providerImageId: string
}

export interface NodeBootstrapCloudInitInput {
  readonly reservation: NodeBootstrapReservation
  readonly registrationTokenBytes: Uint8Array
  readonly registrationExpiresAt: string
  readonly trusted: NodeBootstrapTrustedConfiguration
}

export interface NodeBootstrapTrustedConfiguration {
  readonly controlPlaneUrl: string
  readonly expectedControlPlaneHost: string
  readonly allowLoopbackHttp: boolean
  readonly agentVersion: string
  readonly dockerSocket: '/var/run/docker.sock' | '/run/docker.sock'
  readonly pollWaitSeconds: number
  readonly registrationTtlSeconds: number
  /** Ed25519 public key PEM only. Private key material is forbidden. */
  readonly commandSigningPublicKeyPem: string
  readonly providerInstanceDiscovery: {
    readonly mode: 'image-metadata-helper-v1'
    readonly helperUnit: 'gridora-node-bootstrap.service'
  }
}

export interface NodeBootstrapCloudInitShape {
  /** Returned bytes are ephemeral and owned by the caller. */
  readonly render: (
    input: NodeBootstrapCloudInitInput,
  ) => Effect.Effect<Uint8Array, NodeProvisionExecutionValidationError>
}
export class NodeBootstrapCloudInit extends Context.Service<
  NodeBootstrapCloudInit,
  NodeBootstrapCloudInitShape
>()('@gridora/node-provision-execution/NodeBootstrapCloudInit') {}
export const NodeBootstrapCloudInitLayer = (renderer: NodeBootstrapCloudInitShape) =>
  Layer.succeed(NodeBootstrapCloudInit, renderer)

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Exact ADR 0045 image-helper manifest. The helper, not cloud-init, reads cached instance data. */
export const nodeBootstrapCloudInit: NodeBootstrapCloudInitShape = {
  render: ({ reservation, registrationTokenBytes, registrationExpiresAt, trusted }) =>
    Effect.try({
      try: () => {
        if (registrationTokenBytes.byteLength !== 64)
          throw new Error('registration token text must be 64 bytes')
        const registrationToken = new TextDecoder('utf-8', { fatal: true }).decode(
          registrationTokenBytes,
        )
        if (!/^[a-f0-9]{64}$/.test(registrationToken))
          throw new Error('registration token text is invalid')
        const manifest = new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            organizationId: reservation.organizationId,
            nodeId: reservation.nodeId,
            operationId: reservation.operationId,
            providerType: reservation.providerType,
            imageId: reservation.imageId,
            providerImageId: reservation.providerImageId,
            imageVersion: reservation.imageVersion,
            imageChecksum: reservation.imageChecksum,
            controlPlaneUrl: trusted.controlPlaneUrl,
            expectedControlPlaneHost: trusted.expectedControlPlaneHost,
            allowLoopbackHttp: trusted.allowLoopbackHttp,
            agentVersion: trusted.agentVersion,
            dockerSocket: trusted.dockerSocket,
            pollWaitSeconds: trusted.pollWaitSeconds,
            registrationExpiresAt,
            registrationToken,
            commandSigningPublicKeyPem: trusted.commandSigningPublicKeyPem,
          }),
        )
        try {
          return new TextEncoder().encode(
            [
              '#cloud-config',
              'write_files:',
              '  - path: /var/lib/gridora/bootstrap/reservation.json',
              '    owner: root:root',
              "    permissions: '0600'",
              '    encoding: b64',
              `    content: ${base64(manifest)}`,
              'final_message: "Gridora node bootstrap initiated"',
              '',
            ].join('\n'),
          )
        } finally {
          manifest.fill(0)
        }
      },
      catch: () => new NodeProvisionExecutionValidationError({ code: 'cloud_init_invalid' }),
    }),
}

export const NodeBootstrapCloudInitLive = Layer.succeed(
  NodeBootstrapCloudInit,
  nodeBootstrapCloudInit,
)

export class NodeBootstrapTrustedConfig extends Context.Service<
  NodeBootstrapTrustedConfig,
  NodeBootstrapTrustedConfiguration
>()('@gridora/node-provision-execution/NodeBootstrapTrustedConfig') {}
export const NodeBootstrapTrustedConfigLayer = (configuration: NodeBootstrapTrustedConfiguration) =>
  Layer.succeed(NodeBootstrapTrustedConfig, configuration)

export interface NodeProvisionExecutionClockShape {
  readonly now: Effect.Effect<{ readonly iso: string; readonly epochMilliseconds: number }>
}
export class NodeProvisionExecutionClock extends Context.Service<
  NodeProvisionExecutionClock,
  NodeProvisionExecutionClockShape
>()('@gridora/node-provision-execution/NodeProvisionExecutionClock') {}
export const NodeProvisionExecutionClockLayer = (clock: NodeProvisionExecutionClockShape) =>
  Layer.succeed(NodeProvisionExecutionClock, clock)

const validateRequest = (request: NodeProvisionExecutionRequest) =>
  Schema.decodeUnknownEffect(NodeProvisionExecutionRequest, { onExcessProperty: 'error' })(
    request,
  ).pipe(
    Effect.mapError(
      () => new NodeProvisionExecutionValidationError({ code: 'invalid_execution_request' }),
    ),
  )

const validateOpening = (
  reservation: NodeProvisionExecutionReservation,
  opened: ExactProviderCredential,
) => {
  const account = opened.account
  if (
    opened.credentialBytes.byteLength === 0 ||
    !Number.isSafeInteger(opened.envelopeRevision) ||
    opened.envelopeRevision < 1 ||
    account.id !== reservation.providerAccountId ||
    account.providerType !== reservation.providerType ||
    account.revision !== reservation.providerAccountRevision ||
    account.status !== 'active' ||
    (account.scope === 'organization' && account.organizationId !== reservation.organizationId) ||
    (account.scope === 'platform' && account.organizationId !== null)
  )
    return Effect.fail(new NodeProvisionCredentialError({ operation: 'credential.fence' }))
  return Effect.void
}

const validateTrustedBootstrap = (
  trusted: NodeBootstrapTrustedConfiguration,
): Effect.Effect<void, NodeProvisionExecutionValidationError> =>
  Effect.try({
    try: () => {
      const url = new URL(trusted.controlPlaneUrl)
      const loopback =
        url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
      if (
        url.hostname !== trusted.expectedControlPlaneHost ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== '' ||
        (url.protocol !== 'https:' &&
          !(trusted.allowLoopbackHttp && loopback && url.protocol === 'http:')) ||
        trusted.agentVersion.length < 1 ||
        trusted.agentVersion.length > 128 ||
        !Number.isSafeInteger(trusted.pollWaitSeconds) ||
        trusted.pollWaitSeconds < 1 ||
        trusted.pollWaitSeconds > 30 ||
        !Number.isSafeInteger(trusted.registrationTtlSeconds) ||
        trusted.registrationTtlSeconds < 900 ||
        trusted.registrationTtlSeconds > 86_400 ||
        trusted.providerInstanceDiscovery.mode !== 'image-metadata-helper-v1' ||
        trusted.providerInstanceDiscovery.helperUnit !== 'gridora-node-bootstrap.service' ||
        !trusted.commandSigningPublicKeyPem.includes('-----BEGIN PUBLIC KEY-----') ||
        !trusted.commandSigningPublicKeyPem.includes('-----END PUBLIC KEY-----') ||
        trusted.commandSigningPublicKeyPem.includes('PRIVATE KEY')
      )
        throw new Error('invalid trusted bootstrap configuration')
    },
    catch: () => new NodeProvisionExecutionValidationError({ code: 'trusted_bootstrap_invalid' }),
  })

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const sha256 = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)))),
    catch: () => new NodeProvisionExecutionValidationError({ code: 'token_hash_failed' }),
  })

const tokenTextBytes = (secret: Uint8Array): Uint8Array => new TextEncoder().encode(hex(secret))

const providerName = (reservation: NodeProvisionExecutionReservation): string =>
  `gridora-${reservation.nodeId}`

const retryableProviderFailure = (error: ProviderError): boolean =>
  error._tag === 'ProviderCreateUncertainError' ||
  error._tag === 'ProviderRateLimitError' ||
  error._tag === 'ProviderTemporaryError'

const safeProviderCategory = (error: ProviderError): string => error._tag

const executeFresh = (
  dependencies: {
    readonly reservations: NodeProvisionExecutionReservationPortShape
    readonly credentials: ProviderCredentialSecretPortShape
    readonly registrationTokens: RegistrationTokenSecretShape
    readonly cloudInit: NodeBootstrapCloudInitShape
    readonly provider: ProviderCreateRuntimeShape
    readonly repository: NodeProvisionExecutionRepositoryShape
    readonly clock: NodeProvisionExecutionClockShape
    readonly trustedBootstrap: NodeBootstrapTrustedConfiguration
  },
  request: NodeProvisionExecutionRequest,
): Effect.Effect<NodeProvisionExecutionResult, NodeProvisionExecutionError> =>
  Effect.gen(function* () {
    const reservation = yield* dependencies.reservations
      .load(request.organizationId, request.operationId)
      .pipe(
        Effect.mapError(
          () =>
            new NodeProvisionExecutionValidationError({
              code: 'execution_reservation_unavailable',
            }),
        ),
      )
    const preparation = yield* dependencies.repository.findPreparation(
      request.organizationId,
      request.operationId,
    )
    const receivedAt = yield* dependencies.clock.now
    const requestedAtEpochMilliseconds = Date.parse(request.attemptedAt)
    if (
      reservation.organizationId !== request.organizationId ||
      reservation.operationId !== request.operationId ||
      !Number.isFinite(requestedAtEpochMilliseconds) ||
      Math.abs(receivedAt.epochMilliseconds - requestedAtEpochMilliseconds) > 5 * 60 * 1000 ||
      (preparation === null && reservation.bootstrapToken.state !== 'reserved') ||
      (preparation !== null &&
        (reservation.bootstrapToken.state !== 'materialized' ||
          preparation.organizationId !== reservation.organizationId ||
          preparation.nodeId !== reservation.nodeId ||
          preparation.operationId !== reservation.operationId ||
          preparation.providerAccountId !== reservation.providerAccountId ||
          preparation.providerAccountRevision !== reservation.providerAccountRevision ||
          preparation.providerType !== reservation.providerType ||
          preparation.deliveredTokenHash !== reservation.bootstrapToken.tokenHash ||
          preparation.bootstrapExpiresAt !== reservation.bootstrapToken.expiresAt ||
          Date.parse(preparation.bootstrapExpiresAt) <= receivedAt.epochMilliseconds))
    )
      return yield* new NodeProvisionExecutionValidationError({
        code: 'execution_reservation_invalid',
      })
    yield* validateTrustedBootstrap(dependencies.trustedBootstrap)

    const opened = yield* dependencies.credentials.openExact({
      organizationId: reservation.organizationId,
      nodeId: reservation.nodeId,
      operationId: reservation.operationId,
      providerAccountId: reservation.providerAccountId,
      expectedAccountRevision: reservation.providerAccountRevision,
      expectedProviderType: reservation.providerType,
    })
    return yield* Effect.acquireUseRelease(
      Effect.succeed(opened),
      (exact) =>
        Effect.gen(function* () {
          yield* validateOpening(reservation, exact)
          const rawToken = yield* dependencies.registrationTokens
            .recoverBytes(
              {
                organizationId: reservation.organizationId,
                nodeId: reservation.nodeId,
                operationId: reservation.operationId,
                tokenRecordId: reservation.bootstrapToken.recordId,
              },
              reservation.bootstrapToken.keyVersion,
              preparation?.derivationTokenHash ?? reservation.bootstrapToken.tokenHash,
            )
            .pipe(
              Effect.mapError(
                () => new NodeProvisionCredentialError({ operation: 'registration-token.open' }),
              ),
            )
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => rawToken),
            (raw) =>
              Effect.gen(function* () {
                const deliveredToken = tokenTextBytes(raw)
                return yield* Effect.acquireUseRelease(
                  Effect.succeed(deliveredToken),
                  (token) =>
                    Effect.gen(function* () {
                      const deliveredTokenHash = yield* sha256(token)
                      if (
                        preparation !== null &&
                        preparation.deliveredTokenHash !== deliveredTokenHash
                      )
                        return yield* new NodeProvisionExecutionValidationError({
                          code: 'prepared_token_mismatch',
                        })
                      const callTime = yield* dependencies.clock.now
                      const bootstrapExpiresAt =
                        preparation?.bootstrapExpiresAt ??
                        new Date(
                          callTime.epochMilliseconds +
                            dependencies.trustedBootstrap.registrationTtlSeconds * 1000,
                        ).toISOString()
                      if (Date.parse(bootstrapExpiresAt) <= callTime.epochMilliseconds)
                        return yield* new NodeProvisionExecutionValidationError({
                          code: 'bootstrap_token_expired',
                        })
                      const cloudInit = yield* dependencies.cloudInit.render({
                        reservation,
                        registrationTokenBytes: token,
                        registrationExpiresAt: bootstrapExpiresAt,
                        trusted: dependencies.trustedBootstrap,
                      })
                      return yield* Effect.acquireUseRelease(
                        Effect.succeed(cloudInit),
                        (cloudInitBytes) =>
                          Effect.gen(function* () {
                            const claim = yield* dependencies.repository.beginAttempt({
                              reservation,
                              account: exact.account,
                              envelopeRevision: exact.envelopeRevision,
                              derivationTokenHash:
                                preparation?.derivationTokenHash ??
                                reservation.bootstrapToken.tokenHash,
                              deliveredTokenHash,
                              bootstrapExpiresAt,
                              attemptedAt: callTime.iso,
                            })
                            const providerResult = yield* Effect.result(
                              dependencies.provider.createOrAdopt({
                                account: exact.account,
                                accepted: {
                                  organizationId: reservation.organizationId,
                                  nodeId: reservation.nodeId,
                                  operationId: reservation.operationId,
                                  providerAccountId: reservation.providerAccountId,
                                  providerAccountRevision: reservation.providerAccountRevision,
                                  providerType: reservation.providerType,
                                  regionId: reservation.region,
                                  planId: reservation.plan,
                                  providerImageId: reservation.providerImageId,
                                  imageVersion: reservation.imageVersion,
                                  commercialTerms: reservation.billing,
                                },
                                credentialBytes: exact.credentialBytes,
                                node: {
                                  organizationId: reservation.organizationId,
                                  operationId: reservation.operationId,
                                  nodeId: reservation.nodeId,
                                  name: providerName(reservation),
                                  regionId: reservation.region,
                                  planId: reservation.plan,
                                  imageId: reservation.providerImageId,
                                  imageVersion: reservation.imageVersion,
                                  cloudInit: new TextDecoder().decode(cloudInitBytes),
                                  createMode: claim.mode,
                                  adoptionAttempt: claim.attemptNumber,
                                  adoptionDeadlineAtEpochMs: Date.parse(bootstrapExpiresAt),
                                },
                              }),
                            )
                            if (providerResult._tag === 'Failure') {
                              const providerError = providerResult.failure
                              yield* dependencies.repository
                                .recordFailureAtomic({
                                  reservation,
                                  attemptedAt: callTime.iso,
                                  category: safeProviderCategory(providerError),
                                  retryable: retryableProviderFailure(providerError),
                                  attemptNumber:
                                    providerError instanceof ProviderCreateUncertainError
                                      ? providerError.nextAttemptNumber
                                      : claim.attemptNumber,
                                })
                                .pipe(Effect.catch(() => Effect.void))
                              return yield* providerError
                            }
                            const completionTime = yield* dependencies.clock.now
                            return yield* dependencies.repository.completeAtomic({
                              reservation,
                              account: exact.account,
                              envelopeRevision: exact.envelopeRevision,
                              providerNode: providerResult.success,
                              deliveredTokenHash,
                              completedAt: completionTime.iso,
                            })
                          }),
                        (bytes) => Effect.sync(() => bytes.fill(0)),
                      )
                    }),
                  (bytes) => Effect.sync(() => bytes.fill(0)),
                )
              }),
            (bytes) => Effect.sync(() => bytes.fill(0)),
          )
        }),
      (exact) => Effect.sync(() => exact.credentialBytes.fill(0)),
    )
  })

export interface NodeProvisionExecutionShape {
  readonly execute: (
    request: NodeProvisionExecutionRequest,
  ) => Effect.Effect<NodeProvisionExecutionResult, NodeProvisionExecutionError>
}
export class NodeProvisionExecution extends Context.Service<
  NodeProvisionExecution,
  NodeProvisionExecutionShape
>()('@gridora/node-provision-execution/NodeProvisionExecution') {}

export const makeNodeProvisionExecution = (dependencies: {
  readonly reservations: NodeProvisionExecutionReservationPortShape
  readonly credentials: ProviderCredentialSecretPortShape
  readonly registrationTokens: RegistrationTokenSecretShape
  readonly cloudInit: NodeBootstrapCloudInitShape
  readonly provider: ProviderCreateRuntimeShape
  readonly repository: NodeProvisionExecutionRepositoryShape
  readonly clock: NodeProvisionExecutionClockShape
  readonly trustedBootstrap: NodeBootstrapTrustedConfiguration
}): NodeProvisionExecutionShape => ({
  execute: (request) =>
    Effect.gen(function* () {
      const valid = yield* validateRequest(request)
      const completion = yield* dependencies.repository.findCompletion(
        valid.organizationId,
        valid.operationId,
      )
      if (completion !== null) return { ...completion, disposition: 'adopted' as const }
      return yield* executeFresh(dependencies, valid)
    }),
})

export const NodeProvisionExecutionLive = Layer.effect(
  NodeProvisionExecution,
  Effect.gen(function* () {
    return NodeProvisionExecution.of(
      makeNodeProvisionExecution({
        reservations: yield* NodeProvisionExecutionReservationPort,
        credentials: yield* ProviderCredentialSecretPort,
        registrationTokens: yield* RegistrationTokenSecret,
        cloudInit: yield* NodeBootstrapCloudInit,
        provider: yield* ProviderCreateRuntime,
        repository: yield* NodeProvisionExecutionRepository,
        clock: yield* NodeProvisionExecutionClock,
        trustedBootstrap: yield* NodeBootstrapTrustedConfig,
      }),
    )
  }),
)

export const NodeProvisionExecutionResultContract = Schema.Struct({
  disposition: Schema.Literals(['completed', 'adopted']),
  organizationId: Identifier,
  nodeId: Identifier,
  operationId: Identifier,
  providerInstanceId: Identifier,
  providerState: Schema.Literals([
    'creating',
    'active',
    'stopped',
    'rebuilding',
    'retiring',
    'retired',
    'unknown',
  ]),
  state: Schema.Literal('waiting-for-agent'),
})

export const DeliveredRegistrationTokenHash = Sha256
export const ProviderCredentialEnvelopeRevision = PositiveInteger

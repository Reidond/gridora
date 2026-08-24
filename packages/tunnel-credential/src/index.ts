import { Context, Effect, Layer, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
)
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const PriorRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
)
const SealedCredential = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(131_072),
  Schema.isPattern(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
)

/**
 * This payload is suitable for the signed AgentCommand payload. The sealed value is opaque to the
 * control plane and agent process. Only the privileged installer may open it. A bootstrap image or
 * cloud-init document must contain registration material, never this payload or a Tunnel token.
 */
export const TunnelCredentialInstallPayload = Schema.Struct({
  apiVersion: Schema.Literal('tunnel.gridora.dev/v1alpha1'),
  action: Schema.Literal('install'),
  deliveryId: Identifier,
  organizationId: Identifier,
  nodeId: Identifier,
  tunnelId: Identifier,
  operationId: Identifier,
  revision: Revision,
  expectedPriorRevision: PriorRevision,
  expiresAt: Timestamp,
  sealedCredential: SealedCredential,
  destination: Schema.Struct({
    path: Schema.Literal('/var/lib/gridora/tunnel/credential'),
    owner: Schema.Literal('root'),
    group: Schema.Literal('root'),
    mode: Schema.Literal('0600'),
  }),
})
export type TunnelCredentialInstallPayload = typeof TunnelCredentialInstallPayload.Type

export const TunnelCredentialRevokePayload = Schema.Struct({
  apiVersion: Schema.Literal('tunnel.gridora.dev/v1alpha1'),
  action: Schema.Literal('revoke'),
  deliveryId: Identifier,
  organizationId: Identifier,
  nodeId: Identifier,
  tunnelId: Identifier,
  operationId: Identifier,
  revision: Revision,
  expectedPriorRevision: Revision,
  expiresAt: Timestamp,
})
export type TunnelCredentialRevokePayload = typeof TunnelCredentialRevokePayload.Type

export const TunnelCredentialCommandPayload = Schema.Union([
  TunnelCredentialInstallPayload,
  TunnelCredentialRevokePayload,
])
export type TunnelCredentialCommandPayload = typeof TunnelCredentialCommandPayload.Type

export const TunnelCredentialAcknowledgement = Schema.Struct({
  organizationId: Identifier,
  nodeId: Identifier,
  tunnelId: Identifier,
  operationId: Identifier,
  deliveryId: Identifier,
  revision: Revision,
  status: Schema.Literals(['active', 'revoked']),
  duplicate: Schema.Boolean,
  healthy: Schema.Boolean,
  acknowledgedAt: Timestamp,
})
export type TunnelCredentialAcknowledgement = typeof TunnelCredentialAcknowledgement.Type

const SafeErrorFields = {
  operation: Schema.String,
  code: Schema.Literals([
    'invalid-command',
    'expired-command',
    'scope-mismatch',
    'revision-conflict',
    'replay-rejected',
    'install-failed',
    'unsafe-install',
    'persistence-failed',
    'revocation-failed',
  ]),
  message: Schema.Literal('tunnel credential operation failed'),
}
export class TunnelCredentialError extends Schema.TaggedError<TunnelCredentialError>()(
  'TunnelCredentialError',
  SafeErrorFields,
) {}

export interface TunnelCredentialScope {
  readonly organizationId: string
  readonly nodeId: string
  readonly tunnelId: string
}

export interface TunnelCredentialState extends TunnelCredentialScope {
  readonly operationId: string
  readonly deliveryId: string
  readonly revision: number
  readonly status: 'active' | 'revoked'
  readonly acknowledgement: TunnelCredentialAcknowledgement
}

export interface TunnelCredentialRepositoryShape {
  readonly get: (
    scope: TunnelCredentialScope,
  ) => Effect.Effect<TunnelCredentialState | null, TunnelCredentialError>
  /** Compare and replace. Null means the record must not exist. */
  readonly replace: (
    scope: TunnelCredentialScope,
    expectedRevision: number | null,
    state: TunnelCredentialState,
  ) => Effect.Effect<void, TunnelCredentialError>
}
export class TunnelCredentialRepository extends Context.Service<
  TunnelCredentialRepository,
  TunnelCredentialRepositoryShape
>()('@gridora/tunnel-credential/TunnelCredentialRepository') {}
export const TunnelCredentialRepositoryLayer = (repository: TunnelCredentialRepositoryShape) =>
  Layer.succeed(TunnelCredentialRepository, repository)

export interface AtomicCredentialInstallResult extends TunnelCredentialScope {
  readonly operationId: string
  readonly deliveryId: string
  readonly revision: number
  readonly owner: 'root'
  readonly group: 'root'
  readonly mode: '0600'
  readonly usedAtomicRename: boolean
  readonly fsyncedFile: boolean
  readonly fsyncedDirectory: boolean
  readonly activated: boolean
  readonly healthChecked: boolean
  readonly healthy: boolean
  readonly alreadyInstalled: boolean
}
export interface AtomicCredentialInstallerShape {
  /**
   * Opens the sealed payload inside the privileged boundary. It must create a private temporary
   * file, fsync it, rename it over the destination, fsync the directory, and only then activate it.
   * It must atomically fence expectedPriorRevision, deduplicate deliveryId, reject another delivery
   * at the same revision, and never return or log plaintext credential bytes. The postcondition is
   * the requested revision is active, including when the first response was lost.
   */
  readonly install: (
    command: TunnelCredentialInstallPayload,
  ) => Effect.Effect<AtomicCredentialInstallResult, TunnelCredentialError>
  /**
   * Atomically fences the revision, stops activation, and invalidates/removes the credential before
   * reporting success. `removed` is the postcondition "no credential is present", so a replay after
   * response loss may report both removed and alreadyRevoked.
   */
  readonly revoke: (command: TunnelCredentialRevokePayload) => Effect.Effect<
    {
      readonly removed: boolean
      readonly activationStopped: boolean
      readonly alreadyRevoked: boolean
    },
    TunnelCredentialError
  >
}
export class AtomicCredentialInstaller extends Context.Service<
  AtomicCredentialInstaller,
  AtomicCredentialInstallerShape
>()('@gridora/tunnel-credential/AtomicCredentialInstaller') {}
export const AtomicCredentialInstallerLayer = (installer: AtomicCredentialInstallerShape) =>
  Layer.succeed(AtomicCredentialInstaller, installer)

export interface TunnelCredentialServiceShape {
  readonly execute: (
    authenticatedScope: TunnelCredentialScope,
    command: unknown,
    now: string,
  ) => Effect.Effect<TunnelCredentialAcknowledgement, TunnelCredentialError>
}
export class TunnelCredentialService extends Context.Service<
  TunnelCredentialService,
  TunnelCredentialServiceShape
>()('@gridora/tunnel-credential/TunnelCredentialService') {}

const failure = (operation: string, code: TunnelCredentialError['code']) =>
  new TunnelCredentialError({ operation, code, message: 'tunnel credential operation failed' })
const sameScope = (left: TunnelCredentialScope, right: TunnelCredentialScope) =>
  left.organizationId === right.organizationId &&
  left.nodeId === right.nodeId &&
  left.tunnelId === right.tunnelId
const validTime = (value: string) => Number.isFinite(Date.parse(value))
const validateInstallResult = (
  command: TunnelCredentialInstallPayload,
  result: AtomicCredentialInstallResult,
) =>
  sameScope(command, result) &&
  result.operationId === command.operationId &&
  result.deliveryId === command.deliveryId &&
  result.revision === command.revision &&
  result.owner === 'root' &&
  result.group === 'root' &&
  result.mode === '0600' &&
  result.usedAtomicRename &&
  result.fsyncedFile &&
  result.fsyncedDirectory &&
  result.activated &&
  result.healthChecked &&
  result.healthy

export const TunnelCredentialServiceLive = Layer.effect(
  TunnelCredentialService,
  Effect.gen(function* () {
    const repository = yield* TunnelCredentialRepository
    const installer = yield* AtomicCredentialInstaller

    const execute: TunnelCredentialServiceShape['execute'] = (authenticatedScope, input, now) =>
      Effect.gen(function* () {
        const command = yield* Schema.decodeUnknownEffect(TunnelCredentialCommandPayload, {
          onExcessProperty: 'error',
        })(input).pipe(Effect.mapError(() => failure('tunnel.command.decode', 'invalid-command')))
        if (!sameScope(authenticatedScope, command))
          return yield* failure('tunnel.command.scope', 'scope-mismatch')
        if (!validTime(now) || !validTime(command.expiresAt))
          return yield* failure('tunnel.command.time', 'invalid-command')
        if (Date.parse(command.expiresAt) <= Date.parse(now))
          return yield* failure('tunnel.command.time', 'expired-command')

        const previous = yield* repository
          .get(authenticatedScope)
          .pipe(Effect.mapError(() => failure('tunnel.state.read', 'persistence-failed')))
        if (previous !== null && !sameScope(previous, command))
          return yield* failure('tunnel.state.scope', 'scope-mismatch')
        if (previous?.revision === command.revision) {
          if (
            previous.deliveryId === command.deliveryId &&
            previous.operationId === command.operationId &&
            previous.status === (command.action === 'install' ? 'active' : 'revoked')
          )
            return { ...previous.acknowledgement, duplicate: true }
          return yield* failure('tunnel.command.replay', 'replay-rejected')
        }
        if (previous !== null && command.revision < previous.revision)
          return yield* failure('tunnel.command.revision', 'revision-conflict')
        const priorRevision = previous?.revision ?? 0
        if (command.expectedPriorRevision !== priorRevision)
          return yield* failure('tunnel.command.revision', 'revision-conflict')
        if (command.action === 'revoke' && previous?.status !== 'active')
          return yield* failure('tunnel.command.revoke', 'revision-conflict')

        if (command.action === 'install') {
          const installed = yield* installer
            .install(command)
            .pipe(Effect.mapError(() => failure('tunnel.install', 'install-failed')))
          if (!validateInstallResult(command, installed))
            return yield* failure('tunnel.install.metadata', 'unsafe-install')
        } else {
          const revoked = yield* installer
            .revoke(command)
            .pipe(Effect.mapError(() => failure('tunnel.revoke', 'revocation-failed')))
          if (!revoked.removed || !revoked.activationStopped)
            return yield* failure('tunnel.revoke', 'revocation-failed')
        }

        const acknowledgement: TunnelCredentialAcknowledgement = {
          organizationId: command.organizationId,
          nodeId: command.nodeId,
          tunnelId: command.tunnelId,
          operationId: command.operationId,
          deliveryId: command.deliveryId,
          revision: command.revision,
          status: command.action === 'install' ? 'active' : 'revoked',
          duplicate: false,
          healthy: command.action === 'install',
          acknowledgedAt: now,
        }
        const next: TunnelCredentialState = {
          ...authenticatedScope,
          operationId: command.operationId,
          deliveryId: command.deliveryId,
          revision: command.revision,
          status: acknowledgement.status,
          acknowledgement,
        }
        yield* repository
          .replace(authenticatedScope, previous?.revision ?? null, next)
          .pipe(Effect.mapError(() => failure('tunnel.state.write', 'persistence-failed')))
        return acknowledgement
      })
    return TunnelCredentialService.of({ execute })
  }),
)

export const decodeTunnelCredentialCommand = (input: unknown) =>
  Schema.decodeUnknownEffect(TunnelCredentialCommandPayload, { onExcessProperty: 'error' })(input)

export interface TunnelCredentialEnvelopeCoordinates extends TunnelCredentialScope {
  readonly operationId: string
  readonly revision: number
}

export interface TunnelCredentialNodeKeyPair {
  /** Safe to register with the control plane. */
  readonly publicKey: string
  /** Must remain inside the root-only installer boundary. */
  readonly privateKey: string
}

export class TunnelCredentialEnvelopeError extends Schema.TaggedError<TunnelCredentialEnvelopeError>()(
  'TunnelCredentialEnvelopeError',
  {
    operation: Schema.String,
    message: Schema.Literal('tunnel credential envelope operation failed'),
  },
) {}

const envelopeFailure = (operation: string) =>
  new TunnelCredentialEnvelopeError({
    operation,
    message: 'tunnel credential envelope operation failed',
  })
const encoder = new TextEncoder()
const toBufferSource = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const unbase64Url = (encoded: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid encoding')
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4)
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + padding)
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (base64Url(decoded) !== encoded) throw new Error('non-canonical encoding')
  return decoded
}
const envelopeAad = (coordinates: TunnelCredentialEnvelopeCoordinates): Uint8Array =>
  encoder.encode(
    [
      'gridora-tunnel-credential-v1',
      coordinates.organizationId,
      coordinates.nodeId,
      coordinates.tunnelId,
      coordinates.operationId,
      String(coordinates.revision),
    ]
      .map((part) => `${encoder.encode(part).byteLength}:${part}`)
      .join('|'),
  )
const cryptoEffect = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => envelopeFailure(operation) })
const parseKey = (encoded: string, prefix: string): Uint8Array => {
  const [version, body, extra] = encoded.split('.')
  if (version !== prefix || body === undefined || extra !== undefined)
    throw new Error('invalid key')
  return unbase64Url(body)
}
const validEnvelopeCoordinates = (coordinates: TunnelCredentialEnvelopeCoordinates): boolean =>
  [
    coordinates.organizationId,
    coordinates.nodeId,
    coordinates.tunnelId,
    coordinates.operationId,
  ].every((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) &&
  Number.isSafeInteger(coordinates.revision) &&
  coordinates.revision > 0

/** Generate this once on the node. Persist the private value as root:root 0600. */
export const generateTunnelCredentialNodeKeyPair = (): Effect.Effect<
  TunnelCredentialNodeKeyPair,
  TunnelCredentialEnvelopeError
> =>
  Effect.gen(function* () {
    const pair = yield* cryptoEffect('tunnel.envelope.key.generate', () =>
      crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
      ),
    )
    const keyPair = pair as CryptoKeyPair
    const publicDer = new Uint8Array(
      yield* cryptoEffect('tunnel.envelope.key.export', () =>
        crypto.subtle.exportKey('spki', keyPair.publicKey),
      ),
    )
    const privateDer = new Uint8Array(
      yield* cryptoEffect('tunnel.envelope.key.export', () =>
        crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
      ),
    )
    try {
      return {
        publicKey: `rsa-oaep-spki-v1.${base64Url(publicDer)}`,
        privateKey: `rsa-oaep-pkcs8-v1.${base64Url(privateDer)}`,
      }
    } finally {
      publicDer.fill(0)
      privateDer.fill(0)
    }
  })

/** Seal on the control plane. The returned envelope is safe for the unprivileged agent to relay. */
export const sealTunnelCredential = (
  publicKey: string,
  coordinates: TunnelCredentialEnvelopeCoordinates,
  credential: string,
): Effect.Effect<string, TunnelCredentialEnvelopeError> =>
  Effect.gen(function* () {
    if (
      !validEnvelopeCoordinates(coordinates) ||
      credential.length === 0 ||
      credential.length > 64_000
    )
      return yield* envelopeFailure('tunnel.envelope.seal')
    const publicDer = yield* Effect.try({
      try: () => parseKey(publicKey, 'rsa-oaep-spki-v1'),
      catch: () => envelopeFailure('tunnel.envelope.seal'),
    })
    const plaintext = encoder.encode(credential)
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const aad = envelopeAad(coordinates)
    try {
      const rsaKey = yield* cryptoEffect('tunnel.envelope.seal', () =>
        crypto.subtle.importKey(
          'spki',
          toBufferSource(publicDer),
          { name: 'RSA-OAEP', hash: 'SHA-256' },
          false,
          ['encrypt'],
        ),
      )
      const aesKey = yield* cryptoEffect('tunnel.envelope.seal', () =>
        crypto.subtle.importKey('raw', toBufferSource(dataKey), 'AES-GCM', false, ['encrypt']),
      )
      const [wrapped, ciphertext] = yield* Effect.all([
        cryptoEffect('tunnel.envelope.seal', () =>
          crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, toBufferSource(dataKey)),
        ),
        cryptoEffect('tunnel.envelope.seal', () =>
          crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: toBufferSource(iv),
              additionalData: toBufferSource(aad),
              tagLength: 128,
            },
            aesKey,
            toBufferSource(plaintext),
          ),
        ),
      ])
      return `v1.${base64Url(new Uint8Array(wrapped))}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`
    } finally {
      publicDer.fill(0)
      plaintext.fill(0)
      dataKey.fill(0)
      iv.fill(0)
      aad.fill(0)
    }
  })

/**
 * Open only in the privileged installer. The plaintext is cleared immediately after the sink
 * settles and is never returned from this function.
 */
export const withOpenedTunnelCredential = <A, E>(
  privateKey: string,
  coordinates: TunnelCredentialEnvelopeCoordinates,
  envelope: string,
  sink: (plaintext: Uint8Array) => Effect.Effect<A, E>,
): Effect.Effect<A, E | TunnelCredentialEnvelopeError> =>
  Effect.gen(function* () {
    if (!validEnvelopeCoordinates(coordinates))
      return yield* envelopeFailure('tunnel.envelope.open')
    const privateDer = yield* Effect.try({
      try: () => parseKey(privateKey, 'rsa-oaep-pkcs8-v1'),
      catch: () => envelopeFailure('tunnel.envelope.open'),
    })
    const parts = envelope.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1') {
      privateDer.fill(0)
      return yield* envelopeFailure('tunnel.envelope.open')
    }
    const decoded = yield* Effect.try({
      try: () => ({
        wrapped: unbase64Url(parts[1]!),
        iv: unbase64Url(parts[2]!),
        ciphertext: unbase64Url(parts[3]!),
      }),
      catch: () => envelopeFailure('tunnel.envelope.open'),
    }).pipe(Effect.tapError(() => Effect.sync(() => privateDer.fill(0))))
    const aad = envelopeAad(coordinates)
    let dataKey: Uint8Array | undefined
    let plaintext: Uint8Array | undefined
    try {
      const rsaKey = yield* cryptoEffect('tunnel.envelope.open', () =>
        crypto.subtle.importKey(
          'pkcs8',
          toBufferSource(privateDer),
          { name: 'RSA-OAEP', hash: 'SHA-256' },
          false,
          ['decrypt'],
        ),
      )
      dataKey = new Uint8Array(
        yield* cryptoEffect('tunnel.envelope.open', () =>
          crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsaKey, toBufferSource(decoded.wrapped)),
        ),
      )
      if (dataKey.byteLength !== 32) return yield* envelopeFailure('tunnel.envelope.open')
      const aesKey = yield* cryptoEffect('tunnel.envelope.open', () =>
        crypto.subtle.importKey('raw', toBufferSource(dataKey!), 'AES-GCM', false, ['decrypt']),
      )
      plaintext = new Uint8Array(
        yield* cryptoEffect('tunnel.envelope.open', () =>
          crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: toBufferSource(decoded.iv),
              additionalData: toBufferSource(aad),
              tagLength: 128,
            },
            aesKey,
            toBufferSource(decoded.ciphertext),
          ),
        ),
      )
      return yield* sink(plaintext)
    } finally {
      privateDer.fill(0)
      decoded.wrapped.fill(0)
      decoded.iv.fill(0)
      decoded.ciphertext.fill(0)
      aad.fill(0)
      dataKey?.fill(0)
      plaintext?.fill(0)
    }
  })

import { Context, Effect, Layer, Schema } from 'effect'

export * from './intent.js'
export * from './internal-request.js'

const JwtHeader = Schema.Struct({
  alg: Schema.Literal('RS256'),
  kid: Schema.String,
  typ: Schema.optional(Schema.String),
})

const JwtClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  sub: Schema.String,
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  iat: Schema.optional(Schema.Number),
  email: Schema.String,
  name: Schema.optional(Schema.String),
  identity_nonce: Schema.optional(Schema.String),
})

const Jwk = Schema.Struct({
  kty: Schema.Literal('RSA'),
  kid: Schema.String,
  use: Schema.optional(Schema.String),
  alg: Schema.optional(Schema.String),
  n: Schema.String,
  e: Schema.String,
})

const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) })

export type AccessClaims = typeof JwtClaims.Type

export class AccessAuthenticationError extends Schema.TaggedError<AccessAuthenticationError>()(
  'AccessAuthenticationError',
  {
    reason: Schema.Literals([
      'missing-assertion',
      'malformed-assertion',
      'invalid-signature',
      'invalid-issuer',
      'invalid-audience',
      'expired',
      'not-active',
      'key-unavailable',
    ]),
    message: Schema.String,
  },
) {}

export interface AccessJwtConfig {
  readonly issuer: string
  readonly audience: string
  readonly jwksUrl?: string
  readonly clockSkewSeconds?: number
  readonly jwksCacheTtlMilliseconds?: number
}

const normalizeIssuer = (value: string): string => value.replace(/\/+$/, '')

const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const bufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const decodeJsonPart = (part: string): unknown => {
  const bytes = decodeBase64Url(part)
  return JSON.parse(new TextDecoder().decode(bytes))
}

const malformed = (message: string) =>
  new AccessAuthenticationError({ reason: 'malformed-assertion', message })

const splitJwt = (
  assertion: string,
): Effect.Effect<readonly [string, string, string], AccessAuthenticationError> =>
  Effect.try({
    try: () => {
      const parts = assertion.split('.')
      if (parts.length !== 3 || parts.some((part) => part.length === 0))
        throw new Error('JWT must have three parts')
      return [parts[0]!, parts[1]!, parts[2]!] as const
    },
    catch: () => malformed('The Cloudflare Access assertion is malformed'),
  })

const schemaAuthError = (message: string) => malformed(message)

const parsePart = <S extends Schema.Top>(schema: S, part: string) =>
  Effect.try({
    try: () => decodeJsonPart(part),
    catch: () => malformed('The Cloudflare Access assertion contains invalid JSON'),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => schemaAuthError('The Cloudflare Access assertion has invalid claims')),
  )

const fetchJwks = (url: string): Effect.Effect<typeof Jwks.Type, AccessAuthenticationError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`)
      return response.json()
    },
    catch: () =>
      new AccessAuthenticationError({
        reason: 'key-unavailable',
        message: 'Cloudflare Access signing keys are unavailable',
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Jwks)),
    Effect.mapError(
      () =>
        new AccessAuthenticationError({
          reason: 'key-unavailable',
          message: 'Cloudflare Access returned invalid signing keys',
        }),
    ),
  )

const verifySignature = (
  headerAndPayload: string,
  signaturePart: string,
  jwk: typeof Jwk.Type,
): Effect.Effect<void, AccessAuthenticationError> =>
  Effect.tryPromise({
    try: async () => {
      const importedJwk: JsonWebKey = {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        ext: true,
        ...(jwk.alg === undefined ? {} : { alg: jwk.alg }),
        ...(jwk.use === undefined ? {} : { use: jwk.use }),
      }
      const key = await crypto.subtle.importKey(
        'jwk',
        importedJwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        bufferSource(decodeBase64Url(signaturePart)),
        new TextEncoder().encode(headerAndPayload),
      )
      if (!valid) throw new Error('invalid signature')
    },
    catch: () =>
      new AccessAuthenticationError({
        reason: 'invalid-signature',
        message: 'The Cloudflare Access assertion signature is invalid',
      }),
  })

export class AccessJwtVerifier extends Context.Service<
  AccessJwtVerifier,
  {
    readonly verify: (assertion: string) => Effect.Effect<AccessClaims, AccessAuthenticationError>
  }
>()('@gridora/auth-cloudflare-access/AccessJwtVerifier') {}

export const makeAccessJwtVerifier = (config: AccessJwtConfig): Layer.Layer<AccessJwtVerifier> => {
  const issuer = normalizeIssuer(config.issuer)
  const jwksUrl = config.jwksUrl ?? `${issuer}/cdn-cgi/access/certs`
  const skew = config.clockSkewSeconds ?? 30
  const cacheTtl = config.jwksCacheTtlMilliseconds ?? 5 * 60_000
  let cachedKeys:
    | {
        readonly current: (typeof Jwks.Type)['keys']
        readonly previous: (typeof Jwks.Type)['keys']
        readonly expiresAt: number
      }
    | undefined

  const keys = (
    forceRefresh: boolean,
  ): Effect.Effect<(typeof Jwks.Type)['keys'], AccessAuthenticationError> =>
    Effect.gen(function* () {
      if (!forceRefresh && cachedKeys !== undefined && cachedKeys.expiresAt > Date.now()) {
        return [...cachedKeys.current, ...cachedKeys.previous]
      }
      const refreshed = (yield* fetchJwks(jwksUrl)).keys
      const previous = (cachedKeys?.current ?? []).filter(
        (candidate) => !refreshed.some((key) => key.kid === candidate.kid),
      )
      cachedKeys = { current: refreshed, previous, expiresAt: Date.now() + cacheTtl }
      return [...refreshed, ...previous]
    })

  return Layer.succeed(
    AccessJwtVerifier,
    AccessJwtVerifier.of({
      verify: (assertion) =>
        Effect.gen(function* () {
          const [headerPart, claimsPart, signaturePart] = yield* splitJwt(assertion)
          const header = yield* parsePart(JwtHeader, headerPart)
          const claims = yield* parsePart(JwtClaims, claimsPart)
          if (normalizeIssuer(claims.iss) !== issuer) {
            return yield* Effect.fail(
              new AccessAuthenticationError({
                reason: 'invalid-issuer',
                message: 'The Cloudflare Access assertion issuer is not trusted',
              }),
            )
          }
          const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
          if (!audiences.includes(config.audience)) {
            return yield* Effect.fail(
              new AccessAuthenticationError({
                reason: 'invalid-audience',
                message: 'The Cloudflare Access assertion audience is not accepted',
              }),
            )
          }
          const now = Math.floor(Date.now() / 1_000)
          if (claims.exp + skew < now) {
            return yield* Effect.fail(
              new AccessAuthenticationError({
                reason: 'expired',
                message: 'The Cloudflare Access assertion has expired',
              }),
            )
          }
          if (claims.nbf !== undefined && claims.nbf - skew > now) {
            return yield* Effect.fail(
              new AccessAuthenticationError({
                reason: 'not-active',
                message: 'The Cloudflare Access assertion is not active yet',
              }),
            )
          }
          let key = (yield* keys(false)).find((candidate) => candidate.kid === header.kid)
          if (key === undefined)
            key = (yield* keys(true)).find((candidate) => candidate.kid === header.kid)
          if (key === undefined) {
            return yield* Effect.fail(
              new AccessAuthenticationError({
                reason: 'key-unavailable',
                message: 'The assertion signing key was not found',
              }),
            )
          }
          yield* verifySignature(`${headerPart}.${claimsPart}`, signaturePart, key)
          return claims
        }),
    }),
  )
}

export const assertionFromRequest = (
  request: Request,
): Effect.Effect<string, AccessAuthenticationError> => {
  // Cloudflare Access validates browser sessions and Managed OAuth Bearer tokens at the gateway,
  // then injects this signed assertion. The origin never validates an arbitrary raw Bearer token.
  const assertion = request.headers.get('cf-access-jwt-assertion')
  return assertion === null || assertion.length === 0
    ? Effect.fail(
        new AccessAuthenticationError({
          reason: 'missing-assertion',
          message: 'A Cloudflare Access assertion is required',
        }),
      )
    : Effect.succeed(assertion)
}

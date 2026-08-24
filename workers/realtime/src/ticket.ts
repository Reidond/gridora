import { Effect, Schema } from 'effect'

export const RealtimeTicketClaims = Schema.Struct({
  organizationId: Schema.String,
  principalId: Schema.String,
  audience: Schema.Literals(['console', 'node-agent']),
  resourceType: Schema.Literals(['node', 'organization', 'resource']),
  resourceId: Schema.String,
  machineId: Schema.NullOr(Schema.String),
  sessionVersion: Schema.Number,
  /** Present only for live-log tickets; node/organization tickets remain unchanged. */
  organizationAuthorizationGeneration: Schema.optional(Schema.Number),
  /** Present only for live-log tickets; it fences delete/regrant cycles. */
  membershipAuthorizationGeneration: Schema.optional(Schema.Number),
  expiresAt: Schema.Number,
  nonce: Schema.String,
})
export type RealtimeTicketClaims = typeof RealtimeTicketClaims.Type

export class RealtimeTicketError extends Schema.TaggedError<RealtimeTicketError>()(
  'RealtimeTicketError',
  {
    reason: Schema.Literals(['malformed', 'invalid-signature', 'expired', 'scope-mismatch']),
  },
) {}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const bufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const hmacKey = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )

export const signRealtimeTicket = (
  claims: RealtimeTicketClaims,
  secret: string,
): Effect.Effect<string, RealtimeTicketError> =>
  Effect.tryPromise({
    try: async () => {
      const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)))
      const signature = await crypto.subtle.sign(
        'HMAC',
        await hmacKey(secret, ['sign']),
        new TextEncoder().encode(payload),
      )
      return `${payload}.${base64Url(new Uint8Array(signature))}`
    },
    catch: () => new RealtimeTicketError({ reason: 'malformed' }),
  })

export const verifyRealtimeTicket = (
  ticket: string,
  secret: string,
  expected: Pick<RealtimeTicketClaims, 'organizationId' | 'resourceType' | 'resourceId'>,
): Effect.Effect<RealtimeTicketClaims, RealtimeTicketError> =>
  Effect.gen(function* () {
    const parts = ticket.split('.')
    if (parts.length !== 2) return yield* new RealtimeTicketError({ reason: 'malformed' })
    const [payload, signature] = parts as [string, string]
    const valid = yield* Effect.tryPromise({
      try: async () =>
        crypto.subtle.verify(
          'HMAC',
          await hmacKey(secret, ['verify']),
          bufferSource(fromBase64Url(signature)),
          new TextEncoder().encode(payload),
        ),
      catch: () => new RealtimeTicketError({ reason: 'invalid-signature' }),
    })
    if (!valid) return yield* new RealtimeTicketError({ reason: 'invalid-signature' })
    const claims = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
      catch: () => new RealtimeTicketError({ reason: 'malformed' }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RealtimeTicketClaims)),
      Effect.mapError(() => new RealtimeTicketError({ reason: 'malformed' })),
    )
    if (claims.expiresAt < Date.now()) return yield* new RealtimeTicketError({ reason: 'expired' })
    if (
      claims.organizationId !== expected.organizationId ||
      claims.resourceType !== expected.resourceType ||
      claims.resourceId !== expected.resourceId
    )
      return yield* new RealtimeTicketError({ reason: 'scope-mismatch' })
    return claims
  })

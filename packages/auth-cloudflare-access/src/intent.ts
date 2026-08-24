import { Effect, Schema } from 'effect'

export const AuthenticationIntent = Schema.Struct({
  intent: Schema.Literals(['sign-in', 'sign-up', 'accept-invitation']),
  returnTo: Schema.String,
  csrf: Schema.String,
  nonce: Schema.String,
  expiresAt: Schema.Number,
})
export type AuthenticationIntent = typeof AuthenticationIntent.Type

export class AuthenticationIntentError extends Schema.TaggedError<AuthenticationIntentError>()(
  'AuthenticationIntentError',
  {
    reason: Schema.Literals([
      'malformed',
      'invalid-signature',
      'expired',
      'invalid-return-target',
      'csrf-mismatch',
    ]),
  },
) {}

export const validReturnTarget = (value: string): boolean => {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  if (/%2f|%5c/i.test(value)) return false
  let parsed: URL
  try {
    parsed = new URL(value, 'https://console.gridora.invalid')
  } catch {
    return false
  }
  if (parsed.origin !== 'https://console.gridora.invalid') return false
  if (parsed.pathname === '/cdn-cgi/access/callback' || parsed.pathname.startsWith('/v1/auth/'))
    return false
  return (
    parsed.pathname === '/' ||
    parsed.pathname === '/dashboard' ||
    parsed.pathname === '/setup/organization' ||
    parsed.pathname.startsWith('/invitations/')
  )
}

const encode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const decode = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
const bufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
const key = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )

export const signAuthenticationIntent = (
  intent: AuthenticationIntent,
  secret: string,
): Effect.Effect<string, AuthenticationIntentError> =>
  Effect.gen(function* () {
    if (!validReturnTarget(intent.returnTo))
      return yield* new AuthenticationIntentError({ reason: 'invalid-return-target' })
    const payload = encode(new TextEncoder().encode(JSON.stringify(intent)))
    return yield* Effect.tryPromise({
      try: async () =>
        `${payload}.${encode(
          new Uint8Array(
            await crypto.subtle.sign(
              'HMAC',
              await key(secret, ['sign']),
              new TextEncoder().encode(payload),
            ),
          ),
        )}`,
      catch: () => new AuthenticationIntentError({ reason: 'malformed' }),
    })
  })

export const verifyAuthenticationIntent = (
  token: string,
  secret: string,
  expectedCsrf: string,
): Effect.Effect<AuthenticationIntent, AuthenticationIntentError> =>
  Effect.gen(function* () {
    const parts = token.split('.')
    if (parts.length !== 2) return yield* new AuthenticationIntentError({ reason: 'malformed' })
    const [payload, signature] = parts as [string, string]
    const valid = yield* Effect.tryPromise({
      try: async () =>
        crypto.subtle.verify(
          'HMAC',
          await key(secret, ['verify']),
          bufferSource(decode(signature)),
          new TextEncoder().encode(payload),
        ),
      catch: () => new AuthenticationIntentError({ reason: 'invalid-signature' }),
    })
    if (!valid) return yield* new AuthenticationIntentError({ reason: 'invalid-signature' })
    const intent = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(decode(payload))),
      catch: () => new AuthenticationIntentError({ reason: 'malformed' }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AuthenticationIntent)),
      Effect.mapError(() => new AuthenticationIntentError({ reason: 'malformed' })),
    )
    if (!validReturnTarget(intent.returnTo))
      return yield* new AuthenticationIntentError({ reason: 'invalid-return-target' })
    if (intent.expiresAt < Date.now())
      return yield* new AuthenticationIntentError({ reason: 'expired' })
    if (intent.csrf !== expectedCsrf)
      return yield* new AuthenticationIntentError({ reason: 'csrf-mismatch' })
    return intent
  })

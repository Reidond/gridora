import { Effect, Schema } from 'effect'

export class InternalRequestAuthenticationError extends Schema.TaggedError<InternalRequestAuthenticationError>()(
  'InternalRequestAuthenticationError',
  { reason: Schema.Literals(['missing-headers', 'expired', 'invalid-signature']) },
) {}

export interface VerifiedInternalRequest {
  readonly nonce: string
  readonly timestamp: number
  readonly expiresAt: number
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
const encode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const key = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )
export interface InternalRequestRouting {
  readonly method?: string
  readonly path?: string
  readonly workflow?: string
  readonly workflowStep?: string
  readonly workflowStepOrdinal?: string
  readonly queue?: string
  readonly organizationId?: string
}

const signedPayload = (
  timestamp: string,
  nonce: string,
  body: string,
  routing: Required<InternalRequestRouting>,
): ArrayBuffer =>
  bufferSource(
    new TextEncoder().encode(
      [
        routing.method.toUpperCase(),
        routing.path,
        routing.workflow,
        routing.workflowStep,
        routing.workflowStepOrdinal,
        routing.queue,
        routing.organizationId,
        timestamp,
        nonce,
        body,
      ].join('\n'),
    ),
  )

const completeRouting = (routing: InternalRequestRouting): Required<InternalRequestRouting> => ({
  method: routing.method ?? 'POST',
  path: routing.path ?? '/',
  workflow: routing.workflow ?? '',
  workflowStep: routing.workflowStep ?? '',
  workflowStepOrdinal: routing.workflowStepOrdinal ?? '',
  queue: routing.queue ?? '',
  organizationId: routing.organizationId ?? '',
})

export const signInternalRequest = (
  body: string,
  secret: string,
  timestamp = Date.now(),
  nonce: string = crypto.randomUUID(),
  routing: InternalRequestRouting = {},
): Effect.Effect<Readonly<Record<string, string>>, InternalRequestAuthenticationError> =>
  Effect.tryPromise({
    try: async () => {
      const timestampHeader = String(timestamp)
      const signature = await crypto.subtle.sign(
        'HMAC',
        await key(secret, ['sign']),
        signedPayload(timestampHeader, nonce, body, completeRouting(routing)),
      )
      return {
        'x-gridora-internal-timestamp': timestampHeader,
        'x-gridora-internal-nonce': nonce,
        'x-gridora-internal-signature': encode(new Uint8Array(signature)),
      }
    },
    catch: () => new InternalRequestAuthenticationError({ reason: 'invalid-signature' }),
  })

export const verifyInternalRequest = (
  request: Request,
  secret: string,
  now = Date.now(),
  maxAgeMilliseconds = 60_000,
): Effect.Effect<VerifiedInternalRequest, InternalRequestAuthenticationError> =>
  Effect.gen(function* () {
    const timestamp = request.headers.get('x-gridora-internal-timestamp')
    const nonce = request.headers.get('x-gridora-internal-nonce')
    const signature = request.headers.get('x-gridora-internal-signature')
    if (timestamp === null || nonce === null || signature === null) {
      return yield* new InternalRequestAuthenticationError({ reason: 'missing-headers' })
    }
    const parsedTimestamp = Number(timestamp)
    if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > maxAgeMilliseconds) {
      return yield* new InternalRequestAuthenticationError({ reason: 'expired' })
    }
    const body = yield* Effect.tryPromise({
      try: () => request.clone().text(),
      catch: () => new InternalRequestAuthenticationError({ reason: 'invalid-signature' }),
    })
    const url = new URL(request.url)
    const routing = completeRouting({
      method: request.method,
      path: url.pathname,
      workflow: request.headers.get('x-gridora-workflow') ?? '',
      workflowStep: request.headers.get('x-gridora-workflow-step') ?? '',
      workflowStepOrdinal: request.headers.get('x-gridora-workflow-step-ordinal') ?? '',
      queue: request.headers.get('x-gridora-queue') ?? '',
      organizationId: request.headers.get('x-gridora-organization-id') ?? '',
    })
    const valid = yield* Effect.tryPromise({
      try: async () =>
        crypto.subtle.verify(
          'HMAC',
          await key(secret, ['verify']),
          bufferSource(decode(signature)),
          signedPayload(timestamp, nonce, body, routing),
        ),
      catch: () => new InternalRequestAuthenticationError({ reason: 'invalid-signature' }),
    })
    if (!valid)
      return yield* new InternalRequestAuthenticationError({ reason: 'invalid-signature' })
    return { nonce, timestamp: parsedTimestamp, expiresAt: parsedTimestamp + maxAgeMilliseconds }
  })

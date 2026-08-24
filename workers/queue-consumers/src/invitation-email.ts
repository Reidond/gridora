import { Effect, Schema } from 'effect'
import { EmailAddress, InvitationRole, IsoDateTime } from '@gridora/domain'

export const InvitationEmailPayload = Schema.Struct({
  invitationId: Schema.String,
  email: EmailAddress,
  role: InvitationRole,
  expiresAt: IsoDateTime,
  organizationName: Schema.String,
  tokenDerivation: Schema.Struct({
    version: Schema.String,
    scope: Schema.String,
  }),
})
export type InvitationEmailPayload = typeof InvitationEmailPayload.Type

export interface InvitationTokenKeyring {
  readonly current: { readonly version: string; readonly secret: string }
  readonly previous?: { readonly version: string; readonly secret: string } | undefined
}

export interface InvitationEmailConfiguration {
  readonly publicAppUrl: string
  readonly from: string
  readonly tokenKeys: InvitationTokenKeyring
}

export interface InvitationEmailDeliveryResult {
  readonly status: 'delivered' | 'permanent-failure'
  readonly messageId?: string | undefined
  readonly code?: string | undefined
}

export const InvitationEmailRemediationRecord = Schema.Struct({
  version: Schema.Literal(1),
  disposition: Schema.Literal('permanent-failure'),
  action: Schema.Literal('reissue-invitation'),
  eventId: Schema.String,
  organizationId: Schema.String,
  invitationId: Schema.String,
  code: Schema.String,
  eventCreatedAt: IsoDateTime,
})
export type InvitationEmailRemediationRecord = typeof InvitationEmailRemediationRecord.Type

export interface InvitationEmailRemediationInput {
  readonly eventId: string
  readonly organizationId: string
  readonly invitationId: string
  readonly code: string
  readonly eventCreatedAt: string
}

export const invitationEmailRemediationRecord = async (
  input: InvitationEmailRemediationInput,
): Promise<InvitationEmailRemediationRecord> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(InvitationEmailRemediationRecord)({
      version: 1,
      disposition: 'permanent-failure',
      action: 'reissue-invitation',
      eventId: input.eventId,
      organizationId: input.organizationId,
      invitationId: input.invitationId,
      code: input.code,
      eventCreatedAt: input.eventCreatedAt,
    }),
  )

export const invitationEmailRemediationKey = (organizationId: string, eventId: string): string =>
  `organizations/${encodeURIComponent(organizationId)}/notification-remediation/${encodeURIComponent(eventId)}.json`

export const writeInvitationEmailRemediation = async (
  input: InvitationEmailRemediationInput,
  write: (key: string, value: string) => Promise<void>,
): Promise<void> => {
  const record = await invitationEmailRemediationRecord(input)
  await write(
    invitationEmailRemediationKey(record.organizationId, record.eventId),
    JSON.stringify(record),
  )
}

export const persistInvitationEmailRemediation = async (
  bucket: R2Bucket,
  input: InvitationEmailRemediationInput,
): Promise<void> => {
  await writeInvitationEmailRemediation(input, async (key, value) => {
    await bucket.put(key, value, { httpMetadata: { contentType: 'application/json' } })
  })
}

const transientEmailCodes = new Set([
  'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_INTERNAL_SERVER_ERROR',
])

const knownPermanentEmailCodes = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
])

const safeEmailCode = (cause: unknown): string => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return 'E_UNKNOWN'
  const code = cause.code
  if (typeof code !== 'string') return 'E_UNKNOWN'
  if (transientEmailCodes.has(code) || knownPermanentEmailCodes.has(code)) return code
  return 'E_UNKNOWN'
}

export class RetryableInvitationEmailError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`Invitation email delivery is retryable (${code})`)
    this.name = 'RetryableInvitationEmailError'
    this.code = code
  }
}

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

export const deriveInvitationToken = async (secret: string, scope: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToHex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`gridora-invitation-v1:${scope}`),
    ),
  )
}

const secretForVersion = (keyring: InvitationTokenKeyring, version: string): string => {
  if (keyring.current.version === version) return keyring.current.secret
  if (keyring.previous?.version === version) return keyring.previous.secret
  throw new RetryableInvitationEmailError('TOKEN_KEY_VERSION_UNAVAILABLE')
}

const escaped = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const displayText = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim()

export const decodeInvitationEmailPayload = (input: unknown): Promise<InvitationEmailPayload> =>
  Effect.runPromise(Schema.decodeUnknownEffect(InvitationEmailPayload)(input))

export const sendInvitationEmail = async (
  eventId: string,
  payload: InvitationEmailPayload,
  configuration: InvitationEmailConfiguration,
  email: SendEmail,
): Promise<InvitationEmailDeliveryResult> => {
  const token = await deriveInvitationToken(
    secretForVersion(configuration.tokenKeys, payload.tokenDerivation.version),
    payload.tokenDerivation.scope,
  )
  const acceptUrl = new URL(`/invitations/${encodeURIComponent(token)}`, configuration.publicAppUrl)
  const organizationName = displayText(payload.organizationName)
  const role = displayText(payload.role)
  const expiresAt = displayText(payload.expiresAt)
  const url = acceptUrl.toString()
  try {
    const result = await email.send({
      to: payload.email,
      from: { email: configuration.from, name: 'Gridora' },
      subject: `You are invited to ${organizationName}`,
      headers: { 'X-Gridora-Event-ID': eventId },
      text: [
        `You have been invited to ${organizationName} as ${role}.`,
        `Accept the invitation: ${url}`,
        `This invitation expires at ${expiresAt}.`,
      ].join('\n\n'),
      html: [
        `<p>You have been invited to <strong>${escaped(organizationName)}</strong> as ${escaped(role)}.</p>`,
        `<p><a href="${escaped(url)}">Accept invitation</a></p>`,
        `<p>This invitation expires at ${escaped(expiresAt)}.</p>`,
      ].join(''),
    })
    return { status: 'delivered', messageId: result.messageId }
  } catch (cause) {
    const code = safeEmailCode(cause)
    if (transientEmailCodes.has(code)) throw new RetryableInvitationEmailError(code)
    return { status: 'permanent-failure', code }
  }
}

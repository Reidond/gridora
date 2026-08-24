import { Effect, Layer, Schema } from 'effect'
import {
  AutomationCredentialIssuer,
  AutomationIdentityPersistenceError,
  AutomationScope,
  automationCapabilitiesForScopes,
  type AutomationCredentialIssuerShape,
  type AutomationCapability,
  type AutomationIdentityPersistenceError as AutomationIdentityPersistenceErrorType,
} from '@gridora/automation-identity-control'
import {
  AutomationCredentialId,
  AutomationIdentityId,
  IsoDateTime,
  OrganizationId,
  OrganizationSlug,
} from '@gridora/domain'

const credentialHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const zeroHash = '0'.repeat(64)
const tokenPrefix = 'grda.v1'
const maxAuthorizationLength = 768

export class AutomationCredentialAuthenticationError extends Schema.TaggedError<AutomationCredentialAuthenticationError>()(
  'AutomationCredentialAuthenticationError',
  {
    reason: Schema.Literals([
      'missing_credential',
      'invalid_credential',
      'scope_required',
      'rate_limited',
    ]),
  },
) {}

export class AutomationCredentialAuthenticationPersistenceError extends Schema.TaggedError<AutomationCredentialAuthenticationPersistenceError>()(
  'AutomationCredentialAuthenticationPersistenceError',
  { operation: Schema.String },
) {}

export type AutomationCredentialAuthenticationErrorType =
  | AutomationCredentialAuthenticationError
  | AutomationCredentialAuthenticationPersistenceError

export interface AutomationCredentialAuthenticationRecord {
  readonly organizationId: OrganizationId
  readonly organizationSlug: OrganizationSlug
  readonly automationIdentityId: AutomationIdentityId
  readonly clientId: string
  readonly credentialId: AutomationCredentialId
  /** Monotonic credential generation, distinct from mutable metadata revision. */
  readonly credentialVersion: number
  readonly credentialHash: string
  readonly scopes: ReadonlyArray<AutomationScope>
  readonly organizationStatus: 'active' | 'suspended' | 'deleting' | 'deleted'
  readonly identityStatus: 'active' | 'revoked'
  readonly credentialStatus: 'active' | 'revoked'
  readonly expiresAt: typeof IsoDateTime.Type | null
  readonly identityRevision: number
  readonly credentialRevision: number
  readonly creatorIdentityStatus: 'active' | 'suspended'
  readonly creatorMembershipStatus: 'active' | 'suspended' | null
}

export interface AutomationCredentialAuthenticationRepositoryShape {
  /**
   * This query is scoped by the route organization. A foreign client looks the
   * same as an absent client to this layer.
   */
  readonly findForAuthentication: (input: {
    readonly organization: string
    readonly clientId: string
    readonly credentialId: string
  }) => Effect.Effect<
    AutomationCredentialAuthenticationRecord | null,
    AutomationCredentialAuthenticationPersistenceError
  >
  /** Fixed-window storage is bounded to known credential selectors plus one unknown selector. */
  readonly consumeRateLimit: (input: {
    readonly subject: string
    readonly now: typeof IsoDateTime.Type
    readonly limit: number
    readonly windowMilliseconds: number
  }) => Effect.Effect<
    { readonly allowed: boolean; readonly retryAfterSeconds: number },
    AutomationCredentialAuthenticationPersistenceError
  >
  /**
   * This update repeats every active/revision/expiry fence. A concurrent
   * revoke must make the authentication request fail rather than use a stale
   * principal.
   */
  readonly touchLastUse: (input: {
    readonly organizationId: OrganizationId
    readonly automationIdentityId: AutomationIdentityId
    readonly credentialId: AutomationCredentialId
    readonly expectedIdentityRevision: number
    readonly expectedCredentialRevision: number
    readonly now: typeof IsoDateTime.Type
  }) => Effect.Effect<boolean, AutomationCredentialAuthenticationPersistenceError>
}

export interface AutomationCredentialCryptography {
  readonly hash: (
    credential: string,
  ) => Effect.Effect<string, AutomationIdentityPersistenceErrorType>
  /** Both values must be fixed-length SHA-256 hex values. */
  readonly timingSafeEqual: (
    left: string,
    right: string,
  ) => Effect.Effect<boolean, AutomationIdentityPersistenceErrorType>
}

export interface AutomationCredentialAuthenticationClock {
  readonly now: Effect.Effect<
    typeof IsoDateTime.Type,
    AutomationCredentialAuthenticationPersistenceError
  >
}

export interface AutomationCredentialPrincipal {
  readonly authenticationType: 'automation-credential'
  readonly organizationId: OrganizationId
  readonly organizationSlug: OrganizationSlug
  readonly automationIdentityId: AutomationIdentityId
  readonly clientId: string
  readonly credentialId: AutomationCredentialId
  readonly credentialVersion: number
  readonly identityRevision: number
  readonly scopes: ReadonlyArray<AutomationScope>
  readonly capabilities: ReadonlyArray<AutomationCapability>
}

export interface AuthenticateAutomationCredentialInput {
  readonly authorization: string | undefined
  /** Route organization ID or slug. It is part of the repository selector. */
  readonly organization: string
  readonly requiredScope: AutomationScope
}

export interface AutomationCredentialAuthenticatorShape {
  readonly authenticate: (
    input: AuthenticateAutomationCredentialInput,
  ) => Effect.Effect<AutomationCredentialPrincipal, AutomationCredentialAuthenticationErrorType>
}

export interface AutomationCredentialAuthenticatorDependencies {
  readonly repository: AutomationCredentialAuthenticationRepositoryShape
  readonly cryptography: AutomationCredentialCryptography
  readonly clock: AutomationCredentialAuthenticationClock
  readonly rateLimit?: { readonly limit: number; readonly windowMilliseconds: number }
}

interface ParsedCredential {
  readonly raw: string
  readonly clientId: string
  readonly credentialId: string
}

const parseAuthorization = (value: string | undefined): ParsedCredential | null => {
  if (value === undefined || value.length === 0 || value.length > maxAuthorizationLength)
    return null
  const [scheme, credential, ...rest] = value.split(' ')
  if (scheme !== 'Bearer' || credential === undefined || rest.length !== 0) return null
  const parts = credential.split('.')
  if (
    parts.length !== 5 ||
    parts[0] !== 'grda' ||
    parts[1] !== 'v1' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(parts[2] ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(parts[3] ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[4] ?? '')
  )
    return null
  return { raw: credential, clientId: parts[2]!, credentialId: parts[3]! }
}

const activeAndUnexpired = (
  candidate: AutomationCredentialAuthenticationRecord,
  now: string,
): boolean => {
  const expiresAt = candidate.expiresAt === null ? Number.NaN : Date.parse(candidate.expiresAt)
  const current = Date.parse(now)
  return (
    candidate.organizationStatus === 'active' &&
    candidate.identityStatus === 'active' &&
    candidate.credentialStatus === 'active' &&
    candidate.creatorIdentityStatus === 'active' &&
    candidate.creatorMembershipStatus === 'active' &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(current) &&
    expiresAt > current
  )
}

const invalidCredential = () =>
  new AutomationCredentialAuthenticationError({ reason: 'invalid_credential' })
const cryptoFailure = (operation: string) =>
  new AutomationCredentialAuthenticationPersistenceError({ operation })

/**
 * Bearer credentials cannot cryptographically prevent a copied credential from
 * being replayed. This authenticator therefore gives each credential a bounded
 * fixed-window request budget and requires downstream state-changing routes to
 * keep their own idempotency keys. It never treats a nonce header as proof.
 */
export const makeAutomationCredentialAuthenticator = (
  dependencies: AutomationCredentialAuthenticatorDependencies,
): AutomationCredentialAuthenticatorShape => {
  const rateLimit = dependencies.rateLimit ?? { limit: 60, windowMilliseconds: 60_000 }
  if (
    !Number.isSafeInteger(rateLimit.limit) ||
    rateLimit.limit < 1 ||
    rateLimit.limit > 1_000 ||
    !Number.isSafeInteger(rateLimit.windowMilliseconds) ||
    rateLimit.windowMilliseconds < 1_000 ||
    rateLimit.windowMilliseconds > 3_600_000
  )
    throw new Error('Automation credential rate limit configuration is invalid')

  return {
    authenticate: (input) =>
      Effect.gen(function* () {
        const now = yield* dependencies.clock.now
        const parsed = parseAuthorization(input.authorization)
        // Hash a short fixed invalid value for malformed headers. This bounds CPU
        // use and preserves the same verifier comparison path for all failures.
        const providedHash = yield* dependencies.cryptography
          .hash(parsed === null ? `${tokenPrefix}.invalid` : parsed.raw)
          .pipe(Effect.mapError(() => cryptoFailure('automationCredential.authentication.hash')))
        const candidate =
          parsed === null
            ? null
            : yield* dependencies.repository.findForAuthentication({
                organization: input.organization,
                clientId: parsed.clientId,
                credentialId: parsed.credentialId,
              })
        const budget = yield* dependencies.repository.consumeRateLimit({
          subject: candidate === null ? 'unknown' : `credential:${candidate.credentialId}`,
          now,
          limit: rateLimit.limit,
          windowMilliseconds: rateLimit.windowMilliseconds,
        })
        if (!budget.allowed)
          return yield* new AutomationCredentialAuthenticationError({ reason: 'rate_limited' })
        const verifier = candidate?.credentialHash ?? zeroHash
        const equal = yield* dependencies.cryptography
          .timingSafeEqual(providedHash, verifier)
          .pipe(Effect.mapError(() => cryptoFailure('automationCredential.authentication.compare')))
        if (!equal || candidate === null || !activeAndUnexpired(candidate, now))
          return yield* invalidCredential()
        if (!candidate.scopes.includes(input.requiredScope))
          return yield* new AutomationCredentialAuthenticationError({ reason: 'scope_required' })
        const touched = yield* dependencies.repository.touchLastUse({
          organizationId: candidate.organizationId,
          automationIdentityId: candidate.automationIdentityId,
          credentialId: candidate.credentialId,
          expectedIdentityRevision: candidate.identityRevision,
          expectedCredentialRevision: candidate.credentialRevision,
          now,
        })
        if (!touched) return yield* invalidCredential()
        return {
          authenticationType: 'automation-credential',
          organizationId: candidate.organizationId,
          organizationSlug: candidate.organizationSlug,
          automationIdentityId: candidate.automationIdentityId,
          clientId: candidate.clientId,
          credentialId: candidate.credentialId,
          credentialVersion: candidate.credentialVersion,
          identityRevision: candidate.identityRevision,
          scopes: [...candidate.scopes],
          capabilities: automationCapabilitiesForScopes(candidate.scopes),
        }
      }),
  }
}

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const hashWithWebCrypto = (value: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    catch: () => new AutomationIdentityPersistenceError({ operation: 'automationCredential.hash' }),
  })

const timingSafeHexEqual = (left: string, right: string) =>
  Effect.try({
    try: () => {
      const candidate: unknown = crypto.subtle
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !('timingSafeEqual' in candidate) ||
        typeof candidate.timingSafeEqual !== 'function'
      )
        throw new Error('Workers timingSafeEqual is unavailable')
      const leftBytes = new TextEncoder().encode(left)
      const rightBytes = new TextEncoder().encode(right)
      return candidate.timingSafeEqual(leftBytes, rightBytes)
    },
    catch: () =>
      new AutomationIdentityPersistenceError({ operation: 'automationCredential.compare' }),
  })

export const WebCryptoAutomationCredentialCryptography: AutomationCredentialCryptography = {
  hash: hashWithWebCrypto,
  timingSafeEqual: timingSafeHexEqual,
}

/**
 * The credential string has a public client selector and key selector plus 256
 * bits of random secret material. Only the SHA-256 verifier leaves this method.
 */
export const WebCryptoAutomationCredentialIssuer: AutomationCredentialIssuerShape = {
  issue: ({ clientId, credentialId }) =>
    Effect.try({
      try: () => {
        const bytes = new Uint8Array(32)
        crypto.getRandomValues(bytes)
        return `${tokenPrefix}.${clientId}.${credentialId}.${encodeBase64Url(bytes)}`
      },
      catch: () =>
        new AutomationIdentityPersistenceError({ operation: 'automationCredential.issue' }),
    }).pipe(
      Effect.flatMap((credential) =>
        hashWithWebCrypto(credential).pipe(
          Effect.map((credentialHash) => ({ credential, credentialHash })),
        ),
      ),
    ),
}

/** Convenience layer for central Worker composition. Access JWTs use a separate verifier. */
export const WebCryptoAutomationCredentialIssuerLayer = () =>
  Layer.succeed(AutomationCredentialIssuer, WebCryptoAutomationCredentialIssuer)

export const isAutomationCredentialHash = (value: string): boolean =>
  Schema.is(credentialHash)(value)

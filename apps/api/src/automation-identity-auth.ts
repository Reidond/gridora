import { Effect } from 'effect'
import type { Context as HonoContext, Env as HonoEnv } from 'hono'
import {
  AutomationCredentialAuthenticationError,
  AutomationCredentialAuthenticationPersistenceError,
  type AutomationCredentialAuthenticationErrorType,
  type AutomationCredentialAuthenticatorShape,
  type AutomationCredentialPrincipal,
} from '@gridora/automation-identity-auth'
import type { AutomationScope } from '@gridora/automation-identity-control'

/**
 * This adapter is for machine routes only. It does not read Cloudflare Access
 * assertions and it never makes an automation credential into a human
 * OrganizationContext. Human Access authentication remains a separate path.
 */
export interface AutomationCredentialRequestDependencies<E extends HonoEnv, R> {
  readonly authenticator: (
    bindings: E['Bindings'],
  ) => Effect.Effect<AutomationCredentialAuthenticatorShape, never, R>
}

/**
 * The organization route parameter is passed to the verifier before a client
 * selector lookup. A token from another organization is therefore the same as
 * an absent token to the caller.
 */
export const authenticateAutomationCredentialRequest = <E extends HonoEnv, R>(
  context: HonoContext<E>,
  dependencies: AutomationCredentialRequestDependencies<E, R>,
  requiredScope: AutomationScope,
): Effect.Effect<AutomationCredentialPrincipal, AutomationCredentialAuthenticationErrorType, R> =>
  Effect.gen(function* () {
    const authenticator = yield* dependencies.authenticator(context.env)
    return yield* authenticator.authenticate({
      authorization: context.req.header('authorization'),
      organization: context.req.param('organization') ?? '',
      requiredScope,
    })
  })

/**
 * Machine authentication has its own public problem form. It is intentionally
 * generic: no response says whether a credential selector belongs to another
 * organization, is revoked, expired, or simply absent.
 */
export const automationCredentialAuthenticationResponse = (
  error: AutomationCredentialAuthenticationErrorType,
  requestId: string,
): Response => {
  const status =
    error instanceof AutomationCredentialAuthenticationPersistenceError
      ? 503
      : error.reason === 'scope_required'
        ? 403
        : error.reason === 'rate_limited'
          ? 429
          : 401
  const code =
    error instanceof AutomationCredentialAuthenticationPersistenceError
      ? 'AUTOMATION_AUTHENTICATION_UNAVAILABLE'
      : error.reason === 'scope_required'
        ? 'AUTOMATION_SCOPE_DENIED'
        : error.reason === 'rate_limited'
          ? 'AUTOMATION_AUTHENTICATION_RATE_LIMITED'
          : 'AUTOMATION_AUTHENTICATION_FAILED'
  const detail =
    error instanceof AutomationCredentialAuthenticationPersistenceError
      ? 'The request can be retried'
      : status === 403
        ? 'The credential does not have the required capability'
        : 'A valid automation credential is required'
  return new Response(
    JSON.stringify({
      type: `https://errors.gridora.example/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 503 ? 'Authentication temporarily unavailable' : 'Authentication required',
      status,
      code,
      detail,
      requestId,
      retryable: status === 503 || status === 429,
      fields: [],
    }),
    {
      status,
      headers: {
        'cache-control': 'no-store, private',
        'content-type': 'application/problem+json; charset=utf-8',
        pragma: 'no-cache',
        'referrer-policy': 'no-referrer',
      },
    },
  )
}

export const isAutomationCredentialAuthenticationError = (
  error: unknown,
): error is
  | AutomationCredentialAuthenticationError
  | AutomationCredentialAuthenticationPersistenceError =>
  error instanceof AutomationCredentialAuthenticationError ||
  error instanceof AutomationCredentialAuthenticationPersistenceError

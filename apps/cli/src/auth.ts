import { createHash, randomBytes } from 'node:crypto'
import { Context, Effect } from 'effect'
import { CliError } from './errors.js'

export interface OAuthDiscovery {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint?: string
  readonly revocationEndpoint?: string
}

export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: string
}

export interface LoginStart {
  readonly authorizationUrl: string
  readonly verifier: string
  readonly state: string
  readonly redirectUri: string
}

export class AuthAdapter extends Context.Service<
  AuthAdapter,
  {
    readonly discover: (apiOrigin: string) => Effect.Effect<OAuthDiscovery, CliError>
    readonly register: (
      discovery: OAuthDiscovery,
      redirectUri: string,
    ) => Effect.Effect<string, CliError>
    readonly awaitAuthorizationCode: (
      authorizationUrl: string,
      state: string,
    ) => Effect.Effect<string, CliError>
    readonly exchange: (
      discovery: OAuthDiscovery,
      code: string,
      clientId: string,
      verifier: string,
      redirectUri: string,
    ) => Effect.Effect<OAuthTokens, CliError>
    readonly revoke: (refreshToken: string) => Effect.Effect<void, CliError>
  }
>()('gridora/cli/AuthAdapter') {}

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export const createLoginStart = (input: {
  readonly authorizationEndpoint: string
  readonly clientId: string
  readonly redirectUri: string
  readonly resource: string
  readonly verifier?: string
  readonly state?: string
}): LoginStart => {
  const verifier = input.verifier ?? base64Url(randomBytes(48))
  const state = input.state ?? base64Url(randomBytes(24))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = new URL(input.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: input.resource,
  }).toString()
  return { authorizationUrl: url.toString(), verifier, state, redirectUri: input.redirectUri }
}

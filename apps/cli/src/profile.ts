import { Context, Effect, Layer, Schema } from 'effect'
import { CliError, ExitCode } from './errors.js'

export interface CliProfile {
  readonly name: string
  readonly apiOrigin: string
  readonly clientId?: string | undefined
  readonly authIssuer?: string | undefined
  readonly activeOrganization?: string | undefined
}

export class ProfileStore extends Context.Service<
  ProfileStore,
  {
    readonly load: (name: string) => Effect.Effect<CliProfile | undefined, CliError>
    readonly save: (profile: CliProfile) => Effect.Effect<void, CliError>
    readonly remove: (name: string) => Effect.Effect<void, CliError>
  }
>()('gridora/cli/ProfileStore') {}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly get: (profile: string) => Effect.Effect<string | undefined, CliError>
    readonly set: (profile: string, refreshToken: string) => Effect.Effect<void, CliError>
    readonly remove: (profile: string) => Effect.Effect<void, CliError>
  }
>()('gridora/cli/CredentialStore') {}

export const MemoryProfileStore = (initial: ReadonlyArray<CliProfile> = []) => {
  const values = new Map(initial.map((profile) => [profile.name, profile]))
  return Layer.succeed(ProfileStore, {
    load: (name) => Effect.succeed(values.get(name)),
    save: (profile) =>
      Effect.sync(() => {
        values.set(profile.name, profile)
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name)
      }),
  })
}

export const MemoryCredentialStore = () => {
  const values = new Map<string, string>()
  return Layer.succeed(CredentialStore, {
    get: (profile) => Effect.succeed(values.get(profile)),
    set: (profile, token) =>
      Effect.sync(() => {
        values.set(profile, token)
      }),
    remove: (profile) =>
      Effect.sync(() => {
        values.delete(profile)
      }),
  })
}

export const validateProfile = (value: unknown): Effect.Effect<CliProfile, CliError> =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      name: Schema.String,
      apiOrigin: Schema.String,
      clientId: Schema.optional(Schema.String),
      authIssuer: Schema.optional(Schema.String),
      activeOrganization: Schema.optional(Schema.String),
    }),
  )(value).pipe(
    Effect.mapError(
      (cause) =>
        new CliError({
          code: 'invalid_profile',
          message: 'profile is invalid',
          exitCode: ExitCode.validation,
          details: String(cause),
        }),
    ),
  )

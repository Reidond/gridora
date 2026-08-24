import { Context, Effect } from 'effect'
import { GridoraApi } from './client.js'
import type { ParsedCommand } from './commands.js'
import { CliError, ExitCode } from './errors.js'
import {
  manifestToServerApplyIntent,
  manifestToServerCreateIntent,
  parseDataDocument,
  parseManifestDocument,
} from './manifest.js'
import { ProfileStore } from './profile.js'

export class CliFiles extends Context.Service<
  CliFiles,
  { readonly readUtf8: (path: string) => Effect.Effect<string, CliError> }
>()('gridora/cli/Files') {}

export const resolveOrganization = (
  explicit: string | undefined,
  profileDefault: string | undefined,
): Effect.Effect<string, CliError> => {
  const organization = explicit ?? profileDefault
  return organization === undefined
    ? Effect.fail(
        new CliError({
          code: 'organization_required',
          message: 'use --organization or select an active organization',
          exitCode: ExitCode.usage,
        }),
      )
    : Effect.succeed(organization)
}

export const executeRemoteCommand = (
  command: ParsedCommand,
  profileName: string,
): Effect.Effect<unknown, CliError, CliFiles | GridoraApi | ProfileStore> =>
  Effect.gen(function* () {
    if (command.request === undefined)
      return yield* Effect.fail(
        new CliError({
          code: 'local_command',
          message: 'local command requires its dedicated auth/profile handler',
          exitCode: ExitCode.internal,
        }),
      )
    const profiles = yield* ProfileStore
    const profile = yield* profiles.load(profileName)
    if (profile === undefined)
      return yield* Effect.fail(
        new CliError({
          code: 'profile_not_found',
          message: `profile ${profileName} does not exist`,
          exitCode: ExitCode.authentication,
        }),
      )
    const organization =
      command.request.organizationScoped === true
        ? yield* resolveOrganization(command.organization, profile.activeOrganization)
        : undefined
    let body: unknown
    if (command.file !== undefined) {
      const files = yield* CliFiles
      const source = yield* files.readUtf8(command.file)
      if (
        command.positional[0] === 'servers' &&
        (command.positional[1] === 'apply' || command.positional[1] === 'plan')
      ) {
        const { input, manifest } = yield* parseManifestDocument(source)
        if (manifest.metadata.organization !== organization)
          return yield* Effect.fail(
            new CliError({
              code: 'manifest_organization_mismatch',
              message: 'manifest organization must match the selected organization',
              exitCode: ExitCode.usage,
            }),
          )
        body =
          command.positional[1] === 'plan'
            ? manifestToServerCreateIntent(manifest)
            : manifestToServerApplyIntent(manifest, input)
      } else body = yield* parseDataDocument(source)
    }
    const api = yield* GridoraApi
    const { organization: _parsedOrganization, ...request } = command.request
    if (command.positional[0] === 'operations' && command.positional[1] === 'watch') {
      const operationId = command.positional[2]
      if (operationId === undefined)
        return yield* Effect.fail(
          new CliError({
            code: 'operation_required',
            message: 'operation ID is required',
            exitCode: ExitCode.usage,
          }),
        )
      return yield* api.watchOperation(operationId, command.timeoutMs, organization)
    }
    // File-backed lifecycle mutations carry the immutable action/revision
    // envelope from the parser; the document supplies only the action-specific
    // desired state.  The envelope wins if a file attempts to replace it.
    if (
      body !== undefined &&
      typeof body === 'object' &&
      body !== null &&
      command.request.body !== undefined &&
      command.positional[0] === 'servers' &&
      (command.positional[1] === 'update' || command.positional[1] === 'config')
    )
      body = {
        ...(body as Record<string, unknown>),
        ...(command.request.body as Record<string, unknown>),
      }
    if (
      body !== undefined &&
      typeof body === 'object' &&
      body !== null &&
      command.request.body !== undefined &&
      command.positional[0] === 'mods' &&
      command.positional[1] === 'sync'
    )
      body = {
        ...(body as Record<string, unknown>),
        ...(command.request.body as Record<string, unknown>),
      }
    const response = yield* api.request({
      ...request,
      ...(organization === undefined ? {} : { organization }),
      ...(body === undefined ? {} : { body }),
    })
    if (command.liveLogs !== undefined) {
      if (organization === undefined)
        return yield* Effect.fail(
          new CliError({
            code: 'organization_required',
            message: 'live logs require an active organization',
            exitCode: ExitCode.usage,
          }),
        )
      if (api.streamLogs === undefined)
        return yield* Effect.fail(
          new CliError({
            code: 'live_logs_unavailable',
            message: 'the configured CLI API adapter cannot open live logs',
            exitCode: ExitCode.unavailable,
          }),
        )
      const live = yield* api.streamLogs({ organization, ...command.liveLogs })
      return { archives: response.data, live }
    }
    if (command.wait && response.operationId !== undefined)
      return yield* api.watchOperation(response.operationId, command.timeoutMs, organization)
    return response.data
  })

import { Effect, Schema } from 'effect'
import {
  canonicalGameServerManifest,
  commercialReviewTokenFromManifestInput,
  decodeGameServerManifestInput,
  manifestToGameCreateIntent as toGameCreateIntent,
  manifestToServerApplyIntent as toServerApplyIntent,
  manifestToServerCreateIntent as toServerCreateIntent,
  normalizeGameServerManifest,
  type GameServerManifest,
  type GameServerManifestInput,
} from '@gridora/game-server-manifest-control'
import YAML from 'yaml'
import { CliError, ExitCode } from './errors.js'
import type { OutputFormat } from './output.js'

export type { GameServerManifest, GameServerManifestInput }

export const DataDocument = Schema.Record(Schema.String, Schema.Unknown)
export type DataDocument = typeof DataDocument.Type

const invalid = (code: string, message: string, details?: string) =>
  new CliError({
    code,
    message,
    exitCode: ExitCode.usage,
    ...(details === undefined ? {} : { details }),
  })

const parseYaml = (source: string): Effect.Effect<unknown, CliError> =>
  Effect.try({
    try: () => YAML.parse(source) as unknown,
    catch: (cause) =>
      invalid(
        'invalid_yaml',
        'document is not valid YAML',
        cause instanceof Error ? cause.message : 'YAML parser rejected the document',
      ),
  })

/**
 * Keep the raw document only until the create/apply handoff. The only field
 * that normalization intentionally removes is the opaque commercial proof.
 */
export const parseManifestInput = (
  source: string,
): Effect.Effect<GameServerManifestInput, CliError> =>
  parseYaml(source).pipe(
    Effect.flatMap(decodeGameServerManifestInput),
    Effect.mapError((cause) =>
      cause instanceof CliError
        ? cause
        : invalid(
            'invalid_manifest',
            'manifest does not match the GameServer contract',
            cause instanceof Error ? cause.message : 'manifest schema validation failed',
          ),
    ),
  )

/** Decode legacy-compatible input and return the canonical desired state. */
export const parseManifest = (source: string): Effect.Effect<GameServerManifest, CliError> =>
  parseManifestInput(source).pipe(
    Effect.flatMap(normalizeGameServerManifest),
    Effect.mapError((cause) =>
      cause instanceof CliError
        ? cause
        : invalid(
            'invalid_manifest',
            'manifest does not match the GameServer contract',
            cause instanceof Error ? cause.message : 'manifest schema validation failed',
          ),
    ),
  )

/**
 * Decode once when the caller needs both canonical desired state and the
 * short-lived authored input that may carry a commercial review proof.
 */
export const parseManifestDocument = (
  source: string,
): Effect.Effect<
  { readonly input: GameServerManifestInput; readonly manifest: GameServerManifest },
  CliError
> =>
  parseManifestInput(source).pipe(
    Effect.flatMap((input) =>
      normalizeGameServerManifest(input).pipe(Effect.map((manifest) => ({ input, manifest }))),
    ),
    Effect.mapError((cause) =>
      cause instanceof CliError
        ? cause
        : invalid(
            'invalid_manifest',
            'manifest does not match the GameServer contract',
            cause instanceof Error ? cause.message : 'manifest schema validation failed',
          ),
    ),
  )

export const manifestToServerCreateIntent = (manifest: GameServerManifest) =>
  toServerCreateIntent(manifest)

export const manifestToGameCreateIntent = (manifest: GameServerManifest) =>
  toGameCreateIntent(manifest)

/**
 * The commercial proof is never part of normalized or exported desired state.
 * It is copied only from an authored input document to the legacy create API.
 */
export const manifestToServerApplyIntent = (
  manifest: GameServerManifest,
  input?: GameServerManifestInput,
) =>
  toServerApplyIntent(
    manifest,
    input === undefined ? undefined : commercialReviewTokenFromManifestInput(input),
  )

/**
 * Stable YAML/JSON output is generated from the canonical JSON ordering used
 * for persistence comparisons. Export supports only machine-readable forms;
 * a table would no longer round-trip through the manifest decoder.
 */
export const renderGameServerManifest = (
  manifest: GameServerManifest,
  format: Exclude<OutputFormat, 'table'>,
): string => {
  const ordered = JSON.parse(canonicalGameServerManifest(manifest)) as unknown
  return format === 'json' ? `${JSON.stringify(ordered, null, 2)}\n` : YAML.stringify(ordered)
}

export const parseDataDocument = (source: string): Effect.Effect<DataDocument, CliError> =>
  parseYaml(source).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DataDocument)),
    Effect.mapError((cause) =>
      cause instanceof CliError
        ? cause
        : invalid(
            'invalid_document',
            'document must contain a YAML or JSON object',
            cause instanceof Error ? cause.message : 'document schema validation failed',
          ),
    ),
  )

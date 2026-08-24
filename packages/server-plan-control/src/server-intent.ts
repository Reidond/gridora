import { Effect, Schema } from 'effect'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Canonical scheduler resource contract shared by plan, apply, CLI, and web. */
export const ServerResourceRequest = Schema.Struct({
  cpuMillis: PositiveInteger,
  ramBytes: PositiveInteger,
  diskBytes: PositiveInteger,
})
export type ServerResourceRequest = typeof ServerResourceRequest.Type

/** Public intent deliberately has no server, deployment, provider-account, or allocation ID. */
export const ServerCreateIntent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(96),
    Schema.isPattern(/^(?=\S)\P{Cc}*(?<=\S)$/u),
  ),
  pluginId: Identifier,
  placementMode: Schema.Literals(['auto', 'shared', 'dedicated']),
  resources: ServerResourceRequest,
  // Older v1 declarative documents decode to an explicit refusal. New clients
  // always send this value, so the no-fit preview and the accepted node child
  // share one stable, fingerprinted commercial-consent input.
  nonHourlyCommitmentConfirmed: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
})
export type ServerCreateIntent = typeof ServerCreateIntent.Type

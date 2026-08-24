import { Schema } from 'effect'
import { ServerResourceRequest } from './server-intent.js'

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

/** Leaf wire schema: it intentionally has no dependency on the control service. */
export const ServerPlanDecisionSchema = Schema.Struct({
  kind: Schema.Literal('existing-node'),
  pluginId: Identifier,
  pluginVersion: Identifier,
  placementMode: Schema.Literals(['shared', 'dedicated']),
  nodeId: Identifier,
  resources: ServerResourceRequest,
  ports: Schema.Array(
    Schema.Struct({
      name: Identifier,
      protocol: Schema.Literals(['tcp', 'udp']),
      containerPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      preferredPublicPort: Schema.NullOr(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      ),
      publicPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
    }),
  ),
  newPaidInfrastructure: Schema.Literal(false),
  estimatedMonthlyIncreaseMinor: Schema.Literal(0),
  explanation: Schema.String,
  warnings: Schema.Array(
    Schema.Struct({
      code: Schema.Literal('soft_budget_exceeded'),
      message: Schema.String,
      projectedEstimatedMonthlyMinor: Schema.Number,
      currency: Schema.String,
    }),
  ),
  candidates: Schema.Array(
    Schema.Struct({
      nodeId: Identifier,
      accepted: Schema.Boolean,
      reasons: Schema.Array(Schema.String),
      score: Schema.Number,
    }),
  ),
})
